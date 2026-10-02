// Page strip above the board: RTL spread thumbnails. Click selects, drag reorders,
// "+" appends; arrows scroll when the name has more spreads than fit.
import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  type CanvasTexture,
} from '@iwsdk/core';
import { readingSpreads, spreadIndexOf } from './doc.js';
import { canvasTexture, ctx2d, makeCanvas, type Project } from './project.js';

export const STRIP_W = 0.74;
export const STRIP_H = 0.1;
const TW = 0.04;
const TH = TW * (212 / 150);
const STEP = 2 * TW + 0.016;
const VISIBLE = 7;
const ARROW_W = 0.03;
const CANVAS_W = 1480;
const CANVAS_H = 200;
const PX = CANVAS_W / STRIP_W;
const TILE_Y = 0.008;

export interface NavigatorEvents {
  select(pageId: string): void;
  append(): void;
  reorder(pageId: string, index: number): void;
}

type Hit =
  | { kind: 'page'; id: string }
  | { kind: 'append' }
  | { kind: 'scroll'; dir: -1 | 1 }
  | null;

export class Navigator {
  readonly root = new Group();
  readonly hitPlane: Mesh;
  private readonly bgCanvas = makeCanvas(CANVAS_W, CANVAS_H);
  private readonly bgTex: CanvasTexture = canvasTexture(this.bgCanvas);
  private readonly tiles: Mesh[] = [];
  private readonly tileGeo = new PlaneGeometry(TW, TH);
  private readonly ghost: Mesh;
  private readonly marker: Mesh;
  private start = 0;
  private project: Project | null = null;
  private press: { hit: Hit; x: number; dragging: boolean } | null = null;
  private readonly local = new Vector3();

