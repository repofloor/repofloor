import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { OfficeEvent, OfficeState, ActorState } from "@repofloor/protocol";
import { cellAt, computeLayout, TILE, type Layout } from "./layout.js";
import { Avatar } from "./avatar.js";
import { PALETTE, hash } from "./palette.js";

export interface OfficeRendererOptions {
  /** Pixel scale (2 = chunky pixel art). */
  scale?: number;
  /** Called when the user clicks an actor. */
  onActorClick?: (actor: ActorState) => void;
  /** Provide tooltip HTML for an actor; return "" to hide. Default renders name/status/detail. */
  tooltip?: (actor: ActorState) => string;
  /** Background color behind the office. */
  background?: number;
  /** Drag to pan, wheel/buttons to zoom. Default true. */
  interactiveCamera?: boolean;
}

/** Zoom limits. The office is pixel art, so steps are quarters of a pixel scale. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const ZOOM_STEP = 0.25;
/** Pointer travel (px) before a press counts as a pan instead of a click. */
const DRAG_SLOP = 4;

const ROOM_LABEL = new TextStyle({ fontFamily: "monospace", fontSize: 9, fill: PALETTE.textDim });
const BOARD_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 8, fill: PALETTE.text });
const TITLE_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 11, fill: PALETTE.text, fontWeight: "bold" });

/**
 * OfficeRenderer: mount once, then push states. Diffing is done by actor id, so
 * avatars walk between desks/rooms instead of teleporting.
 */
export class OfficeRenderer {
  private app = new Application();
  private world = new Container();
  private floorLayer = new Graphics();
  private propsLayer = new Container();
  private roomLayer = new Container();
  private actorLayer = new Container();
  private fxLayer = new Container();
  private avatars = new Map<string, Avatar>();
  private layout: Layout | null = null;
  private layoutKey = "";
  private state: OfficeState | null = null;
  private lamp = new Graphics();
  private monitors = new Map<string, Graphics>();
  private board = new Text({ text: "", style: BOARD_STYLE });
  private title = new Text({ text: "", style: TITLE_STYLE });
  private confetti: Array<{ g: Graphics; vx: number; vy: number; life: number }> = [];
  private tooltipEl: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private wanderTimer = 0;
  private camera = { x: 0, y: 0, scale: 2 };
  /** Once the user pans or zooms, stop re-fitting the office under them. */
  private cameraTouched = false;
  private dragged = false;
  private cleanup: Array<() => void> = [];
  private opts: Required<Pick<OfficeRendererOptions, "scale" | "background">> & OfficeRendererOptions;
  private t = 0;

