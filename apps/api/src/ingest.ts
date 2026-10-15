/**
 * Webhook → OfficeEvent[] → OfficeState.
 *
 * The conversion itself is `githubToEvents` from `@repofloor/reducer`, and the state
 * change is `reduce` — the same pure functions the Lite action and the browser run.
 * This file only wires them to storage and publishing.
 */

import { emptyOfficeState, type Building, type Office, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { githubToEvents, reduce, type GithubWebhook } from "@repofloor/reducer";
import type { OfficeStore } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import { KeyedQueue } from "./serialize.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The `repository` block of any repo-scoped webhook identifies both the office and the
 * building it belongs to. Returns undefined for payloads without one (`ping`,
 * org-level events), which the caller treats as "nothing to ingest".
 */
export function officeFromPayload(payload: Obj): { building: Building; office: Office } | undefined {
  const repo = obj(payload["repository"]);
  const fullName = str(repo["full_name"]);
  const owner = obj(repo["owner"]);
  const ownerLogin = str(owner["login"]) || fullName.split("/")[0] || "";
  if (!fullName || !ownerLogin) return undefined;

  const ownerAvatar = str(owner["avatar_url"]);
  const building: Building = {
    id: ownerLogin,
    name: ownerLogin,
    kind: str(owner["type"]) === "Organization" ? "organization" : "user",
    ...(ownerAvatar ? { avatarUrl: ownerAvatar } : {}),
  };

  const description = str(repo["description"]);
  const defaultBranch = str(repo["default_branch"]);
  const office: Office = {
    id: fullName,
    buildingId: ownerLogin,
    name: str(repo["name"]) || fullName,
    ...(description ? { description } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(typeof repo["private"] === "boolean" ? { private: repo["private"] } : {}),
  };

  return { building, office };
}

export interface IngestResult {
  /** "owner/repo", or undefined when the delivery carried no repository. */
  officeId?: string;
  /** Events the webhook produced. */
  events: OfficeEvent[];
  /** Events actually applied — the rest were duplicate deliveries. */
  applied: OfficeEvent[];
  /** The snapshot after applying, when anything was applied. */
  state?: OfficeState;
}

export interface IngestDeps {
  store: OfficeStore;
  publisher: EventPublisher;
  /** Serializes deliveries per office; one per store is created on demand. */
  queue?: KeyedQueue;
}

/**
 * The queue belongs to the store it protects, so a direct `ingestWebhook` call is as
 * safe as one through the HTTP handler and two stores never block each other.
 */
const queues = new WeakMap<OfficeStore, KeyedQueue>();

function queueFor(store: OfficeStore): KeyedQueue {
  let queue = queues.get(store);
  if (!queue) {
    queue = new KeyedQueue();
    queues.set(store, queue);
  }
  return queue;
}

/**
 * Convert one verified delivery, apply it to the office snapshot and publish.
 * Re-deliveries are dropped: event ids are derived from the delivery id, so applying
 * the same delivery twice is a no-op. Deliveries for the same office are serialized.
 */
export async function ingestWebhook(hook: GithubWebhook, deps: IngestDeps): Promise<IngestResult> {
  const payload = obj(hook.payload);
  const identity = officeFromPayload(payload);
  if (!identity) return { events: [], applied: [] };

  // One office is written by one delivery at a time: the loop below reads a snapshot
  // and writes it back, so overlapping deliveries would lose each other's events.
  const queue = deps.queue ?? queueFor(deps.store);
  return queue.run(identity.office.id, () => applyDelivery(hook, identity, deps));
}

async function applyDelivery(
  hook: GithubWebhook,
  identity: { building: Building; office: Office },
  deps: IngestDeps,
): Promise<IngestResult> {
  const { building, office } = identity;
  const events = githubToEvents(hook);
  if (events.length === 0) return { officeId: office.id, events, applied: [] };

  const applied: OfficeEvent[] = [];
  let state = (await deps.store.load(office.id)) ?? emptyOfficeState(building, office, "full");
  // Repo metadata (description, default branch, visibility) can change between
  // deliveries; the newest payload wins.
  state = { ...state, building, office };

  for (const event of events) {
    if (!(await deps.store.markDelivered(event.id))) continue;
    state = reduce(state, event);
    applied.push(event);
  }

  if (applied.length === 0) return { officeId: office.id, events, applied, state };

  await deps.store.save(office.id, state);
  await deps.publisher.publish({ officeId: office.id, events: applied, state });
  return { officeId: office.id, events, applied, state };
}
