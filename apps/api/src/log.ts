/**
 * Structured logs — one JSON object per line.
 *
 * ADR 0001 accepts "no dashboard" on the condition that the service is legible from
 * `psql` plus logs, so the logs have to be greppable by field, not prose. No
 * dependency: a line is `JSON.stringify` of `{ts, level, msg, ...fields}`.
 *
 * Nothing here may be handed a credential. Tokens, cookies, signatures and session
 * ids are never fields; log the *shape* of a request, never what authorized it.
 */

export const LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger that stamps every line with these fields too. */
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  level?: Level | undefined;
  /** Where lines go. Defaults to stdout; tests pass a collector. */
  write?: ((line: string) => void) | undefined;
  now?: (() => string) | undefined;
  /** Stamped on every line, e.g. `{ service: "api" }`. */
  base?: Fields | undefined;
}

/** `LOG_LEVEL`, falling back to `info` for anything unrecognized. */
export function levelFromEnv(value: string | undefined, fallback: Level = "info"): Level {
  const normalized = (value ?? "").trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(normalized) ? (normalized as Level) : fallback;
}

/**
 * An `Error` is not JSON-serializable, and a thrown non-Error is whatever it is, so
 * both are flattened here rather than at every call site.
 */
export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    return {
      error: err.message,
      errorType: err.name,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(err.cause !== undefined ? { cause: String(err.cause) } : {}),
    };
  }
  return { error: String(err) };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  const base = options.base ?? {};

  function make(bound: Fields): Logger {
    const emit = (level: Level, msg: string, fields?: Fields): void => {
      if (RANK[level] < threshold) return;
      let line: string;
      try {
        line = JSON.stringify({ ts: now(), level, msg, ...bound, ...fields });
      } catch {
        // A field that cannot be serialized (a cycle, a BigInt) must not take the
        // log line down with it.
        line = JSON.stringify({ ts: now(), level, msg, ...bound, unserializableFields: true });
      }
      write(line);
    };

    return {
      debug: (msg, fields) => emit("debug", msg, fields),
      info: (msg, fields) => emit("info", msg, fields),
      warn: (msg, fields) => emit("warn", msg, fields),
      error: (msg, fields) => emit("error", msg, fields),
      child: (fields) => make({ ...bound, ...fields }),
    };
  }

  return make(base);
}

/** Drops everything. The default inside `createApp`, so a library user gets no output. */
export const silentLogger: Logger = createLogger({ level: "silent" });
