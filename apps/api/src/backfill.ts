/**
 * Walking an office's whole history into the event store, a step at a time.
 *
 * The resync (2D-3) rebuilds an office from the last few days and replaces its
 * snapshot. This is the other direction: it reaches backwards to the first commit and
 * *adds* to the history, so the office can be replayed from the beginning (ADR 0003).
 *
 * It is a stepper because it has to be. A repository with ten thousand commits is
 * hundreds of API requests; doing that in one go means a job that can be killed
 * halfway and has nothing to show for it. Each step spends a bounded budget, stores
 * what it found, and writes where it stopped.
 *
 * Office-level, like the rest of ADR 0003: no actor parameter reaches here.
 */

import { historyStep, FIRST_STEP, type HistoryCursor } from "@repofloor/collect";
import type { Actor, OfficeEvent } from "@repofloor/protocol";
import type { GitHubAppAuth } from "./app-auth.js";
import type { InstallationStore } from "./installations.js";
import { errorFields, silentLogger, type Logger } from "./log.js";
import type { Queryable } from "./db.js";
import type { OfficeStore } from "./store.js";

/** How often a step runs. Slow on purpose: a backfill is never urgent. */
export const DEFAULT_BACKFILL_INTERVAL_MS = 60_000;
/** Requests one step may spend. Small enough that a sweep never dominates the limit. */
export const DEFAULT_BACKFILL_BUDGET = 12;

export interface BackfillRecord {
  officeId: string;
  cursor: HistoryCursor;
  done: boolean;
  spent: number;
}

/**
 * Where each office's walk got to. Separate from `OfficeStore` because it is a
 * different concern with a different lifetime — the same reason `InstallationStore` is
 * its own thing.
 */
export interface BackfillStore {
  get(officeId: string): Promise<BackfillRecord | undefined>;
  save(record: BackfillRecord): Promise<void>;
  /** An office still to walk, least recently touched first. */
  next(): Promise<BackfillRecord | undefined>;
}

export interface BackfillDeps {
  store: OfficeStore;
  backfills: BackfillStore;
  installations: InstallationStore;
  appAuth: GitHubAppAuth;
  logger?: Logger | undefined;
  apiUrl?: string | undefined;
  budget?: number | undefined;
  stepImpl?: typeof historyStep | undefined;
}

export type BackfillOutcome =
  | { status: "progressed"; officeId: string; events: number; done: boolean }
  | { status: "no_installation"; officeId: string }
  | { status: "failed"; officeId: string; error: string };

/**
 * Actors arrive as a side-channel from the walk rather than as events, so they are
 * turned into `actor.upsert`s here — timestamped at the earliest event in the batch,
 * so that replaying to any point after it finds the person already named.
 *
 * Without this the reducer still creates them, from the ids in the events, but with no
 * display name and no avatar: a floor of logins.
 */
function actorEvents(officeId: string, actors: Actor[], events: OfficeEvent[]): OfficeEvent[] {
  if (actors.length === 0) return [];
  const earliest = events.reduce<string | undefined>(
    (min, e) => (min === undefined || Date.parse(e.at) < Date.parse(min) ? e.at : min),
    undefined,
  );
  if (!earliest) return [];
  return actors.map((actor) => ({
    id: `backfill:actor:${officeId}:${actor.id}`,
    at: earliest,
    officeId,
    type: "actor.upsert" as const,
    actor,
  }));
}

