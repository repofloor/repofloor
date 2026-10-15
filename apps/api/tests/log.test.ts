/** One JSON object per line, filtered by level, and never a credential in it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, errorFields, levelFromEnv } from "../src/log.ts";

function collector() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

const parse = (lines: string[]): Array<Record<string, unknown>> => lines.map((l) => JSON.parse(l));

test("every line is one JSON object with ts, level and msg", () => {
  const out = collector();
  const log = createLogger({ write: out.write, now: () => "2026-10-15T00:00:00.000Z" });
  log.info("request", { status: 200 });

  assert.deepEqual(parse(out.lines), [
    { ts: "2026-10-15T00:00:00.000Z", level: "info", msg: "request", status: 200 },
  ]);
});

test("levels below the threshold are dropped, and silent drops everything", () => {
  const out = collector();
  const log = createLogger({ write: out.write, level: "warn" });
  log.debug("a");
  log.info("b");
  log.warn("c");
  log.error("d");
  assert.deepEqual(
    parse(out.lines).map((l) => l["msg"]),
    ["c", "d"],
  );

  const quiet = collector();
  const silent = createLogger({ write: quiet.write, level: "silent" });
  silent.error("not even this");
  assert.deepEqual(quiet.lines, []);
});

test("base and child fields are stamped on every line, child wins on a clash", () => {
  const out = collector();
  const log = createLogger({ write: out.write, base: { service: "api" } });
  log.info("root");
  log.child({ officeId: "repofloor/repofloor" }).info("scoped", { status: 200 });
  log.child({ service: "realtime" }).info("renamed");

  const [root, scoped, renamed] = parse(out.lines);
  assert.equal(root?.["service"], "api");
  assert.equal(scoped?.["officeId"], "repofloor/repofloor");
  assert.equal(scoped?.["status"], 200);
  assert.equal(renamed?.["service"], "realtime");
});

test("errorFields flattens an Error, and anything else that was thrown", () => {
  const fields = errorFields(new TypeError("boom"));
  assert.equal(fields["error"], "boom");
  assert.equal(fields["errorType"], "TypeError");
  assert.equal(typeof fields["stack"], "string");
  assert.deepEqual(errorFields("just a string"), { error: "just a string" });
});

test("a field that cannot be serialized does not take the line down", () => {
  const out = collector();
  const log = createLogger({ write: out.write });
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;

  log.info("round trip", { cycle });
  const [line] = parse(out.lines);
  assert.equal(line?.["msg"], "round trip");
  assert.equal(line?.["unserializableFields"], true);
});

test("LOG_LEVEL falls back to info for anything unrecognized", () => {
  assert.equal(levelFromEnv("debug"), "debug");
  assert.equal(levelFromEnv(" WARN "), "warn");
  assert.equal(levelFromEnv(undefined), "info");
  assert.equal(levelFromEnv("verbose"), "info");
  assert.equal(levelFromEnv("verbose", "debug"), "debug");
});
