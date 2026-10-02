// Tool behaviour on the board. One active pointer session at a time; coordinates
// arrive in board content space (meters) and are mapped to page raster pixels.
import {
  BLEED_FRAME,
  INNER_FRAME,
  PX_PER_M,
  RASTER_H,
  RASTER_W,
  TRIM_FRAME,
  newId,
  type Side,
  type TextBox,
  type ToolId,
} from './doc.js';
import { clampRect, crop, inkEntry, makePatch, textEntry, type Rect } from './patches.js';
import type { PageRt } from './project.js';
import { Selection, borrowBackup, returnBackup } from './selection.js';
import type { StudioCtx } from './studio-ctx.js';
import { defaultBoxSize, fitTextBox } from './text-render.js';

export interface BoardPoint {
  x: number;
  y: number;
}

type Session =
  | {
      kind: 'ink';
      tool: 'pen' | 'eraser';
      slot: number;
      page: PageRt;
      sx: number;
      sy: number;
      lastX: number;
      lastY: number;
      midX: number;
      midY: number;
      pressure: number;
      bbox: Rect | null;
      backup: HTMLCanvasElement | null;
      fx: OneEuro;
      fy: OneEuro;
      t: number;
    }
  | { kind: 'shape'; tool: 'line' | 'frame'; slot: number; page: PageRt; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'text-tap'; slot: number; page: PageRt; x: number; y: number; moved: boolean; hit: TextBox | null }
  | {
      kind: 'text-drag';
      mode: 'move' | 'resize';
      page: PageRt;
      slot: number;
      text: TextBox;
      start: TextBox;
      before: TextBox[];
      x: number;
      y: number;
    }
  | { kind: 'marquee' }
  | { kind: 'clip-drag' };

const ONE_EURO_BETA = 0.004;

/** One Euro filter (Casiez et al.) for one axis. */
export class OneEuro {
  private dx = 0;
  constructor(private x: number) {}
  reset(x: number): void {
    this.x = x;
    this.dx = 0;
  }
  filter(v: number, dt: number, minCutoff: number, beta: number): number {
    const a = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const d = (v - this.x) / dt;
    this.dx += a(1) * (d - this.dx);
    this.x += a(minCutoff + beta * Math.abs(this.dx)) * (v - this.x);
    return this.x;
  }
}
const DOUBLE_TAP_MS = 450;
const SNAP_PX = 22;
const FRAME_EDGES_X = [0, BLEED_FRAME.x, TRIM_FRAME.x, INNER_FRAME.x, INNER_FRAME.x + INNER_FRAME.w, TRIM_FRAME.x + TRIM_FRAME.w, BLEED_FRAME.x + BLEED_FRAME.w, RASTER_W];
const FRAME_EDGES_Y = [0, BLEED_FRAME.y, TRIM_FRAME.y, INNER_FRAME.y, INNER_FRAME.y + INNER_FRAME.h, TRIM_FRAME.y + TRIM_FRAME.h, BLEED_FRAME.y + BLEED_FRAME.h, RASTER_H];

export class ToolController {
  /** Tool of the acting hand: the last one assigned or used. */
  tool: ToolId = 'pen';
  /** Tool held by each hand. 'hand' (移動) means an empty hand. */
  readonly hands: Record<Side, ToolId> = { left: 'hand', right: 'pen' };
  focus: Side = 'right';
  selectedText: { page: PageRt; id: string } | null = null;
  /** Dialogue waiting to be dropped by the next text-tool tap (script / PDF). */
  pendingText: string | null = null;
  readonly selection: Selection;
  /** Movement that still counts as a tap; the studio widens it for XR rays (trigger wobble). */
  tapSlopPx = 10;
  private echoAt = 0;
  onSelectionChange: () => void = () => {};
  private session: Session | null = null;
  private pointerId: number | null = null;
  private readonly raster = { x: 0, y: 0 };
  private lastTap = { id: '', time: 0 };

  constructor(private readonly ctx: StudioCtx) {
    this.selection = new Selection(ctx);
  }

  get busy(): boolean {
    return this.session != null;
  }

  get settings() {
    return this.ctx.project.tools;
  }

  /** Give `side` a tool and make it the acting hand (mouse and keyboard act as the right hand). */
  setTool(tool: ToolId, side: Side = this.focus): void {
    if (this.session != null) return;
    this.hands[side] = tool;
    this.focus = side;
    this.activate(tool);
  }

