/**
 * Walking a repository's whole history, a batch at a time.
 *
 * `collect()` answers "what has happened lately": a window in hours, fetched in one go,
 * replayed into a snapshot. A backfill asks something different — "everything, from the
 * first commit" — and a repository with ten thousand commits cannot be fetched in one
 * request, one process lifetime, or one rate-limit budget. So this is a *stepper*: each
 * call does a bounded amount of work and hands back a cursor to resume from.
 *
 * Three resources, three paging behaviours, and the cursor has to survive all of them:
 *
 * - **Commits** come back newest-first and cannot be sorted. The cursor is `until`, a
 *   timestamp: each step asks for commits older than the oldest one it has seen. Stable
 *   under new pushes, because they land after the cursor, not before it.
 * - **Pull requests and issues** can be sorted by creation date ascending, so the cursor
 *   is a page number. Stable for the same reason: ascending by creation means anything
 *   new appends at the end, and the pages already walked do not shift.
 *
 * A page number would have been wrong for commits and a timestamp wrong for the others,
 * which is why the cursor is a small record rather than one value.
 *
 * Office-level, like everything in ADR 0003: there is no actor parameter here.
 */

import type { Actor, OfficeEvent } from "@repofloor/protocol";

export interface HistoryCursor {
  /** Fetch commits older than this. Absent on the first step: start from now. */
  commitsUntil?: string;
  /** Next page of pull requests, ascending by creation. 1-based; 0 means finished. */
  pullsPage: number;
  /** Next page of issues, same shape. */
  issuesPage: number;
}

export const FIRST_STEP: HistoryCursor = { pullsPage: 1, issuesPage: 1 };

export interface HistoryStepOptions {
  owner: string;
  repo: string;
  token: string;
  cursor?: HistoryCursor;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /**
   * How many API requests this step may spend. The point of a budget is that a step
   * returns rather than running until something kills it — a timeout mid-walk loses
   * the work, a budget hands back a cursor.
   */
  budget?: number;
}

export interface HistoryStep {
  events: OfficeEvent[];
  /** The actors the events refer to, so a caller can seed an office with them. */
  actors: Actor[];
  cursor: HistoryCursor;
  /** True when every resource has been walked to its end. */
  done: boolean;
  /** Requests actually spent, for logging and for pacing the next step. */
  spent: number;
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const PER_PAGE = 100;
const DEFAULT_BUDGET = 12;

/**
 * One bounded step of a backfill.
 *
 * Returns the events found, the actors they mention, and where to resume. Call it again
 * with `step.cursor` until `step.done`.
 */
export async function historyStep(opts: HistoryStepOptions): Promise<HistoryStep> {
  const api = opts.apiBase ?? "https://api.github.com";
  const f = opts.fetchImpl ?? fetch;
  const cursor: HistoryCursor = { ...FIRST_STEP, ...opts.cursor };
  let budget = opts.budget ?? DEFAULT_BUDGET;

  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": opts.userAgent ?? "repofloor-backfill",
  };

