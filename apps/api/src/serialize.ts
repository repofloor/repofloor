/**
 * Run async work one at a time per key.
 *
 * Ingesting a delivery is read-modify-write over an office snapshot (load → reduce →
 * save) and GitHub delivers webhooks concurrently, so two deliveries for the same
 * office can interleave: both read the same snapshot and the second save drops the
 * first one's events. A queue per office makes that impossible inside one process.
 *
 * TODO(full-mode): across processes the guarantee has to come from the store — a row
 * lock or a transaction spanning the ingest loop (see `OfficeStore`). This queue is
 * then still useful: it keeps a single process from fighting itself for the lock.
 */
export class KeyedQueue {
  /** The tail of each key's chain; absent once the chain has drained. */
  readonly #tails = new Map<string, Promise<void>>();

  /** Queue `task` behind whatever is already running for `key`. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    // start after the previous task settles, failure included: one bad delivery
    // must not wedge the office's queue
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      // only the last writer clears the key, so the map cannot grow without bound
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** Keys with work running or queued. Zero when everything has drained. */
  get pending(): number {
    return this.#tails.size;
  }
}