  /** Make `side` the acting hand, e.g. right before its pen touches the board. */
  useHand(side: Side): void {
    if (this.session != null) return;
    this.focus = side;
    this.activate(this.hands[side]);
  }

  private activate(tool: ToolId): void {
    if (tool === this.tool) return;
    if (tool !== 'select' && tool !== 'lasso') this.selection.commit();
    if (tool !== 'text') this.selectText(null);
    this.tool = tool;
    this.ctx.board.hideCursor();
    this.ctx.refreshTexts();
    this.onSelectionChange();
  }

  /** Commit transient state before the displayed spread changes. */
  settle(): void {
    if (this.session != null) this.cancel();
    this.selection.commit();
    this.selectText(null);
  }

  hover(p: BoardPoint | null, t: ToolId = this.tool): void {
    const board = this.ctx.board;
    if (p == null || this.session?.kind === 'marquee') {
      board.hideCursor();
      return;
    }
    if (t !== 'pen' && t !== 'eraser' && t !== 'line' && t !== 'frame') {
      board.hideCursor();
      return;
    }
    if (board.slotAt(p.x, p.y, 0.01) < 0) {
      board.hideCursor();
      return;
    }
    const size = t === 'eraser' ? this.settings.eraserSize : this.settings.penSize;
    board.showCursor(p.x, p.y, size / 2, t);
  }

  down(pointerId: number, p: BoardPoint, pressure: number): void {
    if (this.session != null) return;
    const board = this.ctx.board;
    const slot = board.slotAt(p.x, p.y);
    const page = slot >= 0 ? board.slots[slot]!.page : null;
    this.pointerId = pointerId;
    switch (this.tool) {
      case 'pen':
      case 'eraser': {
        if (page == null) break;
        board.toRaster(slot, p.x, p.y, this.raster);
        const backup = this.tool === 'eraser' ? borrowBackup(page) : null;
        const { x, y } = this.raster;
        this.session = {
          kind: 'ink',
          tool: this.tool,
          slot,
          page,
          sx: x,
          sy: y,
          lastX: x,
          lastY: y,
          midX: x,
          midY: y,
          pressure: this.pressure(pressure),
          bbox: null,
          backup,
          fx: new OneEuro(x),
          fy: new OneEuro(y),
          t: performance.now(),
        };
        if (this.tool === 'pen') board.beginStroke(slot, this.settings.penOpacity);
        this.dab(this.session);
        break;
      }
      case 'line':
      case 'frame': {
        if (page == null) break;
        board.toRaster(slot, p.x, p.y, this.raster);
        let { x, y } = this.raster;
        if (this.tool === 'frame') [x, y] = [this.snap(x, FRAME_EDGES_X), this.snap(y, FRAME_EDGES_Y)];
        this.session = { kind: 'shape', tool: this.tool, slot, page, x0: x, y0: y, x1: x, y1: y };
        board.beginStroke(slot, this.settings.penOpacity);
        break;
      }
      case 'text': {
        if (page == null) {
          this.selectText(null);
          break;
        }
        board.toRaster(slot, p.x, p.y, this.raster);
        const { x, y } = this.raster;
        const selected = this.currentText();
        if (selected != null && selected.page === page && this.onResizeHandle(selected.text, x, y)) {
          this.session = this.textDrag('resize', page, slot, selected.text, x, y);
          break;
        }
        const hit = this.hitText(page, x, y);
        this.session = { kind: 'text-tap', slot, page, x, y, moved: false, hit };
        if (hit != null) this.selectText({ page, id: hit.id });
        break;
      }
      case 'select':
      case 'lasso': {
        const mode = this.selection.hitTest(p.x, p.y);
        if (mode != null) {
          this.selection.beginDrag(mode, p.x, p.y);
          this.session = { kind: 'clip-drag' };
          break;
        }
        this.selection.commit();
        this.selection.beginMarquee(p.x, p.y, this.tool === 'lasso');
        this.session = { kind: 'marquee' };
        break;
      }
    }
    if (this.session == null) this.pointerId = null;
  }

