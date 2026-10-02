// Canvas text layout for manga dialogue. Canvas has no `writing-mode`, so vertical
// text is laid out glyph by glyph (ported from MangaSketcher drawPageTextsOnThumb).
import type { TextBox, WritingMode } from './doc.js';

export const TEXT_FONT_FAMILY = 'GenEiAntique';
const FONT_STACK = `"${TEXT_FONT_FAMILY}", "M PLUS 1p", sans-serif`;
const VERTICAL_PITCH = 1.5;
const HORIZONTAL_PITCH = 1.2;

const VERTICAL_FORMS: Readonly<Record<number, string>> = {
  0x2014: '︱', 0x2026: '︙', 0x3001: '︑', 0x3002: '︒',
  0x3008: '︿', 0x3009: '﹀', 0x300a: '︽', 0x300b: '︾',
  0x300c: '﹁', 0x300d: '﹂', 0x300e: '﹃', 0x300f: '﹄',
  0x3010: '︻', 0x3011: '︼', 0x3014: '︹', 0x3015: '︺',
  0x3016: '︗', 0x3017: '︘', 0xff08: '︵', 0xff09: '︶',
  0xff0c: '︐', 0xff3f: '︳', 0xff5b: '︷', 0xff5d: '︸',
  0x0028: '︵', 0x0029: '︶', 0x007b: '︷', 0x007d: '︸',
};
const ROTATE_IN_VERTICAL = new Set([
  0x30fc, 0xff70, 0x2025, 0x22ef, 0x2015, 0x2013, 0x2010, 0x2212, 0xff0d, 0x301c, 0xff5e,
]);
/** Small kana sit in the upper-right of their cell in vertical text. */
const SMALL_KANA = new Set([...'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ']);

export function textFont(px: number): string {
  return `${px}px ${FONT_STACK}`;
}

export function isWhite(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c === '#fff' || c === '#ffffff' || c === 'white';
}

function cellsPerLine(extent: number, fontSize: number): number {
  return Math.max(1, Math.floor((extent + 0.01) / fontSize));
}

/** Number of columns (vertical) or rows (horizontal) the content needs. */
export function lineCount(content: string, extent: number, fontSize: number): number {
  const per = cellsPerLine(extent, fontSize);
  let lines = 0;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    lines += Math.max(1, Math.ceil([...raw].length / per));
  }
  return Math.max(1, lines);
}

/**
 * Grow the cross axis so every glyph fits. Vertical boxes keep their right edge
 * (text starts there), horizontal boxes keep their top edge.
 */
export function fitTextBox(box: TextBox): void {
  if (box.mode === 'vertical') {
    const right = box.x + box.w;
    const cols = lineCount(box.content, box.h, box.fontSize);
    box.w = Math.max(box.fontSize * VERTICAL_PITCH, cols * box.fontSize * VERTICAL_PITCH);
    box.x = right - box.w;
  } else {
    const rows = lineCount(box.content, box.w, box.fontSize);
    box.h = Math.max(box.fontSize * HORIZONTAL_PITCH, rows * box.fontSize * HORIZONTAL_PITCH);
  }
}

export function defaultBoxSize(mode: WritingMode, fontSize: number): { w: number; h: number } {
  return mode === 'vertical'
    ? { w: fontSize * VERTICAL_PITCH, h: Math.round(fontSize * 8) }
    : { w: Math.round(fontSize * 10), h: fontSize * HORIZONTAL_PITCH };
}

function paintGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  px: number,
  outline: boolean,
): void {
  if (outline) ctx.strokeText(glyph, x, y);
  ctx.fillText(glyph, x, y);
}

/** Draw texts in page raster space scaled by `scale` (1 = full raster). */
export function drawTexts(
  ctx: CanvasRenderingContext2D,
  texts: readonly TextBox[],
  scale: number,
): void {
  for (const text of texts) {
    if (text.content.trim().length === 0) continue;
    const px = Math.max(1, text.fontSize * scale);
    const bx = text.x * scale;
    const by = text.y * scale;
    const bw = text.w * scale;
    const bh = text.h * scale;
    const outline = isWhite(text.color);
    ctx.save();
    ctx.font = textFont(px);
    ctx.fillStyle = text.color;
    ctx.textBaseline = 'top';
    if (outline) {
      ctx.strokeStyle = '#1A1A1A';
      ctx.lineWidth = Math.max(1, px * 0.18);
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }
    const glyphs = [...text.content.replace(/\r\n?/g, '\n')];
    if (text.mode === 'horizontal') {
      ctx.textAlign = 'left';
      const pitch = px * HORIZONTAL_PITCH;
      let x = bx;
      let y = by + (pitch - px) / 2;
      for (const g of glyphs) {
        if (g === '\n' || x + px > bx + bw + 0.5) {
          y += pitch;
          x = bx;
          if (g === '\n') continue;
        }
        if (y + px > by + bh + px) break;
        paintGlyph(ctx, g, x, y, px, outline);
        x += ctx.measureText(g).width || px;
      }
    } else {
      ctx.textAlign = 'center';
      const pitch = px * VERTICAL_PITCH;
      let colX = bx + bw - pitch / 2;
      let y = by;
      for (const g of glyphs) {
        if (g === '\n' || y + px > by + bh + 0.5) {
          colX -= pitch;
          y = by;
          if (g === '\n') continue;
        }
        if (colX < bx - pitch) break;
        const code = g.codePointAt(0) ?? 0;
        const form = VERTICAL_FORMS[code];
        if (form != null) {
          paintGlyph(ctx, form, colX, y, px, outline);
        } else if (ROTATE_IN_VERTICAL.has(code)) {
          ctx.save();
          ctx.translate(colX, y + px / 2);
          ctx.rotate(Math.PI / 2);
          ctx.textBaseline = 'middle';
          paintGlyph(ctx, g, 0, 0, px, outline);
          ctx.restore();
        } else if (SMALL_KANA.has(g)) {
          paintGlyph(ctx, g, colX + px * 0.1, y - px * 0.12, px, outline);
        } else {
          paintGlyph(ctx, g, colX, y, px, outline);
        }
        y += px;
      }
    }
    ctx.restore();
  }
}

let fontPromise: Promise<void> | null = null;

/** Load the manga dialogue font once for canvas use. */
export function loadTextFont(url: string): Promise<void> {
  fontPromise ??= (async () => {
    try {
      const face = new FontFace(TEXT_FONT_FAMILY, `url(${url})`);
      await face.load();
      document.fonts.add(face);
    } catch (error) {
      console.warn('[MangaNameStudio] dialogue font failed to load', error);
    }
  })();
  return fontPromise;
}
