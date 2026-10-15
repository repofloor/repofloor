/**
 * The hub: one channel per office, the clients on it, and where frames come from.
 *
 * It knows nothing about WebSockets. A client here is anything that can be sent a
 * string and closed, which is what makes the whole fan-out testable without a socket.
 *
 * Three inputs feed a channel:
 *
 * - a notification carrying events — forwarded as-is, the animated path;
 * - a notification carrying only an office id (the payload did not fit the 8000-byte
 *   `NOTIFY` cap) — the snapshot is loaded and sent whole;
 * - a resync after the listener reconnected — same thing, for every live channel,
 *   because nothing can know what was missed.
 */

import type { Actor, OfficeEvent, OfficeState } from "@repofloor/protocol";
import { PROTOCOL_VERSION } from "@repofloor/protocol";
import type { Logger } from "@repofloor/api";
import { silentLogger } from "@repofloor/api";
import { isEmptyChange, OfficePresence, presenceEvents, type PresenceOptions } from "./presence.js";
import { CLOSE, encode, type ServerMessage, type Viewer } from "./wire.js";

/** Everything the hub needs of a connection. `ws` satisfies it; so does a test fake. */
export interface Client {
  send(data: string): void;
  close(code: number, reason?: string): void;
}

export interface SnapshotSource {
  load(officeId: string): Promise<OfficeState | undefined>;
}

export interface HubOptions {
  snapshots: SnapshotSource;
  logger?: Logger | undefined;
  presence?: PresenceOptions | undefined;
  now?: (() => string) | undefined;
}

interface Member {
  client: Client;
  viewer: Viewer | undefined;
}

/**
 * One office's channel. Created when the first client joins and dropped when the last
 * one leaves, so an idle deployment holds nothing.
 */
class Channel {
  readonly members = new Set<Member>();
  readonly presence: OfficePresence;
  /** Actor ids the persisted snapshot knows, so presence never marks them offline. */
  knownToOffice: ReadonlySet<string> = new Set();

  constructor(presenceOptions: PresenceOptions | undefined) {
    this.presence = new OfficePresence(presenceOptions ?? {});
  }
}

export class OfficeHub {
  readonly #channels = new Map<string, Channel>();
  readonly #snapshots: SnapshotSource;
  readonly #log: Logger;
  readonly #presenceOptions: PresenceOptions | undefined;
  readonly #now: () => string;

  constructor(options: HubOptions) {
    this.#snapshots = options.snapshots;
    this.#log = options.logger ?? silentLogger;
    this.#presenceOptions = options.presence;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get officeCount(): number {
    return this.#channels.size;
  }

  clientCount(officeId: string): number {
    return this.#channels.get(officeId)?.members.size ?? 0;
  }

  viewers(officeId: string): Actor[] {
    return this.#channels.get(officeId)?.presence.actors() ?? [];
  }

  /**
   * Admit an already-authorized client. The caller does the authorizing — the hub
   * never decides who may be here, it only decides what they are sent.
   *
   * Returns a function to call when the connection closes.
   */
  join(officeId: string, client: Client, state: OfficeState, viewer?: Viewer): () => void {
    let channel = this.#channels.get(officeId);
    if (!channel) {
      channel = new Channel(this.#presenceOptions);
      this.#channels.set(officeId, channel);
    }
    channel.knownToOffice = new Set(state.actors.map((a) => a.actor.id));

    const member: Member = { client, viewer };
    channel.members.add(member);

    const hello: ServerMessage = viewer
      ? { type: "hello", officeId, protocolVersion: PROTOCOL_VERSION, viewer }
      : { type: "hello", officeId, protocolVersion: PROTOCOL_VERSION };
    send(client, hello);
    send(client, { type: "snapshot", officeId, state });

    // Whoever is already here, so a late arrival sees a populated floor rather than
    // waiting for the next person to move.
    const alreadyHere = channel.presence.actors();
    if (alreadyHere.length > 0) {
      send(client, {
        type: "events",
        officeId,
        events: presenceEvents(officeId, { arrived: alreadyHere, departed: [] }, this.#now(), channel.knownToOffice),
      });
    }

    if (viewer) {
      // The login *is* the actor id, which is what makes a viewer and the same
      // person's webhook activity one actor on the floor rather than two.
      const actor: Actor = {
        id: viewer.login,
        kind: "human",
        name: viewer.login,
        ...(viewer.avatarUrl ? { avatarUrl: viewer.avatarUrl } : {}),
      };
      this.#announce(officeId, channel, channel.presence.join(actor));
    }

    return () => this.#leave(officeId, member);
  }

  /** A sign of life from a socket, which is what keeps a viewer off the TTL cut. */
  touch(officeId: string, viewer: Viewer | undefined): void {
    if (!viewer) return;
    this.#channels.get(officeId)?.presence.touch(viewer.login);
  }

  /** Drop viewers whose sockets died without a close frame. Run on a timer. */
  expirePresence(): void {
    for (const [officeId, channel] of this.#channels) {
      this.#announce(officeId, channel, channel.presence.expire());
    }
  }

  /** A notification arrived. Events if they came through, a snapshot if they did not. */
  async deliver(officeId: string, events: OfficeEvent[] | undefined): Promise<void> {
    const channel = this.#channels.get(officeId);
    if (!channel || channel.members.size === 0) return;

    if (events && events.length > 0) {
      this.#broadcast(channel, { type: "events", officeId, events });
      return;
    }
    await this.resync(officeId);
  }

  /** Load the current snapshot and send it whole. The degraded and post-gap path. */
  async resync(officeId: string): Promise<void> {
    const channel = this.#channels.get(officeId);
    if (!channel || channel.members.size === 0) return;

    let state: OfficeState | undefined;
    try {
      state = await this.#snapshots.load(officeId);
    } catch (err) {
      this.#log.warn("could not load snapshot for resync", {
        officeId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!state) return;

    channel.knownToOffice = new Set(state.actors.map((a) => a.actor.id));
    this.#broadcast(channel, { type: "snapshot", officeId, state });
  }

  /** Resync every live channel. What a reconnected listener owes its clients. */
  async resyncAll(): Promise<void> {
    await Promise.all([...this.#channels.keys()].map((officeId) => this.resync(officeId)));
  }

  /** Close every connection, politely. Used on shutdown. */
  closeAll(): void {
    for (const channel of this.#channels.values()) {
      for (const member of channel.members) member.client.close(CLOSE.GOING_AWAY, "server shutting down");
      channel.members.clear();
    }
    this.#channels.clear();
  }

  #leave(officeId: string, member: Member): void {
    const channel = this.#channels.get(officeId);
    if (!channel) return;
    if (!channel.members.delete(member)) return;

    if (member.viewer) this.#announce(officeId, channel, channel.presence.leave(member.viewer.login));
    // An office nobody is watching costs nothing to forget.
    if (channel.members.size === 0) this.#channels.delete(officeId);
  }

  #announce(officeId: string, channel: Channel, change: ReturnType<OfficePresence["join"]>): void {
    if (isEmptyChange(change)) return;
    const events = presenceEvents(officeId, change, this.#now(), channel.knownToOffice);
    if (events.length === 0) return;
    this.#broadcast(channel, { type: "events", officeId, events });
  }

  #broadcast(channel: Channel, message: ServerMessage): void {
    const payload = encode(message);
    for (const member of channel.members) {
      try {
        member.client.send(payload);
      } catch (err) {
        // One broken socket must not stop the rest of the floor updating.
        this.#log.debug("send failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

function send(client: Client, message: ServerMessage): void {
  try {
    client.send(encode(message));
  } catch {
    /* the caller will see the close */
  }
}
