/**
 * "Sign in with GitHub" over a real server, with GitHub faked.
 *
 * The point of the slice, and so of this file: after signing in, a browser reads a
 * private office with nothing but a cookie, the cookie never contains the GitHub token,
 * and the read is still authorized by asking GitHub about that user (CLAUDE.md rule 6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.ts";
import { GitHubOAuth } from "../src/oauth.ts";
import { InMemorySessionStore } from "../src/session.ts";
import { SignIn, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "../src/sign-in.ts";
import { InMemoryOfficeStore } from "../src/store.ts";
import { signWebhook } from "../src/signature.ts";
import type { AccessDecision, RepoAccess } from "../src/access.ts";

const SECRET = "webhook-secret";
const COOKIE_SECRET = "cookie-secret-long-enough";
const BASE_URL = "https://repofloor.example";
/** What the fake GitHub hands back for a code. */
const USER_TOKEN = "gho_from_oauth";

const push = (isPrivate: boolean) => ({
  repository: {
    full_name: "repofloor/repofloor",
    name: "repofloor",
    default_branch: "main",
    private: isPrivate,
    owner: { login: "repofloor", type: "Organization" },
  },
  ref: "refs/heads/main",
  commits: [{ id: "a" }],
  sender: { login: "aliosmanmho" },
});

/** Answers from a table of tokens, and records what it was asked. */
class FakeAccess implements RepoAccess {
  readonly asked: Array<{ officeId: string; token: string | undefined }> = [];
  allowedTokens = new Set<string>([USER_TOKEN, "gho_alice"]);

  async canRead(officeId: string, token: string | undefined): Promise<AccessDecision> {
    this.asked.push({ officeId, token });
    if (!token) return { allowed: false, reason: "unauthenticated" };
    return this.allowedTokens.has(token)
      ? { allowed: true, cached: false }
      : { allowed: false, reason: "forbidden", cached: false };
  }

  invalidateOffice(): void {
    /* not exercised here */
  }
}

interface FakeGitHub {
  fetchImpl: typeof fetch;
  calls: string[];
  /** Set to an error code to make the token exchange fail the way GitHub does. */
  oauthError: string | undefined;
  userStatus: number;
}

function fakeGitHub(): FakeGitHub {
  const gh: FakeGitHub = {
    calls: [],
    oauthError: undefined,
    userStatus: 200,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      gh.calls.push(url);

      if (url.endsWith("/login/oauth/access_token")) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        assert.equal(body["client_id"], "Iv1.client");
        assert.equal(body["client_secret"], "client-secret");
        assert.equal(body["redirect_uri"], `${BASE_URL}/auth/github/callback`);
        if (gh.oauthError) return Response.json({ error: gh.oauthError });
        return Response.json({ access_token: USER_TOKEN, token_type: "bearer" });
      }

      if (url.endsWith("/user")) {
        if (gh.userStatus !== 200) return new Response("{}", { status: gh.userStatus });
        return Response.json({ login: "aliosmanmho", id: 7, avatar_url: "https://avatars.example/7" });
      }

      throw new Error(`unexpected call to ${url}`);
    }) as unknown as typeof fetch,
  };
  return gh;
}

interface Harness {
  base: string;
  access: FakeAccess;
  gh: FakeGitHub;
  sessions: InMemorySessionStore;
}

