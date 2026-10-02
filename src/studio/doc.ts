// Document model shared by every studio module. Pixels live in page canvases,
// everything else is plain JSON so it can be snapshotted for undo and autosave.

export const RASTER_W = 1200;
export const RASTER_H = 1700;
/** World width of one page on the board (meters). */
export const PAGE_W = 0.3;
export const PAGE_H = (PAGE_W * RASTER_H) / RASTER_W;
/** Raster pixels per board meter. */
export const PX_PER_M = RASTER_W / PAGE_W;
export const SPREAD_GAP = 0.012;
export const THUMB_W = 150;
export const THUMB_H = 212;
export const HISTORY_DEPTH = 50;

/** Template inner frame (基本枠) in raster px, measured from page_template.jpg. */
export const INNER_FRAME = { x: 188, y: 215, w: 851, h: 1263 };
/** Template trim (仕上がり) and bleed (裁ち落とし) areas in raster px. */
export const TRIM_FRAME = { x: 100, y: 131, w: 998, h: 1435 };
export const BLEED_FRAME = { x: 74, y: 101, w: 1053, h: 1497 };
/** Region of the baked-in "1" on the template that must be hidden. */
export const TEMPLATE_NUMBER_COVER = { x: 0.48, y: 0.876, w: 0.06, h: 0.022 };

export const PALETTE = [
  '#1A1A1A',
  '#6F675C',
  '#FFFFFF',
  '#C45C26',
  '#3D5A80',
  '#2A9D8F',
  '#5B9BD5',
  '#D64545',
] as const;

export type ToolId =
  | 'pen'
  | 'eraser'
  | 'line'
  | 'frame'
  | 'text'
  | 'select'
  | 'lasso'
  | 'hand';

/** Which hand (or controller) holds a tool. */
export type Side = 'left' | 'right';
export const SIDES: readonly Side[] = ['left', 'right'];

export type WritingMode = 'vertical' | 'horizontal';

export interface TextBox {
  id: string;
  content: string;
  /** Page raster px; for vertical text the right edge is the anchor. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  color: string;
  mode: WritingMode;
}

export interface ToolSettings {
  penColor: string;
  penSize: number;
  penOpacity: number;
  eraserSize: number;
  eraserOpacity: number;
  pressure: boolean;
  stabilizer: number;
  angleSnap: boolean;
  textSize: number;
  textColor: string;
  textMode: WritingMode;
}

export const DEFAULT_TOOLS: ToolSettings = {
  penColor: '#1A1A1A',
  penSize: 8,
  penOpacity: 1,
  eraserSize: 40,
  eraserOpacity: 1,
  pressure: true,
  stabilizer: 0.5,
  angleSnap: true,
  textSize: 36,
  textColor: '#1A1A1A',
  textMode: 'vertical',
};

export type StockItem =
  | { kind: 'page'; id: string }
  | { kind: 'clip'; id: string };

export interface DioramaSave {
  id: string;
  kind: string;
  color: string;
  label: string;
  pose: string;
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Camera tilt (radians); figures and props stay upright. */
  pitch?: number;
}

/** JSON part of a project (no pixels). */
export interface DocJson {
  version: 1;
  id: string;
  name: string;
  order: string[];
  stock: StockItem[];
  trash: string[];
  texts: Record<string, TextBox[]>;
  currentPage: string | null;
  tools: ToolSettings;
  script: string[];
  scriptCursor: number;
  pdfName: string | null;
  pdfPage: number;
  diorama: DioramaSave[];
  /** Saved diorama layouts (camera + pieces) keyed by page id: one "cut" per page. */
  cuts?: Record<string, DioramaSave[]>;
  updatedAt: number;
}

export function newId(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

export type Slot = { page: string } | { blank: true } | null;

export interface Spread {
  /** Reading-order first page sits on the right in RTL manga. */
  right: Slot;
  left: Slot;
}

/** RTL odd-start spreads: [1][余白] | [3][2] | [5][4] ... (left|right). */
export function readingSpreads(order: readonly string[]): Spread[] {
  if (order.length === 0) return [{ right: { blank: true }, left: null }];
  // Right-bound books open on page 1 alone on the LEFT, with a blank on the right.
  const spreads: Spread[] = [{ right: { blank: true }, left: { page: order[0]! } }];
  for (let i = 1; i < order.length; i += 2) {
    const left = order[i + 1];
    spreads.push({
      right: { page: order[i]! },
      left: left != null ? { page: left } : null,
    });
  }
  return spreads;
}

export function spreadIndexOf(order: readonly string[], pageId: string | null): number {
  const i = pageId == null ? -1 : order.indexOf(pageId);
  if (i <= 0) return 0;
  return Math.floor((i + 1) / 2);
}

export function pagesOfSpread(spread: Spread): string[] {
  const ids: string[] = [];
  for (const slot of [spread.right, spread.left]) {
    if (slot != null && 'page' in slot) ids.push(slot.page);
  }
  return ids;
}

export function cloneTexts(texts: Record<string, TextBox[]>): Record<string, TextBox[]> {
  const out: Record<string, TextBox[]> = {};
  for (const [id, list] of Object.entries(texts)) out[id] = list.map((t) => ({ ...t }));
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Selftest for the RTL spread rule; run with `node --experimental-strip-types`. */
export function selfTestSpreads(): void {
  const s = readingSpreads(['a', 'b', 'c', 'd']);
  const show = s.map((x) => `${JSON.stringify(x.left)}|${JSON.stringify(x.right)}`);
  if (s.length !== 3) throw new Error(`spreads ${show.join(' ')}`);
  if (pagesOfSpread(s[0]!).join() !== 'a') throw new Error('spread 0');
  if (pagesOfSpread(s[1]!).join() !== 'b,c') throw new Error('spread 1');
  if (pagesOfSpread(s[2]!).join() !== 'd') throw new Error('spread 2');
  if (spreadIndexOf(['a', 'b', 'c', 'd'], 'c') !== 1) throw new Error('index c');
  if (spreadIndexOf(['a', 'b', 'c', 'd'], 'd') !== 2) throw new Error('index d');
}
