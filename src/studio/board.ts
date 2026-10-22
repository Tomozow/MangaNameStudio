// Display layer of the drawing board: a fixed "window" in the rig, with the
// spread inside a zoom group clipped to that window. No tool logic lives here.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  LinearFilter,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Plane,
  PlaneGeometry,
  RingGeometry,
  Vector3,
  type Material,
} from '@iwsdk/core';
import {
  PAGE_H,
  PAGE_W,
  PX_PER_M,
  RASTER_H,
  RASTER_W,
  SPREAD_GAP,
  type Side,
  type TextBox,
  type ToolId,
} from './doc.js';
import { canvasTexture, ctx2d, makeCanvas, template, type PageRt } from './project.js';
import { drawTexts } from './text-render.js';

/** Texture re-uploaded every frame while drawing: skip mipmap regeneration. */
function liveTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = canvasTexture(canvas);
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  return t;
}

export const WINDOW_W = 0.72;
export const WINDOW_H = 0.5;
/** Paper surface height in board-root space. */
export const PAPER_Z = 0.002;
const LASSO_MAX = 4096;
/** Window edges as (normal x, normal y, point x, point y), board-root local. */
const CLIP_DEFS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, -WINDOW_W / 2, 0],
  [-1, 0, WINDOW_W / 2, 0],
  [0, 1, 0, -WINDOW_H / 2],
  [0, -1, 0, WINDOW_H / 2],
];

export interface SlotRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function line(points: number, color: number, loop: boolean): Line {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points * 3), 3));
  geometry.setDrawRange(0, 0);
  const material = new LineBasicMaterial({ color, depthTest: false, transparent: true });
  const obj = loop ? new LineLoop(geometry, material) : new Line(geometry, material);
  obj.renderOrder = 20;
  obj.frustumCulled = false;
  return obj;
}

function setLinePoints(obj: Line, pts: ArrayLike<number>, count: number, z: number): void {
  const attr = obj.geometry.getAttribute('position') as BufferAttribute;
  const arr = attr.array as Float32Array;
  const n = Math.min(count, arr.length / 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = pts[i * 2]!;
    arr[i * 3 + 1] = pts[i * 2 + 1]!;
    arr[i * 3 + 2] = z;
  }
  attr.needsUpdate = true;
  obj.geometry.setDrawRange(0, n);
  obj.geometry.computeBoundingSphere();
}

class SlotView {
  readonly group = new Group();
  readonly paper: Mesh;
  readonly ink: Mesh;
  readonly text: Mesh;
  readonly blank: Mesh;
  readonly label: Mesh;
  readonly highlight: LineLoop;
  readonly textCanvas = makeCanvas(RASTER_W, RASTER_H);
  readonly textTex: CanvasTexture = canvasTexture(this.textCanvas);
  private readonly labelCanvas = makeCanvas(160, 64);
  private readonly labelTex = canvasTexture(this.labelCanvas);
  page: PageRt | null = null;
  isBlank = false;
  private labelText = '';

  constructor(geometry: PlaneGeometry, templateTex: CanvasTexture, clip: Plane[]) {
    const mat = (opts: ConstructorParameters<typeof MeshBasicMaterial>[0]) =>
      new MeshBasicMaterial({ ...opts, clippingPlanes: clip });
    this.paper = new Mesh(geometry, mat({ map: templateTex }));
    this.ink = new Mesh(geometry, mat({ transparent: true, depthWrite: false }));
    this.ink.position.z = 0.0006;
    this.text = new Mesh(geometry, mat({ map: this.textTex, transparent: true, depthWrite: false }));
    this.text.position.z = 0.0018;
    this.blank = new Mesh(geometry, mat({ color: 0x2b2f36, transparent: true, opacity: 0.55 }));
    this.label = new Mesh(
      new PlaneGeometry(0.06, 0.024),
      mat({ map: this.labelTex, transparent: true, depthWrite: false }),
    );
    this.label.position.set(0, -PAGE_H / 2 - 0.018, 0.001);
    this.highlight = line(4, 0x4c8dff, true) as LineLoop;
    const hw = PAGE_W / 2 + 0.004;
    const hh = PAGE_H / 2 + 0.004;
    setLinePoints(this.highlight, [-hw, -hh, hw, -hh, hw, hh, -hw, hh], 4, 0.002);
    (this.highlight.material as LineBasicMaterial).clippingPlanes = clip;
    this.ink.renderOrder = 1;
    this.text.renderOrder = 3;
    for (const obj of [this.paper, this.ink, this.text, this.blank, this.label, this.highlight]) {
      obj.raycast = () => undefined;
      this.group.add(obj);
    }
  }