async function withServer<T>(
  fn: (h: Harness) => Promise<T>,
  options: { signIn?: boolean } = {},
): Promise<T> {
  const gh = fakeGitHub();
  const access = new FakeAccess();
  const sessions = new InMemorySessionStore();
  const signIn =
    options.signIn === false
      ? undefined
      : new SignIn({
          oauth: new GitHubOAuth({
            clientId: "Iv1.client",
            clientSecret: "client-secret",
            fetchImpl: gh.fetchImpl,
          }),
          sessions,
          cookieSecret: COOKIE_SECRET,
          baseUrl: BASE_URL,
          appSlug: "repofloor",
        });

  const app = createApp({
    webhookSecret: SECRET,
    store: new InMemoryOfficeStore(),
    access,
    ...(signIn ? { signIn } : {}),
  });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  try {
    return await fn({ base: `http://127.0.0.1:${address.port}`, access, gh, sessions });
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

/** `name=value` of a `Set-Cookie`, or undefined if the response did not set it. */
function cookie(res: Response, name: string): string | undefined {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return set?.split(";")[0];
}

function cookieAttributes(res: Response, name: string): string {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "";
}

/** The whole sign-in round trip; returns the session cookie to send on later requests. */
async function signInAs(h: Harness): Promise<string> {
  const begin = await fetch(`${h.base}/auth/github`, { redirect: "manual" });
  assert.equal(begin.status, 302);
  const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookie(begin, OAUTH_STATE_COOKIE)!;

  const callback = await fetch(`${h.base}/auth/github/callback?code=the-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: stateCookie },
  });
  assert.equal(callback.status, 302, "a successful sign-in ends in a redirect");
  return cookie(callback, SESSION_COOKIE)!;
}

const read = (base: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/office/repofloor/repofloor`, { headers });

test("beginning a sign-in sends the browser to GitHub with a state it also kept", async () => {
  await withServer(async (h) => {
    const res = await fetch(`${h.base}/auth/github`, { redirect: "manual" });
    assert.equal(res.status, 302);

    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "Iv1.client");
    assert.equal(location.searchParams.get("redirect_uri"), `${BASE_URL}/auth/github/callback`);
    assert.equal(location.searchParams.get("scope"), null, "a GitHub App's permissions decide, not a scope");

    const state = location.searchParams.get("state");
    assert.ok(state && state.length > 10);

    const attributes = cookieAttributes(res, OAUTH_STATE_COOKIE);
    assert.ok(attributes.includes("HttpOnly"), "the state cookie is not script-readable");
    assert.ok(attributes.includes("SameSite=Lax"));
    assert.ok(attributes.includes("Secure"), "https base URL means a Secure cookie");
    assert.ok(attributes.includes("Max-Age=600"), "and it is short-lived");
    assert.equal(h.gh.calls.length, 0, "starting a sign-in talks to nobody");
  });
});

test("the callback exchanges the code, opens a session and sets an opaque cookie", async () => {
  await withServer(async (h) => {
    const begin = await fetch(`${h.base}/auth/github?return_to=/office/repofloor/repofloor`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;

    const res = await fetch(`${h.base}/auth/github/callback?code=the-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookie(begin, OAUTH_STATE_COOKIE)! },
    });

    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      `${BASE_URL}/office/repofloor/repofloor`,
      "back to where the sign-in started",
    );

    const session = cookie(res, SESSION_COOKIE)!;
    assert.ok(session.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(!session.includes(USER_TOKEN), "the GitHub token is not in the cookie");
    assert.ok(cookieAttributes(res, SESSION_COOKIE).includes("HttpOnly"));
    assert.ok(cookieAttributes(res, OAUTH_STATE_COOKIE).includes("Max-Age=0"), "the state cookie is single-use");

    assert.equal(h.sessions.size, 1, "the token is held server-side");
    assert.deepEqual(h.gh.calls, [
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
  });
});

test("a signed-in browser reads a private office with nothing but its cookie", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    const session = await signInAs(h);

    assert.equal((await read(h.base)).status, 401, "and without the cookie it still cannot");

    const res = await read(h.base, { cookie: session });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { office: { id: string } }).office.id, "repofloor/repofloor");
    assert.deepEqual(
      h.access.asked.at(-1),
      { officeId: "repofloor/repofloor", token: USER_TOKEN },
      "the session's token is what GitHub is asked about — the same check as before",
    );
  });
});

test("a signed-in user GitHub refuses still gets the 404, because the session is not a permission", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    const session = await signInAs(h);
    h.access.allowedTokens.delete(USER_TOKEN);

    const res = await read(h.base, { cookie: session });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "unknown_office", officeId: "repofloor/repofloor" });
  });
});

test("an explicit Authorization header wins over the session", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    const session = await signInAs(h);

    const res = await read(h.base, { cookie: session, authorization: "Bearer gho_alice" });
    assert.equal(res.status, 200);
    assert.equal(h.access.asked.at(-1)?.token, "gho_alice", "a deliberate token is never silently ignored");
  });
});

test("the 401 on a private office points at the sign-in route when there is one", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    const res = await read(h.base);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: "authentication_required",
      officeId: "repofloor/repofloor",
      signIn: "/auth/github",
    });
  });
});

test("/auth/me says who is signed in and never leaks the token", async () => {
  await withServer(async (h) => {
    assert.equal((await fetch(`${h.base}/auth/me`)).status, 401);

    const session = await signInAs(h);
    const res = await fetch(`${h.base}/auth/me`, { headers: { cookie: session } });
    assert.equal(res.status, 200);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["login"], "aliosmanmho");
    assert.equal(body["id"], 7);
    assert.equal(body["avatarUrl"], "https://avatars.example/7");
    assert.ok(typeof body["expiresAt"] === "string");
    assert.ok(!JSON.stringify(body).includes(USER_TOKEN), "the token stays server-side");
  });
});

test("logging out destroys the session server-side, not just the cookie", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    const session = await signInAs(h);

    const res = await fetch(`${h.base}/auth/logout`, { method: "POST", headers: { cookie: session } });
    assert.equal(res.status, 200);
    assert.ok(cookieAttributes(res, SESSION_COOKIE).includes("Max-Age=0"));
    assert.equal(h.sessions.size, 0);

    // Replaying the old cookie proves the record is gone, not merely forgotten by the browser.
    assert.equal((await fetch(`${h.base}/auth/me`, { headers: { cookie: session } })).status, 401);
    assert.equal((await read(h.base, { cookie: session })).status, 401);
  });
});

test("a callback without the matching state cookie is refused", async () => {
  await withServer(async (h) => {
    const begin = await fetch(`${h.base}/auth/github`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = cookie(begin, OAUTH_STATE_COOKIE)!;

    const noCookie = await fetch(`${h.base}/auth/github/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    assert.equal(noCookie.status, 400);
    assert.deepEqual(await noCookie.json(), { error: "state_mismatch" }, "a forged callback has no cookie");

    const otherState = await fetch(`${h.base}/auth/github/callback?code=c&state=somebody-elses-state`, {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    assert.equal(otherState.status, 400);

    const tampered = await fetch(`${h.base}/auth/github/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}.not-a-signature` },
    });
    assert.equal(tampered.status, 400, "an unsigned state cookie is no state cookie");

    assert.equal(h.gh.calls.length, 0, "no code is ever exchanged for a refused callback");
    assert.equal(h.sessions.size, 0);
  });
});

test("a callback missing its parameters, or carrying GitHub's refusal, is refused", async () => {
  await withServer(async (h) => {
    const missing = await fetch(`${h.base}/auth/github/callback`, { redirect: "manual" });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "missing_code_or_state" });

    const denied = await fetch(`${h.base}/auth/github/callback?error=access_denied`, { redirect: "manual" });
    assert.equal(denied.status, 400);
    assert.deepEqual(await denied.json(), { error: "github_denied", detail: "access_denied" });
    assert.equal(h.sessions.size, 0);
  });
});

test("GitHub failing the exchange is a 502, not a half-open session", async () => {
  await withServer(async (h) => {
    h.gh.oauthError = "bad_verification_code";
    const begin = await fetch(`${h.base}/auth/github`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;

    const res = await fetch(`${h.base}/auth/github/callback?code=stale&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookie(begin, OAUTH_STATE_COOKIE)! },
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "github_unavailable" });
    assert.equal(h.sessions.size, 0, "no session without a user to attach it to");
  });
});

test("return_to cannot be turned into an open redirect", async () => {
  await withServer(async (h) => {
    for (const hostile of ["https://evil.example/", "//evil.example/", "/ok\r\nX: 1"]) {
      const begin = await fetch(`${h.base}/auth/github?return_to=${encodeURIComponent(hostile)}`, {
        redirect: "manual",
      });
      const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;

      const res = await fetch(`${h.base}/auth/github/callback?code=c&state=${encodeURIComponent(state)}`, {
        redirect: "manual",
        headers: { cookie: cookie(begin, OAUTH_STATE_COOKIE)! },
      });
      assert.equal(res.headers.get("location"), `${BASE_URL}/`, `${hostile} is not followed`);
    }
  });
});

test("the sign-in routes answer honestly about their methods", async () => {
  await withServer(async (h) => {
    assert.equal((await fetch(`${h.base}/auth/github`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${h.base}/auth/logout`)).status, 405, "logout is POST only");
    assert.equal((await fetch(`${h.base}/auth/nonsense`)).status, 404);
  });
});

test("without sign-in configured the routes say so instead of pretending to be missing", async () => {
  await withServer(
    async (h) => {
      for (const path of ["/auth/github", "/auth/me", "/auth/install", "/auth/install/callback"]) {
        const res = await fetch(`${h.base}${path}`, { redirect: "manual" });
        assert.equal(res.status, 501, `${path} is configuration, not a typo`);
        assert.deepEqual(await res.json(), { error: "sign_in_not_configured" });
      }

      // And the old path still works, unchanged.
      await deliver(h.base, "push", "d1", push(true));
      assert.equal((await read(h.base, { authorization: "Bearer gho_alice" })).status, 200);
      const anonymous = await read(h.base);
      assert.equal(anonymous.status, 401);
      assert.deepEqual(
        await anonymous.json(),
        { error: "authentication_required", officeId: "repofloor/repofloor" },
        "no sign-in hint when there is no sign-in",
      );
    },
    { signIn: false },
  );
});

test("a public office needs neither a token nor a session", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(false));
    assert.equal((await read(h.base)).status, 200);
    assert.equal(h.access.asked.length, 0, "and GitHub is not asked");
  });
});

test("a session cookie this server did not sign is ignored", async () => {
  await withServer(async (h) => {
    await deliver(h.base, "push", "d1", push(true));
    for (const forged of ["made-up-id", "made-up-id.and-a-signature", ""]) {
      const res = await read(h.base, { cookie: `${SESSION_COOKIE}=${forged}` });
      assert.equal(res.status, 401, `"${forged}" is not a session`);
    }
  });
});

test("the sign-in surface is announced on /healthz", async () => {
  await withServer(async (h) => {
    assert.equal(((await (await fetch(`${h.base}/healthz`)).json()) as { signIn: boolean }).signIn, true);
  });
  await withServer(
    async (h) => {
      assert.equal(((await (await fetch(`${h.base}/healthz`)).json()) as { signIn: boolean }).signIn, false);
    },
    { signIn: false },
  );
});