  constructor(private readonly events: NavigatorEvents) {
    const bg = new Mesh(
      new PlaneGeometry(STRIP_W, STRIP_H),
      new MeshBasicMaterial({ map: this.bgTex, transparent: true }),
    );
    bg.raycast = () => undefined;
    this.root.add(bg);
    for (let i = 0; i < VISIBLE * 2 + 1; i++) {
      const tile = new Mesh(this.tileGeo, new MeshBasicMaterial({ transparent: true }));
      tile.position.z = 0.001;
      tile.raycast = () => undefined;
      tile.visible = false;
      this.tiles.push(tile);
      this.root.add(tile);
    }
    this.ghost = new Mesh(this.tileGeo, new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false }));
    this.ghost.renderOrder = 40;
    this.ghost.visible = false;
    this.ghost.raycast = () => undefined;
    this.marker = new Mesh(
      new PlaneGeometry(0.003, TH + 0.012),
      new MeshBasicMaterial({ color: 0x4c8dff, depthTest: false }),
    );
    this.marker.renderOrder = 41;
    this.marker.visible = false;
    this.marker.raycast = () => undefined;
    this.hitPlane = new Mesh(
      new PlaneGeometry(STRIP_W, STRIP_H),
      new MeshBasicMaterial({ visible: false, side: DoubleSide }),
    );
    this.hitPlane.position.z = 0.003;
    this.hitPlane.name = 'PageStripHitPlane';
    this.root.add(this.ghost, this.marker, this.hitPlane);
  }

  private get originX(): number {
    return ((VISIBLE - 1) * STEP) / 2;
  }

  private spreadX(s: number): number {
    return this.originX - (s - this.start) * STEP;
  }

  /** Board-strip x of page `k` (reading index). */
  private pageX(k: number): number {
    const s = k === 0 ? 0 : Math.floor((k + 1) / 2);
    const right = k > 0 && k % 2 === 1;
    return this.spreadX(s) + (right ? TW / 2 + 0.001 : -TW / 2 - 0.001);
  }

  /** Re-layout; `follow` scrolls so the current spread stays visible. */
  refresh(project: Project, follow = true): void {
    this.project = project;
    const spreads = readingSpreads(project.order);
    const current = spreadIndexOf(project.order, project.currentPage);
    const total = spreads.length + 1;
    if (follow && current < this.start) this.start = current;
    if (follow && current >= this.start + VISIBLE) this.start = current - VISIBLE + 1;
    this.start = Math.max(0, Math.min(this.start, Math.max(0, total - VISIBLE)));
    this.draw(project, current, spreads.length);
    let t = 0;
    for (let k = 0; k < project.order.length; k++) {
      const s = k === 0 ? 0 : Math.floor((k + 1) / 2);
      if (s < this.start || s >= this.start + VISIBLE) continue;
      const tile = this.tiles[t++];
      if (tile == null) break;
      const page = project.pages.get(project.order[k]!)!;
      const mat = tile.material as MeshBasicMaterial;
      if (mat.map !== page.thumbTex) {
        mat.map = page.thumbTex;
        mat.needsUpdate = true;
      }
      tile.position.set(this.pageX(k), TILE_Y, 0.001);
      tile.visible = true;
    }
    for (; t < this.tiles.length; t++) this.tiles[t]!.visible = false;
  }

  private draw(project: Project, current: number, spreadCount: number): void {
    const c = ctx2d(this.bgCanvas);
    c.clearRect(0, 0, CANVAS_W, CANVAS_H);
    c.fillStyle = 'rgba(24,27,32,0.92)';
    roundRect(c, 0, 0, CANVAS_W, CANVAS_H, 26);
    c.fill();
    const toPx = (x: number) => (x + STRIP_W / 2) * PX;
    const toPy = (y: number) => (STRIP_H / 2 - y) * PX;
    // Current spread highlight.
    if (current >= this.start && current < this.start + VISIBLE) {
      const cx = toPx(this.spreadX(current));
      c.fillStyle = 'rgba(76,141,255,0.22)';
      roundRect(c, cx - (STEP / 2 - 0.003) * PX, 8, (STEP - 0.006) * PX, CANVAS_H - 16, 14);
      c.fill();
    }
    c.font = '600 22px "M PLUS 1p", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k < project.order.length; k++) {
      const s = k === 0 ? 0 : Math.floor((k + 1) / 2);
      if (s < this.start || s >= this.start + VISIBLE) continue;
      const x = toPx(this.pageX(k));
      const id = project.order[k]!;
      const selected = id === project.currentPage;
      c.fillStyle = selected ? '#8fb6ff' : '#aeb5c0';
      c.fillText(String(k + 1), x, toPy(TILE_Y - TH / 2 - 0.009));
      if (selected) {
        c.strokeStyle = '#4c8dff';
        c.lineWidth = 6;
        c.strokeRect(x - (TW / 2) * PX - 4, toPy(TILE_Y + TH / 2) - 4, TW * PX + 8, TH * PX + 8);
      }
    }
    // Blank slot next to page 1.
    if (this.start === 0) {
      const x = toPx(this.spreadX(0) + TW / 2 + 0.001);
      c.fillStyle = 'rgba(255,255,255,0.06)';
      c.fillRect(x - (TW / 2) * PX, toPy(TILE_Y + TH / 2), TW * PX, TH * PX);
    }
    // Append tile.
    if (spreadCount >= this.start && spreadCount < this.start + VISIBLE) {
      const x = toPx(this.spreadX(spreadCount) + TW / 2);
      c.strokeStyle = '#6f7a8a';
      c.lineWidth = 3;
      c.setLineDash([10, 8]);
      c.strokeRect(x - (TW / 2) * PX, toPy(TILE_Y + TH / 2), TW * PX, TH * PX);
      c.setLineDash([]);
      c.fillStyle = '#cfd5de';
      c.font = '300 64px "M PLUS 1p", sans-serif';
      c.fillText('+', x, toPy(TILE_Y) + 2);
      c.font = '600 22px "M PLUS 1p", sans-serif';
    }
    // Scroll arrows.
    c.fillStyle = '#cfd5de';
    c.font = '700 44px "M PLUS 1p", sans-serif';
    const canLater = this.start + VISIBLE < spreadCount + 1;
    const canEarlier = this.start > 0;
    c.globalAlpha = canLater ? 1 : 0.2;
    c.fillText('‹', ARROW_W * PX * 0.5, CANVAS_H / 2);
    c.globalAlpha = canEarlier ? 1 : 0.2;
    c.fillText('›', CANVAS_W - ARROW_W * PX * 0.5, CANVAS_H / 2);
    c.globalAlpha = 1;
    this.bgTex.needsUpdate = true;
  }

  private hitAt(x: number, y: number): Hit {
    const project = this.project;
    if (project == null) return null;
    if (x < -STRIP_W / 2 + ARROW_W) return { kind: 'scroll', dir: 1 };
    if (x > STRIP_W / 2 - ARROW_W) return { kind: 'scroll', dir: -1 };
    if (Math.abs(y - TILE_Y) > TH / 2 + 0.01) return null;
    for (let k = 0; k < project.order.length; k++) {
      const s = k === 0 ? 0 : Math.floor((k + 1) / 2);
      if (s < this.start || s >= this.start + VISIBLE) continue;
      if (Math.abs(x - this.pageX(k)) <= TW / 2 + 0.002) return { kind: 'page', id: project.order[k]! };
    }
    const spreads = readingSpreads(project.order).length;
    if (Math.abs(x - (this.spreadX(spreads) + TW / 2)) <= TW / 2 + 0.004) return { kind: 'append' };
    return null;
  }

  private toLocal(world: Vector3): Vector3 {
    return this.root.worldToLocal(this.local.copy(world));
  }

  pointerDown(world: Vector3): void {
    const p = this.toLocal(world);
    this.press = { hit: this.hitAt(p.x, p.y), x: p.x, dragging: false };
  }

  pointerMove(world: Vector3): void {
    const press = this.press;
    if (press == null || press.hit?.kind !== 'page' || this.project == null) return;
    const p = this.toLocal(world);
    if (!press.dragging && Math.abs(p.x - press.x) < 0.012) return;
    press.dragging = true;
    const page = this.project.pages.get(press.hit.id);
    const mat = this.ghost.material as MeshBasicMaterial;
    if (page != null && mat.map !== page.thumbTex) {
      mat.map = page.thumbTex;
      mat.needsUpdate = true;
    }
    this.ghost.position.set(p.x, TILE_Y + 0.006, 0.006);
    this.ghost.visible = true;
    const index = this.insertIndex(p.x);
    this.marker.position.set(this.boundaryX(index), TILE_Y, 0.005);
    this.marker.visible = true;
  }

  pointerUp(world: Vector3 | null): void {
    const press = this.press;
    this.press = null;
    this.ghost.visible = false;
    this.marker.visible = false;
    if (press == null || this.project == null) return;
    const hit = press.hit;
    if (press.dragging && hit?.kind === 'page' && world != null) {
      const p = this.toLocal(world);
      const from = this.project.order.indexOf(hit.id);
      let to = this.insertIndex(p.x);
      if (from < to) to -= 1;
      if (from !== to) this.events.reorder(hit.id, to);
      return;
    }
    if (hit == null) return;
    if (hit.kind === 'page') this.events.select(hit.id);
    else if (hit.kind === 'append') this.events.append();
    else this.scroll(hit.dir);
  }

  scroll(dir: -1 | 1): void {
    if (this.project == null) return;
    const total = readingSpreads(this.project.order).length + 1;
    this.start = Math.max(0, Math.min(this.start + dir * (VISIBLE - 1), Math.max(0, total - VISIBLE)));
    this.refresh(this.project, false);
  }

  /** Reading-order insert index for a strip x (pages to the right come first). */
  private insertIndex(x: number): number {
    const order = this.project?.order ?? [];
    let index = 0;
    for (let k = 0; k < order.length; k++) if (this.pageX(k) > x) index = k + 1;
    return index;
  }

  private boundaryX(index: number): number {
    const order = this.project?.order ?? [];
    if (order.length === 0) return this.originX;
    if (index <= 0) return this.pageX(0) + TW / 2 + 0.002;
    if (index >= order.length) return this.pageX(order.length - 1) - TW / 2 - 0.002;
    return (this.pageX(index - 1) + this.pageX(index)) / 2;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

