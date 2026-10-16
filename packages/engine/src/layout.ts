/**
 * Deterministic floor plan: given an OfficeState, lay out a *building* — an outer
 * shell, rooms with walls and doorways, a corridor, and an open-plan area of desk
 * pods between them.
 *
 * Pure: the same state always produces the same office, so positions are stable
 * between frames and between page loads.
 *
 * The model is a grid of cells rather than a list of rectangles. That is what lets
 * the renderer draw a wall as a wall (it can see its neighbours, so it knows where
 * the corners and the faces go), and it answers "can someone walk here", which is
 * what A* pathing (#5) will need.
 */

import type { OfficeState, Room } from "@repofloor/protocol";
import { hash } from "./palette.js";

export const TILE = 16;

/**
 * What occupies one tile. Everything except `wall` is walkable; `door` is the gap in
 * a wall that makes a room reachable.
 */
export type Cell = "outside" | "wall" | "door" | "corridor" | "open" | "room";

export interface DeskSlot {
  actorId: string;
  /** tile coordinates of the chair (the actor sits here) */
  tx: number;
  ty: number;
  /**
   * Where the desk is relative to the chair. Pods seat people facing each other, so
   * the desk is above for the back row and below for the front row.
   */
  facing: "up" | "down";
}

export interface RoomBox {
  room: Room;
  /** interior origin and size, excluding the walls around it */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** the gap in this room's wall; always on the corridor side */
  door: { tx: number; ty: number };
  /** seat tiles inside the room */
  seats: Array<{ tx: number; ty: number }>;
}

export type PropKind = "plant" | "coffee" | "board" | "lamp" | "printer" | "sofa" | "table" | "cabinet";

export interface Layout {
  /** total size in tiles */
  cols: number;
  rows: number;
  /** row-major, `cols * rows` entries. Index with `cellAt`. */
  cells: Cell[];
  /** index into `rooms` for a room tile, -1 elsewhere. Row-major, same size as cells. */
  roomIndex: number[];
  desks: DeskSlot[];
  rooms: RoomBox[];
  props: Array<{ kind: PropKind; tx: number; ty: number }>;
  /** where unassigned / visiting actors wander: the corridor by the entrance */
  lounge: { tx: number; ty: number; tw: number; th: number };
  /** the way in, in the bottom wall */
  entrance: { tx: number; ty: number };
}

/** Interior size of a room, excluding its walls. */
const ROOM_W = 8;
const ROOM_H = 5;
/** Rooms sit in a band; the band is the room plus the wall above and below it. */
const BAND_H = ROOM_H + 2;
/** A pod is two rows of desks facing each other across a shared surface. */
const POD_COLS = 3;
const POD_W = POD_COLS * 3 + 1;
const POD_H = 5;
const CORRIDOR_H = 3;
const MARGIN = 1;
/** A strip under the top wall for the repo title, the wall board and the CI lamp. */
const HEADER_H = 2;

export function cellAt(layout: Layout, tx: number, ty: number): Cell {
  if (tx < 0 || ty < 0 || tx >= layout.cols || ty >= layout.rows) return "outside";
  return layout.cells[ty * layout.cols + tx] ?? "outside";
}

export function isWalkable(layout: Layout, tx: number, ty: number): boolean {
  const cell = cellAt(layout, tx, ty);
  return cell !== "wall" && cell !== "outside";
}

