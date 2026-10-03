import { CanvasTexture, SRGBColorSpace } from '@iwsdk/core';
import {
  DEFAULT_TOOLS,
  RASTER_H,
  RASTER_W,
  TEMPLATE_NUMBER_COVER,
  THUMB_H,
  THUMB_W,
  cloneTexts,
  newId,
  type DioramaSave,
  type DocJson,
  type StockItem,
  type TextBox,
  type ToolSettings,
} from './doc.js';
import { drawTexts } from './text-render.js';
import * as storage from './storage.js';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** Copy of a stock entry; a clip's texts are copied too so snapshots never share them. */
const cloneStockItem = (s: StockItem): StockItem =>
  s.kind === 'clip' && s.texts != null ? { ...s, texts: s.texts.map((t) => ({ ...t })) } : { ...s };

/** How a clip looks: its ink with its texts drawn on top (the ink canvas itself when it has none). */
export function composeClip(ink: HTMLCanvasElement, texts: readonly TextBox[] | undefined): HTMLCanvasElement {
  if (texts == null || texts.length === 0) return ink;
  const out = makeCanvas(ink.width, ink.height);
  const c = ctx2d(out);
  c.drawImage(ink, 0, 0);
  drawTexts(c, texts, 1);
  return out;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx == null) throw new Error('2D canvas unavailable');
  return ctx;
}

export function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

let templateCanvas: HTMLCanvasElement | null = null;

/** Template with its baked-in page number painted out (MangaSketcher rule). */
export async function loadTemplate(url: string): Promise<HTMLCanvasElement> {
  if (templateCanvas != null) return templateCanvas;
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = makeCanvas(RASTER_W, RASTER_H);
  const ctx = ctx2d(canvas);
  ctx.drawImage(image, 0, 0, RASTER_W, RASTER_H);
  const c = TEMPLATE_NUMBER_COVER;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(c.x * RASTER_W, c.y * RASTER_H, c.w * RASTER_W, c.h * RASTER_H);
  templateCanvas = canvas;
  return canvas;
}

export function template(): HTMLCanvasElement {
  if (templateCanvas == null) throw new Error('template not loaded');
  return templateCanvas;
}

export class PageRt {
  readonly ink = makeCanvas(RASTER_W, RASTER_H);
  readonly ctx = ctx2d(this.ink);
  readonly thumb = makeCanvas(THUMB_W, THUMB_H);
  readonly thumbTex = canvasTexture(this.thumb);
  inkVersion = 0;
  savedVersion = 0;
  /** Its texts before a floating clip took some; page-structure undo keeps these, not the cut. */
  textsBeforeCut: TextBox[] | null = null;
  private inkTexture: CanvasTexture | null = null;
  private thumbStale = true;

  constructor(
    readonly id: string,
    public texts: TextBox[] = [],
  ) {}

  /** GPU texture for the board; disposed when the page leaves the board. */
  get inkTex(): CanvasTexture {
    this.inkTexture ??= canvasTexture(this.ink);
    return this.inkTexture;
  }

  releaseInkTexture(): void {
    this.inkTexture?.dispose();
    this.inkTexture = null;
  }

  markInk(): void {
    this.inkVersion++;
    if (this.inkTexture != null) this.inkTexture.needsUpdate = true;
    this.thumbStale = true;
  }

  markTexts(): void {
    this.thumbStale = true;
  }

  /** Redraw the thumbnail when stale; cheap enough to call once per frame. */
  refreshThumb(): boolean {
    if (!this.thumbStale) return false;
    this.thumbStale = false;
    const ctx = ctx2d(this.thumb);
    ctx.drawImage(template(), 0, 0, THUMB_W, THUMB_H);
    ctx.drawImage(this.ink, 0, 0, THUMB_W, THUMB_H);
    drawTexts(ctx, this.texts, THUMB_W / RASTER_W);
    this.thumbTex.needsUpdate = true;
    return true;
  }