  show(page: PageRt | null, blank: boolean, number: number, selected: boolean): void {
    if (this.page !== page) this.page?.releaseInkTexture();
    this.page = page;
    this.isBlank = blank;
    this.group.visible = page != null || blank;
    this.paper.visible = page != null;
    this.ink.visible = page != null;
    this.text.visible = page != null;
    this.blank.visible = blank && page == null;
    this.label.visible = page != null;
    this.highlight.visible = selected && page != null;
    const inkMat = this.ink.material as MeshBasicMaterial;
    const map = page?.inkTex ?? null;
    if (inkMat.map !== map) {
      inkMat.map = map;
      inkMat.needsUpdate = true;
    }
    const label = page != null ? String(number) : '';
    if (label !== this.labelText) {
      this.labelText = label;
      const ctx = ctx2d(this.labelCanvas);
      ctx.clearRect(0, 0, 160, 64);
      ctx.fillStyle = '#d9dde4';
      ctx.font = '600 40px "M PLUS 1p", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 80, 34);
      this.labelTex.needsUpdate = true;
    }
  }

  renderTexts(texts: readonly TextBox[], frames: boolean, selectedId: string | null): void {
    const ctx = ctx2d(this.textCanvas);
    ctx.clearRect(0, 0, RASTER_W, RASTER_H);
    drawTexts(ctx, texts, 1);
    if (frames) {
      for (const t of texts) {
        const selected = t.id === selectedId;
        ctx.save();
        ctx.lineWidth = selected ? 4 : 2;
        ctx.strokeStyle = selected ? '#2f7dff' : 'rgba(47,125,255,0.55)';
        ctx.setLineDash(selected ? [] : [10, 8]);
        ctx.strokeRect(t.x, t.y, t.w, t.h);
        if (selected) {
          ctx.fillStyle = '#2f7dff';
          const hx = t.mode === 'vertical' ? t.x : t.x + t.w;
          ctx.fillRect(hx - 18, t.y + t.h - 18, 36, 36);
        }
        ctx.restore();
      }
    }
    this.textTex.needsUpdate = true;
  }
}

/** Where a pen tip will land: a ring that closes in on a dot as the tip approaches. */
class TipMarker {
  readonly root = new Group();
  private readonly ring: Mesh;
  private readonly ringMat = new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
  private readonly dotMat = new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });

  constructor(ringGeo: RingGeometry, dotGeo: CircleGeometry) {
    this.ring = new Mesh(ringGeo, this.ringMat);
    const dot = new Mesh(dotGeo, this.dotMat);
    dot.scale.setScalar(0.0012);
    for (const m of [this.ring, dot]) {
      m.renderOrder = 31;
      m.raycast = () => undefined;
      this.root.add(m);
    }
    this.root.visible = false;
  }

  show(x: number, y: number, height: number, touching: boolean, hoverRange: number): void {
    const near = 1 - Math.min(1, height / hoverRange);
    this.ring.scale.setScalar(0.0025 + height * 0.22);
    this.ringMat.opacity = touching ? 0.95 : 0.3 + 0.55 * near;
    const color = touching ? 0x4c8dff : 0xffffff;
    this.ringMat.color.setHex(color);
    this.dotMat.color.setHex(color);
    this.root.position.set(x, y, 0.005);
    this.root.visible = true;
  }
}

export interface ClipView {
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rot: number;
}