export function computeLayout(state: OfficeState): Layout {
  // Actors that deserve a desk: everyone except offline bots. Offline humans keep a
  // desk (an empty chair says something).
  const deskActors = state.actors
    .filter((a) => !(a.actor.kind === "bot" && a.status === "offline"))
    .map((a) => a.actor.id)
    .sort((x, y) => hash(x) - hash(y)); // stable but not alphabetical, on purpose

  const rooms = state.rooms.filter((r) => r.kind !== "floor");

  // ── how wide is the building? ────────────────────────────────────────────
  // Wide enough for the desk pods we need, and for the rooms along the top.
  const podCount = Math.max(1, Math.ceil(deskActors.length / (POD_COLS * 2)));
  const podsPerRow = Math.min(podCount, 3);
  const podRows = Math.ceil(podCount / podsPerRow);

  const topRoomCount = Math.min(rooms.length, 3);
  const bottomRoomCount = Math.max(0, rooms.length - topRoomCount);

  const byPods = MARGIN * 2 + podsPerRow * POD_W + (podsPerRow - 1);
  const byRooms = MARGIN * 2 + Math.max(topRoomCount, bottomRoomCount) * (ROOM_W + 2);
  const cols = Math.max(byPods, byRooms, 22);

  // ── how tall? ────────────────────────────────────────────────────────────
  const topBand = topRoomCount > 0 ? BAND_H : 0;
  const bottomBand = bottomRoomCount > 0 ? BAND_H : 0;
  const deskArea = podRows * POD_H + (podRows - 1);
  const rows = MARGIN + HEADER_H + topBand + CORRIDOR_H + deskArea + CORRIDOR_H + bottomBand + MARGIN;

  const cells: Cell[] = new Array(cols * rows).fill("open");
  const roomIndex: number[] = new Array(cols * rows).fill(-1);
  const set = (tx: number, ty: number, cell: Cell): void => {
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return;
    cells[ty * cols + tx] = cell;
  };

  // ── the shell ────────────────────────────────────────────────────────────
  for (let x = 0; x < cols; x++) {
    set(x, 0, "wall");
    set(x, rows - 1, "wall");
  }
  for (let y = 0; y < rows; y++) {
    set(0, y, "wall");
    set(cols - 1, y, "wall");
  }


  // ── rooms ────────────────────────────────────────────────────────────────
  const roomBoxes: RoomBox[] = [];

  const placeBand = (band: Room[], bandTop: number, doorOn: "bottom" | "top"): void => {
    const bandW = band.length * (ROOM_W + 2);
    const bandLeft = Math.max(MARGIN, Math.floor((cols - bandW) / 2));
    band.forEach((room, i) => {
      // Interior origin. The wall ring sits one tile outside it.
      const tx = bandLeft + i * (ROOM_W + 2) + 1;
      const ty = bandTop + 1;

      for (let y = ty - 1; y <= ty + ROOM_H; y++) {
        for (let x = tx - 1; x <= tx + ROOM_W; x++) {
          const onEdge = y === ty - 1 || y === ty + ROOM_H || x === tx - 1 || x === tx + ROOM_W;
          if (onEdge) set(x, y, "wall");
          else {
            set(x, y, "room");
            roomIndex[y * cols + x] = roomBoxes.length;
          }
        }
      }

      // One doorway, always onto the corridor, so every room is reachable without
      // crossing another. Offset from centre so it does not line up with the table.
      const door = { tx: tx + ROOM_W - 3, ty: doorOn === "bottom" ? ty + ROOM_H : ty - 1 };
      set(door.tx, door.ty, "door");

      const seats = [
        { tx: tx + 2, ty: ty + 1 },
        { tx: tx + 5, ty: ty + 1 },
        { tx: tx + 2, ty: ty + 3 },
        { tx: tx + 5, ty: ty + 3 },
        { tx: tx + 3, ty: ty + 3 },
        { tx: tx + 4, ty: ty + 1 },
      ];
      roomBoxes.push({ room, tx, ty, tw: ROOM_W, th: ROOM_H, door, seats });
    });
  };

  const bandTop = MARGIN + HEADER_H;
  if (topRoomCount > 0) placeBand(rooms.slice(0, topRoomCount), bandTop, "bottom");
  if (bottomRoomCount > 0)
    placeBand(rooms.slice(topRoomCount), bandTop + topBand + CORRIDOR_H + deskArea + CORRIDOR_H, "top");

  // ── corridors ────────────────────────────────────────────────────────────
  const corridorTop = bandTop + topBand;
  const deskTop = corridorTop + CORRIDOR_H;
  const corridorBottom = deskTop + deskArea;

  for (let y = corridorTop; y < corridorTop + CORRIDOR_H; y++) {
    for (let x = 1; x < cols - 1; x++) set(x, y, "corridor");
  }
  for (let y = corridorBottom; y < corridorBottom + CORRIDOR_H; y++) {
    for (let x = 1; x < cols - 1; x++) set(x, y, "corridor");
  }

  // ── desks, in pods ───────────────────────────────────────────────────────
  // A pod is two rows of three, facing each other over a shared run of desks. That
  // is what makes an open plan read as an office rather than as a grid of furniture.
  const desks: DeskSlot[] = [];
  const podAreaW = podsPerRow * POD_W + (podsPerRow - 1);
  const podLeft = Math.max(MARGIN, Math.floor((cols - podAreaW) / 2));
  deskActors.forEach((actorId, i) => {
    // Round-robin across pods rather than filling one before starting the next: a
    // crowded pod beside an empty one looks like a seating mistake, and with a small
    // team it is most of what you see.
    const pod = i % podCount;
    const withinPod = Math.floor(i / podCount);
    const podRow = Math.floor(pod / podsPerRow);
    const podCol = pod % podsPerRow;

    const podX = podLeft + podCol * (POD_W + 1) + 1;
    const podY = deskTop + podRow * (POD_H + 1);

    const back = withinPod < POD_COLS; // back row sits above the shared desk run
    const slot = withinPod % POD_COLS;

    desks.push({
      actorId,
      tx: podX + slot * 3 + 1,
      ty: back ? podY + 1 : podY + 3,
      facing: back ? "down" : "up",
    });
  });

  // ── the way in ───────────────────────────────────────────────────────────
  // Last, because it has to open onto walkable floor and only now is it settled
  // what is where. Centring it blindly put the front door against the back wall of
  // a room whenever the bottom band happened to sit in the middle — you walked in
  // and hit a wall, which nothing visual would have told us.
  const entranceTy = rows - 1;
  const middle = Math.floor(cols / 2);
  let entranceTx = middle;
  for (let offset = 0; offset < cols; offset++) {
    const candidate = offset % 2 === 0 ? middle + offset / 2 : middle - (offset + 1) / 2;
    if (candidate <= 0 || candidate >= cols - 1) continue;
    const inside = cells[(entranceTy - 1) * cols + candidate];
    if (inside && inside !== "wall") {
      entranceTx = candidate;
      break;
    }
  }
  const entrance = { tx: entranceTx, ty: entranceTy };
  set(entrance.tx, entrance.ty, "door");

  // ── props ────────────────────────────────────────────────────────────────
  const props: Layout["props"] = [
    { kind: "lamp", tx: cols - 3, ty: MARGIN },
    { kind: "board", tx: MARGIN + 1, ty: MARGIN },
  ];

  // The corridor by the entrance is where people without a desk end up.
  const lounge = { tx: 2, ty: corridorBottom, tw: Math.max(3, cols - 6), th: CORRIDOR_H };
  props.push({ kind: "coffee", tx: cols - 4, ty: corridorBottom + 1 });
  props.push({ kind: "printer", tx: 2, ty: corridorBottom + 1 });
  props.push({ kind: "plant", tx: 1, ty: corridorTop });
  props.push({ kind: "plant", tx: cols - 2, ty: corridorBottom + CORRIDOR_H - 1 });
  props.push({ kind: "plant", tx: 1, ty: rows - 2 });

  // Furniture that belongs to a room, chosen by what the room is for. Procedural
  // (rule 5): these are shapes, not files.
  for (const box of roomBoxes) {
    const mid = { tx: box.tx + 2, ty: box.ty + 2 };
    if (box.room.kind === "meeting") props.push({ kind: "table", tx: mid.tx, ty: mid.ty });
    else if (box.room.kind === "focus") props.push({ kind: "sofa", tx: box.tx + 1, ty: box.ty + 2 });
    else props.push({ kind: "table", tx: mid.tx, ty: mid.ty });
    props.push({ kind: "cabinet", tx: box.tx + box.tw - 2, ty: box.ty });
    props.push({ kind: "plant", tx: box.tx, ty: box.ty + box.th - 1 });
  }

  return { cols, rows, cells, roomIndex, desks, rooms: roomBoxes, props, lounge, entrance };
}