  /** Full-resolution composite (template + ink + text) for export. */
  composite(withTemplate = true): HTMLCanvasElement {
    const out = makeCanvas(RASTER_W, RASTER_H);
    const ctx = ctx2d(out);
    if (withTemplate) ctx.drawImage(template(), 0, 0);
    else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, RASTER_W, RASTER_H);
    }
    ctx.drawImage(this.ink, 0, 0);
    drawTexts(ctx, this.texts, 1);
    return out;
  }

  dispose(): void {
    this.releaseInkTexture();
    this.thumbTex.dispose();
    this.ink.width = 0;
    this.thumb.width = 0;
  }
}

export interface StructSnapshot {
  order: string[];
  stock: StockItem[];
  trash: string[];
  texts: Record<string, TextBox[]>;
  currentPage: string | null;
}

export type ChangeKind = 'struct' | 'ink' | 'text' | 'tools' | 'meta' | 'script';

export class Project {
  id = newId('prj');
  name = '新しいネーム';
  readonly pages = new Map<string, PageRt>();
  order: string[] = [];
  stock: StockItem[] = [];
  trash: string[] = [];
  readonly clips = new Map<string, HTMLCanvasElement>();
  currentPage: string | null = null;
  tools: ToolSettings = { ...DEFAULT_TOOLS };
  script: string[] = [];
  scriptCursor = 0;
  pdfName: string | null = null;
  pdfPage = 1;
  diorama: DioramaSave[] = [];
  cuts: Record<string, DioramaSave[]> = {};
  /** Stock card places (not part of undo: moving a card is not an edit of the name). */
  stockPlaces: Record<string, number[]> = {};
  updatedAt = Date.now();
  /** Set when the project was deleted; autosave must never write it back. */
  deleted = false;
  /** Clip ids whose PNG is already in IndexedDB. */
  readonly savedClips = new Set<string>();
  readonly removedInks: string[] = [];
  readonly removedClips: string[] = [];
  private readonly listeners: Array<(kind: ChangeKind) => void> = [];

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.push(listener);
    return () => this.listeners.splice(this.listeners.indexOf(listener), 1);
  }

  emit(kind: ChangeKind): void {
    this.updatedAt = Date.now();
    for (const listener of this.listeners) listener(kind);
  }

  static blank(pageCount: number, name: string): Project {
    const project = new Project();
    project.name = name;
    for (let i = 0; i < Math.max(1, pageCount); i++) {
      const page = new PageRt(newId('pg'));
      project.pages.set(page.id, page);
      project.order.push(page.id);
    }
    project.currentPage = project.order[0] ?? null;
    return project;
  }

  static async load(id: string): Promise<Project | null> {
    const json = await storage.loadDoc(id);
    if (json == null) return null;
    const project = new Project();
    project.id = json.id;
    project.name = json.name;
    project.order = [...json.order];
    project.stock = json.stock.map(cloneStockItem);
    project.trash = [...json.trash];
    project.currentPage = json.currentPage;
    project.tools = { ...DEFAULT_TOOLS, ...json.tools };
    project.script = [...(json.script ?? [])];
    project.scriptCursor = json.scriptCursor ?? 0;
    project.pdfName = json.pdfName ?? null;
    project.pdfPage = json.pdfPage ?? 1;
    project.diorama = (json.diorama ?? []).map((d) => ({ ...d }));
    project.cuts = Object.fromEntries(Object.entries(json.cuts ?? {}).map(([k, v]) => [k, v.map((d) => ({ ...d }))]));
    project.stockPlaces = Object.fromEntries(Object.entries(json.stockPlaces ?? {}).map(([k, v]) => [k, [...v]]));
    project.updatedAt = json.updatedAt;
    const pageIds = new Set([
      ...json.order,
      ...json.trash,
      ...json.stock.filter((s) => s.kind === 'page').map((s) => s.id),
    ]);
    await Promise.all(
      [...pageIds].map(async (pageId) => {
        const page = new PageRt(pageId, (json.texts[pageId] ?? []).map((t) => ({ ...t })));
        project.pages.set(pageId, page);
        const blob = await storage.loadInk(json.id, pageId);
        if (blob != null) {
          const bitmap = await createImageBitmap(blob);
          page.ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        }
        page.markInk();
        page.savedVersion = page.inkVersion;
      }),
    );
    await Promise.all(
      json.stock
        .filter((s) => s.kind === 'clip')
        .map(async (s) => {
          const blob = await storage.loadClip(json.id, s.id);
          if (blob == null) return;
          const bitmap = await createImageBitmap(blob);
          const canvas = makeCanvas(bitmap.width, bitmap.height);
          ctx2d(canvas).drawImage(bitmap, 0, 0);
          bitmap.close();
          project.clips.set(s.id, canvas);
          project.savedClips.add(s.id);
        }),
    );
    if (project.currentPage == null || !project.order.includes(project.currentPage)) {
      project.currentPage = project.order[0] ?? null;
    }
    return project;
  }

  toJson(): DocJson {
    const texts: Record<string, TextBox[]> = {};
    for (const [id, page] of this.pages) texts[id] = page.texts.map((t) => ({ ...t }));
    return {
      version: 1,
      id: this.id,
      name: this.name,
      order: [...this.order],
      stock: this.stock.map(cloneStockItem),
      trash: [...this.trash],
      texts,
      currentPage: this.currentPage,
      tools: { ...this.tools },
      script: [...this.script],
      scriptCursor: this.scriptCursor,
      pdfName: this.pdfName,
      pdfPage: this.pdfPage,
      diorama: this.diorama.map((d) => ({ ...d })),
      cuts: Object.fromEntries(Object.entries(this.cuts).map(([k, v]) => [k, v.map((d) => ({ ...d }))])),
      // Only items still in the stock keep a place.
      stockPlaces: Object.fromEntries(
        this.stock.filter((s) => this.stockPlaces[s.id] != null).map((s) => [s.id, [...this.stockPlaces[s.id]!]]),
      ),
      updatedAt: this.updatedAt,
    };
  }

  page(id: string | null): PageRt | undefined {
    return id == null ? undefined : this.pages.get(id);
  }

  pageNumber(id: string): number {
    return this.order.indexOf(id) + 1;
  }

  snapshot(): StructSnapshot {
    const texts: Record<string, TextBox[]> = {};
    for (const [id, page] of this.pages) texts[id] = page.textsBeforeCut ?? page.texts;
    return {
      order: [...this.order],
      stock: this.stock.map(cloneStockItem),
      trash: [...this.trash],
      texts: cloneTexts(texts),
      currentPage: this.currentPage,
    };
  }

  restore(snap: StructSnapshot): void {
    this.order = [...snap.order];
    this.stock = snap.stock.map(cloneStockItem);
    this.trash = [...snap.trash];
    const texts = cloneTexts(snap.texts);
    for (const [id, page] of this.pages) {
      page.texts = texts[id] ?? [];
      page.markTexts();
    }
    this.currentPage = snap.currentPage;
    this.emit('struct');
    this.emit('text');
  }

  newPage(): PageRt {
    const page = new PageRt(newId('pg'));
    this.pages.set(page.id, page);
    page.markInk();
    return page;
  }

  /** Permanently drop trashed pages (history must be cleared by the caller). */
  emptyTrash(): number {
    const count = this.trash.length;
    for (const id of this.trash) {
      this.pages.get(id)?.dispose();
      this.pages.delete(id);
      this.removedInks.push(id);
      delete this.cuts[id];
    }
    this.trash = [];
    this.emit('struct');
    return count;
  }

  removeClip(id: string): void {
    this.clips.delete(id);
    if (this.savedClips.delete(id)) this.removedClips.push(id);
  }

  dispose(): void {
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    this.listeners.length = 0;
  }
}
