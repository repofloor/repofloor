import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { ActorState, ActivityStatus } from "@repofloor/protocol";
import { PALETTE, paletteFor, lerp, shade } from "./palette.js";
import { TILE } from "./layout.js";

const LABEL_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 9, fill: PALETTE.text });
const BUBBLE_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 8, fill: 0x111318 });
const EMOJI_STYLE = new TextStyle({ fontSize: 12 });

/**
 * One actor on screen. Procedurally drawn (no textures) so the project needs no asset pipeline.
 * Humans: head/hair/body/legs. Agents: boxy robot with antenna and glowing visor.
 */
export class Avatar extends Container {
  readonly actorId: string;
  private body = new Graphics();
  private face = new Graphics();
  private statusIcon = new Graphics();
  private bubble = new Container();
  private bubbleBg = new Graphics();
  private bubbleText = new Text({ text: "", style: BUBBLE_STYLE });
  private nameLabel: Text;
  private emoji = new Text({ text: "", style: EMOJI_STYLE });
  private ring = new Graphics();

  private isAgent: boolean;
  private colors: ReturnType<typeof paletteFor>;
  private t = Math.random() * 100;
  private walkFrom = { x: 0, y: 0 };
  private walkTo = { x: 0, y: 0 };
  private walkT = 1;
  private jump = 0;
  state: ActorState;
  private trailIdx = 0;
  private trailTimer = 0;

  constructor(state: ActorState) {
    super();
    this.state = state;
    this.actorId = state.actor.id;
    this.isAgent = state.actor.kind === "agent";
    this.colors = paletteFor(state.actor.id);
    this.nameLabel = new Text({ text: shortName(state), style: LABEL_STYLE });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.y = 4;
    this.nameLabel.resolution = 2;
    this.emoji.anchor.set(0.5, 1);
    this.emoji.y = -26;
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.bubble.visible = false;
    this.addChild(this.ring, this.body, this.face, this.statusIcon, this.nameLabel, this.emoji, this.bubble);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.draw();
  }

  /**
   * Stagger the name label onto a second line.
   *
   * Desks in a pod are three tiles apart and names are wider than that, so adjacent
   * labels ran into each other and the floor read as one smear of text. Alternating
   * rows costs nothing and fixes it without shrinking the type.
   */
  setLabelRow(row: number) {
    this.nameLabel.y = 4 + (row % 2) * 9;
  }

  /** Tile position the avatar should walk to. */
  moveTo(tx: number, ty: number, instant = false) {
    const x = tx * TILE + TILE / 2;
    const y = ty * TILE + TILE;
    if (instant) {
      this.position.set(x, y);
      this.walkFrom = { x, y };
      this.walkTo = { x, y };
      this.walkT = 1;
      return;
    }
    if (Math.abs(this.walkTo.x - x) < 0.5 && Math.abs(this.walkTo.y - y) < 0.5) return;
    this.walkFrom = { x: this.position.x, y: this.position.y };
    this.walkTo = { x, y };
    this.walkT = 0;
  }

  get walking(): boolean {
    return this.walkT < 1;
  }

  setState(state: ActorState) {
    const prev = this.state;
    this.state = state;
    this.emoji.text = state.actor.emoji ?? "";
    this.nameLabel.text = shortName(state);
    if (prev.status !== state.status) {
      if (state.status === "celebrating") this.jump = 1;
      this.drawStatus();
    }
    this.alpha = state.status === "offline" ? 0.35 : 1;
  }

