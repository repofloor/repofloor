/**
 * The GitHub App installation flow, over a real server with GitHub faked.
 *
 * Two ways an installation is recorded, and the difference matters:
 *   - the `installation` **delivery**, which is signed, and therefore authoritative;
 *   - the **Setup URL**, which is just the owner's browser and carries an unsigned
 *     `installation_id`, so the installation is read back from GitHub as the App before
 *     anything is stored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "../src/app.ts";
import { GitHubAppAuth } from "../src/app-auth.ts";
import { GitHubOAuth } from "../src/oauth.ts";
import { InMemoryInstallationStore } from "../src/installations.ts";
import { InMemorySessionStore } from "../src/session.ts";
import { SignIn } from "../src/sign-in.ts";
import { signWebhook } from "../src/signature.ts";
import { InMemoryOfficeStore } from "../src/store.ts";

const SECRET = "webhook-secret";
const BASE_URL = "https://repofloor.example";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** The installation object, as GitHub sends it in a delivery and in the API answer. */
const installationPayload = (over: Record<string, unknown> = {}) => ({
  id: 42,
  account: { login: "repofloor", id: 99, type: "Organization" },
  repository_selection: "selected",
  suspended_at: null,
  ...over,
});

interface FakeGitHub {
  fetchImpl: typeof fetch;
  calls: string[];
  /** Which installation ids this App actually has. Anything else 404s, as GitHub does. */
  known: Set<number>;
  status: number;
}

function fakeGitHub(): FakeGitHub {
  const gh: FakeGitHub = {
    calls: [],
    known: new Set([42]),
    status: 200,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      gh.calls.push(url);
      if (gh.status >= 400) return new Response("{}", { status: gh.status });

      const match = url.match(/\/app\/installations\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);
        if (!gh.known.has(id)) return new Response("{}", { status: 404 });
        return Response.json(installationPayload({ id }), { status: 200 });
      }
      // Enough of the OAuth leg for the combined install-and-sign-in flow.
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "gho_owner" });
      if (url.endsWith("/user")) return Response.json({ login: "aliosmanmho", id: 7 });
      throw new Error(`unexpected call to ${url}`);
    }) as unknown as typeof fetch,
  };
  return gh;
}

interface Harness {
  base: string;
  gh: FakeGitHub;
  installations: InMemoryInstallationStore;
}

async function withServer<T>(
  fn: (h: Harness) => Promise<T>,
  options: { appCredentials?: boolean; appSlug?: string | undefined } = {},
): Promise<T> {
  const gh = fakeGitHub();
  const installations = new InMemoryInstallationStore();
  const appAuth =
    options.appCredentials === false
      ? undefined
      : new GitHubAppAuth({ appId: "123456", privateKey, fetchImpl: gh.fetchImpl });

  const signIn = new SignIn({
    oauth: new GitHubOAuth({ clientId: "Iv1.client", clientSecret: "client-secret", fetchImpl: gh.fetchImpl }),
    sessions: new InMemorySessionStore(),
    cookieSecret: "cookie-secret-long-enough",
    baseUrl: BASE_URL,
    ...(appAuth ? { appAuth } : {}),
    installations,
    ...("appSlug" in options ? { appSlug: options.appSlug } : { appSlug: "repofloor" }),
  });

  const app = createApp({
    webhookSecret: SECRET,
    store: new InMemoryOfficeStore(),
    signIn,
    installations,
  });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  try {
    return await fn({ base: `http://127.0.0.1:${address.port}`, gh, installations });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function deliver(base: string, event: string, deliveryId: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signWebhook(SECRET, body),
    },
    body,
  });
}

test("/auth/install sends the owner to GitHub's install page", async () => {
  await withServer(async (h) => {
    const res = await fetch(`${h.base}/auth/install`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://github.com/apps/repofloor/installations/new");
  });

  await withServer(
    async (h) => {
      const res = await fetch(`${h.base}/auth/install`, { redirect: "manual" });
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), { error: "app_slug_not_configured" });
    },
    { appSlug: undefined },
  );
});

test("the setup callback reads the installation back from GitHub and stores it", async () => {
  await withServer(async (h) => {
    const res = await fetch(`${h.base}/auth/install/callback?installation_id=42&setup_action=install`, {
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      setupAction: "install",
      installationId: 42,
      account: "repofloor",
    });

    assert.equal(h.gh.calls[0], "https://api.github.com/app/installations/42", "asked as the App, not trusted");
    assert.deepEqual(await h.installations.get(42), {
      installationId: 42,
      accountLogin: "repofloor",
      accountId: 99,
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
    });
  });
});

test("an installation_id GitHub does not recognise is stored for nobody", async () => {
  await withServer(async (h) => {
    const res = await fetch(`${h.base}/auth/install/callback?installation_id=999&setup_action=install`, {
      redirect: "manual",
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: "unknown_installation",
      setupAction: "install",
      installationId: 999,
    });
    assert.deepEqual(await h.installations.list(), [], "a made-up id cannot write a row");
  });
});

