/**
 * `computeLayout` is the one part of the engine that is pure, and since it became a
 * floor-plan generator it is also the part that can be wrong in ways a screenshot
 * will not show — a room with no door, two rooms overlapping, a desk inside a wall.
 *
 * These are invariants rather than pixel assertions: the look is a judgement call,
 * but "every room is reachable" is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type ActorState, type OfficeState, type Room } from "@repofloor/protocol";
import { cellAt, computeLayout, isWalkable, type Layout } from "../src/layout.ts";

const OFFICE = "repofloor/repofloor";

function state(actorCount: number, roomKinds: Array<Room["kind"]> = []): OfficeState {
  const base = emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: false },
    "full",
  );
  const actors: ActorState[] = Array.from({ length: actorCount }, (_, i) => ({
    actor: { id: `dev-${i}`, kind: "human" as const },
    status: "coding" as const,
    lastSeen: "2026-10-16T09:00:00.000Z",
  }));
  const rooms: Room[] = [
    ...base.rooms,
    ...roomKinds.map((kind, i) => ({ id: `${OFFICE}#${kind}-${i}`, officeId: OFFICE, kind, name: `${kind} ${i}` })),
  ];
  return { ...base, actors, rooms };
}

/** Every tile of the shell is a wall, except the one entrance. */
function shellIsClosed(layout: Layout): boolean {
  let gaps = 0;
  for (let x = 0; x < layout.cols; x++) {
    for (const y of [0, layout.rows - 1]) if (cellAt(layout, x, y) !== "wall") gaps += 1;
  }
  for (let y = 0; y < layout.rows; y++) {
    for (const x of [0, layout.cols - 1]) if (cellAt(layout, x, y) !== "wall") gaps += 1;
  }
  return gaps === 1;
}

/** Flood fill from a tile, counting what it can reach without passing a wall. */
function reachable(layout: Layout, from: { tx: number; ty: number }): Set<number> {
  const seen = new Set<number>();
  const queue = [from];
  while (queue.length > 0) {
    const { tx, ty } = queue.pop()!;
    const key = ty * layout.cols + tx;
    if (seen.has(key)) continue;
    if (!isWalkable(layout, tx, ty)) continue;
    seen.add(key);
    queue.push({ tx: tx + 1, ty }, { tx: tx - 1, ty }, { tx, ty: ty + 1 }, { tx, ty: ty - 1 });
  }
  return seen;
}

test("the building is closed except for one entrance", () => {
  for (const s of [state(1), state(8, ["team", "meeting"]), state(30, ["team", "meeting", "focus", "team", "meeting"])]) {
    const layout = computeLayout(s);
    assert.ok(shellIsClosed(layout), `${layout.cols}x${layout.rows} shell has the wrong number of gaps`);
    assert.equal(cellAt(layout, layout.entrance.tx, layout.entrance.ty), "door");
  }
});

test("every room has exactly one door, and it is a gap in that room's own wall", () => {
  const layout = computeLayout(state(10, ["team", "meeting", "focus"]));
  assert.equal(layout.rooms.length, 3);

  for (const room of layout.rooms) {
    assert.equal(cellAt(layout, room.door.tx, room.door.ty), "door");
    // The door is on the room's boundary, not inside it and not adrift.
    const onBoundary =
      room.door.ty === room.ty - 1 ||
      room.door.ty === room.ty + room.th ||
      room.door.tx === room.tx - 1 ||
      room.door.tx === room.tx + room.tw;
    assert.ok(onBoundary, `door for ${room.room.name} is not on its wall`);
  }
});

test("every room interior is reachable from the entrance", () => {
  // The point of doors. A room sealed behind a wall would render perfectly and be
  // unusable, and nothing visual would say so.
  const layout = computeLayout(state(12, ["team", "meeting", "focus", "team"]));
  const seen = reachable(layout, { tx: layout.entrance.tx, ty: layout.entrance.ty - 1 });

  for (const room of layout.rooms) {
    for (let y = room.ty; y < room.ty + room.th; y++) {
      for (let x = room.tx; x < room.tx + room.tw; x++) {
        assert.ok(seen.has(y * layout.cols + x), `${room.room.name} is sealed off at ${x},${y}`);
      }
    }
  }
});