  /** Called every frame. `dt` is in seconds. */
  tick(dt: number) {
    this.t += dt;
    // walking
    if (this.walkT < 1) {
      const dist = Math.hypot(this.walkTo.x - this.walkFrom.x, this.walkTo.y - this.walkFrom.y);
      const speed = 70; // px/s
      this.walkT = Math.min(1, this.walkT + (dt * speed) / Math.max(dist, 1));
      const e = this.walkT < 0.5 ? 2 * this.walkT * this.walkT : -1 + (4 - 2 * this.walkT) * this.walkT;
      this.position.set(lerp(this.walkFrom.x, this.walkTo.x, e), lerp(this.walkFrom.y, this.walkTo.y, e));
      this.body.y = Math.abs(Math.sin(this.t * 14)) * -2;
      this.face.y = this.body.y;
      this.scale.x = this.walkTo.x < this.walkFrom.x ? -1 : 1;
      this.nameLabel.scale.x = this.scale.x; // keep text readable
      this.emoji.scale.x = this.scale.x;
      this.bubble.scale.x = this.scale.x;
      return;
    }
    this.scale.x = 1;
    this.nameLabel.scale.x = 1;
    this.emoji.scale.x = 1;
    this.bubble.scale.x = 1;

    const s = this.state.status;
    // idle bob / typing
    if (s === "coding" || s === "building") {
      this.body.y = Math.round(Math.sin(this.t * 18) * 0.6);
      this.face.y = this.body.y;
    } else if (s === "offline") {
      this.body.y = 0;
      this.face.y = 0;
    } else {
      this.body.y = Math.round(Math.sin(this.t * 2.2)) * 0.5;
      this.face.y = this.body.y;
    }
    // celebrate jump
    if (this.jump > 0) {
      this.jump = Math.max(0, this.jump - dt * 1.4);
      const h = Math.sin(this.jump * Math.PI * 3) * 8 * this.jump;
      this.body.y -= Math.abs(h);
      this.face.y = this.body.y;
      if (this.jump === 0 && this.state.status === "celebrating") this.jump = 1; // keep jumping while celebrating
    }
    // status icon animation
    this.statusIcon.rotation = s === "building" ? this.t * 3 : 0;
    this.statusIcon.y = -30 + (s === "blocked" ? Math.sin(this.t * 6) * 1.5 : 0);
    this.statusIcon.alpha = s === "focus" ? 0.6 + Math.sin(this.t * 2) * 0.2 : 1;
    this.ring.visible = s === "coding" && this.isAgent;
    this.ring.alpha = 0.35 + Math.sin(this.t * 4) * 0.25;

    // agent trail bubble
    const trail = this.state.agentTrail;
    if (this.isAgent && trail && trail.length && s !== "offline" && s !== "idle") {
      this.trailTimer += dt;
      if (this.trailTimer > 1.6) {
        this.trailTimer = 0;
        this.trailIdx = (this.trailIdx + 1) % trail.length;
      }
      const call = trail[Math.min(this.trailIdx, trail.length - 1)]!;
      const txt = `${call.tool}${call.target ? " " + truncate(call.target, 22) : ""}`;
      if (this.bubbleText.text !== txt) {
        this.bubbleText.text = txt;
        this.drawBubble();
      }
      this.bubble.visible = true;
    } else if (this.state.detail && (s === "blocked" || s === "celebrating")) {
      const txt = truncate(this.state.detail, 24);
      if (this.bubbleText.text !== txt) {
        this.bubbleText.text = txt;
        this.drawBubble();
      }
      this.bubble.visible = true;
    } else {
      this.bubble.visible = false;
    }
  }

  private drawBubble() {
    const w = this.bubbleText.width + 8;
    const h = this.bubbleText.height + 4;
    this.bubbleBg.clear().roundRect(-w / 2, -44 - h, w, h, 2).fill(0xffffff).moveTo(-3, -44).lineTo(3, -44).lineTo(0, -40).fill(0xffffff);
    this.bubbleText.position.set(-w / 2 + 4, -44 - h + 2);
  }

