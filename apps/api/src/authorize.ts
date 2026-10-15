/**
 * "May this request read this office?" — in one place, because it is about to be
 * asked from two.
 *
 * `GET /office/:owner/:repo` asks it per request. `apps/realtime` must ask the *same*
 * question when a WebSocket connects, and a socket that is cheaper to open than a GET
 * is a hole, not a feature. So the check lives here rather than inside the HTTP
 * handler, and it takes an `IncomingMessage` — which an upgrade request also is.
 *
 * It is still not a second ACL (CLAUDE.md rule 6): every answer below comes from the
 * snapshot's own `office.private` or from `RepoAccess`, which asks GitHub. Nothing
 * here records who may read what.
 */

import type { IncomingMessage } from "node:http";
import type { OfficeState } from "@repofloor/protocol";
import { bearerToken, type RepoAccess } from "./access.js";
import type { OfficeStore } from "./store.js";

export type OfficeReadResult =
  | { ok: true; state: OfficeState }
  /** No such office, or we were never told one exists. */
  | { ok: false; reason: "unknown_office" }
  /** Private office, no credential presented at all. */
  | { ok: false; reason: "authentication_required" }
  /** A credential was presented and GitHub says it cannot see the repository. */
  | { ok: false; reason: "forbidden" }
  /** GitHub could not be asked. We fail closed rather than guess. */
  | { ok: false; reason: "unavailable" };

export interface OfficeReadDeps {
  store: Pick<OfficeStore, "load">;
  access: RepoAccess;
  /**
   * Resolves a session cookie to the GitHub token it stands for. Absent when sign-in
   * is not configured, in which case only the `Authorization` header is an identity.
   */
  sessionToken?: ((req: IncomingMessage) => Promise<string | undefined>) | undefined;
}

/**
 * The credential to authorize with: an explicit `Authorization: Bearer <token>` first,
 * the session cookie second. The header wins so a deliberate token is never silently
 * ignored in favour of whoever happens to be signed in in that browser.
 */
export async function readCredential(
  req: IncomingMessage,
  sessionToken?: ((req: IncomingMessage) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  return bearerToken(req.headers.authorization) ?? (await sessionToken?.(req));
}

/**
 * Load the office and decide whether this request may have it.
 *
 * Public offices are open — an office is public exactly when a *signed* delivery said
 * so (`office.private === false`). Anything else, an office whose visibility we have
 * never been told included, needs a token GitHub accepts for that repository.
 *
 * Callers must not distinguish `unknown_office` from `forbidden` to the outside:
 * whether a private repository exists is itself private. They are separate here only
 * so each caller can log and count them.
 */
export async function authorizeOfficeRead(
  deps: OfficeReadDeps,
  officeId: string,
  req: IncomingMessage,
): Promise<OfficeReadResult> {
  const state = await deps.store.load(officeId);
  if (!state) return { ok: false, reason: "unknown_office" };
  if (state.office.private === false) return { ok: true, state };

  const token = await readCredential(req, deps.sessionToken);
  const decision = await deps.access.canRead(officeId, token);
  if (decision.allowed) return { ok: true, state };
  // "unauthenticated" is renamed on the way out: at this layer it means "ask the
  // caller for a credential", which is a different instruction from "denied".
  if (decision.reason === "unauthenticated") return { ok: false, reason: "authentication_required" };
  return { ok: false, reason: decision.reason };
}

/** One row of `GET /offices`: enough to draw a list, never the whole snapshot. */
export interface OfficeSummary {
  officeId: string;
  name: string;
  buildingId: string;
  private: boolean | undefined;
  /** When the snapshot was last generated. */
  generatedAt: string;
  actors: number;
}

export interface OfficeListing {
  offices: OfficeSummary[];
  /**
   * True when at least one office was left out because GitHub could not be asked
   * about it. The listing is then shorter than the truth, and saying so is better
   * than letting a caller read absence as "no access".
   */
  partial: boolean;
}

export interface OfficeListDeps extends OfficeReadDeps {
  store: Pick<OfficeStore, "load" | "list">;
}

/**
 * Every office this request may see.
 *
 * The same rule as a single read, applied per office: public ones are listed for
 * anyone, private ones only when GitHub says this caller can see the repository. An
 * anonymous caller skips the private ones without a single API call, because there is
 * no credential to ask about — which is also what keeps an unauthenticated `GET
 * /offices` from being a way to make us hammer GitHub.
 *
 * Checks run one at a time and `RepoAccess` caches them. That is fine at today's
 * scale and will not be at a thousand offices; the fix then is a cursor on this
 * route, not a permissions table (CLAUDE.md rule 6).
 */
export async function listReadableOffices(
  deps: OfficeListDeps,
  req: IncomingMessage,
): Promise<OfficeListing> {
  const ids = await deps.store.list();
  const token = await readCredential(req, deps.sessionToken);

  const offices: OfficeSummary[] = [];
  let partial = false;

  for (const officeId of ids) {
    const state = await deps.store.load(officeId);
    if (!state) continue;

    if (state.office.private !== false) {
      if (token === undefined) continue;
      const decision = await deps.access.canRead(officeId, token);
      if (!decision.allowed) {
        if (decision.reason === "unavailable") partial = true;
        continue;
      }
    }

    offices.push({
      officeId,
      name: state.office.name,
      buildingId: state.office.buildingId,
      private: state.office.private,
      generatedAt: state.generatedAt,
      actors: state.actors.length,
    });
  }

  return { offices, partial };
}