test("rooms never overlap each other", () => {
  const layout = computeLayout(state(6, ["team", "meeting", "focus", "team", "meeting"]));
  const claimed = new Map<number, string>();

  for (const room of layout.rooms) {
    for (let y = room.ty - 1; y <= room.ty + room.th; y++) {
      for (let x = room.tx - 1; x <= room.tx + room.tw; x++) {
        const key = y * layout.cols + x;
        const previous = claimed.get(key);
        // Shared walls would be fine; shared interiors are not.
        const interior = y >= room.ty && y < room.ty + room.th && x >= room.tx && x < room.tx + room.tw;
        if (interior && previous) assert.fail(`${room.room.name} overlaps ${previous} at ${x},${y}`);
        if (interior) claimed.set(key, room.room.name);
      }
    }
  }
});

test("every desk chair is on walkable floor, inside the building", () => {
  for (const count of [1, 5, 7, 18, 40]) {
    const layout = computeLayout(state(count));
    assert.equal(layout.desks.length, count, `${count} actors should get ${count} desks`);
    for (const desk of layout.desks) {
      assert.ok(isWalkable(layout, desk.tx, desk.ty), `desk ${desk.actorId} sits in a wall at ${desk.tx},${desk.ty}`);
      // The desk surface itself must also be inside.
      const deskY = desk.facing === "up" ? desk.ty - 1 : desk.ty + 1;
      assert.notEqual(cellAt(layout, desk.tx, deskY), "outside");
    }
  }
});

test("no two actors are given the same chair", () => {
  const layout = computeLayout(state(25));
  const seats = new Set(layout.desks.map((d) => `${d.tx},${d.ty}`));
  assert.equal(seats.size, layout.desks.length);
});

test("layout is deterministic: the same state gives the same plan", () => {
  const s = state(9, ["team", "meeting"]);
  const a = computeLayout(s);
  const b = computeLayout(s);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.desks, b.desks);
});

test("desk order is stable but not alphabetical, on purpose", () => {
  // CLAUDE.md: desk order is by hash(login). A desk that moves when someone else
  // joins would make the office unrecognisable from one visit to the next.
  const layout = computeLayout(state(12));
  const ids = layout.desks.map((d) => d.actorId);
  const alphabetical = [...ids].sort();
  assert.notDeepEqual(ids, alphabetical);
});

test("an empty office still produces a usable building", () => {
  const layout = computeLayout(state(0));
  assert.ok(layout.cols > 4 && layout.rows > 4);
  assert.equal(layout.desks.length, 0);
  assert.ok(shellIsClosed(layout));
  assert.ok(isWalkable(layout, layout.entrance.tx, layout.entrance.ty - 1));
});

test("the floor room is not drawn as a room: it is the open plan", () => {
  // `emptyOfficeState` always includes a `floor` room. It is the building, not a box
  // inside it, so it must never become a walled rectangle.
  const layout = computeLayout(state(4));
  assert.equal(layout.rooms.length, 0);
  assert.ok(layout.cells.some((c) => c === "open"));
});

test("roomIndex points every room tile at its own room, and nothing else", () => {
  const layout = computeLayout(state(8, ["team", "meeting"]));
  for (let y = 0; y < layout.rows; y++) {
    for (let x = 0; x < layout.cols; x++) {
      const index = layout.roomIndex[y * layout.cols + x]!;
      const cell = cellAt(layout, x, y);
      if (cell === "room") {
        const room = layout.rooms[index];
        assert.ok(room, `room tile ${x},${y} has no room`);
        assert.ok(x >= room.tx && x < room.tx + room.tw && y >= room.ty && y < room.ty + room.th);
      } else {
        assert.equal(index, -1, `non-room tile ${x},${y} claims room ${index}`);
      }
    }
  }
});
