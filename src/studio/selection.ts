// Rectangle / lasso cut into a floating clip that can be moved, scaled, rotated,
// flipped and baked back onto either page of the spread (MangaSketcher pasteboard).
// Texts touching the cut ride along with the ink and land back on the pages as texts.
// A clip is either on a page or in the stock: cutting to the stock takes it off the
// page, and a clip pasted from the stock leaves the stock once it is placed.
import { PX_PER_M, RASTER_H, RASTER_W, newId, type StockItem, type TextBox } from './doc.js';
import type { HistoryEntry } from './history.js';
import { clampRect, makePatch, inkEntry, opaqueBounds, unionRect, type Rect, type InkPatch } from './patches.js';
import { canvasTexture, composeClip, ctx2d, makeCanvas, type PageRt } from './project.js';
import type { ClipView, SlotRect } from './board.js';
import type { StudioCtx } from './studio-ctx.js';
import { drawTexts } from './text-render.js';

type DragMode = 'move' | 'scale' | 'rotate';

interface Backup {
  page: PageRt;
  canvas: HTMLCanvasElement;
  dirty: Rect | null;
  /** Page placement on the board when the clip was made; bakes never depend on the live layout. */
  rect: SlotRect;
  /** Page left the board while the clip floated: keep its cut, never bake into it. */
  carried?: boolean;
  /** The page's texts when the clip was made (undo, and cancel puts cut texts back). */
  texts: TextBox[];
}

interface FloatingClip extends ClipView {
  backups: Map<string, Backup>;
  label: string;
  /** Pasted from outside (stock / diorama): committing it always counts as an edit. */
  floated: boolean;
  origin: { cx: number; cy: number };
  /** Ink only, for baking; `texture` shows `display` (ink with the texts on top). */
  display: HTMLCanvasElement;
  /** Texts carried with the clip, in clip px. */
  texts: TextBox[];
  /** `display` draws the texts mirrored, so a flipped clip shows them readable as they will land. */
  mirrored: boolean;
  /** Stock clip this came from: it leaves the stock when the clip is placed. */
  stockId: string | null;
}

/** A page's texts before and after a clip took or placed some. */
interface TextChange {
  page: PageRt;
  before: TextBox[];
  after: TextBox[];
}

/** A stock edit made together with a clip, applied and reverted with it. */
interface StockChange {
  apply(): void;
  revert(): void;
}

const copyTexts = (texts: readonly TextBox[]): TextBox[] => texts.map((t) => ({ ...t }));