  move(pointerId: number, p: BoardPoint, pressure: number): void {
    const s = this.session;
    if (s == null || pointerId !== this.pointerId) return;
    const board = this.ctx.board;
    switch (s.kind) {
      case 'ink': {
        board.toRaster(s.slot, p.x, p.y, this.raster);
        // One Euro filter: strong smoothing when slow (hand tremor), little lag when fast.
        const now = performance.now();
        // Event bursts (high-rate pens, coalesced input) must not stall the filter.
        const dt = Math.max(1 / 120, (now - s.t) / 1000);
        s.t = now;
        const stab = this.settings.stabilizer;
        if (stab <= 0.01) {
          s.sx = this.raster.x;
          s.sy = this.raster.y;
        } else {
          const minCutoff = 6 - 5.6 * stab;
          s.sx = s.fx.filter(this.raster.x, dt, minCutoff, ONE_EURO_BETA);
          s.sy = s.fy.filter(this.raster.y, dt, minCutoff, ONE_EURO_BETA);
        }
        s.pressure += (this.pressure(pressure) - s.pressure) * 0.35;
        this.segment(s);
        this.hover(p);
        break;
      }
      case 'shape': {
        board.toRaster(s.slot, p.x, p.y, this.raster);
        let { x, y } = this.raster;
        if (s.tool === 'frame') {
          x = this.snap(x, FRAME_EDGES_X);
          y = this.snap(y, FRAME_EDGES_Y);
        } else if (this.settings.angleSnap) {
          [x, y] = this.snapAngle(s.x0, s.y0, x, y);
        }
        s.x1 = x;
        s.y1 = y;
        this.drawShape(s);
        break;
      }
      case 'text-tap': {
        board.toRaster(s.slot, p.x, p.y, this.raster);
        const d = Math.hypot(this.raster.x - s.x, this.raster.y - s.y);
        if (d > this.tapSlopPx / board.zoom && s.hit != null) {
          const drag = this.textDrag('move', s.page, s.slot, s.hit, s.x, s.y);
          this.session = drag;
          this.move(pointerId, p, pressure);
        } else if (d > this.tapSlopPx / board.zoom) {
          s.moved = true;
        }
        break;
      }
      case 'text-drag': {
        board.toRaster(s.slot, p.x, p.y, this.raster);
        const { x, y } = this.raster;
        if (s.mode === 'move') {
          s.text.x = s.start.x + x - s.x;
          s.text.y = s.start.y + y - s.y;
        } else {
          const ax = s.start.mode === 'vertical' ? s.start.x + s.start.w : s.start.x;
          const ay = s.start.y;
          const r0 = Math.hypot(s.x - ax, s.y - ay);
          const k = Math.min(6, Math.max(0.2, Math.hypot(x - ax, y - ay) / Math.max(1, r0)));
          s.text.fontSize = Math.min(240, Math.max(10, s.start.fontSize * k));
          s.text.w = s.start.w * k;
          s.text.h = s.start.h * k;
          if (s.start.mode === 'vertical') s.text.x = ax - s.text.w;
        }
        s.page.markTexts();
        this.ctx.refreshTexts(s.page);
        break;
      }
      case 'marquee':
        this.selection.extendMarquee(p.x, p.y);
        break;
      case 'clip-drag':
        this.selection.dragTo(p.x, p.y);
        break;
    }
  }

  up(pointerId: number): void {
    const s = this.session;
    if (s == null || pointerId !== this.pointerId) return;
    this.session = null;
    this.pointerId = null;
    switch (s.kind) {
      case 'ink':
        this.finishInk(s);
        break;
      case 'shape':
        this.bakeStroke(s.page, s.tool === 'line' ? '直線' : 'コマ枠', this.shapeBounds(s));
        break;
      case 'text-tap':
        this.tapText(s);
        break;
      case 'text-drag':
        this.ctx.history.push(
          textEntry(s.mode === 'move' ? 'テキスト移動' : 'テキストの拡大縮小', s.page, s.before, () => this.ctx.refreshTexts()),
        );
        this.ctx.markDirty();
        break;
      case 'marquee':
        if (this.selection.endMarquee()) this.ctx.haptic(0.4);
        this.onSelectionChange();
        break;
      case 'clip-drag':
        this.selection.endDrag();
        break;
    }
  }

  /** Abort the active pointer session (e.g. page turn mid-stroke). */
  cancel(): void {
    const s = this.session;
    if (s == null) return;
    if (s.kind === 'ink' || s.kind === 'shape') {
      if (s.kind === 'ink' && s.backup != null) {
        s.page.ctx.clearRect(0, 0, RASTER_W, RASTER_H);
        s.page.ctx.drawImage(s.backup, 0, 0);
        s.page.markInk();
        returnBackup(s.backup);
      }
      this.ctx.board.endStroke();
    }
    if (s.kind === 'marquee') this.ctx.board.hideMarquee();
    this.session = null;
    this.pointerId = null;
  }

  // ---------- ink ----------