  constructor(opts: OfficeRendererOptions = {}) {
    this.opts = { scale: 2, background: 0x14161c, ...opts };
    this.camera.scale = this.opts.scale;
  }

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    await this.app.init({
      background: this.opts.background,
      resizeTo: host,
      antialias: false,
      roundPixels: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    this.world.addChild(this.floorLayer, this.roomLayer, this.propsLayer, this.actorLayer, this.fxLayer);
    this.world.scale.set(this.opts.scale);
    this.app.stage.addChild(this.world);
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    this.app.renderer.on("resize", () => this.fitToHost());
    // `resizeTo` only reacts to window resizes; the host can also change on its own
    // (a side panel closing, a responsive grid), so watch the element itself.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (!this.host) return;
        this.app.renderer.resize(this.host.clientWidth, this.host.clientHeight);
        this.fitToHost();
      });
      ro.observe(host);
      this.cleanup.push(() => ro.disconnect());
    }

    this.tooltipEl = document.createElement("div");
    Object.assign(this.tooltipEl.style, {
      position: "absolute",
      pointerEvents: "none",
      background: "rgba(20,22,28,0.95)",
      color: "#e8ebf2",
      border: "1px solid #4a5265",
      borderRadius: "4px",
      padding: "6px 8px",
      font: "11px/1.4 ui-monospace, monospace",
      display: "none",
      zIndex: "10",
      maxWidth: "260px",
    } as CSSStyleDeclaration);
    host.style.position ||= "relative";
    host.appendChild(this.tooltipEl);
    this.setupCamera();
    if (this.state) this.setState(this.state);
  }

  destroy() {
    for (const off of this.cleanup) off();
    this.cleanup = [];
    this.app.destroy(true, { children: true });
    this.tooltipEl?.remove();
  }

  /** Re-centre and re-fit the office, discarding the user's pan/zoom. */
  resetCamera() {
    this.cameraTouched = false;
    this.fitToHost();
  }

  /** Replace the whole state; avatars are diffed by id. */
  setState(state: OfficeState) {
    this.state = state;
    if (!this.host) return;
    const key = layoutKey(state);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = computeLayout(state);
      this.drawStatic(state, this.layout);
    }
    const layout = this.layout!;
    const seen = new Set<string>();
    const targets = this.resolveTargets(state, layout);
    for (const a of state.actors) {
      seen.add(a.actor.id);
      let av = this.avatars.get(a.actor.id);
      const target = targets.get(a.actor.id)!;
      if (!av) {
        av = new Avatar(a);
        av.on("pointerover", (e) => this.showTooltip(av!, e.global.x, e.global.y));
        av.on("pointermove", (e) => this.showTooltip(av!, e.global.x, e.global.y));
        av.on("pointerout", () => this.hideTooltip());
        av.on("pointertap", () => {
          if (!this.dragged) this.opts.onActorClick?.(av!.state);
        });
        this.avatars.set(a.actor.id, av);
        this.actorLayer.addChild(av);
        // New actors walk in through the entrance, which is a gap in the bottom wall
        // rather than a prop now that the shell is drawn from the cell grid.
        av.moveTo(layout.entrance.tx, layout.entrance.ty - 1, true);
        av.moveTo(target.tx, target.ty);
      } else {
        av.setState(a);
        av.moveTo(target.tx, target.ty);
      }
      const mon = this.monitors.get(a.actor.id);
      if (mon) this.drawMonitor(mon, a);
    }
    for (const [id, av] of this.avatars) {
      if (!seen.has(id)) {
        this.actorLayer.removeChild(av);
        av.destroy();
        this.avatars.delete(id);
      }
    }
    this.drawLamp(state);
    this.board.text = boardText(state);
    this.placeTitle(state.office.id);
    this.fitToHost();
  }

  /** Optional: feed events for one-shot effects (confetti on merge, etc.). State must still be set separately. */
  applyEffect(event: OfficeEvent) {
    if (event.type === "pr.merged") {
      const av = this.avatars.get(event.actorId);
      if (av) this.burstConfetti(av.position.x, av.position.y - 20);
    }
    if (event.type === "ci.status" && event.status === "failure") {
      this.flashLamp();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One tile per actor. Desks and room seats are unique by construction, but the
   * lounge and the door are not — with a big team everyone used to pile onto the
   * same tile and their name labels became unreadable.
   */
  private resolveTargets(state: OfficeState, layout: Layout): Map<string, { tx: number; ty: number }> {
    const out = new Map<string, { tx: number; ty: number }>();
    const taken = new Set<string>();
    for (const a of state.actors) {
      let t = this.targetFor(a, layout);
      for (let i = 1; taken.has(`${t.tx},${t.ty}`) && i <= 12; i++) {
        // deterministic nudge: right, left, right… then down a row
        const dx = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
        const tx = clamp(t.tx + dx, 1, layout.cols - 2);
        const ty = clamp(t.ty + (i > 6 ? 1 : 0), 1, layout.rows - 2);
        t = { tx, ty };
      }
      taken.add(`${t.tx},${t.ty}`);
      out.set(a.actor.id, t);
    }
    return out;
  }

  /** Spread loungers across the lounge by a stable index instead of a hash. */
  private loungeSpot(a: ActorState, layout: Layout): { tx: number; ty: number } {
    const ids = (this.state?.actors ?? []).map((x) => x.actor.id).sort();
    const i = Math.max(0, ids.indexOf(a.actor.id));
    const l = layout.lounge;
    return { tx: l.tx + (i % l.tw), ty: l.ty + (Math.floor(i / l.tw) % Math.max(1, l.th)) };
  }

  private targetFor(a: ActorState, layout: Layout): { tx: number; ty: number } {
    if (a.roomId) {
      const box = layout.rooms.find((r) => r.room.id === a.roomId);
      if (box) {
        // seat by index among the room's occupants, so two people never share a chair
        const occupants = (this.state?.actors ?? []).filter((x) => x.roomId === a.roomId).map((x) => x.actor.id).sort();
        const idx = Math.max(0, occupants.indexOf(a.actor.id));
        return box.seats[idx % box.seats.length]!;
      }
    }
    const desk = layout.desks.find((d) => d.actorId === a.actor.id);
    if (desk) {
      if (a.status === "idle" && hash(a.actor.id + Math.floor(this.t / 20)) % 3 === 0) {
        // idle people occasionally hang out in the lounge
        return this.loungeSpot(a, layout);
      }
      return { tx: desk.tx, ty: desk.ty };
    }
    return this.loungeSpot(a, layout);
  }

  private drawStatic(state: OfficeState, layout: Layout) {
    const g = this.floorLayer.clear();

    // ── floor ──────────────────────────────────────────────────────────────
    // One pass over the grid. Each cell kind gets its own material, which is what
    // makes a room read as a room rather than as a tinted rectangle.
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < layout.cols; x++) {
        const cell = cellAt(layout, x, y);
        if (cell === "wall" || cell === "outside") continue;
        const checker = (x + y) % 2 === 0;
        let fill: number;
        if (cell === "corridor" || cell === "door") {
          fill = checker ? PALETTE.corridor : PALETTE.corridorAlt;
        } else if (cell === "room") {
          const box = layout.rooms[layout.roomIndex[y * layout.cols + x] ?? -1];
          const kind = box?.room.kind;
          fill =
            kind === "meeting"
              ? PALETTE.roomFloorMeeting
              : kind === "focus"
                ? PALETTE.roomFloorFocus
                : PALETTE.roomFloorTeam;
        } else {
          fill = checker ? PALETTE.openFloor : PALETTE.openFloorAlt;
        }
        g.rect(x * TILE, y * TILE, TILE, TILE).fill(fill);
      }
    }

    // ── walls ──────────────────────────────────────────────────────────────
    // A wall is a dark body plus a lit edge on whichever side faces into a space.
    // Seen from directly above that edge is the only cue for height, and without it
    // the plan flattens into outlines.
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < layout.cols; x++) {
        if (cellAt(layout, x, y) !== "wall") continue;
        const px = x * TILE;
        const py = y * TILE;
        g.rect(px, py, TILE, TILE).fill(PALETTE.wallFace);

        const lit = (dx: number, dy: number): boolean => {
          const n = cellAt(layout, x + dx, y + dy);
          return n !== "wall" && n !== "outside";
        };
        const E = 3;
        if (lit(0, 1)) g.rect(px, py + TILE - E, TILE, E).fill(PALETTE.wallEdge);
        if (lit(0, -1)) g.rect(px, py, TILE, E - 1).fill(PALETTE.wallTop);
        if (lit(-1, 0)) g.rect(px, py, E - 1, TILE).fill(PALETTE.wallTop);
        if (lit(1, 0)) g.rect(px + TILE - (E - 1), py, E - 1, TILE).fill(PALETTE.wallTop);
      }
    }

    // ── doorways ───────────────────────────────────────────────────────────
    // The gap is already floor; these are the jambs either side of it, which is what
    // makes an opening look deliberate instead of like a missing tile.
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < layout.cols; x++) {
        if (cellAt(layout, x, y) !== "door") continue;
        const px = x * TILE;
        const py = y * TILE;
        const horizontal = cellAt(layout, x - 1, y) === "wall" && cellAt(layout, x + 1, y) === "wall";
        if (horizontal) {
          g.rect(px - 2, py + 2, 2, TILE - 4).fill(PALETTE.doorFrame);
          g.rect(px + TILE, py + 2, 2, TILE - 4).fill(PALETTE.doorFrame);
        } else {
          g.rect(px + 2, py - 2, TILE - 4, 2).fill(PALETTE.doorFrame);
          g.rect(px + 2, py + TILE, TILE - 4, 2).fill(PALETTE.doorFrame);
        }
      }
    }

    this.propsLayer.removeChildren();
    this.roomLayer.removeChildren();
    this.monitors.clear();

    // ── desks ──────────────────────────────────────────────────────────────
    // A pod seats two rows facing each other, so the desk is above the chair for the
    // back row and below it for the front row.
    for (const d of layout.desks) {
      const dg = new Graphics();
      const cx = d.tx * TILE;
      const cy = d.ty * TILE;
      const deskY = d.facing === "up" ? cy - TILE : cy + TILE;

      dg.rect(cx - TILE, deskY + 4, TILE * 3, TILE - 4).fill(PALETTE.deskWood);
      dg.rect(cx - TILE, deskY + TILE - 3, TILE * 3, 3).fill(PALETTE.deskWoodDark);

      // The partition between the two rows: low, so avatars stay visible over it.
      if (d.facing === "up") dg.rect(cx - TILE, deskY + 1, TILE * 3, 3).fill(PALETTE.metalDark);

      const mon = new Graphics();
      mon.position.set(cx, deskY);
      this.monitors.set(d.actorId, mon);
      this.drawMonitor(mon, state.actors.find((a) => a.actor.id === d.actorId));

      dg.rect(cx + 3, cy + 2, TILE - 6, TILE - 4).fill(PALETTE.chair);
      this.propsLayer.addChild(dg, mon);
    }

    // ── room labels ────────────────────────────────────────────────────────
    // The floor and the walls already say where a room is; this only says what it is.
    for (const r of layout.rooms) {
      const label = new Text({ text: `${roomIcon(r.room.kind)} ${r.room.name}`, style: ROOM_LABEL });
      label.position.set(r.tx * TILE + 2, r.ty * TILE + 1);
      this.roomLayer.addChild(label);
    }

    // ── props ──────────────────────────────────────────────────────────────
    for (const p of layout.props) {
      const pg = new Graphics();
      const x = p.tx * TILE;
      const y = p.ty * TILE;
      if (p.kind === "plant") {
        pg.rect(x + 5, y + 9, 6, 6).fill(PALETTE.pot).circle(x + 8, y + 6, 5).fill(PALETTE.plant).circle(x + 5, y + 8, 3).fill(PALETTE.plantDark);
      } else if (p.kind === "coffee") {
        pg.rect(x + 2, y + 2, 12, 14).fill(PALETTE.metalDark).rect(x + 4, y + 4, 8, 4).fill(PALETTE.monitor).rect(x + 6, y + 10, 4, 3).fill(0xf5f5f4);
        const steam = new Text({ text: "☕", style: new TextStyle({ fontSize: 8 }) });
        steam.position.set(x + 3, y - 10);
        this.propsLayer.addChild(steam);
      } else if (p.kind === "printer") {
        pg.rect(x + 1, y + 4, TILE - 2, TILE - 6).fill(PALETTE.metal);
        pg.rect(x + 3, y + 2, TILE - 6, 3).fill(PALETTE.metalDark);
        pg.rect(x + 3, y + 9, TILE - 6, 4).fill(PALETTE.paper);
      } else if (p.kind === "cabinet") {
        pg.rect(x + 1, y + 3, TILE - 2, TILE - 4).fill(PALETTE.metalDark);
        pg.rect(x + 2, y + 5, TILE - 4, 3).fill(PALETTE.metal);
        pg.rect(x + 2, y + 10, TILE - 4, 3).fill(PALETTE.metal);
      } else if (p.kind === "sofa") {
        pg.rect(x, y + 4, TILE * 3, TILE - 2).fill(PALETTE.carpet);
        pg.rect(x, y + 2, TILE * 3, 4).fill(PALETTE.roomStroke);
      } else if (p.kind === "table") {
        pg.roundRect(x, y + 3, TILE * 4, TILE * 2 - 4, 3).fill(PALETTE.deskWood);
        pg.roundRect(x + 2, y + 5, TILE * 4 - 4, TILE * 2 - 8, 2).fill(PALETTE.deskWoodDark);
      } else if (p.kind === "board") {
        pg.rect(x, y + 1, TILE * 14, TILE).fill(PALETTE.paper).stroke({ width: 1, color: 0x94a3b8 });
        this.propsLayer.addChild(pg);
        this.board.position.set(x + 4, y + 3);
        this.board.style.fill = 0x111318;
        this.propsLayer.addChild(this.board);
        // The title goes in the header strip under the top wall, beside the board.
        // It used to sit on the wall itself, which the room band now occupies.
        this.title.position.set(x, y - TILE + 3);
        this.propsLayer.addChild(this.title);
        continue;
      } else if (p.kind === "lamp") {
        this.lamp.position.set(x, y);
        this.propsLayer.addChild(this.lamp);
      }
      this.propsLayer.addChild(pg);
    }
  }

  /**
   * The repo name sits on the top wall, left of the CI lamp. A narrow office (few
   * desks, no rooms) leaves little room, so shorten rather than overlap.
   */
  private placeTitle(id: string) {
    this.title.text = id;
    const layout = this.layout;
    if (!layout) return;
    const lamp = layout.props.find((p) => p.kind === "lamp");
    const max = ((lamp ? lamp.tx : layout.cols) - 1) * TILE - 6;
    if (max <= 0 || this.title.width <= max) return;
    let t = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id; // drop the owner first
    this.title.text = t;
    while (this.title.width > max && t.length > 1) {
      t = t.slice(0, -1);
      this.title.text = `${t}…`;
    }
  }

  private drawMonitor(mon: Graphics, actor: ActorState | undefined) {
    const on = actor && actor.status !== "offline" && actor.status !== "idle" && !actor.roomId;
    const screen = on ? (actor?.actor.kind === "agent" ? PALETTE.monitorAgent : PALETTE.monitorOn) : 0x1f232b;
    mon.clear().rect(2, -4, TILE - 4, 10).fill(PALETTE.monitor).rect(3, -3, TILE - 6, 7).fill(screen).rect(6, 6, 4, 2).fill(0x374151);
    if (on) mon.rect(4, -2, 5, 1).fill(0xffffff).rect(4, 0, 7, 1).fill(0xffffff).rect(4, 2, 3, 1).fill(0xffffff);
  }

  private drawLamp(state: OfficeState) {
    const s = state.defaultBranchCi;
    const color = s === "success" ? PALETTE.ok : s === "failure" ? PALETTE.bad : s === "running" || s === "queued" ? PALETTE.warn : PALETTE.textDim;
    this.lamp.clear().rect(2, 2, 12, 14).fill(0x374151).rect(4, 4, 8, 10).fill(color);
    const label = s ? `CI ${s}` : "CI —";
    const existing = this.lamp.children[0] as Text | undefined;
    if (existing) existing.text = label;
    else {
      const t = new Text({ text: label, style: new TextStyle({ fontFamily: "monospace", fontSize: 8, fill: PALETTE.textDim }) });
      t.anchor.set(1, 0);
      t.position.set(-2, 4);
      this.lamp.addChild(t);
    }
  }

  private flashLamp() {
    let n = 0;
    const iv = setInterval(() => {
      this.lamp.alpha = this.lamp.alpha === 1 ? 0.3 : 1;
      if (++n > 8) {
        clearInterval(iv);
        this.lamp.alpha = 1;
      }
    }, 120);
  }

  private burstConfetti(x: number, y: number) {
    for (let i = 0; i < 28; i++) {
      const g = new Graphics().rect(0, 0, 2, 2).fill(PALETTE.confetti[i % PALETTE.confetti.length]!);
      g.position.set(x, y);
      this.fxLayer.addChild(g);
      this.confetti.push({ g, vx: (Math.random() - 0.5) * 90, vy: -60 - Math.random() * 60, life: 1.4 });
    }
  }

  private tick(dt: number) {
    this.t += dt;
    for (const av of this.avatars.values()) av.tick(dt);
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i]!;
      c.life -= dt;
      c.vy += 160 * dt;
      c.g.x += c.vx * dt;
      c.g.y += c.vy * dt;
      c.g.alpha = Math.max(0, c.life);
      if (c.life <= 0) {
        this.fxLayer.removeChild(c.g);
        c.g.destroy();
        this.confetti.splice(i, 1);
      }
    }
    // re-evaluate wander targets every few seconds so idle people drift around
    this.wanderTimer += dt;
    if (this.wanderTimer > 4 && this.state && this.layout) {
      this.wanderTimer = 0;
      const targets = this.resolveTargets(this.state, this.layout);
      for (const a of this.state.actors) {
        const av = this.avatars.get(a.actor.id);
        if (av && !av.walking && a.status !== "offline") {
          const t = targets.get(a.actor.id)!;
          av.moveTo(t.tx, t.ty);
        }
      }
    }
    // lamp blink while running
    if (this.state?.defaultBranchCi === "running") this.lamp.alpha = 0.7 + Math.sin(this.t * 5) * 0.3;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  // The office is one world container; panning moves it, zooming scales it.
  // Scale stays on quarter steps so pixel art never lands on a blurry fraction.

  private fitToHost() {
    if (!this.host || !this.layout) return;
    if (!this.cameraTouched) this.fitCamera();
    this.applyCamera();
  }

  /** Scale so the whole office is visible, centred. */
  private fitCamera() {
    if (!this.host || !this.layout) return;
    const W = this.layout.cols * TILE;
    const H = this.layout.rows * TILE;
    const raw = Math.min(this.host.clientWidth / W, this.host.clientHeight / H, this.opts.scale * 2);
    // integer scales above 2 (crispest), quarter steps below, so a crowded office still fits
    this.camera.scale = clamp(raw >= 2 ? Math.floor(raw) : Math.floor(raw / ZOOM_STEP) * ZOOM_STEP, MIN_SCALE, MAX_SCALE);
  }

  /** Zoom by `factor` around a point in host (css pixel) coordinates. */
  private zoomAt(factor: number, px: number, py: number) {
    const from = this.camera.scale;
    const to = clamp(Math.round((from * factor) / ZOOM_STEP) * ZOOM_STEP, MIN_SCALE, MAX_SCALE);
    if (to === from) return;
    // keep whatever sits under the pointer in place
    this.camera.x = px - ((px - this.camera.x) * to) / from;
    this.camera.y = py - ((py - this.camera.y) * to) / from;
    this.camera.scale = to;
    this.cameraTouched = true;
    this.applyCamera();
  }

  private applyCamera() {
    this.clampCamera();
    this.world.scale.set(this.camera.scale);
    // whole pixels only: fractional offsets smear the 16px tiles
    this.world.position.set(Math.round(this.camera.x), Math.round(this.camera.y));
  }

  /** Centre an axis while the office fits on it; otherwise keep its edges outside the viewport. */
  private clampCamera() {
    if (!this.host || !this.layout) return;
    const W = this.layout.cols * TILE * this.camera.scale;
    const H = this.layout.rows * TILE * this.camera.scale;
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    this.camera.x = W <= vw ? (vw - W) / 2 : clamp(this.camera.x, vw - W, 0);
    this.camera.y = H <= vh ? (vh - H) / 2 : clamp(this.camera.y, vh - H, 0);
  }

  private setupCamera() {
    if (this.opts.interactiveCamera === false || !this.host) return;
    const host = this.host;
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen; // the whole canvas drags, not just the floor

    let dragging = false;
    let travel = 0;
    let lastX = 0;
    let lastY = 0;
    stage.on("pointerdown", (e) => {
      dragging = true;
      travel = 0;
      this.dragged = false;
      lastX = e.global.x;
      lastY = e.global.y;
      host.style.cursor = "grabbing";
    });
    const endDrag = () => {
      dragging = false;
      host.style.cursor = "grab";
    };
    stage.on("pointerup", endDrag);
    stage.on("pointerupoutside", endDrag);
    stage.on("globalpointermove", (e) => {
      if (!dragging) return;
      const dx = e.global.x - lastX;
      const dy = e.global.y - lastY;
      lastX = e.global.x;
      lastY = e.global.y;
      travel += Math.abs(dx) + Math.abs(dy);
      if (travel < DRAG_SLOP) return; // a click on an avatar is still a click
      this.dragged = true;
      this.cameraTouched = true;
      this.camera.x += dx;
      this.camera.y += dy;
      this.applyCamera();
      this.hideTooltip();
    });

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = host.getBoundingClientRect();
      this.zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, ev.clientX - rect.left, ev.clientY - rect.top);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    const onDouble = () => this.resetCamera();
    host.addEventListener("dblclick", onDouble);
    host.style.cursor = "grab";
    host.style.touchAction = "none";
    this.cleanup.push(() => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDouble);
    });

    this.buildCameraControls(host);
  }

  /** Small +/-/reset cluster, so zoom is discoverable without a wheel. */
  private buildCameraControls(host: HTMLElement) {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      right: "8px",
      bottom: "8px",
      display: "flex",
      gap: "4px",
      zIndex: "10",
    } as CSSStyleDeclaration);
    const make = (label: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      Object.assign(b.style, {
        width: "26px",
        height: "26px",
        background: "rgba(20,22,28,0.9)",
        color: "#e8ebf2",
        border: "1px solid #4a5265",
        borderRadius: "4px",
        font: "14px/1 ui-monospace, monospace",
        cursor: "pointer",
      } as CSSStyleDeclaration);
      b.addEventListener("click", fn);
      bar.appendChild(b);
    };
    const centre = (): [number, number] => [host.clientWidth / 2, host.clientHeight / 2];
    make("−", "Zoom out", () => this.zoomAt(0.8, ...centre()));
    make("+", "Zoom in", () => this.zoomAt(1.25, ...centre()));
    make("⤢", "Fit the whole office", () => this.resetCamera());
    host.appendChild(bar);
    this.cleanup.push(() => bar.remove());
  }

  private showTooltip(av: Avatar, x: number, y: number) {
    if (!this.tooltipEl) return;
    const html = this.opts.tooltip ? this.opts.tooltip(av.state) : defaultTooltip(av.state);
    if (!html) return this.hideTooltip();
    this.tooltipEl.innerHTML = html;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${x + 12}px`;
    this.tooltipEl.style.top = `${y + 12}px`;
  }

  private hideTooltip() {
    if (this.tooltipEl) this.tooltipEl.style.display = "none";
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function layoutKey(s: OfficeState): string {
  return s.actors.map((a) => `${a.actor.id}:${a.status === "offline" ? 0 : 1}`).sort().join("|") + "#" + s.rooms.map((r) => r.id).join("|");
}

function boardText(s: OfficeState): string {
  const online = s.actors.filter((a) => a.status !== "offline").length;
  const agents = s.actors.filter((a) => a.actor.kind === "agent" && a.status !== "offline").length;
  return `${online} online · ${agents} agents · ${s.pullRequests.length} PRs · ${s.issues.length} issues`;
}

function roomIcon(kind: string): string {
  return kind === "focus" ? "🎧" : kind === "meeting" ? "📋" : kind === "team" ? "👥" : "💬";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function defaultTooltip(a: ActorState): string {
  const name = esc(a.actor.name ?? a.actor.id);
  const kind = a.actor.kind === "agent" ? ` <span style="color:#c084fc">${esc(a.actor.agent?.provider ?? "agent")}</span>` : "";
  const detail = a.detail ? `<div style="color:#9aa3b5">${esc(a.detail)}</div>` : "";
  const trail = a.agentTrail?.length
    ? `<div style="margin-top:4px;color:#9aa3b5">${a.agentTrail.slice(-4).map((c) => `› ${esc(c.tool)} ${esc(c.target ?? "")}`).join("<br>")}</div>`
    : "";
  return `<b>${name}</b>${kind}<div>${esc(a.status)}</div>${detail}${trail}`;
}
