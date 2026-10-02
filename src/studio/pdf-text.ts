// PDF text helpers ported from MangaSketcher (src/domain/pdfText.ts, pdfExtract.ts):
// ruby removal, vertical reading order and range selection on raw pdf.js items.

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

interface PdfJsItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function glyphFontSize(item: PdfJsItem): number {
  const fromTransform = Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0);
  const { width: w, height: h } = item;
  if (Number.isFinite(h) && Number.isFinite(w) && h > w * 1.25 && w > 0) return w;
  if (fromTransform > 0 && fromTransform < 80) return fromTransform;
  return (w > 0 && w < 80 ? w : 12) || 12;
}

function explodeVerticalRun(item: PdfTextItem): PdfTextItem[] {
  const chars = [...item.str];
  const em = Math.max(1, item.fontSize || item.width || 1);
  const run = item.height || em;
  if (chars.length <= 1 || run <= em * 1.35) return [item];
  const step = run / chars.length;
  return chars.map((str, index) => ({
    ...item,
    str,
    y: item.y - (index + 1) * step,
    width: item.width || em,
    height: step,
    fontSize: em,
  }));
}

export function toItems(items: ReadonlyArray<unknown>): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const raw of items) {
    if (raw == null || typeof raw !== 'object' || !('str' in raw) || !('transform' in raw)) continue;
    const item = raw as PdfJsItem;
    const fontSize = glyphFontSize(item);
    out.push(
      ...explodeVerticalRun({
        str: item.str,
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        width: item.width || fontSize,
        height: item.height || fontSize,
        fontSize,
      }),
    );
  }
  return out;
}

/** Drop furigana: glyphs much smaller than the body size. */
export function stripRuby(items: readonly PdfTextItem[]): PdfTextItem[] {
  const mid = median(items.map((i) => i.fontSize).filter((s) => s > 0));
  return items.filter((item) => item.str.trim().length > 0 && (mid <= 0 || item.fontSize >= mid * 0.72));
}

function isHorizontal(items: readonly PdfTextItem[]): boolean {
  let wide = 0;
  for (const item of items) if (item.width > item.height * 1.5 && [...item.str].length > 1) wide++;
  return wide > items.length * 0.4;
}

/** Join body text in reading order (vertical RTL columns, or horizontal rows). */
export function joinBody(items: readonly PdfTextItem[]): string {
  const body = stripRuby(items);
  if (body.length === 0) return '';
  if (isHorizontal(body)) {
    const sorted = [...body].sort((a, b) => {
      const row = b.y - a.y;
      return Math.abs(row) > Math.max(a.fontSize, b.fontSize) * 0.6 ? row : a.x - b.x;
    });
    let text = '';
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i]!;
      if (prev != null && Math.abs(prev.y - cur.y) > Math.max(prev.fontSize, cur.fontSize) * 0.6) text += '\n';
      text += cur.str;
    }
    return text.trim();
  }
  return [...body]
    .sort((a, b) => {
      const col = b.x - a.x;
      return Math.abs(col) > Math.max(a.fontSize, b.fontSize) * 0.8 ? col : b.y - a.y;
    })
    .map((item) => item.str)
    .join('')
    .replace(/\s+/g, '');
}

export function inRect(
  items: readonly PdfTextItem[],
  rect: { x: number; y: number; width: number; height: number },
): PdfTextItem[] {
  return items.filter(
    (item) =>
      item.x < rect.x + rect.width &&
      item.x + item.width > rect.x &&
      item.y < rect.y + rect.height &&
      item.y + item.height > rect.y,
  );
}

/** Drop 「」 and turn 、。 into spaces (MangaSketcher option). */
export function sanitize(text: string): string {
  return text
    .replace(/[「」]/g, '')
    .replace(/[、。]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Script lines from a plain-text file: one dialogue per non-empty line. */
export function scriptLines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function selfTestPdfText(): void {
  const items: PdfTextItem[] = [
    { str: 'い', x: 100, y: 500, width: 10, height: 10, fontSize: 10 },
    { str: 'あ', x: 100, y: 510, width: 10, height: 10, fontSize: 10 },
    { str: 'う', x: 80, y: 510, width: 10, height: 10, fontSize: 10 },
    { str: 'るび', x: 112, y: 510, width: 4, height: 8, fontSize: 4 },
  ];
  const joined = joinBody(items);
  if (joined !== 'あいう') throw new Error(`joinBody vertical: ${joined}`);
  if (sanitize('「あ、い。」') !== 'あ い') throw new Error('sanitize');
  if (scriptLines('﻿a\n\n b \r\nc').join('|') !== 'a|b|c') throw new Error('scriptLines');
}