test("a missing or nonsensical installation_id is a 400", async () => {
  await withServer(async (h) => {
    const missing = await fetch(`${h.base}/auth/install/callback`, { redirect: "manual" });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "missing_installation_id" });

    for (const bad of ["abc", "-1", "0", "1.5"]) {
      const res = await fetch(`${h.base}/auth/install/callback?installation_id=${bad}`, { redirect: "manual" });
      assert.equal(res.status, 400, `${bad} is not an installation id`);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_installation_id");
    }
    assert.equal(h.gh.calls.length, 0, "GitHub is not bothered with obvious rubbish");
  });
});

test("GitHub being unreachable during setup is a 502, and nothing is stored", async () => {
  await withServer(async (h) => {
    h.gh.status = 500;
    const res = await fetch(`${h.base}/auth/install/callback?installation_id=42`, { redirect: "manual" });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "github_unavailable");
    assert.deepEqual(await h.installations.list(), []);
  });
});

test("without App credentials the setup callback says so rather than guessing", async () => {
  await withServer(
    async (h) => {
      const res = await fetch(`${h.base}/auth/install/callback?installation_id=42`, { redirect: "manual" });
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), {
        error: "app_credentials_not_configured",
        installationId: 42,
      });
      assert.deepEqual(await h.installations.list(), [], "an unverified id is never stored");
    },
    { appCredentials: false },
  );
});

test("a return_to on the setup URL redirects into the web app instead of showing JSON", async () => {
  await withServer(async (h) => {
    const res = await fetch(`${h.base}/auth/install/callback?installation_id=42&return_to=/offices`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `${BASE_URL}/offices`);
    assert.equal((await h.installations.get(42))?.accountLogin, "repofloor", "and it is still recorded");

    const hostile = await fetch(
      `${h.base}/auth/install/callback?installation_id=42&return_to=${encodeURIComponent("https://evil.example")}`,
      { redirect: "manual" },
    );
    assert.equal(hostile.headers.get("location"), `${BASE_URL}/`, "no open redirect here either");
  });
});

test("an installation delivery records the installation without asking GitHub anything", async () => {
  await withServer(async (h) => {
    const res = await deliver(h.base, "installation", "d1", {
      action: "created",
      installation: installationPayload(),
      sender: { login: "aliosmanmho" },
    });
    assert.equal(res.status, 202);

    assert.equal((await h.installations.get(42))?.accountLogin, "repofloor");
    assert.equal(h.gh.calls.length, 0, "the delivery is signed, so its payload is enough");
  });
});

test("suspending, unsuspending and deleting an App are all followed", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "installation", "d1", { action: "created", installation: installationPayload() });

    await deliver(h.base, "installation", "d2", {
      action: "suspend",
      installation: installationPayload({ suspended_at: "2026-10-02T10:00:00Z" }),
    });
    assert.equal((await h.installations.get(42))?.suspended, true);

    await deliver(h.base, "installation", "d3", {
      action: "unsuspend",
      installation: installationPayload(),
    });
    assert.equal((await h.installations.get(42))?.suspended, false);

    await deliver(h.base, "installation", "d4", {
      action: "deleted",
      installation: installationPayload(),
    });
    assert.equal(await h.installations.get(42), undefined, "uninstalling removes the row");
  });
});

test("a delivery with nothing recognisable in it is still acknowledged", async () => {
  await withServer(async (h) => {
    assert.equal((await deliver(h.base, "installation", "d1", { action: "created" })).status, 202);
    assert.equal((await deliver(h.base, "installation", "d2", { action: "created", installation: {} })).status, 202);
    assert.deepEqual(await h.installations.list(), []);
  });
});

test("the OAuth callback also records an installation when the two flows are combined", async () => {
  // GitHub can ask for user authorization *during* an install, which lands on the OAuth
  // callback with installation_id in the query.
  await withServer(async (h) => {
    const begin = await fetch(`${h.base}/auth/github`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = begin.headers.getSetCookie()[0]!.split(";")[0]!;

    const res = await fetch(
      `${h.base}/auth/github/callback?code=c&state=${encodeURIComponent(state)}&installation_id=42`,
      { redirect: "manual", headers: { cookie: stateCookie } },
    );
    assert.equal(res.status, 302, "the owner is signed in");
    assert.ok(
      res.headers.getSetCookie().some((c) => c.startsWith("rf_session=")),
      "with a session",
    );
    assert.equal((await h.installations.get(42))?.accountLogin, "repofloor", "and the installation is recorded");
    assert.ok(
      h.gh.calls.includes("https://api.github.com/app/installations/42"),
      "still read back from GitHub rather than taken from the query",
    );
  });
});
