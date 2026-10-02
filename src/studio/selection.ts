// Rectangle / lasso cut into a floating clip that can be moved, scaled, rotated,
// flipped and baked back onto either page of the spread (MangaSketcher pasteboard).
import { PX_PER_M, RASTER_H, RASTER_W } from './doc.js';
import { clampRect, makePatch, inkEntry, opaqueBounds, unionRect, type Rect, type InkPatch } from './patches.js';
import { canvasTexture, ctx2d, makeCanvas, type PageRt } from './project.js';
import type { ClipView, SlotRect } from './board.js';
import type { StudioCtx } from './studio-ctx.js';

type DragMode = 'move' | 'scale' | 'rotate';

interface Backup {
  page: PageRt;
  canvas: HTMLCanvasElement;
  dirty: Rect | null;
  /** Page placement on the board when the clip was made; bakes never depend on the live layout. */
  rect: SlotRect;
  /** Page left the board while the clip floated: keep its cut, never bake into it. */
  carried?: boolean;
}

interface FloatingClip extends ClipView {
  backups: Map<string, Backup>;
  label: string;
  /** Pasted from outside (stock / diorama): committing it always counts as an edit. */
  floated: boolean;
  origin: { cx: number; cy: number };
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
    const tight = opaqueBounds(canvas);
    if (tight == null) {
      this.releaseBackups(backups);
      this.ctx.toast('選択範囲に線がありません');
      return false;
    }
    const trimmed = makeCanvas(tight.w, tight.h);
    ctx2d(trimmed).drawImage(canvas, tight.x, tight.y, tight.w, tight.h, 0, 0, tight.w, tight.h);
    canvas.width = 0;
    this.clip = {
      canvas: trimmed,
      texture: canvasTexture(trimmed),
      cx: minX + (tight.x + tight.w / 2) / PX_PER_M,
      cy: maxY - (tight.y + tight.h / 2) / PX_PER_M,
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

  /** Float an external image (stock clip, diorama snapshot) over the current page. */
  float(source: HTMLCanvasElement, cx: number, cy: number, label: string, fitWidth?: number): void {
    this.commit();
    const canvas = makeCanvas(source.width, source.height);
    ctx2d(canvas).drawImage(source, 0, 0);
    const scale = fitWidth != null ? Math.min(1, (fitWidth * PX_PER_M) / source.width) : 1;
    this.clip = {
      canvas,
      texture: canvasTexture(canvas),
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

  /** Copy of the clip pixels for the stock. */
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
    this.finish(patches, clip.label);
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
    this.finish([], '');
  }

  /** Drop the clip; the cut area stays empty (undoable). */
  remove(): void {
    const clip = this.clip;
    if (clip == null) return;
    const patches: InkPatch[] = [];
    for (const b of clip.backups.values()) {
      if (b.dirty != null) patches.push(makePatch(b.page, b.canvas, b.dirty));
    }
    this.finish(patches, '選択範囲の削除');
  }

  /** Bake a copy at the current spot and keep floating the original. */
  duplicate(): void {
    const clip = this.clip;
    if (clip == null) return;
    const keep = { ...clip, canvas: this.snapshotCanvas()! };
    this.commit();
    this.float(keep.canvas, keep.cx + 0.012, keep.cy - 0.012, '複製の配置');
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
      clip.backups.set(page.id, { page, canvas, dirty: null, rect: board.slotRect(i) });
    }
    clip.floated = true;
    this.show();
  }

  private finish(patches: InkPatch[], label: string): void {
    const clip = this.clip;
    if (clip == null) return;
    this.clip = null;
    this.drag = null;
    clip.texture.dispose();
    this.releaseBackups(clip.backups);
    this.ctx.board.showClip(null);
    if (patches.length > 0) {
      this.ctx.history.push(inkEntry(label, patches, () => this.ctx.markDirty()));
      this.ctx.markDirty();
    }
  }

  private show(): void {
    if (this.clip == null) return;
    this.clip.texture.needsUpdate = true;
    this.ctx.board.showClip(this.clip);
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
      backups.set(slot.page.id, { page: slot.page, canvas, dirty: null, rect: board.slotRect(i) });
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