export class BoardView {
  readonly root = new Group();
  readonly content = new Group();
  readonly hitPlane: Mesh;
  readonly clipPlanes = [new Plane(), new Plane(), new Plane(), new Plane()];
  readonly slots: SlotView[];
  readonly strokeCanvas = makeCanvas(RASTER_W, RASTER_H);
  readonly strokeCtx = ctx2d(this.strokeCanvas);
  readonly strokeTex = liveTexture(this.strokeCanvas);
  readonly strokeMesh: Mesh;
  private readonly cursor: Group;
  private readonly cursorInner: Mesh;
  private readonly marquee = line(LASSO_MAX, 0x2f7dff, false);
  private readonly clipOutline = line(4, 0x2f7dff, true);
  private readonly clipMesh: Mesh;
  private readonly handles: Mesh[] = [];
  private readonly rotateKnob: Mesh;
  private readonly tipMarkers: Record<Side, TipMarker>;
  private readonly tmp = new Vector3();
  private readonly lassoPts = new Float32Array(LASSO_MAX * 2);
  zoom = 1;
  panX = 0;
  panY = 0;
  single = false;

  constructor() {
    const pageGeometry = new PlaneGeometry(PAGE_W, PAGE_H);
    const templateTex = canvasTexture(template());
    this.slots = [0, 1].map(() => new SlotView(pageGeometry, templateTex, this.clipPlanes));
    for (const slot of this.slots) this.content.add(slot.group);

    this.strokeMesh = new Mesh(
      pageGeometry,
      new MeshBasicMaterial({
        map: this.strokeTex,
        transparent: true,
        depthWrite: false,
        clippingPlanes: this.clipPlanes,
      }),
    );
    this.strokeMesh.position.z = 0.0012;
    this.strokeMesh.renderOrder = 2;
    this.strokeMesh.visible = false;
    this.strokeMesh.raycast = () => undefined;

    const bezel = new Mesh(
      new PlaneGeometry(WINDOW_W + 0.03, WINDOW_H + 0.03),
      new MeshBasicMaterial({ color: 0x1c1f24 }),
    );
    bezel.position.z = -0.004;
    bezel.raycast = () => undefined;
    const backdrop = new Mesh(
      new PlaneGeometry(WINDOW_W, WINDOW_H),
      new MeshBasicMaterial({ color: 0x3a3f47 }),
    );
    backdrop.position.z = -0.002;
    backdrop.raycast = () => undefined;
    this.hitPlane = new Mesh(
      new PlaneGeometry(WINDOW_W, WINDOW_H),
      new MeshBasicMaterial({ visible: false, side: DoubleSide }),
    );
    this.hitPlane.position.z = 0.004;
    this.hitPlane.name = 'BoardHitPlane';

    const ringMat = new MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true });
    const ringMat2 = new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
    const outer = new Mesh(new RingGeometry(0.94, 1, 40), ringMat);
    this.cursorInner = new Mesh(new RingGeometry(0.86, 0.94, 40), ringMat2);
    this.cursor = new Group();
    this.cursor.add(outer, this.cursorInner);
    this.cursor.renderOrder = 30;
    outer.renderOrder = 30;
    this.cursorInner.renderOrder = 30;
    this.cursor.visible = false;
    outer.raycast = () => undefined;
    this.cursorInner.raycast = () => undefined;

    this.clipMesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ transparent: true, depthWrite: false, clippingPlanes: this.clipPlanes }),
    );
    this.clipMesh.renderOrder = 10;
    this.clipMesh.visible = false;
    this.clipMesh.raycast = () => undefined;
    const handleMat = new MeshBasicMaterial({ color: 0x2f7dff, depthTest: false });
    const handleGeo = new PlaneGeometry(0.012, 0.012);
    for (let i = 0; i < 4; i++) {
      const h = new Mesh(handleGeo, handleMat);
      h.renderOrder = 25;
      h.visible = false;
      h.raycast = () => undefined;
      this.handles.push(h);
    }
    this.rotateKnob = new Mesh(new RingGeometry(0.004, 0.008, 24), handleMat);
    this.rotateKnob.renderOrder = 25;
    this.rotateKnob.visible = false;
    this.rotateKnob.raycast = () => undefined;

    for (const obj of [this.marquee, this.clipOutline]) {
      (obj.material as Material).clippingPlanes = this.clipPlanes;
      obj.visible = false;
    }
    this.content.add(
      this.strokeMesh,
      this.marquee,
      this.clipMesh,
      this.clipOutline,
      this.rotateKnob,
      this.cursor,
      ...this.handles,
    );
    const ringGeo = new RingGeometry(0.82, 1, 40);
    const dotGeo = new CircleGeometry(1, 16);
    this.tipMarkers = { left: new TipMarker(ringGeo, dotGeo), right: new TipMarker(ringGeo, dotGeo) };
    this.root.add(bezel, backdrop, this.content, this.hitPlane, this.tipMarkers.left.root, this.tipMarkers.right.root);
    this.applyZoom();
  }

  slotRect(index: number): SlotRect {
    if (this.single) return { x0: -PAGE_W / 2, x1: PAGE_W / 2, y0: -PAGE_H / 2, y1: PAGE_H / 2 };
    const g = SPREAD_GAP / 2;
    return index === 0
      ? { x0: g, x1: g + PAGE_W, y0: -PAGE_H / 2, y1: PAGE_H / 2 }
      : { x0: -g - PAGE_W, x1: -g, y0: -PAGE_H / 2, y1: PAGE_H / 2 };
  }

  layoutSlots(): void {
    for (let i = 0; i < 2; i++) {
      const r = this.slotRect(i);
      this.slots[i]!.group.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0);
    }
    if (this.single) this.slots[1]!.group.visible = false;
  }

  /** Board-local (content space) coordinates of a world point. */
  toBoard(world: Vector3, out: { x: number; y: number }): void {
    this.tmp.copy(world);
    this.content.worldToLocal(this.tmp);
    out.x = this.tmp.x;
    out.y = this.tmp.y;
  }

  slotAt(x: number, y: number, margin = 0): number {
    for (let i = 0; i < (this.single ? 1 : 2); i++) {
      const r = this.slotRect(i);
      if (this.slots[i]!.page == null) continue;
      if (x >= r.x0 - margin && x <= r.x1 + margin && y >= r.y0 - margin && y <= r.y1 + margin) {
        return i;
      }
    }
    return -1;
  }

  toRaster(slot: number, x: number, y: number, out: { x: number; y: number }): void {
    const r = this.slotRect(slot);
    out.x = (x - r.x0) * PX_PER_M;
    out.y = (r.y1 - y) * PX_PER_M;
  }

  fromRaster(slot: number, rx: number, ry: number, out: { x: number; y: number }): void {
    const r = this.slotRect(slot);
    out.x = r.x0 + rx / PX_PER_M;
    out.y = r.y1 - ry / PX_PER_M;
  }

  /** Zoom keeping the content point (px, py) fixed on screen. */
  zoomAt(factor: number, px: number, py: number): void {
    const next = Math.min(4, Math.max(0.6, this.zoom * factor));
    const k = next / this.zoom;
    this.panX = px * this.zoom + this.panX - px * next;
    this.panY = py * this.zoom + this.panY - py * next;
    this.zoom = next;
    if (Math.abs(k - 1) > 0) this.applyZoom();
  }

  pan(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.applyZoom();
  }

  resetZoom(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyZoom();
  }

  private applyZoom(): void {
    const limitX = (WINDOW_W / 2) * this.zoom;
    const limitY = (WINDOW_H / 2) * this.zoom;
    this.panX = Math.min(limitX, Math.max(-limitX, this.panX));
    this.panY = Math.min(limitY, Math.max(-limitY, this.panY));
    this.content.scale.setScalar(this.zoom);
    this.content.position.set(this.panX, this.panY, 0);
    this.cursor.scale.setScalar(1);
  }

  /** Keep the four clipping planes on the window edges in world space. */
  updateClipPlanes(): void {
    this.root.updateWorldMatrix(true, false);
    const m = this.root.matrixWorld;
    for (let i = 0; i < 4; i++) {
      const [nx, ny, px, py] = CLIP_DEFS[i]!;
      const plane = this.clipPlanes[i]!;
      this.tmp.set(px, py, 0);
      plane.normal.set(nx, ny, 0);
      plane.setFromNormalAndCoplanarPoint(plane.normal, this.tmp);
      plane.applyMatrix4(m);
    }
  }

  showCursor(x: number, y: number, radiusPx: number, tool: ToolId): void {
    const r = Math.max(0.0015, radiusPx / PX_PER_M);
    this.cursor.position.set(x, y, 0.003);
    this.cursor.scale.setScalar(r);
    this.cursor.visible = true;
    (this.cursorInner.material as MeshBasicMaterial).color.set(tool === 'eraser' ? 0xff7a59 : 0xffffff);
  }

  hideCursor(): void {
    this.cursor.visible = false;
  }

  /** Pen approach marker at board-root (x, y), `height` of `hoverRange` meters above the paper. */
  showTipMarker(side: Side, x: number, y: number, height: number, touching: boolean, hoverRange: number): void {
    this.tipMarkers[side].show(x, y, height, touching, hoverRange);
  }

  hideTipMarker(side: Side): void {
    this.tipMarkers[side].root.visible = false;
  }

  beginStroke(slot: number, opacity: number): void {
    this.strokeCtx.clearRect(0, 0, RASTER_W, RASTER_H);
    this.strokeTex.needsUpdate = true;
    const r = this.slotRect(slot);
    this.strokeMesh.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0.0012);
    (this.strokeMesh.material as MeshBasicMaterial).opacity = opacity;
    this.strokeMesh.visible = true;
  }

  endStroke(): void {
    this.strokeMesh.visible = false;
    this.strokeCtx.clearRect(0, 0, RASTER_W, RASTER_H);
  }

  showMarquee(points: ArrayLike<number>, count: number, closed: boolean): void {
    const n = Math.min(count, LASSO_MAX - 1);
    for (let i = 0; i < n * 2; i++) this.lassoPts[i] = points[i]!;
    if (closed && n > 0) {
      this.lassoPts[n * 2] = points[0]!;
      this.lassoPts[n * 2 + 1] = points[1]!;
    }
    setLinePoints(this.marquee, this.lassoPts, closed ? n + 1 : n, 0.0035);
    this.marquee.visible = n > 1;
  }

  hideMarquee(): void {
    this.marquee.visible = false;
  }

  showClip(clip: ClipView | null): void {
    const visible = clip != null;
    this.clipMesh.visible = visible;
    this.clipOutline.visible = visible;
    this.rotateKnob.visible = visible;
    for (const h of this.handles) h.visible = visible;
    if (clip == null) return;
    const mat = this.clipMesh.material as MeshBasicMaterial;
    if (mat.map !== clip.texture) {
      mat.map = clip.texture;
      mat.needsUpdate = true;
    }
    const w = (clip.canvas.width / PX_PER_M) * clip.sx;
    const h = (clip.canvas.height / PX_PER_M) * clip.sy;
    this.clipMesh.position.set(clip.cx, clip.cy, 0.0025);
    this.clipMesh.rotation.z = clip.rot;
    this.clipMesh.scale.set(w, h, 1);
    const cos = Math.cos(clip.rot);
    const sin = Math.sin(clip.rot);
    const aw = Math.abs(w) / 2;
    const ah = Math.abs(h) / 2;
    const corners = [-aw, -ah, aw, -ah, aw, ah, -aw, ah];
    const pts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const lx = corners[i * 2]!;
      const ly = corners[i * 2 + 1]!;
      const x = clip.cx + lx * cos - ly * sin;
      const y = clip.cy + lx * sin + ly * cos;
      pts.push(x, y);
      const handle = this.handles[i]!;
      handle.position.set(x, y, 0.004);
      handle.rotation.z = clip.rot;
      handle.scale.setScalar(1 / this.zoom);
    }
    setLinePoints(this.clipOutline, pts, 4, 0.0035);
    const kx = clip.cx - (ah + 0.02 / this.zoom) * sin;
    const ky = clip.cy + (ah + 0.02 / this.zoom) * cos;
    this.rotateKnob.position.set(kx, ky, 0.004);
    this.rotateKnob.scale.setScalar(1 / this.zoom);
  }
}
