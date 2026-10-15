/**
 * Acting as the GitHub App: the JWT we sign with the App's private key, and the
 * installation tokens we mint with it.
 *
 * A real RSA keypair is generated in-process, so the JWT's signature is actually
 * verified rather than merely shaped. GitHub itself is faked the way
 * tests/access.test.ts fakes it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GitHubAppAuth, normalizePem } from "../src/app-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

interface FakeGitHub {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string; jwt: string | undefined }>;
  token: string;
  expiresAt: string;
  status: number;
  installation: unknown;
}

function fakeGitHub(): FakeGitHub {
  const gh: FakeGitHub = {
    calls: [],
    token: "ghs_installation_1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 201,
    installation: {
      id: 42,
      account: { login: "repofloor", id: 99, type: "Organization" },
      repository_selection: "selected",
      suspended_at: null,
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      gh.calls.push({ url, method: init?.method ?? "GET", jwt: auth?.replace(/^Bearer /, "") });

      if (gh.status >= 400) return new Response("{}", { status: gh.status });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: gh.token, expires_at: gh.expiresAt }, { status: 201 });
      }
      return Response.json(gh.installation, { status: 200 });
    }) as unknown as typeof fetch,
  };
  return gh;
}

const auth = (gh: FakeGitHub, now?: () => number): GitHubAppAuth =>
  new GitHubAppAuth({ appId: "123456", privateKey, fetchImpl: gh.fetchImpl, ...(now ? { now } : {}) });

test("the App JWT is RS256, issued by the App, and verifies against the public key", () => {
  const clock = 1_700_000_000_000;
  const jwt = auth(fakeGitHub(), () => clock).appJwt();

  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, number | string>;
  const seconds = Math.floor(clock / 1000);
  assert.equal(claims["iss"], "123456");
  assert.equal(claims["iat"], seconds - 60, "back-dated a minute for GitHub's clock skew");
  assert.ok((claims["exp"] as number) > seconds, "not already expired");
  assert.ok((claims["exp"] as number) - seconds <= 600, "GitHub's ceiling is ten minutes");

  const verified = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
  assert.ok(verified, "the signature is really made with the App's private key");
});

test("an installation token is minted with the JWT and then reused", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  assert.equal(await app.installationToken(42), "ghs_installation_1");
  assert.equal(await app.installationToken(42), "ghs_installation_1");
  assert.equal(gh.calls.length, 1, "the second caller gets the cached token");
  assert.equal(gh.calls[0]?.url, "https://api.github.com/app/installations/42/access_tokens");
  assert.equal(gh.calls[0]?.method, "POST");
  assert.match(gh.calls[0]?.jwt ?? "", /^[\w-]+\.[\w-]+\.[\w-]+$/, "asked for with an App JWT, not a token");
});

test("each installation gets its own token", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  await app.installationToken(42);
  gh.token = "ghs_installation_2";
  assert.equal(await app.installationToken(43), "ghs_installation_2");
  assert.equal(gh.calls.length, 2);
  assert.equal(app.size, 2);
});

test("a token is re-minted shortly before it expires, not after", async () => {
  const gh = fakeGitHub();
  let clock = 1_700_000_000_000;
  gh.expiresAt = new Date(clock + 10 * 60 * 1000).toISOString();
  const app = auth(gh, () => clock);

  assert.equal(await app.installationToken(42), "ghs_installation_1");

  clock += 8 * 60 * 1000; // two minutes of life left
  assert.equal(await app.installationToken(42), "ghs_installation_1");
  assert.equal(gh.calls.length, 1);

  clock += 90 * 1000; // inside the skew window
  gh.token = "ghs_installation_fresh";
  gh.expiresAt = new Date(clock + 60 * 60 * 1000).toISOString();
  assert.equal(await app.installationToken(42), "ghs_installation_fresh");
  assert.equal(gh.calls.length, 2);
});

test("a burst of callers makes one request to GitHub", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => app.installationToken(42)));
  assert.deepEqual(new Set(tokens), new Set(["ghs_installation_1"]));
  assert.equal(gh.calls.length, 1, "in-flight mints are shared");
});

test("GitHub refusing to mint throws, and nothing is cached", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  gh.status = 401;
  await assert.rejects(() => app.installationToken(42), /github_installation_token_status_401/);
  assert.equal(app.size, 0);

  gh.status = 201;
  assert.equal(await app.installationToken(42), "ghs_installation_1", "a later attempt is not poisoned");
});

test("invalidate forgets a token, e.g. after a suspend delivery", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  await app.installationToken(42);
  app.invalidate(42);
  assert.equal(app.size, 0);

  gh.token = "ghs_installation_after_suspend";
  assert.equal(await app.installationToken(42), "ghs_installation_after_suspend");
});

test("fetchInstallation reads GitHub's own answer, and 404 means not ours", async () => {
  const gh = fakeGitHub();
  const app = auth(gh);

  assert.deepEqual(await app.fetchInstallation(42), {
    installationId: 42,
    accountLogin: "repofloor",
    accountId: 99,
    accountType: "Organization",
    repositorySelection: "selected",
    suspended: false,
  });
  assert.equal(gh.calls[0]?.url, "https://api.github.com/app/installations/42");

  gh.status = 404;
  assert.equal(await app.fetchInstallation(42), undefined);

  gh.status = 500;
  await assert.rejects(() => app.fetchInstallation(42), /github_app_installations_status_500/);
});

test("GITHUB_API_URL is honoured, so GHES works", async () => {
  const gh = fakeGitHub();
  const app = new GitHubAppAuth({
    appId: "1",
    privateKey,
    apiUrl: "https://ghe.example/api/v3/",
    fetchImpl: gh.fetchImpl,
  });

  await app.installationToken(7);
  assert.equal(gh.calls[0]?.url, "https://ghe.example/api/v3/app/installations/7/access_tokens");
});

test("a PEM pasted with escaped newlines is accepted", () => {
  const escaped = privateKey.trimEnd().replace(/\n/g, "\\n");
  assert.equal(normalizePem(escaped), privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`);

  // And it signs: an env-var-shaped key is not a broken key.
  const app = new GitHubAppAuth({ appId: "1", privateKey: escaped, fetchImpl: fakeGitHub().fetchImpl });
  const [header, payload, signature] = app.appJwt().split(".");
  assert.ok(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, "base64url")),
  );
});

test("the credentials are required, not optional", () => {
  assert.throws(() => new GitHubAppAuth({ appId: "", privateKey }), /appId is required/);
  assert.throws(() => new GitHubAppAuth({ appId: "1", privateKey: "" }), /privateKey is required/);
});