  private pressure(raw: number): number {
    return this.settings.pressure ? Math.min(1, Math.max(0.05, raw)) : 1;
  }

  private width(s: Extract<Session, { kind: 'ink' }>): number {
    const base = s.tool === 'eraser' ? this.settings.eraserSize : this.settings.penSize;
    return Math.max(1, base * (0.25 + 0.75 * s.pressure));
  }

  private paintTarget(s: Extract<Session, { kind: 'ink' }>): CanvasRenderingContext2D {
    const c = s.tool === 'pen' ? this.ctx.board.strokeCtx : s.page.ctx;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (s.tool === 'pen') {
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.strokeStyle = this.settings.penColor;
      c.fillStyle = this.settings.penColor;
    } else {
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = this.settings.eraserOpacity;
      c.strokeStyle = '#000';
      c.fillStyle = '#000';
    }
    return c;
  }

  private grow(s: Extract<Session, { kind: 'ink' }>, x: number, y: number, r: number): void {
    const box = { x: x - r, y: y - r, w: r * 2, h: r * 2 };
    if (s.bbox == null) {
      s.bbox = box;
      return;
    }
    const x0 = Math.min(s.bbox.x, box.x);
    const y0 = Math.min(s.bbox.y, box.y);
    s.bbox = {
      x: x0,
      y: y0,
      w: Math.max(s.bbox.x + s.bbox.w, box.x + box.w) - x0,
      h: Math.max(s.bbox.y + s.bbox.h, box.y + box.h) - y0,
    };
  }