/** One bounded step for one office. Returns rather than throws, so a sweep continues. */
export async function backfillStep(officeId: string, deps: BackfillDeps): Promise<BackfillOutcome> {
  const log = deps.logger ?? silentLogger;
  const [owner, repo] = officeId.split("/");
  if (!owner || !repo) return { status: "failed", officeId, error: "malformed office id" };

  const installation = await deps.installations.byAccount(owner);
  if (!installation) return { status: "no_installation", officeId };

  const record = (await deps.backfills.get(officeId)) ?? { officeId, cursor: FIRST_STEP, done: false, spent: 0 };
  if (record.done) return { status: "progressed", officeId, events: 0, done: true };

  try {
    const token = await deps.appAuth.installationToken(installation.installationId);
    const step = await (deps.stepImpl ?? historyStep)({
      owner,
      repo,
      token,
      cursor: record.cursor,
      budget: deps.budget ?? DEFAULT_BACKFILL_BUDGET,
      userAgent: "repofloor-backfill",
      ...(deps.apiUrl ? { apiBase: deps.apiUrl } : {}),
    });

    // Events first, cursor second. Crashing in between means the next step re-walks
    // ground it already covered, which the event-id conflict makes harmless; the
    // other order would silently skip it.
    const all = [...actorEvents(officeId, step.actors, step.events), ...step.events];
    if (all.length > 0) await deps.store.appendEvents(officeId, all);
    await deps.backfills.save({
      officeId,
      cursor: step.cursor,
      done: step.done,
      spent: record.spent + step.spent,
    });

    log.info("backfill step", {
      officeId,
      events: all.length,
      spent: step.spent,
      totalSpent: record.spent + step.spent,
      done: step.done,
    });
    return { status: "progressed", officeId, events: all.length, done: step.done };
  } catch (err) {
    // Yield the turn without advancing the cursor.
    //
    // Not advancing is the point: the step stored nothing, so moving past it would
    // leave a hole nothing would ever report. But writing *nothing* starves the
    // queue — `next()` orders by when a row was last touched, and an office with no row
    // is always first, so one permanently broken repository took every turn forever
    // and the healthy ones were never walked. Found by watching exactly that happen.
    await deps.backfills
      .save({ officeId, cursor: record.cursor, done: false, spent: record.spent })
      .catch(() => {});
    log.warn("backfill step failed", { officeId, ...errorFields(err) });
    return { status: "failed", officeId, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BackfillSchedule {
  stop(): void;
}

/**
 * Step whichever office is least recently touched and not finished, on a timer.
 *
 * One office per tick rather than a sweep: a backfill competes with live deliveries
 * for the same rate limit, and the live path is the one anyone is watching.
 */
export function scheduleBackfill(deps: BackfillDeps, intervalMs = DEFAULT_BACKFILL_INTERVAL_MS): BackfillSchedule {
  const log = deps.logger ?? silentLogger;
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // a slow step is not a reason to start another
    running = true;
    void (async () => {
      const record = await deps.backfills.next();
      if (!record) return; // nothing left to walk
      await backfillStep(record.officeId, deps);
    })()
      .catch((err: unknown) => log.error("backfill tick failed", errorFields(err)))
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

/** Process-local backfill state. The default when there is no database. */
export class InMemoryBackfillStore implements BackfillStore {
  readonly #records = new Map<string, BackfillRecord>();

  async get(officeId: string): Promise<BackfillRecord | undefined> {
    return this.#records.get(officeId);
  }

  async save(record: BackfillRecord): Promise<void> {
    this.#records.set(record.officeId, { ...record });
  }

  async next(): Promise<BackfillRecord | undefined> {
    for (const record of this.#records.values()) if (!record.done) return record;
    return undefined;
  }

  /** Offices the scheduler has not been told about yet get walked from the start. */
  async enqueue(officeId: string): Promise<void> {
    if (this.#records.has(officeId)) return;
    await this.save({ officeId, cursor: FIRST_STEP, done: false, spent: 0 });
  }
}

/** `BackfillStore` on plain Postgres (ADR 0001: plain SQL, no extension). */
export class PostgresBackfillStore implements BackfillStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(officeId: string): Promise<BackfillRecord | undefined> {
    const { rows } = await this.#db.query<{ cursor: HistoryCursor; done: boolean; spent: number }>(
      "select cursor, done, spent from backfill_state where office_id = $1",
      [officeId],
    );
    const row = rows[0];
    return row ? { officeId, cursor: row.cursor, done: row.done, spent: row.spent } : undefined;
  }

  async save(record: BackfillRecord): Promise<void> {
    await this.#db.query(
      `insert into backfill_state (office_id, cursor, done, spent)
            values ($1, $2, $3, $4)
       on conflict (office_id)
       do update set cursor = excluded.cursor, done = excluded.done,
                     spent = excluded.spent, updated_at = now()`,
      [record.officeId, JSON.stringify(record.cursor), record.done, record.spent],
    );
  }

  /**
   * An office still to walk, least recently touched first, so a slow repository
   * cannot starve the others.
   *
   * An office with no row yet is picked up too: `offices` is the list of what exists,
   * and anything in it without backfill state has never been walked.
   */
  async next(): Promise<BackfillRecord | undefined> {
    const { rows } = await this.#db.query<{ office_id: string; cursor: HistoryCursor | null; spent: number | null }>(
      `select o.office_id, b.cursor, b.spent
         from offices o
         left join backfill_state b on b.office_id = o.office_id
        where b.office_id is null or b.done = false
        order by b.updated_at asc nulls first
        limit 1`,
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      officeId: row.office_id,
      cursor: row.cursor ?? FIRST_STEP,
      done: false,
      spent: row.spent ?? 0,
    };
  }
}
