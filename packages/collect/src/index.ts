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

export async function collect(opts: CollectOptions): Promise<OfficeState> {
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
  for (const c of arr(await get(`/repos/${full}/commits?since=${since.toISOString()}&per_page=100`))) {
    const co = o(c);
    const author = seen(co["author"]);
    const at = s(o(o(co["commit"])["author"])["date"], now.toISOString());
    if (author) ev(`c:${s(co["sha"])}`, at, { type: "push", actorId: author, branch: defaultBranch, commits: 1, url: s(co["html_url"]) });
  }

  // Open PRs + recently updated
  for (const p of arr(await get(`/repos/${full}/pulls?state=all&sort=updated&direction=desc&per_page=50`))) {
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
  for (const i of arr(await get(`/repos/${full}/issues?state=all&sort=updated&direction=desc&since=${since.toISOString()}&per_page=50`))) {
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

  return replay(state, [...upserts, ...events], now.toISOString());
}
