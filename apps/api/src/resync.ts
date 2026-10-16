/**
 * Periodic resync: rebuild an office from the GitHub REST API, as the App.
 *
 * Webhooks are a stream and streams have gaps. A delivery can fail while we are
 * restarting, GitHub can give up retrying, `pg_notify` drops anything sent while
 * nothing is listening, and an office created before the App was installed has no
 * history at all. Nothing in the system notices any of that, because a snapshot that
 * is quietly out of date looks exactly like a quiet repository.
 *
 * This is the repair. It does not diff and it does not reconcile: it fetches the whole
 * picture and replaces the snapshot, so whatever was missed stops mattering. That is
 * only safe because `collect` returns a complete `OfficeState` — the same function the
 * Lite action runs, shared rather than reimplemented (CLAUDE.md rule 1).
 *
 * It is also the only thing that uses the App identity for anything. Installation
 * tokens are minted from the private key, cached in memory and never written down.
 */

import { collect } from "@repofloor/collect";
import type { OfficeState } from "@repofloor/protocol";
import type { GitHubAppAuth } from "./app-auth.js";
import type { InstallationStore } from "./installations.js";
import { errorFields, silentLogger, type Logger } from "./log.js";
import type { EventPublisher } from "./publisher.js";
import type { OfficeStore } from "./store.js";

export const DEFAULT_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How far back a resync looks. Wider than any plausible delivery gap. */
export const DEFAULT_RESYNC_HOURS = 72;

export interface ResyncDeps {
  store: OfficeStore;
  publisher: EventPublisher;
  installations: InstallationStore;
  appAuth: GitHubAppAuth;
  logger?: Logger | undefined;
  apiUrl?: string | undefined;
  hours?: number | undefined;
  /** Injected in tests. */
  collectImpl?: typeof collect | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export type ResyncOutcome =
  | { status: "resynced"; officeId: string; actors: number }
  /** No installation covers this office's owner, so we cannot act as the App for it. */
  | { status: "no_installation"; officeId: string }
  | { status: "failed"; officeId: string; error: string };

/**
 * Rebuild one office. Returns rather than throws: a resync sweep must not stop at the
 * first repository whose installation was removed while we were not looking.
 */
export async function resyncOffice(officeId: string, deps: ResyncDeps): Promise<ResyncOutcome> {
  const log = deps.logger ?? silentLogger;
  const [owner, repo] = officeId.split("/");
  if (!owner || !repo) return { status: "failed", officeId, error: "malformed office id" };

  const installation = await deps.installations.byAccount(owner);
  if (!installation) return { status: "no_installation", officeId };

  try {
    const token = await deps.appAuth.installationToken(installation.installationId);
    const collector = deps.collectImpl ?? collect;
    const state: OfficeState = await collector({
      owner,
      repo,
      token,
      mode: "full",
      userAgent: "repofloor-api",
      hours: deps.hours ?? DEFAULT_RESYNC_HOURS,
      ...(deps.apiUrl ? { apiBase: deps.apiUrl } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    // Replace rather than merge. The point is to stop trusting what we accumulated.
    await deps.store.save(officeId, state);
    // Announced as a snapshot with no events: there is nothing to animate, because
    // what changed is "everything we thought we knew".
    await deps.publisher.publish({ officeId, events: [], state });

    log.info("office resynced", { officeId, actors: state.actors.length });
    return { status: "resynced", officeId, actors: state.actors.length };
  } catch (err) {
    log.warn("resync failed", { officeId, ...errorFields(err) });
    return { status: "failed", officeId, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Rebuild every office the store knows about, one at a time. */
export async function resyncAll(deps: ResyncDeps): Promise<ResyncOutcome[]> {
  const log = deps.logger ?? silentLogger;
  const officeIds = await deps.store.list();

  const outcomes: ResyncOutcome[] = [];
  // Sequential on purpose. A sweep is not urgent, and GitHub's secondary rate limits
  // are unkind to a burst of parallel requests from one installation.
  for (const officeId of officeIds) {
    outcomes.push(await resyncOffice(officeId, deps));
  }

  const resynced = outcomes.filter((o) => o.status === "resynced").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "no_installation").length;
  log.info("resync sweep finished", { offices: officeIds.length, resynced, failed, skipped });

  return outcomes;
}

export interface ResyncSchedule {
  stop(): void;
}

/**
 * Run a sweep every `intervalMs`. Not on startup: a restart is the moment the service
 * is least able to spare the requests, and the first sweep being an interval away is
 * no worse than the gap it exists to close.
 */
export function scheduleResync(deps: ResyncDeps, intervalMs = DEFAULT_RESYNC_INTERVAL_MS): ResyncSchedule {
  const log = deps.logger ?? silentLogger;
  let running = false;

  const timer = setInterval(() => {
    // Skip rather than queue: a sweep that outlasts its own interval means something
    // is slow, and stacking another one on top is how that becomes an outage.
    if (running) {
      log.warn("resync still running, skipping this round");
      return;
    }
    running = true;
    void resyncAll(deps)
      .catch((err: unknown) => log.error("resync sweep failed", errorFields(err)))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