  private draw() {
    const g = this.body.clear();
    const c = this.colors;

    // Shadow first, so everything else lands on top of it. Without one an avatar
    // hovers over the floor no matter how well the rest is drawn — and with a floor
    // plan under it, hovering is exactly what it looked like.
    g.ellipse(0, -1, 6, 2.5).fill({ color: PALETTE.shadow, alpha: 0.38 });

    if (this.isAgent) {
      // robot: legs, boxy body, head with antenna
      g.rect(-5, -4, 3, 4).fill(0x4b5563).rect(2, -4, 3, 4).fill(0x4b5563);
      g.rect(-6, -14, 12, 10).fill(0x9ca3af).rect(-6, -14, 12, 2).fill(0xd1d5db);
      g.rect(-4, -11, 8, 5).fill(c.accent); // chest panel
      g.rect(-5, -23, 10, 9).fill(0xcbd5e1).rect(-5, -23, 10, 1).fill(0xf1f5f9);
      g.rect(-1, -27, 2, 4).fill(0x6b7280).circle(0, -28, 1.5).fill(PALETTE.purple);
      this.face.clear().rect(-4, -21, 8, 3).fill(PALETTE.monitorAgent).rect(-3, -20, 2, 1).fill(0xffffff).rect(1, -20, 2, 1).fill(0xffffff);
      this.ring.clear().circle(0, -12, 13).stroke({ width: 1, color: PALETTE.purple });
    } else {
      // human: legs, body, arms, head, hair
      g.rect(-4, -4, 3, 4).fill(0x1f2937).rect(1, -4, 3, 4).fill(0x1f2937);
      g.rect(-5, -14, 10, 10).fill(c.shirt);
      // A darker side and a lighter shoulder: the body stops being one flat block,
      // which is most of why the old avatars read as paper cut-outs.
      g.rect(2, -14, 3, 10).fill(shade(c.shirt, -0.18));
      g.rect(-5, -14, 10, 2).fill(shade(c.shirt, 0.16));
      g.rect(-7, -13, 2, 7).fill(c.skin).rect(5, -13, 2, 7).fill(c.skin);
      g.rect(-4, -23, 8, 9).fill(c.skin);
      g.rect(2, -23, 2, 9).fill(shade(c.skin, -0.14));
      g.rect(-5, -24, 10, 4).fill(c.hair).rect(-5, -21, 2, 3).fill(c.hair).rect(3, -21, 2, 3).fill(c.hair);
      g.rect(-5, -24, 10, 1).fill(shade(c.hair, 0.22));
      this.face.clear().rect(-2, -19, 1, 1).fill(0x111).rect(1, -19, 1, 1).fill(0x111);
      this.ring.clear();
    }
    this.drawStatus();
  }

  private drawStatus() {
    const g = this.statusIcon.clear();
    const s: ActivityStatus = this.state.status;
    switch (s) {
      case "building":
        g.circle(0, 0, 4).stroke({ width: 2, color: PALETTE.warn });
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          g.rect(Math.cos(a) * 5 - 1, Math.sin(a) * 5 - 1, 2, 2).fill(PALETTE.warn);
        }
        break;
      case "blocked":
        g.rect(-1, -5, 2, 6).fill(PALETTE.bad).rect(-1, 2, 2, 2).fill(PALETTE.bad);
        break;
      case "reviewing":
        g.circle(-1, -1, 3).stroke({ width: 1.5, color: PALETTE.info }).moveTo(1, 1).lineTo(4, 4).stroke({ width: 2, color: PALETTE.info });
        break;
      case "discussing":
        g.roundRect(-5, -4, 10, 7, 2).fill(PALETTE.text).rect(-2, 3, 2, 2).fill(PALETTE.text);
        g.rect(-3, -2, 1, 1).fill(0x333).rect(-1, -2, 1, 1).fill(0x333).rect(1, -2, 1, 1).fill(0x333);
        break;
      case "focus":
        g.roundRect(-5, -3, 10, 2, 1).fill(PALETTE.purple).rect(-6, -2, 2, 4).fill(PALETTE.purple).rect(4, -2, 2, 4).fill(PALETTE.purple);
        break;
      case "celebrating":
        g.star(0, 0, 5, 5, 2).fill(PALETTE.warn);
        break;
      case "in_room":
        g.roundRect(-4, -3, 8, 6, 1).stroke({ width: 1, color: PALETTE.textDim });
        break;
      case "offline":
        g.rect(-3, -1, 6, 2).fill(PALETTE.textDim);
        break;
      default:
        break; // idle, coding → no icon
    }
  }
}

function shortName(s: ActorState): string {
  const n = s.actor.name ?? s.actor.id;
  if (s.actor.kind === "agent") return `🤖 ${n.replace(/^agent:[^:]+:/, "")}`;
  return truncate(n, 12);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