  let spent = 0;
  const get = async (path: string): Promise<unknown[]> => {
    budget -= 1;
    spent += 1;
    const r = await f(`${api}${path}`, { headers });
    // A repository with no commits yet answers 409; an absent resource 404. Neither is
    // a failed backfill — there is simply nothing of that kind to walk.
    if (r.status === 404 || r.status === 409) return [];
    if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}`);
    return arr(await r.json());
  };

  const full = `${opts.owner}/${opts.repo}`;

  // Check the repository exists before walking it.
  //
  // Every endpoint below answers 404 for a repository that is gone, renamed, or that
  // this token cannot see — and `get` turns a 404 into an empty page, which is right for
  // "no commits yet" and wrong here. Without this a missing repository walks to
  // completion in three requests and is marked fully backfilled, which is the same
  // mistake `collect` made by blanking an office, wearing different clothes.
  const probe = await f(`${api}/repos/${full}`, { headers });
  spent += 1;
  if (!probe.ok) throw new Error(`GitHub API ${probe.status} for /repos/${full}`);
  budget -= 1;

  const events: OfficeEvent[] = [];
  const actors = new Map<string, Actor>();

  const seen = (user: unknown): string => {
    const login = s(o(user)["login"]);
    if (!login) return "";
    if (!actors.has(login)) {
      actors.set(login, {
        id: login,
        kind: login.endsWith("[bot]") ? "bot" : "human",
        name: login,
        ...(s(o(user)["avatar_url"]) ? { avatarUrl: s(o(user)["avatar_url"]) } : {}),
      });
    }
    return login;
  };

  // ── commits, walking backwards ────────────────────────────────────────────
  let commitsDone = cursor.commitsUntil === "";
  while (!commitsDone && budget > 0) {
    const until = cursor.commitsUntil ? `&until=${encodeURIComponent(cursor.commitsUntil)}` : "";
    const page = await get(`/repos/${full}/commits?per_page=${PER_PAGE}${until}`);
    if (page.length === 0) {
      commitsDone = true;
      break;
    }

    let oldest: string | undefined;
    for (const c of page) {
      const co = o(c);
      const at = s(o(o(co["commit"])["author"])["date"]);
      const sha = s(co["sha"]);
      if (!at || !sha) continue;
      // `until` is inclusive, so the boundary commit comes back again on the next
      // step. The event id is the sha, and the store drops duplicates on it.
      const author = seen(co["author"]);
      if (author) {
        events.push({
          id: `c:${sha}`,
          at,
          officeId: full,
          type: "push",
          actorId: author,
          branch: "main",
          commits: 1,
          ...(s(co["html_url"]) ? { url: s(co["html_url"]) } : {}),
        });
      }
      if (!oldest || Date.parse(at) < Date.parse(oldest)) oldest = at;
    }

    // No progress means we are at the first commit: asking again would loop forever.
    if (!oldest || oldest === cursor.commitsUntil) {
      commitsDone = true;
      break;
    }
    cursor.commitsUntil = oldest;
    if (page.length < PER_PAGE) commitsDone = true;
  }
  if (commitsDone) cursor.commitsUntil = "";

  // ── pull requests, ascending by creation ──────────────────────────────────
  while (cursor.pullsPage > 0 && budget > 0) {
    const page = await get(
      `/repos/${full}/pulls?state=all&sort=created&direction=asc&per_page=${PER_PAGE}&page=${cursor.pullsPage}`,
    );
    for (const p of page) {
      const po = o(p);
      const number = n(po["number"]);
      const author = seen(po["user"]);
      const createdAt = s(po["created_at"]);
      if (!number || !createdAt) continue;

      events.push({
        id: `pr:${number}:opened`,
        at: createdAt,
        officeId: full,
        type: "pr.opened",
        pr: {
          number,
          title: s(po["title"]),
          authorId: author,
          url: s(po["html_url"]),
          draft: po["draft"] === true,
          reviewerIds: arr(po["requested_reviewers"]).map(seen).filter(Boolean),
          updatedAt: s(po["updated_at"], createdAt),
        },
      });

      // The close is its own moment, which is the whole point of a history.
      const merged = s(po["merged_at"]);
      const closed = s(po["closed_at"]);
      if (merged) {
        events.push({ id: `pr:${number}:merged`, at: merged, officeId: full, type: "pr.merged", number, actorId: author });
      } else if (closed) {
        events.push({ id: `pr:${number}:closed`, at: closed, officeId: full, type: "pr.closed", number });
      }
    }
    cursor.pullsPage = page.length < PER_PAGE ? 0 : cursor.pullsPage + 1;
  }

  // ── issues, ascending by creation ─────────────────────────────────────────
  while (cursor.issuesPage > 0 && budget > 0) {
    const page = await get(
      `/repos/${full}/issues?state=all&sort=created&direction=asc&per_page=${PER_PAGE}&page=${cursor.issuesPage}`,
    );
    for (const i of page) {
      const io = o(i);
      // The issues endpoint returns pull requests too; they are already covered above.
      if (io["pull_request"]) continue;
      const number = n(io["number"]);
      const author = seen(io["user"]);
      const createdAt = s(io["created_at"]);
      if (!number || !createdAt) continue;

      events.push({
        id: `issue:${number}:opened`,
        at: createdAt,
        officeId: full,
        type: "issue.opened",
        actorId: author,
        issue: {
          number,
          title: s(io["title"]),
          url: s(io["html_url"]),
          assigneeIds: arr(io["assignees"]).map(seen).filter(Boolean),
          updatedAt: s(io["updated_at"], createdAt),
        },
      });

      const closed = s(io["closed_at"]);
      if (closed) {
        events.push({ id: `issue:${number}:closed`, at: closed, officeId: full, type: "issue.closed", number, actorId: author });
      }
    }
    cursor.issuesPage = page.length < PER_PAGE ? 0 : cursor.issuesPage + 1;
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    events,
    actors: [...actors.values()],
    cursor,
    done: commitsDone && cursor.pullsPage === 0 && cursor.issuesPage === 0,
    spent,
  };
}
