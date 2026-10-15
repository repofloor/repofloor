/**
 * Event publishing.
 *
 * TODO(full-mode): `apps/realtime` subscribes to this to fan events out over WebSocket,
 * one channel per office. Per ADR 0001 the first real implementation is Postgres
 * `LISTEN`/`NOTIFY`; Redis pub/sub replaces it if presence volume demands it. Both fit
 * behind this interface — publishing stays fire-and-forget and must never fail a
 * webhook response.
 */

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";

export interface OfficeUpdate {
  officeId: string;
  /** The events that were applied, in order. */
  events: OfficeEvent[];
  /** The snapshot after applying them. */
  state: OfficeState;
}

export interface EventPublisher {
  publish(update: OfficeUpdate): Promise<void>;
}

/** Drops everything. The default until `apps/realtime` exists. */
export class NoopEventPublisher implements EventPublisher {
  async publish(): Promise<void> {
    /* no subscribers yet */
  }
}

/** In-process fan-out; also what the tests assert against. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly published: OfficeUpdate[] = [];
  readonly #subscribers = new Set<(update: OfficeUpdate) => void>();

  async publish(update: OfficeUpdate): Promise<void> {
    this.published.push(update);
    for (const fn of this.#subscribers) fn(update);
  }

  /** Returns an unsubscribe function. */
  subscribe(fn: (update: OfficeUpdate) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }
}
