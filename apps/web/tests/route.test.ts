import { strict as assert } from "node:assert";
import { test } from "node:test";
import { officePagePath, parseRoute, routePath } from "../src/route.js";

test("the three levels of the hierarchy are three paths", () => {
  assert.deepEqual(parseRoute("/"), { kind: "home" });
  assert.deepEqual(parseRoute(""), { kind: "home" });
  assert.deepEqual(parseRoute("/repofloor"), { kind: "building", owner: "repofloor" });
  assert.deepEqual(parseRoute("/repofloor/repofloor"), { kind: "office", owner: "repofloor", repo: "repofloor" });
  assert.deepEqual(parseRoute("/installed"), { kind: "installed" });
});

test("a trailing slash is the same page", () => {
  assert.deepEqual(parseRoute("/repofloor/"), { kind: "building", owner: "repofloor" });
  assert.deepEqual(parseRoute("/repofloor/repofloor//"), { kind: "office", owner: "repofloor", repo: "repofloor" });
});

test("repository names may carry dots, owners may not", () => {
  assert.deepEqual(parseRoute("/aliosmanmho/dot.files"), {
    kind: "office",
    owner: "aliosmanmho",
    repo: "dot.files",
  });
  assert.equal(parseRoute("/not.an.owner").kind, "unknown");
});

test("an encoded slash cannot smuggle a third segment into an office id", () => {
  // The server-side mirror of this is `officeIdFromPath` in apps/realtime: decoding
  // first and validating after is what stops `a%2Fb/c` becoming the id `a/b/c`.
  assert.equal(parseRoute("/a%2Fb/c").kind, "unknown");
  assert.equal(parseRoute("/a/b/c").kind, "unknown");
  assert.equal(parseRoute("/%ZZ").kind, "unknown");
});

test("assets and dotfiles are not buildings", () => {
  assert.equal(parseRoute("/favicon.ico").kind, "unknown");
  assert.equal(parseRoute("/assets/index-abc123.js").kind, "unknown");
});

test("routePath round-trips every route it parses", () => {
  for (const path of ["/", "/installed", "/repofloor", "/repofloor/repofloor"]) {
    assert.equal(routePath(parseRoute(path)), path);
  }
});

test("an office id out of the api becomes a page path", () => {
  assert.equal(officePagePath("repofloor/repofloor"), "/repofloor/repofloor");
  assert.equal(officePagePath("nonsense"), "/");
});
