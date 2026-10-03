// Structural page operations. Each one is a single undo step built from
// before/after JSON snapshots; page pixels are never copied for these.
import { RASTER_H, RASTER_W, spreadIndexOf, readingSpreads, pagesOfSpread } from './doc.js';
import { inkEntry, makePatch } from './patches.js';
import type { PageRt } from './project.js';
import { borrowBackup, returnBackup } from './selection.js';
import type { StudioCtx } from './studio-ctx.js';

export function structChange(ctx: StudioCtx, label: string, mutate: () => boolean | void): boolean {
  const project = ctx.project;
  const before = project.snapshot();
  if (mutate() === false) return false;
  const after = project.snapshot();
  ctx.history.push({
    label,
    undo: () => {
      project.restore(before);
      ctx.refreshBoard();
    },
    redo: () => {
      project.restore(after);
      ctx.refreshBoard();
    },
  });
  project.emit('struct');
  ctx.refreshBoard();
  ctx.markDirty();
  return true;
}

export function goToPage(ctx: StudioCtx, pageId: string): void {
  if (!ctx.project.order.includes(pageId)) return;
  ctx.project.currentPage = pageId;
  ctx.refreshBoard();
  ctx.markDirty();
}

/** Turn by whole spreads (+1 = later pages, which sit to the left in RTL). */
export function turnSpread(ctx: StudioCtx, dir: number): boolean {
  const project = ctx.project;
  const spreads = readingSpreads(project.order);
  const cur = spreadIndexOf(project.order, project.currentPage);
  const next = Math.min(spreads.length - 1, Math.max(0, cur + dir));
  if (next === cur) return false;
  const ids = pagesOfSpread(spreads[next]!);
  project.currentPage = ids[0] ?? project.currentPage;
  ctx.refreshBoard();
  ctx.markDirty();
  return true;
}

/** Single-page view turns one page at a time. */
export function turnPage(ctx: StudioCtx, dir: number): boolean {
  const project = ctx.project;
  const i = project.currentPage == null ? -1 : project.order.indexOf(project.currentPage);
  const next = Math.min(project.order.length - 1, Math.max(0, i + dir));
  if (next === i || next < 0) return false;
  project.currentPage = project.order[next]!;
  ctx.refreshBoard();
  ctx.markDirty();
  return true;
}

export function appendPage(ctx: StudioCtx): void {
  structChange(ctx, 'ページ追加', () => {
    const page = ctx.project.newPage();
    ctx.project.order.push(page.id);
    ctx.project.currentPage = page.id;
  });
}

export function insertAfterCurrent(ctx: StudioCtx): void {
  structChange(ctx, 'ページ挿入', () => {
    const project = ctx.project;
    const page = project.newPage();
    const i = project.currentPage == null ? project.order.length - 1 : project.order.indexOf(project.currentPage);
    project.order.splice(i + 1, 0, page.id);
    project.currentPage = page.id;
  });
}

export function duplicateCurrent(ctx: StudioCtx): void {
  const project = ctx.project;
  const src = project.page(project.currentPage);
  if (src == null) return;
  structChange(ctx, 'ページ複製', () => {
    const page = project.newPage();
    page.ctx.drawImage(src.ink, 0, 0);
    page.texts = src.texts.map((t) => ({ ...t, id: `${t.id}-c${Date.now().toString(36)}` }));
    page.markInk();
    page.markTexts();
    project.order.splice(project.order.indexOf(src.id) + 1, 0, page.id);
    project.currentPage = page.id;
  });
}

export function reorder(ctx: StudioCtx, pageId: string, index: number): void {
  structChange(ctx, 'ページ並べ替え', () => {
    const order = ctx.project.order;
    const from = order.indexOf(pageId);
    if (from < 0) return false;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, index)), 0, pageId);
    ctx.project.currentPage = pageId;
  });
}

export function moveCurrent(ctx: StudioCtx, delta: number): void {
  const project = ctx.project;
  const id = project.currentPage;
  if (id == null) return;
  const from = project.order.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= project.order.length) return;
  reorder(ctx, id, to);
}

/** Remove the current page from the workspace into the stock or the trash. */
export function removeCurrent(ctx: StudioCtx, target: 'stock' | 'trash'): void {
  const project = ctx.project;
  const id = project.currentPage;
  if (id == null) return;
  structChange(ctx, target === 'stock' ? 'ストックへ移動' : 'ゴミ箱へ移動', () => {
    const i = project.order.indexOf(id);
    project.order.splice(i, 1);
    if (target === 'stock') project.stock.push({ kind: 'page', id });
    else project.trash.push(id);
    project.currentPage = project.order[Math.min(i, project.order.length - 1)] ?? null;
  });
  ctx.toast(target === 'stock' ? 'ページをネームストックへ移しました' : 'ページをゴミ箱へ移しました (ストックタブから戻せます)');
}

/** Put a stocked/trashed page back at reading-order `index` (default: after the current page). */
export function restorePage(ctx: StudioCtx, pageId: string, from: 'stock' | 'trash', index?: number): void {
  const project = ctx.project;
  structChange(ctx, 'ページを戻す', () => {
    if (from === 'stock') project.stock = project.stock.filter((s) => !(s.kind === 'page' && s.id === pageId));
    else project.trash = project.trash.filter((t) => t !== pageId);
    const after = project.currentPage == null ? project.order.length - 1 : project.order.indexOf(project.currentPage);
    project.order.splice(Math.max(0, Math.min(project.order.length, index ?? after + 1)), 0, pageId);
    project.currentPage = pageId;
  });
}

export function stockPageToTrash(ctx: StudioCtx, pageId: string): void {
  structChange(ctx, 'ストックから削除', () => {
    const project = ctx.project;
    project.stock = project.stock.filter((s) => !(s.kind === 'page' && s.id === pageId));
    project.trash.push(pageId);
  });
}

export function removeStockClip(ctx: StudioCtx, clipId: string): void {
  structChange(ctx, 'クリップ削除', () => {
    ctx.project.stock = ctx.project.stock.filter((s) => !(s.kind === 'clip' && s.id === clipId));
  });
}


export function clearCurrentInk(ctx: StudioCtx): void {
  const page: PageRt | undefined = ctx.project.page(ctx.project.currentPage);
  if (page == null) return;
  const backup = borrowBackup(page);
  page.ctx.clearRect(0, 0, RASTER_W, RASTER_H);
  page.markInk();
  ctx.history.push(
    inkEntry('白紙に戻す', [makePatch(page, backup, { x: 0, y: 0, w: RASTER_W, h: RASTER_H })], () => ctx.markDirty()),
  );
  returnBackup(backup);
  ctx.markDirty();
  ctx.toast('ページの線画を消しました (テキストは残ります / 取り消し可)');
}
