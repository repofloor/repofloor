/**
 * Collects recent repository activity through the GitHub REST API and turns it into
 * OfficeEvents, then replays them into an OfficeState snapshot.
 *
 * Two callers, deliberately one implementation (CLAUDE.md rule 1 — Lite and Full must
 * not fork):
 *
 * - the Lite action, inside a GitHub Action with the default `GITHUB_TOKEN`;
 * - Full mode's periodic resync, with an installation token minted from the App.
 *
 * Both read the same public-ish data (commits, PRs, issues, workflow runs,
 * contributors) and get back a whole snapshot rather than a diff, which is what makes
 * this usable as a repair: whatever a deployment missed, a resync lands on the truth.
 */

import { emptyOfficeState, type OfficeEvent, type OfficeState, type Actor } from "@repofloor/protocol";
import { replay } from "@repofloor/reducer";

/**
 * How many pages any one list will follow. A guard against an unbounded fetch on a
 * repository with years of history, not a view on how much is interesting: at this
 * depth the office already has far more than it can draw.
 */
export const MAX_PAGES = 10;

export interface CollectOptions {
  owner: string;
  repo: string;
  token: string;
  /** Look-back window in hours. */
  hours?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /**
   * What the snapshot says it is. Lite has no live presence and the engine reads this
   * to know what to expect, so a resync for Full mode must not claim to be Lite.
   */
  mode?: OfficeState["mode"];
  /** Sent as `User-Agent`; GitHub asks for one that identifies the caller. */
  userAgent?: string;
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const login = (u: unknown): string => s(o(u)["login"]);

/**
 * The snapshot *and* the events that produced it.
 *
 * `collect` has always built the events and then thrown them away, which was fine while
 * the only question was "what does the office look like now". History asks "what did it
 * look like then", and the answer is these, replayed to that moment (ADR 0003).
 *
 * The events are returned in the order `replay` sorted them, so a caller can feed them
 * back in without re-sorting and get exactly the same states along the way.
 */
export interface Collected {
  state: OfficeState;
  events: OfficeEvent[];
}

/** The snapshot alone. What most callers want, and what this has always returned. */
export async function collect(opts: CollectOptions): Promise<OfficeState> {
  return (await collectWithEvents(opts)).state;
}

export async function collectWithEvents(opts: CollectOptions): Promise<Collected> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.hours ?? 48) * 3600_000);
  const api = opts.apiBase ?? "https://api.github.com";
  const f = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": opts.userAgent ?? "repofloor-lite",
  };
  const get = async (path: string): Promise<unknown> => {
    const r = await f(`${api}${path}`, { headers });
    if (r.status === 404 || r.status === 409) return [];
    if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}`);
    return r.json();
  };

  /**
   * Follow pages until one comes back short, or until `stop` says the rest cannot
   * matter, or until `maxPages`.
   *
   * Without this a busy repository is silently truncated: the first page of commits is
   * 100, and a repository that pushed more than that inside the look-back window simply
   * lost the rest — with no error, and a floor that looked merely quiet.
   *
   * `maxPages` is a stop against an unbounded fetch, not a product decision. Past it
   * the office has far more than it can draw anyway.
   */
  const getPages = async (
    path: string,
    perPage: number,
    stop?: (page: unknown[]) => boolean,
    maxPages = MAX_PAGES,
  ): Promise<unknown[]> => {
    const all: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const join = path.includes("?") ? "&" : "?";
      const items = arr(await get(`${path}${join}per_page=${perPage}&page=${page}`));
      all.push(...items);
      // A short page is the last page; GitHub does not say so any other way here.
      if (items.length < perPage) break;
      if (stop?.(items)) break;
    }
    return all;
  };

  const full = `${opts.owner}/${opts.repo}`;
  // The repository itself is fetched strictly. `get` turns a 404 into an empty list,
  // which is right for a sub-resource — no commits yet, no contributors, a 409 for an
  // empty repo — and wrong here: a repository that is gone, renamed, or that this
  // token cannot see would otherwise produce a valid, empty snapshot. Full mode's
  // resync replaces what it has with what it collects, so that silently blanks a real
  // office. Failing is what leaves the old snapshot alone.
  const repoResponse = await f(`${api}/repos/${full}`, { headers });
  if (!repoResponse.ok) throw new Error(`GitHub API ${repoResponse.status} for /repos/${full}`);
  const repo = o(await repoResponse.json());
  const ownerObj = o(repo["owner"]);
  const defaultBranch = s(repo["default_branch"], "main");

  const state = emptyOfficeState(
    {
      id: opts.owner,
      name: opts.owner,
      kind: s(ownerObj["type"]) === "Organization" ? "organization" : "user",
      avatarUrl: s(ownerObj["avatar_url"]),
    },
    {
      id: full,
      buildingId: opts.owner,
      name: opts.repo,
      description: s(repo["description"]),
      defaultBranch,
      private: repo["private"] === true,
    },
    opts.mode ?? "lite",
  );

  const events: OfficeEvent[] = [];
  const actors = new Map<string, Actor>();
  type Body = OfficeEvent extends infer E ? (E extends OfficeEvent ? Omit<E, "id" | "at" | "officeId"> : never) : never;
  const ev = (id: string, at: string, e: Body) => {
    events.push({ id, at, officeId: full, ...e } as OfficeEvent);
  };
  const seen = (u: unknown) => {
    const id = login(u);
    if (!id) return "";
    if (!actors.has(id)) {
      actors.set(id, {
        id,
        kind: id.endsWith("[bot]") ? "bot" : "human",
        name: id,
        avatarUrl: s(o(u)["avatar_url"]),
      });
    }
    return id;
  };

  // Contributors → everyone gets a desk (even if quiet lately)
  for (const c of arr(await get(`/repos/${full}/contributors?per_page=30`))) seen(c);

  // Commits on default branch
  // `since` bounds this server-side, so pagination ends on its own; MAX_PAGES is only
  // the guard. A repository pushing more than a hundred commits in the window used to
  // lose everything past the first page.
  for (const c of await getPages(`/repos/${full}/commits?since=${since.toISOString()}`, 100)) {
    const co = o(c);
    const author = seen(co["author"]);
    const at = s(o(o(co["commit"])["author"])["date"], now.toISOString());
    if (author) ev(`c:${s(co["sha"])}`, at, { type: "push", actorId: author, branch: defaultBranch, commits: 1, url: s(co["html_url"]) });
  }

  // Open PRs, and closed ones touched inside the window.
  //
  // Two queries rather than one `state=all`, because the two have different stopping
  // rules and one query cannot honour both. An open PR belongs on the floor however
  // old it is — someone is still waiting on it — while a closed one only matters if
  // something happened to it recently. Asking for `state=all` sorted by `updated` and
  // taking the first page meant an open PR nobody had touched in a while fell off the
  // end, on exactly the repositories busy enough for that to matter.
  const openPulls = await getPages(`/repos/${full}/pulls?state=open&sort=updated&direction=desc`, 50);
  const closedPulls = await getPages(
    `/repos/${full}/pulls?state=closed&sort=updated&direction=desc`,
    50,
    // Sorted newest-first, so once a whole page predates the window, so does the rest.
    (page) => page.every((p) => Date.parse(s(o(p)["updated_at"])) < since.getTime()),
  );

  for (const p of [...openPulls, ...closedPulls]) {
    const po = o(p);
    const updated = s(po["updated_at"]);
    if (Date.parse(updated) < since.getTime() && s(po["state"]) !== "open") continue;
    const author = seen(po["user"]);
    const reviewerIds = arr(po["requested_reviewers"]).map(seen).filter(Boolean);
    const pr = {
      number: n(po["number"]),
      title: s(po["title"]),
      authorId: author,
      url: s(po["html_url"]),
      draft: po["draft"] === true,
      reviewerIds,
      updatedAt: updated,
    };
    const branch = s(o(po["head"])["ref"]);
    if (po["merged_at"]) {
      ev(`pr:${pr.number}:open`, s(po["created_at"]), { type: "pr.opened", pr });
      ev(`pr:${pr.number}:merged`, s(po["merged_at"]), { type: "pr.merged", number: pr.number, actorId: author });
    } else if (s(po["state"]) === "open") {
      ev(`pr:${pr.number}:open`, updated, { type: "pr.opened", pr });
      if (author) ev(`pr:${pr.number}:push`, updated, { type: "push", actorId: author, branch, commits: 0, url: pr.url });
    }
  }

  // Issues (not PRs) updated recently
  // Issues take `since` as a parameter too, so the same applies.
  for (const i of await getPages(`/repos/${full}/issues?state=all&sort=updated&direction=desc&since=${since.toISOString()}`, 50)) {
    const io = o(i);
    if (io["pull_request"]) continue;
    const author = seen(io["user"]);
    const issue = {
      number: n(io["number"]),
      title: s(io["title"]),
      assigneeIds: arr(io["assignees"]).map(seen).filter(Boolean),
      url: s(io["html_url"]),
      updatedAt: s(io["updated_at"]),
    };
    if (s(io["state"]) === "open") ev(`i:${issue.number}`, s(io["updated_at"]), { type: "issue.opened", issue, actorId: author });
    else ev(`i:${issue.number}:closed`, s(io["closed_at"], s(io["updated_at"])), { type: "issue.closed", number: issue.number, actorId: author });
  }

  // Latest workflow runs → CI status
  const runs = arr(o(await get(`/repos/${full}/actions/runs?per_page=20`))["workflow_runs"]);
  for (const r of runs) {
    const ro = o(r);
    const status = s(ro["status"]);
    const conclusion = s(ro["conclusion"]);
    const ci = status === "in_progress" ? "running" : status === "queued" ? "queued" : conclusion === "success" ? "success" : conclusion === "cancelled" ? "cancelled" : conclusion ? "failure" : "queued";
    const actor = seen(ro["actor"]);
    ev(`run:${n(ro["id"])}`, s(ro["updated_at"], now.toISOString()), {
      type: "ci.status",
      status: ci,
      branch: s(ro["head_branch"]),
      url: s(ro["html_url"]),
      ...(actor ? { actorId: actor } : {}),
    });
  }

  // Register actors first so avatars/names are known before activity
  const upserts: OfficeEvent[] = [...actors.values()].map((actor) => ({
    id: `actor:${actor.id}`,
    at: since.toISOString(),
    officeId: full,
    type: "actor.upsert",
    actor,
  }));

  // Sorted here rather than inside replay, so the caller gets back exactly the order
  // the states were produced in and can replay them without re-deriving it.
  const all = [...upserts, ...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { state: replay(state, all, now.toISOString()), events: all };
}