/** Whether rect (temp px) touches a closed polygon of [x, y, ...] points: any overlap counts. */
function rectTouchesPolygon(r: Rect, poly: readonly number[]): boolean {
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const n = poly.length / 2;
  const inside = (x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i * 2]!;
      const yi = poly[i * 2 + 1]!;
      const xj = poly[j * 2]!;
      const yj = poly[j * 2 + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  if (inside(r.x, r.y) || inside(x1, r.y) || inside(x1, y1) || inside(r.x, y1)) return true;
  // Otherwise an outline segment must cross the rect: clip each one against it.
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2]!;
    const ay = poly[j * 2 + 1]!;
    const bx = poly[i * 2]!;
    const by = poly[i * 2 + 1]!;
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    let hit = true;
    for (const [p, q] of [[-dx, ax - r.x], [dx, x1 - ax], [-dy, ay - r.y], [dy, y1 - ay]] as const) {
      if (p === 0) {
        if (q < 0) hit = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (hit && t0 <= t1) return true;
  }
  return false;
}

const pool: HTMLCanvasElement[] = [];

export class Selection {
  clip: FloatingClip | null = null;
  private readonly marquee: number[] = [];
  private lasso = false;
  private drag: {
    mode: DragMode;
    x: number;
    y: number;
    cx: number;
    cy: number;
    sx: number;
    sy: number;
    rot: number;
  } | null = null;

  constructor(private readonly ctx: StudioCtx) {}

  get active(): boolean {
    return this.clip != null;
  }

  beginMarquee(x: number, y: number, lasso: boolean): void {
    this.lasso = lasso;
    this.marquee.length = 0;
    this.marquee.push(x, y);
    if (!lasso) this.marquee.push(x, y);
  }

  extendMarquee(x: number, y: number): void {
    if (this.lasso) {
      const n = this.marquee.length;
      const dx = x - this.marquee[n - 2]!;
      const dy = y - this.marquee[n - 1]!;
      if (dx * dx + dy * dy < (1.5 / PX_PER_M) ** 2) return;
      this.marquee.push(x, y);
      this.ctx.board.showMarquee(this.marquee, this.marquee.length / 2, false);
    } else {
      this.marquee[2] = x;
      this.marquee[3] = y;
      const [x0, y0] = [this.marquee[0]!, this.marquee[1]!];
      this.ctx.board.showMarquee([x0, y0, x, y0, x, y, x0, y], 4, true);
    }
  }

  /** Cut the marquee contents into a floating clip. Returns true on success. */
  endMarquee(): boolean {
    const board = this.ctx.board;
    board.hideMarquee();
    const pts = this.lasso ? [...this.marquee] : this.rectPoints();
    if (pts.length < 6) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!);
      maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!);
      maxY = Math.max(maxY, pts[i + 1]!);
    }
    const wPx = Math.ceil((maxX - minX) * PX_PER_M);
    const hPx = Math.ceil((maxY - minY) * PX_PER_M);
    if (wPx < 4 || hPx < 4) return false;
    const canvas = makeCanvas(wPx, hPx);
    const cctx = ctx2d(canvas);
    const backups = this.backupDisplayed();
    // Board point -> clip canvas pixel.
    const toClip = (x: number, y: number): [number, number] => [(x - minX) * PX_PER_M, (maxY - y) * PX_PER_M];
    for (const [slotIndex, slot] of board.slots.entries()) {
      const page = slot.page;
      if (page == null || (board.single && slotIndex === 1)) continue;
      const r = board.slotRect(slotIndex);
      const region = clampRect({
        x: (minX - r.x0) * PX_PER_M,
        y: (r.y1 - maxY) * PX_PER_M,
        w: wPx,
        h: hPx,
      });
      if (region == null) continue;
      const [ox, oy] = toClip(r.x0, r.y1);
      cctx.save();
      if (this.lasso) {
        cctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          const [px, py] = toClip(pts[i]!, pts[i + 1]!);
          if (i === 0) cctx.moveTo(px, py);
          else cctx.lineTo(px, py);
        }
        cctx.closePath();
        cctx.clip();
      }
      cctx.drawImage(page.ink, region.x, region.y, region.w, region.h, ox + region.x, oy + region.y, region.w, region.h);
      cctx.restore();
      // Remove the cut pixels from the page.
      const pctx = page.ctx;
      pctx.save();
      if (this.lasso) {
        pctx.globalCompositeOperation = 'destination-out';
        pctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          const px = (pts[i]! - r.x0) * PX_PER_M;
          const py = (r.y1 - pts[i + 1]!) * PX_PER_M;
          if (i === 0) pctx.moveTo(px, py);
          else pctx.lineTo(px, py);
        }
        pctx.closePath();
        pctx.fill();
      } else {
        pctx.clearRect(region.x, region.y, region.w, region.h);
      }
      pctx.restore();
      page.markInk();
      const backup = backups.get(page.id);
      if (backup != null) backup.dirty = region;
    }
    const texts = this.cutTexts(this.lasso ? pts.map((v, i) => (i % 2 === 0 ? (v - minX) * PX_PER_M : (maxY - v) * PX_PER_M)) : null, wPx, hPx, toClip);
    let tight = opaqueBounds(canvas);
    for (const t of texts) tight = unionRect(tight, t);
    if (tight == null) {
      this.releaseBackups(backups);
      this.ctx.toast('選択範囲に線や文字がありません');
      return false;
    }
    // Texts may reach past the marquee: the clip spans the ink and every text it took.
    const x0 = Math.floor(tight.x);
    const y0 = Math.floor(tight.y);
    const tw = Math.ceil(tight.x + tight.w) - x0;
    const th = Math.ceil(tight.y + tight.h) - y0;
    const trimmed = makeCanvas(tw, th);
    ctx2d(trimmed).drawImage(canvas, -x0, -y0);
    canvas.width = 0;
    for (const t of texts) {
      t.x -= x0;
      t.y -= y0;
    }
    const display = composeClip(trimmed, texts);
    this.clip = {
      canvas: trimmed,
      display,
      texts,
      mirrored: false,
      stockId: null,
      texture: canvasTexture(display),
      cx: minX + (x0 + tw / 2) / PX_PER_M,
      cy: maxY - (y0 + th / 2) / PX_PER_M,
      sx: 1,
      sy: 1,
      rot: 0,
      backups,
      label: '選択範囲の変形',
      floated: false,
      origin: { cx: 0, cy: 0 },
    };
    this.clip.origin = { cx: this.clip.cx, cy: this.clip.cy };
    this.show();
    return true;
  }

  /**
   * Float an external image (stock clip, diorama snapshot) over the current page. A stock
   * clip brings its texts and leaves the stock once placed (cancel keeps it there).
   */
  float(
    source: HTMLCanvasElement,
    cx: number,
    cy: number,
    label: string,
    fitWidth?: number,
    from?: { texts?: readonly TextBox[]; stockId?: string },
  ): void {
    // Pasting the stock clip that is already out on the page again would place it twice.
    if (from?.stockId != null && this.clip?.stockId === from.stockId) {
      this.ctx.toast('このクリップは貼り付け中です。確定か取消をしてください');
      return;
    }
    this.commit();
    const canvas = makeCanvas(source.width, source.height);
    ctx2d(canvas).drawImage(source, 0, 0);
    const scale = fitWidth != null ? Math.min(1, (fitWidth * PX_PER_M) / source.width) : 1;
    const texts = copyTexts(from?.texts ?? []);
    const display = composeClip(canvas, texts);
    this.clip = {
      canvas,
      display,
      texts,
      mirrored: false,
      stockId: from?.stockId ?? null,
      texture: canvasTexture(display),
      cx,
      cy,
      sx: scale,
      sy: scale,
      rot: 0,
      backups: this.backupDisplayed(),
      label,
      floated: true,
      origin: { cx, cy },
    };
    this.show();
  }

  hitTest(x: number, y: number): DragMode | null {
    const clip = this.clip;
    if (clip == null) return null;
    const z = this.ctx.board.zoom;
    const hw = (clip.canvas.width / PX_PER_M / 2) * Math.abs(clip.sx);
    const hh = (clip.canvas.height / PX_PER_M / 2) * Math.abs(clip.sy);
    const cos = Math.cos(clip.rot);
    const sin = Math.sin(clip.rot);
    const knobX = clip.cx - (hh + 0.02 / z) * sin;
    const knobY = clip.cy + (hh + 0.02 / z) * cos;
    const grab = 0.016 / z;
    if (Math.hypot(x - knobX, y - knobY) < grab) return 'rotate';
    const dx = x - clip.cx;
    const dy = y - clip.cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    // Corner handles win only in the outer half, so thin clips stay movable.
    const outer = Math.abs(lx) > hw * 0.5 || Math.abs(ly) > hh * 0.5;
    const cornerGrab = Math.min(grab, 0.45 * Math.max(hw, hh));
    if (outer && Math.hypot(Math.abs(lx) - hw, Math.abs(ly) - hh) < cornerGrab) return 'scale';
    if (Math.abs(lx) <= hw + grab * 0.25 && Math.abs(ly) <= hh + grab * 0.25) return 'move';
    return null;
  }

  beginDrag(mode: DragMode, x: number, y: number): void {
    const clip = this.clip;
    if (clip == null) return;
    this.drag = { mode, x, y, cx: clip.cx, cy: clip.cy, sx: clip.sx, sy: clip.sy, rot: clip.rot };
  }

  dragTo(x: number, y: number): void {
    const clip = this.clip;
    const d = this.drag;
    if (clip == null || d == null) return;
    if (d.mode === 'move') {
      clip.cx = d.cx + x - d.x;
      clip.cy = d.cy + y - d.y;
    } else if (d.mode === 'scale') {
      const r0 = Math.max(0.004, Math.hypot(d.x - d.cx, d.y - d.cy));
      const r1 = Math.hypot(x - d.cx, y - d.cy);
      const k = Math.min(8, Math.max(0.05, r1 / Math.max(1e-4, r0)));
      clip.sx = d.sx * k;
      clip.sy = d.sy * k;
    } else {
      const a0 = Math.atan2(d.y - d.cy, d.x - d.cx);
      const a1 = Math.atan2(y - d.cy, x - d.cx);
      let rot = d.rot + a1 - a0;
      const step = Math.PI / 12;
      const snapped = Math.round(rot / step) * step;
      if (Math.abs(rot - snapped) < 0.035) rot = snapped;
      clip.rot = rot;
    }
    this.show();
  }

  endDrag(): void {
    this.drag = null;
  }

  flip(): void {
    if (this.clip == null) return;
    this.clip.sx = -this.clip.sx;
    this.show();
  }

  rotateBy(rad: number): void {
    if (this.clip == null) return;
    this.clip.rot += rad;
    this.show();
  }

  scaleBy(k: number): void {
    if (this.clip == null) return;
    this.clip.sx *= k;
    this.clip.sy *= k;
    this.show();
  }

  /** Copy of the clip's ink pixels. */
  snapshotCanvas(): HTMLCanvasElement | null {
    if (this.clip == null) return null;
    const out = makeCanvas(this.clip.canvas.width, this.clip.canvas.height);
    ctx2d(out).drawImage(this.clip.canvas, 0, 0);
    return out;
  }

  /** Bake the clip into every displayed page it overlaps; one undo step. */
  commit(): void {
    const clip = this.clip;
    if (clip == null) return;
    // An untouched cut is not an edit: put the pixels back and keep the redo stack intact.
    const untouched =
      !clip.floated && clip.sx === 1 && clip.sy === 1 && clip.rot === 0 &&
      Math.abs(clip.cx - clip.origin.cx) < 1e-6 && Math.abs(clip.cy - clip.origin.cy) < 1e-6;
    if (untouched) {
      this.cancel();
      return;
    }
    const patches: InkPatch[] = [];
    const w = clip.canvas.width;
    const h = clip.canvas.height;
    for (const backup of clip.backups.values()) {
      const page = backup.page;
      const r = backup.rect;
      if (backup.carried) {
        if (backup.dirty != null) patches.push(makePatch(page, backup.canvas, backup.dirty));
        continue;
      }
      const cx = (clip.cx - r.x0) * PX_PER_M;
      const cy = (r.y1 - clip.cy) * PX_PER_M;
      const hw = (w / 2) * Math.abs(clip.sx);
      const hh = (h / 2) * Math.abs(clip.sy);
      const ex = Math.abs(hw * Math.cos(clip.rot)) + Math.abs(hh * Math.sin(clip.rot));
      const ey = Math.abs(hw * Math.sin(clip.rot)) + Math.abs(hh * Math.cos(clip.rot));
      const bake = clampRect({ x: cx - ex, y: cy - ey, w: ex * 2, h: ey * 2 }, 2);
      if (bake != null) {
        const pctx = page.ctx;
        pctx.save();
        pctx.translate(cx, cy);
        pctx.rotate(-clip.rot);
        pctx.scale(clip.sx, clip.sy);
        pctx.imageSmoothingQuality = 'high';
        pctx.drawImage(clip.canvas, -w / 2, -h / 2);
        pctx.restore();
        page.markInk();
      }
      const region = unionRect(backup.dirty, bake);
      if (region != null) patches.push(makePatch(page, backup.canvas, region));
    }
    this.placeTexts(clip);
    this.finish(patches, clip.label, clip.stockId != null ? this.takeFromStock(clip.stockId) : null);
  }

  /** Put everything back exactly as before the cut; no history. */
  cancel(): void {
    const clip = this.clip;
    if (clip == null) return;
    for (const b of clip.backups.values()) {
      if (b.dirty == null) continue;
      b.page.ctx.clearRect(b.dirty.x, b.dirty.y, b.dirty.w, b.dirty.h);
      b.page.ctx.drawImage(b.canvas, b.dirty.x, b.dirty.y, b.dirty.w, b.dirty.h, b.dirty.x, b.dirty.y, b.dirty.w, b.dirty.h);
      b.page.markInk();
    }
    for (const b of clip.backups.values()) {
      if (b.page.textsBeforeCut == null) continue;
      b.page.texts = copyTexts(b.texts);
      b.page.markTexts();
      this.ctx.refreshTexts(b.page);
    }
    this.finish([], '');
  }

  /** Drop the clip; the cut area stays empty (undoable). A clip from the stock is gone from it too. */
  remove(): void {
    const clip = this.clip;
    if (clip == null) return;
    this.finish(this.cutPatches(clip), '選択範囲の削除', clip.stockId != null ? this.takeFromStock(clip.stockId) : null);
  }

  /**
   * Move the clip (ink and texts, as cut) into the stock; the pages keep no copy. A clip
   * pasted from the stock just goes back there. False when nothing is selected.
   */
  toStock(): boolean {
    const clip = this.clip;
    if (clip == null) return false;
    const project = this.ctx.project;
    // Unless it was deleted from the stock meanwhile: then it is stocked anew below.
    if (clip.stockId != null && project.stock.some((s) => s.kind === 'clip' && s.id === clip.stockId)) {
      this.cancel();
      return true;
    }
    const id = newId('clip');
    // The clip is done with its ink canvas (finish never frees it): the stock keeps it.
    project.clips.set(id, clip.canvas);
    const texts = copyTexts(clip.texts);
    const same = (s: StockItem) => s.kind === 'clip' && s.id === id;
    this.finish(this.cutPatches(clip), 'ストックへ切り出し', {
      apply: () => {
        if (project.stock.some(same)) return;
        project.stock.push(texts.length > 0 ? { kind: 'clip', id, texts: copyTexts(texts) } : { kind: 'clip', id });
      },
      revert: () => {
        project.stock = project.stock.filter((s) => !same(s));
      },
    });
    return true;
  }

  /** Patches that keep the cut areas empty. */
  private cutPatches(clip: FloatingClip): InkPatch[] {
    const patches: InkPatch[] = [];
    for (const b of clip.backups.values()) {
      if (b.dirty != null) patches.push(makePatch(b.page, b.canvas, b.dirty));
    }
    return patches;
  }

  /** Taking stock clip `id` out of the stock, or null when it is no longer there. */
  private takeFromStock(id: string): StockChange | null {
    const project = this.ctx.project;
    const same = (s: StockItem) => s.kind === 'clip' && s.id === id;
    const index = project.stock.findIndex(same);
    if (index < 0) return null;
    const item = project.stock[index]!;
    return {
      apply: () => {
        project.stock = project.stock.filter((s) => !same(s));
      },
      revert: () => {
        if (!project.stock.some(same)) project.stock.splice(Math.min(index, project.stock.length), 0, item);
      },
    };
  }

  /** Put the clip's texts on the shown page under each, following the clip's move, scale and mirroring. */
  private placeTexts(clip: FloatingClip): void {
    const targets = [...clip.backups.values()].filter((b) => !b.carried);
    if (targets.length === 0) return;
    const w = clip.canvas.width;
    const h = clip.canvas.height;
    const s = Math.abs(clip.sy);
    const cos = Math.cos(clip.rot);
    const sin = Math.sin(clip.rot);
    for (const t of clip.texts) {
      // Texts move with the clip but stay upright: only their centres turn.
      const lx = ((t.x + t.w / 2 - w / 2) / PX_PER_M) * clip.sx;
      const ly = (-(t.y + t.h / 2 - h / 2) / PX_PER_M) * clip.sy;
      const bx = clip.cx + lx * cos - ly * sin;
      const by = clip.cy + lx * sin + ly * cos;
      // The shown page under the text's centre, else the nearest one.
      let best = targets[0]!;
      let bestDistance = Infinity;
      for (const b of targets) {
        const r = b.rect;
        const dx = Math.max(r.x0 - bx, 0, bx - r.x1);
        const dy = Math.max(r.y0 - by, 0, by - r.y1);
        if (dx * dx + dy * dy < bestDistance) {
          bestDistance = dx * dx + dy * dy;
          best = b;
        }
      }
      const r = best.rect;
      const tw = t.w * s;
      const th = t.h * s;
      // A text off every page would be invisible yet still there: keep its centre on the page.
      const px = Math.min(Math.max(bx, r.x0), r.x1);
      const py = Math.min(Math.max(by, r.y0), r.y1);
      best.page.texts.push({
        ...t,
        id: newId('tx'),
        fontSize: t.fontSize * s,
        w: tw,
        h: th,
        x: (px - r.x0) * PX_PER_M - tw / 2,
        y: (r.y1 - py) * PX_PER_M - th / 2,
      });
      best.page.markTexts();
    }
  }

  /** Take every shown text touching the marquee off its page; returns copies in marquee px. */
  private cutTexts(
    poly: number[] | null,
    wPx: number,
    hPx: number,
    toClip: (x: number, y: number) => [number, number],
  ): TextBox[] {
    const board = this.ctx.board;
    const taken: TextBox[] = [];
    for (const [slotIndex, slot] of board.slots.entries()) {
      const page = slot.page;
      if (page == null || (board.single && slotIndex === 1)) continue;
      const r = board.slotRect(slotIndex);
      const [ox, oy] = toClip(r.x0, r.y1);
      const keep: TextBox[] = [];
      for (const t of page.texts) {
        const rect = { x: ox + t.x, y: oy + t.y, w: t.w, h: t.h };
        const touches =
          poly != null
            ? rectTouchesPolygon(rect, poly)
            : rect.x < wPx && rect.x + rect.w > 0 && rect.y < hPx && rect.y + rect.h > 0;
        if (touches && t.content.trim().length > 0) taken.push({ ...t, x: rect.x, y: rect.y });
        else keep.push(t);
      }
      if (keep.length === page.texts.length) continue;
      page.textsBeforeCut = page.texts;
      page.texts = keep;
      page.markTexts();
      this.ctx.refreshTexts(page);
    }
    return taken;
  }

  /** Bake a copy at the current spot and keep floating the original. */
  duplicate(): void {
    const clip = this.clip;
    if (clip == null) return;
    const keep = { ...clip, canvas: this.snapshotCanvas()!, texts: copyTexts(clip.texts) };
    this.commit();
    this.float(keep.canvas, keep.cx + 0.012, keep.cy - 0.012, '複製の配置', undefined, { texts: keep.texts });
    if (this.clip != null) {
      this.clip.sx = keep.sx;
      this.clip.sy = keep.sy;
      this.clip.rot = keep.rot;
      this.show();
    }
  }

  /**
   * The spread changed while a clip floats (MangaSketcher pasteboard): keep the clip
   * where it is on the board and make the newly shown pages its bake targets.
   */
  carryToDisplayed(): void {
    const clip = this.clip;
    if (clip == null) return;
    for (const b of clip.backups.values()) b.carried = true;
    const board = this.ctx.board;
    for (const [i, slot] of board.slots.entries()) {
      const page = slot.page;
      if (page == null || (board.single && i === 1)) continue;
      const existing = clip.backups.get(page.id);
      if (existing != null) {
        existing.carried = false;
        existing.rect = board.slotRect(i);
        continue;
      }
      const canvas = pool.pop() ?? makeCanvas(RASTER_W, RASTER_H);
      const c = ctx2d(canvas);
      c.clearRect(0, 0, RASTER_W, RASTER_H);
      c.drawImage(page.ink, 0, 0);
      clip.backups.set(page.id, { page, canvas, dirty: null, rect: board.slotRect(i), texts: copyTexts(page.texts) });
    }
    clip.floated = true;
    this.show();
  }

  private finish(patches: InkPatch[], label: string, stock: StockChange | null = null): void {
    const clip = this.clip;
    if (clip == null) return;
    this.clip = null;
    this.drag = null;
    clip.texture.dispose();
    if (clip.display !== clip.canvas) clip.display.width = 0;
    const texts: TextChange[] = [];
    for (const b of clip.backups.values()) {
      b.page.textsBeforeCut = null;
      if (JSON.stringify(b.page.texts) === JSON.stringify(b.texts)) continue;
      texts.push({ page: b.page, before: b.texts, after: copyTexts(b.page.texts) });
    }
    this.releaseBackups(clip.backups);
    this.ctx.board.showClip(null);
    stock?.apply();
    if (patches.length > 0 || texts.length > 0 || stock != null) {
      this.ctx.history.push(this.entry(label, patches, texts, stock));
      this.ctx.markDirty();
    }
    if (texts.length > 0) this.ctx.refreshTexts();
    if (stock != null) {
      this.ctx.project.emit('struct');
      this.ctx.refreshBoard();
    }
  }

  /** One undo step for the ink, the texts the clip moved and the stock edit made with it. */
  private entry(label: string, patches: InkPatch[], texts: TextChange[], stock: StockChange | null): HistoryEntry {
    const ctx = this.ctx;
    const ink = inkEntry(label, patches, () => {});
    const set = (which: 'before' | 'after') => {
      for (const t of texts) {
        t.page.texts = copyTexts(t[which]);
        t.page.markTexts();
      }
    };
    const done = () => {
      ctx.refreshTexts();
      if (stock != null) {
        ctx.project.emit('struct');
        ctx.refreshBoard();
      }
      ctx.markDirty();
    };
    return {
      label,
      bytes: ink.bytes,
      dispose: ink.dispose,
      undo: () => {
        ink.undo();
        set('before');
        stock?.revert();
        done();
      },
      redo: () => {
        ink.redo();
        set('after');
        stock?.apply();
        done();
      },
    };
  }

  private show(): void {
    const clip = this.clip;
    if (clip == null) return;
    // Placed texts never mirror: a flipped clip draws them mirrored so they read the same.
    if (clip.texts.length > 0 && clip.sx < 0 !== clip.mirrored) {
      clip.mirrored = clip.sx < 0;
      const w = clip.display.width;
      const c = ctx2d(clip.display);
      c.clearRect(0, 0, w, clip.display.height);
      c.drawImage(clip.canvas, 0, 0);
      c.save();
      if (clip.mirrored) c.setTransform(-1, 0, 0, 1, w, 0);
      drawTexts(c, clip.mirrored ? clip.texts.map((t) => ({ ...t, x: w - t.x - t.w })) : clip.texts, 1);
      c.restore();
      // Only a redraw needs an upload; moving the clip does not.
      clip.texture.needsUpdate = true;
    }
    this.ctx.board.showClip(clip);
  }

  private rectPoints(): number[] {
    const [x0, y0, x1, y1] = this.marquee as [number, number, number, number];
    return [x0, y0, x1, y0, x1, y1, x0, y1];
  }

  private backupDisplayed(): Map<string, Backup> {
    const backups = new Map<string, Backup>();
    const board = this.ctx.board;
    for (const [i, slot] of board.slots.entries()) {
      if (slot.page == null || (board.single && i === 1)) continue;
      const canvas = pool.pop() ?? makeCanvas(RASTER_W, RASTER_H);
      const c = ctx2d(canvas);
      c.clearRect(0, 0, RASTER_W, RASTER_H);
      c.drawImage(slot.page.ink, 0, 0);
      backups.set(slot.page.id, { page: slot.page, canvas, dirty: null, rect: board.slotRect(i), texts: copyTexts(slot.page.texts) });
    }
    return backups;
  }

  private releaseBackups(backups: Map<string, Backup>): void {
    for (const b of backups.values()) recycle(b.canvas);
    backups.clear();
  }
}

/** Shared pooled full-page backup used by the eraser. */
export function borrowBackup(page: PageRt): HTMLCanvasElement {
  const canvas = pool.pop() ?? makeCanvas(RASTER_W, RASTER_H);
  const c = ctx2d(canvas);
  c.clearRect(0, 0, RASTER_W, RASTER_H);
  c.drawImage(page.ink, 0, 0);
  return canvas;
}

/** Keep a few full-page canvases for reuse; free the rest (8 MB each). */
function recycle(canvas: HTMLCanvasElement): void {
  if (pool.length < 3) pool.push(canvas);
  else canvas.width = 0;
}

export function returnBackup(canvas: HTMLCanvasElement): void {
  recycle(canvas);
}