  private dab(s: Extract<Session, { kind: 'ink' }>): void {
    const c = this.paintTarget(s);
    const w = this.width(s);
    c.beginPath();
    c.arc(s.sx, s.sy, w / 2, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    this.grow(s, s.sx, s.sy, w);
    this.touched(s);
  }

  /** Quadratic midpoint smoothing between stabilised samples. */
  private segment(s: Extract<Session, { kind: 'ink' }>): void {
    const dx = s.sx - s.lastX;
    const dy = s.sy - s.lastY;
    if (dx * dx + dy * dy < 0.6) return;
    const midX = (s.lastX + s.sx) / 2;
    const midY = (s.lastY + s.sy) / 2;
    const c = this.paintTarget(s);
    const w = this.width(s);
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(s.midX, s.midY);
    c.quadraticCurveTo(s.lastX, s.lastY, midX, midY);
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    this.grow(s, s.lastX, s.lastY, w);
    this.grow(s, midX, midY, w);
    this.grow(s, s.sx, s.sy, w);
    s.midX = midX;
    s.midY = midY;
    s.lastX = s.sx;
    s.lastY = s.sy;
    this.touched(s);
  }

  private touched(s: Extract<Session, { kind: 'ink' }>): void {
    if (s.tool === 'pen') this.ctx.board.strokeTex.needsUpdate = true;
    else s.page.markInk();
  }

  private finishInk(s: Extract<Session, { kind: 'ink' }>): void {
    const c = this.paintTarget(s);
    c.lineWidth = this.width(s);
    c.beginPath();
    c.moveTo(s.midX, s.midY);
    c.lineTo(s.lastX, s.lastY);
    c.stroke();
    // The tail segment must be inside the bake / undo region too.
    this.grow(s, s.lastX, s.lastY, c.lineWidth);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    if (s.tool === 'pen') {
      this.bakeStroke(s.page, 'ペン', s.bbox);
      return;
    }
    s.page.markInk();
    const region = s.bbox != null ? clampRect(s.bbox, 2) : null;
    if (s.backup != null) {
      if (region != null) {
        this.ctx.history.push(inkEntry('消しゴム', [makePatch(s.page, s.backup, region)], () => this.ctx.markDirty()));
        this.ctx.markDirty();
      }
      returnBackup(s.backup);
    }
  }

  /** Composite the live stroke canvas onto the page with the pen opacity. */
  private bakeStroke(page: PageRt, label: string, bbox: Rect | null): void {
    const board = this.ctx.board;
    const region = bbox != null ? clampRect(bbox, 3) : null;
    if (region == null) {
      board.endStroke();
      return;
    }
    const before = crop(page.ink, region);
    page.ctx.save();
    page.ctx.globalAlpha = this.settings.penOpacity;
    page.ctx.drawImage(board.strokeCanvas, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
    page.ctx.restore();
    page.markInk();
    board.endStroke();
    const patch = { page, ...region, before, after: crop(page.ink, region) };
    this.ctx.history.push(inkEntry(label, [patch], () => this.ctx.markDirty()));
    this.ctx.markDirty();
  }

  // ---------- line / frame ----------

  private snap(v: number, edges: readonly number[]): number {
    const tolerance = SNAP_PX / this.ctx.board.zoom;
    let best = v;
    let bestD = tolerance;
    for (const e of edges) {
      const d = Math.abs(v - e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private snapAngle(x0: number, y0: number, x: number, y: number): [number, number] {
    const dx = x - x0;
    const dy = y - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return [x, y];
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    if (Math.abs(angle - snapped) > (6 * Math.PI) / 180) return [x, y];
    return [x0 + Math.cos(snapped) * len, y0 + Math.sin(snapped) * len];
  }

  private drawShape(s: Extract<Session, { kind: 'shape' }>): void {
    const c = this.ctx.board.strokeCtx;
    c.clearRect(0, 0, RASTER_W, RASTER_H);
    c.strokeStyle = this.settings.penColor;
    c.lineWidth = this.settings.penSize;
    c.lineCap = s.tool === 'line' ? 'round' : 'square';
    c.lineJoin = 'miter';
    c.beginPath();
    if (s.tool === 'line') {
      c.moveTo(s.x0, s.y0);
      c.lineTo(s.x1, s.y1);
    } else {
      c.rect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
    }
    c.stroke();
    this.ctx.board.strokeTex.needsUpdate = true;
  }

  private shapeBounds(s: Extract<Session, { kind: 'shape' }>): Rect | null {
    const w = Math.abs(s.x1 - s.x0);
    const h = Math.abs(s.y1 - s.y0);
    if (w < 3 && h < 3) return null;
    if (s.tool === 'frame' && (w < 12 || h < 12)) return null;
    const pad = this.settings.penSize;
    return { x: Math.min(s.x0, s.x1) - pad, y: Math.min(s.y0, s.y1) - pad, w: w + pad * 2, h: h + pad * 2 };
  }

  // ---------- text ----------

  currentText(): { page: PageRt; text: TextBox } | null {
    const sel = this.selectedText;
    if (sel == null) return null;
    const text = sel.page.texts.find((t) => t.id === sel.id);
    return text != null ? { page: sel.page, text } : null;
  }

  selectText(sel: { page: PageRt; id: string } | null): void {
    const prev = this.selectedText;
    if (prev?.id === sel?.id && prev?.page === sel?.page) return;
    this.selectedText = sel;
    this.ctx.refreshTexts();
    this.onSelectionChange();
  }

  private hitText(page: PageRt, x: number, y: number): TextBox | null {
    const pad = 8 / this.ctx.board.zoom;
    for (let i = page.texts.length - 1; i >= 0; i--) {
      const t = page.texts[i]!;
      if (x >= t.x - pad && x <= t.x + t.w + pad && y >= t.y - pad && y <= t.y + t.h + pad) return t;
    }
    return null;
  }

  private onResizeHandle(t: TextBox, x: number, y: number): boolean {
    const hx = t.mode === 'vertical' ? t.x : t.x + t.w;
    const hy = t.y + t.h;
    return Math.hypot(x - hx, y - hy) < 34 / this.ctx.board.zoom;
  }

  private textDrag(
    mode: 'move' | 'resize',
    page: PageRt,
    slot: number,
    text: TextBox,
    x: number,
    y: number,
  ): Extract<Session, { kind: 'text-drag' }> {
    return {
      kind: 'text-drag',
      mode,
      page,
      slot,
      text,
      start: { ...text },
      before: page.texts.map((t) => ({ ...t })),
      x,
      y,
    };
  }

  private tapText(s: Extract<Session, { kind: 'text-tap' }>): void {
    if (s.moved) return;
    if (s.hit != null) {
      const now = performance.now();
      if (this.lastTap.id === s.hit.id && now - this.lastTap.time < DOUBLE_TAP_MS) {
        this.editText();
        this.lastTap = { id: '', time: 0 };
      } else {
        this.lastTap = { id: s.hit.id, time: now };
      }
      return;
    }
    if (this.selectedText != null && this.pendingText == null) {
      // First tap on empty paper just deselects, like most editors.
      this.selectText(null);
      return;
    }
    this.createText(s.page, s.x, s.y);
  }

  createText(page: PageRt, x: number, y: number): void {
    const settings = this.settings;
    const size = defaultBoxSize(settings.textMode, settings.textSize);
    const content = this.pendingText ?? '';
    const box: TextBox = {
      id: newId('tx'),
      content,
      x: settings.textMode === 'vertical' ? x - size.w / 2 : x,
      y: y - settings.textSize * 0.4,
      w: size.w,
      h: size.h,
      fontSize: settings.textSize,
      color: settings.textColor,
      mode: settings.textMode,
    };
    if (content.length > 0) {
      const lines = content.length;
      if (box.mode === 'vertical') box.h = Math.min(box.fontSize * Math.max(4, Math.min(lines, 12)), RASTER_H * 0.45);
      fitTextBox(box);
    }
    const before = page.texts.map((t) => ({ ...t }));
    page.texts.push(box);
    page.markTexts();
    this.selectText({ page, id: box.id });
    this.ctx.markDirty();
    this.ctx.haptic(0.3);
    if (this.pendingText != null) {
      this.ctx.history.push(textEntry('テキスト追加', page, before, () => this.ctx.refreshTexts()));
      this.pendingText = null;
      this.onPendingPlaced();
    } else {
      // Creating and typing the first words is one undo step.
      this.editText(before, 'テキスト追加');
    }
  }

  /** Hook so the script panel can advance to the next line. */
  onPendingPlaced: () => void = () => {};

  editText(created?: TextBox[], label = 'テキスト編集'): void {
    const cur = this.currentText();
    if (cur == null) return;
    const { page, text } = cur;
    const before = created ?? page.texts.map((t) => ({ ...t }));
    const original = text.content;
    this.ctx.textInput.open({
      title: 'セリフ入力',
      value: original,
      multiline: true,
      onInput: (value) => {
        text.content = value;
        fitTextBox(text);
        page.markTexts();
        this.ctx.refreshTexts(page);
        // In XR the DOM field is invisible: echo what is being typed on the palette.
        const now = performance.now();
        if (now - this.echoAt > 300) {
          this.echoAt = now;
          this.ctx.toast(`入力中: ${value.split('\n').join(' / ').slice(-40)}`);
        }
      },
      onCommit: (value) => {
        text.content = value;
        fitTextBox(text);
        page.markTexts();
        this.ctx.refreshTexts();
        if (value !== original || created != null) {
          this.ctx.history.push(textEntry(label, page, before, () => this.ctx.refreshTexts()));
          this.ctx.markDirty();
        }
      },
    });
  }

  deleteText(): void {
    const cur = this.currentText();
    if (cur == null) return;
    const before = cur.page.texts.map((t) => ({ ...t }));
    cur.page.texts = cur.page.texts.filter((t) => t.id !== cur.text.id);
    cur.page.markTexts();
    this.selectedText = null;
    this.ctx.history.push(textEntry('テキスト削除', cur.page, before, () => this.ctx.refreshTexts()));
    this.ctx.refreshTexts();
    this.ctx.markDirty();
    this.onSelectionChange();
  }

  /** Apply a property change to the selected text as one undo step. */
  updateText(patch: Partial<Pick<TextBox, 'fontSize' | 'color' | 'mode'>>, label: string): void {
    const cur = this.currentText();
    if (cur == null) return;
    const before = cur.page.texts.map((t) => ({ ...t }));
    const t = cur.text;
    if (patch.mode != null && patch.mode !== t.mode) {
      const right = t.x + t.w;
      const size = defaultBoxSize(patch.mode, t.fontSize);
      t.mode = patch.mode;
      t.w = patch.mode === 'horizontal' ? Math.max(size.w, t.h) : size.w;
      t.h = patch.mode === 'vertical' ? Math.max(size.h, t.w) : size.h;
      if (patch.mode === 'vertical') t.x = right - t.w;
    }
    if (patch.fontSize != null) {
      const k = patch.fontSize / t.fontSize;
      t.fontSize = patch.fontSize;
      if (t.mode === 'vertical') {
        const right = t.x + t.w;
        t.h *= k;
        t.w *= k;
        t.x = right - t.w;
      } else {
        t.w *= k;
        t.h *= k;
      }
    }
    if (patch.color != null) t.color = patch.color;
    fitTextBox(t);
    cur.page.markTexts();
    this.ctx.history.push(textEntry(label, cur.page, before, () => this.ctx.refreshTexts()));
    this.ctx.refreshTexts();
    this.ctx.markDirty();
  }

  get textFramesVisible(): boolean {
    return this.tool === 'text';
  }

  /** Raster px per board meter, exposed for panels that convert sizes. */
  static readonly pxPerM = PX_PER_M;
}
