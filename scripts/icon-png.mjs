/**
 * Render `docs/assets/icon.svg` to PNG, with no dependency and no design tool.
 *
 *   node scripts/icon-png.mjs                 # the sizes GitHub asks for
 *   node scripts/icon-png.mjs 1024            # or any size you like
 *
 * GitHub wants a raster for an organization avatar and a repository social preview,
 * and the icon is an SVG. Rather than keep a PNG beside it that drifts the first time
 * the SVG changes, this reads the SVG and draws it — so the vector file stays the one
 * source of truth and the PNGs are output, like `apps/lite-action/dist`.
 *
 * It parses only what our icon uses: `<rect>`, `<circle>`, `<ellipse>`, a `fill` on the
 * shape or on an enclosing `<g>`, and `opacity`. That is not a general SVG renderer and
 * is not trying to be — it is a few dozen lines that understand one file we wrote, and
 * it throws on anything it does not recognise rather than quietly dropping it.
 *
 * In the spirit of rule 5: the default visuals are shapes in files you can read, and so
 * is the thing that turns them into pixels.
 */

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVG = join(ROOT, "docs/assets/icon.svg");
const OUT_DIR = join(ROOT, "docs/assets");

/** Supersampling factor. Rect edges land on integers either way; circles need this. */
const SS = 4;

// ── the bit of SVG we understand ─────────────────────────────────────────────

/** `#rrggbb` → [r, g, b]. */
function parseColor(value) {
  const hex = value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`icon-png: unsupported colour ${value}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
};
const num = (tag, name, fallback = 0) => {
  const v = attr(tag, name);
  return v === undefined ? fallback : Number(v);
};

/**
 * Flatten the SVG into a list of shapes in paint order, carrying a `<g>`'s fill down
 * to the shapes inside it.
 */
function parseShapes(svg) {
  // Strip comments first: ours contain the word "rect" in prose more than once.
  const body = svg.replace(/<!--[\s\S]*?-->/g, "");
  const shapes = [];
  const groupFills = [];

  const token = /<(g|\/g|rect|circle|ellipse)\b([^>]*)>/g;
  let m;
  while ((m = token.exec(body)) !== null) {
    const [, name, rest] = m;
    const tag = `<${name}${rest}>`;

    if (name === "g") {
      groupFills.push(attr(tag, "fill"));
      continue;
    }
    if (name === "/g") {
      groupFills.pop();
      continue;
    }

    const fill = attr(tag, "fill") ?? groupFills[groupFills.length - 1];
    if (!fill) throw new Error(`icon-png: <${name}> has no fill and no enclosing group fill`);
    const alpha = num(tag, "opacity", 1);
    const color = parseColor(fill);

    if (name === "rect") {
      shapes.push({ kind: "rect", x: num(tag, "x"), y: num(tag, "y"), w: num(tag, "width"), h: num(tag, "height"), color, alpha });
    } else if (name === "circle") {
      const r = num(tag, "r");
      shapes.push({ kind: "ellipse", cx: num(tag, "cx"), cy: num(tag, "cy"), rx: r, ry: r, color, alpha });
    } else {
      shapes.push({ kind: "ellipse", cx: num(tag, "cx"), cy: num(tag, "cy"), rx: num(tag, "rx"), ry: num(tag, "ry"), color, alpha });
    }
  }

  if (groupFills.length !== 0) throw new Error("icon-png: unbalanced <g> in the SVG");
  return shapes;
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Paint the shapes into an RGBA buffer of `side` pixels, source-over. */
function raster(shapes, viewBox, side) {
  const scale = side / viewBox;
  const buf = new Uint8ClampedArray(side * side * 4);

  const blend = (x, y, [r, g, b], a) => {
    if (x < 0 || y < 0 || x >= side || y >= side) return;
    const i = (y * side + x) * 4;
    const dstA = buf[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
      buf[i + c] = ([r, g, b][c] * a + buf[i + c] * dstA * (1 - a)) / outA;
    }
    buf[i + 3] = outA * 255;
  };

  for (const s of shapes) {
    if (s.kind === "rect") {
      const x0 = Math.round(s.x * scale);
      const y0 = Math.round(s.y * scale);
      const x1 = Math.round((s.x + s.w) * scale);
      const y1 = Math.round((s.y + s.h) * scale);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) blend(x, y, s.color, s.alpha);
    } else {
      const cx = s.cx * scale;
      const cy = s.cy * scale;
      const rx = s.rx * scale;
      const ry = s.ry * scale;
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) blend(x, y, s.color, s.alpha);
        }
      }
    }
  }
  return buf;
}

/** Box-downsample by SS, which is what keeps the circles from looking chewed. */
function downsample(big, bigSide, side) {
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * bigSide + (x * SS + sx)) * 4;
          r += big[i]; g += big[i + 1]; b += big[i + 2]; a += big[i + 3];
        }
      }
      const n = SS * SS;
      const i = (y * side + x) * 4;
      out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n; out[i + 3] = a / n;
    }
  }
  return out;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(rgba, side) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline. Filter 0 (none) — the image is flat colour, so the
  // win from predicting neighbours is not worth the code to choose a filter per row.
  const raw = Buffer.alloc(side * (side * 4 + 1));
  for (let y = 0; y < side; y++) {
    raw[y * (side * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * side * 4, side * 4).copy(raw, y * (side * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── go ───────────────────────────────────────────────────────────────────────

const svg = readFileSync(SVG, "utf8");
const viewBox = Number((svg.match(/viewBox="0 0 (\d+) \1"/) ?? [])[1]);
if (!viewBox) throw new Error("icon-png: the SVG needs a square viewBox starting at 0 0");

const shapes = parseShapes(svg);
const sizes = process.argv[2] ? [Number(process.argv[2])] : [512, 256, 128, 64, 32, 16];

for (const side of sizes) {
  const big = raster(shapes, viewBox, side * SS);
  const png = encodePng(downsample(big, side * SS, side), side);
  const path = join(OUT_DIR, `icon-${side}.png`);
  writeFileSync(path, png);
  console.log(`${path}  ${side}x${side}  ${png.length} bytes`);
}
