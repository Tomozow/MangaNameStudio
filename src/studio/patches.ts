// Undo for pixels stores only the touched rectangle (before/after), never whole pages.
import { RASTER_H, RASTER_W, type TextBox } from './doc.js';
import type { HistoryEntry } from './history.js';
import { ctx2d, makeCanvas, type PageRt } from './project.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InkPatch extends Rect {
  page: PageRt;
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
}

/** Integer rect clamped to the raster; null when empty. */
export function clampRect(r: Rect, pad = 0): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x - pad));
  const y0 = Math.max(0, Math.floor(r.y - pad));
  const x1 = Math.min(RASTER_W, Math.ceil(r.x + r.w + pad));
  const y1 = Math.min(RASTER_H, Math.ceil(r.y + r.h + pad));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (a == null) return b;
  if (b == null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function crop(src: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const out = makeCanvas(r.w, r.h);
  ctx2d(out).drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}

export function makePatch(page: PageRt, before: HTMLCanvasElement, r: Rect): InkPatch {
  return { page, ...r, before: crop(before, r), after: crop(page.ink, r) };
}

function apply(patch: InkPatch, which: 'before' | 'after'): void {
  patch.page.ctx.clearRect(patch.x, patch.y, patch.w, patch.h);
  patch.page.ctx.drawImage(patch[which], patch.x, patch.y);
  patch.page.markInk();
}

export function inkEntry(label: string, patches: InkPatch[], onApply: () => void): HistoryEntry {
  return {
    label,
    bytes: patches.reduce((sum, p) => sum + p.w * p.h * 8, 0),
    undo: () => {
      for (const p of patches) apply(p, 'before');
      onApply();
    },
    redo: () => {
      for (const p of patches) apply(p, 'after');
      onApply();
    },
    dispose: () => {
      for (const p of patches) {
        p.before.width = 0;
        p.after.width = 0;
      }
    },
  };
}

export function textEntry(
  label: string,
  page: PageRt,
  before: TextBox[],
  onApply: () => void,
): HistoryEntry {
  const after = page.texts.map((t) => ({ ...t }));
  const set = (list: TextBox[]) => {
    page.texts = list.map((t) => ({ ...t }));
    page.markTexts();
    onApply();
  };
  return { label, undo: () => set(before), redo: () => set(after) };
}

/** Tight bounds of non-transparent pixels (one readback, used once per cut). */
export function opaqueBounds(canvas: HTMLCanvasElement): Rect | null {
  const { width, height } = canvas;
  if (width === 0 || height === 0) return null;
  const data = ctx2d(canvas).getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
