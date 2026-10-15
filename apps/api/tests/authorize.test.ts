/**
 * The shared office read check. `GET /office/...` and (next) a WebSocket connect both
 * go through this, so it is tested here on its own rather than only through HTTP.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { emptyOfficeState, type OfficeState } from "@repofloor/protocol";
import { authorizeOfficeRead, readCredential, type OfficeReadDeps } from "../src/authorize.ts";
import type { AccessDecision, RepoAccess } from "../src/access.ts";

const OFFICE = "repofloor/repofloor";

function state(isPrivate: boolean | undefined): OfficeState {
  return emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    {
      id: OFFICE,
      buildingId: "repofloor",
      name: "repofloor",
      ...(isPrivate === undefined ? {} : { private: isPrivate }),
    },
    "full",
  );
}

class FakeAccess implements RepoAccess {
  readonly asked: Array<string | undefined> = [];
  constructor(private readonly answer: (token: string | undefined) => AccessDecision) {}
  async canRead(_officeId: string, token: string | undefined): Promise<AccessDecision> {
    this.asked.push(token);
    return this.answer(token);
  }
  invalidateOffice(): void {}
}

const allowOnly = (allowed: string) =>
  new FakeAccess((token) =>
    token === undefined
      ? { allowed: false, reason: "unauthenticated" }
      : token === allowed
        ? { allowed: true, cached: false }
        : { allowed: false, reason: "forbidden", cached: false },
  );

const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as IncomingMessage;

function deps(
  stored: OfficeState | undefined,
  access: RepoAccess,
  sessionToken?: (req: IncomingMessage) => Promise<string | undefined>,
): OfficeReadDeps {
  return {
    store: { load: async () => stored },
    access,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

test("an office nobody has told us about is unknown, and GitHub is never asked", async () => {
  const access = allowOnly("gho_alice");
  const result = await authorizeOfficeRead(deps(undefined, access), OFFICE, req());
  assert.deepEqual(result, { ok: false, reason: "unknown_office" });
  assert.equal(access.asked.length, 0);
});

test("a public office is open, with no credential and no call to GitHub", async () => {
  const access = allowOnly("gho_alice");
  const result = await authorizeOfficeRead(deps(state(false), access), OFFICE, req());
  assert.equal(result.ok, true);
  assert.equal(access.asked.length, 0);
});

test("a private office with no credential asks for one", async () => {
  const result = await authorizeOfficeRead(deps(state(true), allowOnly("gho_alice")), OFFICE, req());
  assert.deepEqual(result, { ok: false, reason: "authentication_required" });
});

test("unknown visibility is treated as private", async () => {
  const access = allowOnly("gho_alice");
  const result = await authorizeOfficeRead(deps(state(undefined), access), OFFICE, req());
  assert.deepEqual(result, { ok: false, reason: "authentication_required" });
  assert.deepEqual(access.asked, [undefined]);
});

test("a bearer token GitHub accepts gets the snapshot", async () => {
  const result = await authorizeOfficeRead(
    deps(state(true), allowOnly("gho_alice")),
    OFFICE,
    req({ authorization: "Bearer gho_alice" }),
  );
  assert.equal(result.ok, true);
});

test("a token GitHub refuses is forbidden, not unknown — the caller flattens them", async () => {
  const result = await authorizeOfficeRead(
    deps(state(true), allowOnly("gho_alice")),
    OFFICE,
    req({ authorization: "Bearer gho_mallory" }),
  );
  assert.deepEqual(result, { ok: false, reason: "forbidden" });
});

test("GitHub being unreachable fails closed", async () => {
  const access = new FakeAccess(() => ({ allowed: false, reason: "unavailable" }));
  const result = await authorizeOfficeRead(
    deps(state(true), access),
    OFFICE,
    req({ authorization: "Bearer gho_alice" }),
  );
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("the session cookie is an identity when no header is present", async () => {
  const access = allowOnly("gho_session");
  const result = await authorizeOfficeRead(
    deps(state(true), access, async () => "gho_session"),
    OFFICE,
    req(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(access.asked, ["gho_session"]);
});

test("an explicit header wins over the session, so a deliberate token is never ignored", async () => {
  const access = allowOnly("gho_alice");
  const result = await authorizeOfficeRead(
    deps(state(true), access, async () => "gho_session"),
    OFFICE,
    req({ authorization: "Bearer gho_alice" }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(access.asked, ["gho_alice"]);
});

test("readCredential falls back to the session and tolerates there being none", async () => {
  assert.equal(await readCredential(req({ authorization: "Bearer gho_x" })), "gho_x");
  assert.equal(await readCredential(req()), undefined);
  assert.equal(await readCredential(req(), async () => "gho_s"), "gho_s");
});
