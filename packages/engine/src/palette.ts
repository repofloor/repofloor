/** Colors and tiny helpers shared by the renderer. Everything is procedural (no sprite sheets). */

export const PALETTE = {
  floor: 0x2b2f3a,
  floorAlt: 0x2f3440,
  wall: 0x1b1e26,
  wallTop: 0x3a3f4d,
  deskWood: 0x8b5e3c,
  deskWoodDark: 0x6e4529,
  monitor: 0x111318,
  monitorOn: 0x7fd3ff,
  monitorAgent: 0xb98cff,
  chair: 0x3f4654,
  plant: 0x3fa35b,
  plantDark: 0x2c7a43,
  pot: 0xa0522d,
  text: 0xe8ebf2,
  textDim: 0x9aa3b5,
  roomFill: 0x252a35,
  roomStroke: 0x4a5265,
  roomFocus: 0x2a2440,
  roomMeeting: 0x24323a,

  // Floor materials. Desaturated on purpose: colour is reserved for people, which is
  // what keeps a crowded floor readable (docs/VISUAL_TARGET.md).
  corridor: 0x343a47,
  corridorAlt: 0x383e4b,
  openFloor: 0x2b2f3a,
  openFloorAlt: 0x2f3440,
  roomFloorTeam: 0x2a3340,
  roomFloorMeeting: 0x26323a,
  roomFloorFocus: 0x2c2740,

  // Walls are drawn as a body plus a lit top edge, which is what reads as height
  // from directly above.
  wallFace: 0x14171d,
  wallEdge: 0x474e5e,
  doorFrame: 0x6b7280,

  carpet: 0x3b3340,
  metal: 0x4b5563,
  metalDark: 0x374151,
  paper: 0xe5e7eb,
  ok: 0x4ade80,
  warn: 0xfacc15,
  bad: 0xf87171,
  info: 0x60a5fa,
  purple: 0xc084fc,
  confetti: [0xf87171, 0xfbbf24, 0x4ade80, 0x60a5fa, 0xc084fc, 0xf472b6],
} as const;

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd1a37c];
const SHIRT = [0x3b82f6, 0xef4444, 0x10b981, 0xf59e0b, 0x8b5cf6, 0xec4899, 0x14b8a6, 0xf97316, 0x6366f1, 0x84cc16];
const HAIR = [0x2b1d0e, 0x5a3a1a, 0xd4a017, 0x1f1f1f, 0x8b0000, 0x6b7280, 0xf5deb3];

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function paletteFor(id: string) {
  const h = hash(id);
  return {
    skin: SKIN[h % SKIN.length]!,
    shirt: SHIRT[(h >> 4) % SHIRT.length]!,
    hair: HAIR[(h >> 8) % HAIR.length]!,
    accent: SHIRT[(h >> 12) % SHIRT.length]!,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
