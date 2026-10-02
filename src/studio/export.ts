// Export and backup. PNG pages are composited at full raster resolution; a backup
// is a zip of project.json + ink PNGs (+ clips, PDF) that imports as a new project.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { RASTER_W, newId, type DocJson } from './doc.js';
import { ctx2d, makeCanvas, type Project } from './project.js';
import * as storage from './storage.js';

async function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function download(data: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'name';
}

export async function exportPagesZip(project: Project): Promise<number> {
  const files: Zippable = {};
  const digits = String(project.order.length).length;
  for (const [i, id] of project.order.entries()) {
    const page = project.pages.get(id);
    if (page == null) continue;
    const composite = page.composite(true);
    files[`${String(i + 1).padStart(Math.max(2, digits), '0')}.png`] = [await png(composite), { level: 0 }];
    composite.width = 0;
  }
  download(zipSync(files) as BlobPart, `${safeName(project.name)}.zip`, 'application/zip');
  return project.order.length;
}

/** Right-to-left spread as one image: [left][right]. */
export async function exportSpreadPng(project: Project, pageIds: Array<string | null>): Promise<void> {
  const [rightId, leftId] = pageIds;
  const gap = 24;
  const out = makeCanvas(RASTER_W * 2 + gap, 1700);
  const c = ctx2d(out);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, out.width, out.height);
  const draw = (id: string | null | undefined, x: number) => {
    const page = id != null ? project.pages.get(id) : undefined;
    if (page == null) return;
    const composite = page.composite(true);
    c.drawImage(composite, x, 0);
    composite.width = 0;
  };
  draw(leftId, 0);
  draw(rightId, RASTER_W + gap);
  const n = rightId != null ? project.pageNumber(rightId) : 0;
  download((await png(out)) as BlobPart, `${safeName(project.name)}_p${n}.png`, 'image/png');
}

export async function exportBackup(project: Project): Promise<void> {
  const files: Zippable = { 'project.json': strToU8(JSON.stringify(project.toJson())) };
  for (const [id, page] of project.pages) files[`ink/${id}.png`] = [await png(page.ink), { level: 0 }];
  for (const item of project.stock) {
    const clip = item.kind === 'clip' ? project.clips.get(item.id) : undefined;
    if (clip != null) files[`clip/${item.id}.png`] = [await png(clip), { level: 0 }];
  }
  const pdf = await storage.loadPdf(project.id);
  if (pdf != null) files[`pdf/${safeName(pdf.name)}`] = [new Uint8Array(pdf.data), { level: 0 }];
  download(zipSync(files) as BlobPart, `${safeName(project.name)}.mnsbackup.zip`, 'application/zip');
}

/** Import a backup zip as a new project (fresh id, never overwrites). */
export async function importBackup(file: File): Promise<string> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const jsonBytes = entries['project.json'];
  if (jsonBytes == null) throw new Error('project.json がありません');
  const doc = JSON.parse(strFromU8(jsonBytes)) as DocJson;
  if (doc.version !== 1 || !Array.isArray(doc.order)) throw new Error('対応していない形式です');
  const id = newId('prj');
  const inks = new Map<string, Blob>();
  const clips = new Map<string, Blob>();
  for (const [path, bytes] of Object.entries(entries)) {
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    if (path.startsWith('ink/')) inks.set(path.slice(4, -4), blob);
    else if (path.startsWith('clip/')) clips.set(path.slice(5, -4), blob);
    else if (path.startsWith('pdf/')) {
      const copy = bytes.slice().buffer as ArrayBuffer;
      await storage.savePdf(id, path.slice(4), copy);
    }
  }
  const imported: DocJson = { ...doc, id, name: `${doc.name} (読込)`, updatedAt: Date.now() };
  await storage.saveProject(imported, inks, clips, [], []);
  return id;
}

async function jpeg(canvas: HTMLCanvasElement, quality = 0.9): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Minimal PDF: one JPEG per page, B5 trim size (182 x 257 mm). */
export async function exportPdf(project: Project): Promise<number> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const W = 515.9;
  const H = (W * 1700) / RASTER_W;
  const ids = project.order.filter((id) => project.pages.has(id));
  const n = ids.length;
  // Objects: 1 catalog, 2 pages, then per page: page, image, content.
  const obj = (num: number, body: () => void) => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%âã\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R /PageLayout /TwoPageRight /ViewerPreferences << /Direction /R2L >> >>'));
  const kids = ids.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  for (const [i, id] of ids.entries()) {
    const base = 3 + i * 3;
    const composite = project.pages.get(id)!.composite(true);
    const img = await jpeg(composite);
    composite.width = 0;
    const content = `q ${W.toFixed(2)} 0 0 ${H.toFixed(2)} 0 0 cm /Im0 Do Q`;
    obj(base, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /XObject << /Im0 ${base + 1} 0 R >> >> /Contents ${base + 2} 0 R >>`,
      ),
    );
    obj(base + 1, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${RASTER_W} /Height 1700 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push('\nendstream');
    });
    obj(base + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  }
  const total = 3 + n * 3;
  const xref = length;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  download(new Blob(chunks as BlobPart[], { type: 'application/pdf' }), `${safeName(project.name)}.pdf`, 'application/pdf');
  return n;
}

/** Mini-name overview: every spread on one sheet, read right-to-left. */
export async function exportMiniJpg(project: Project): Promise<void> {
  const pw = 240;
  const ph = 340;
  const gap = 16;
  const perRow = 4; // spreads per row
  const spreads: Array<[string | null, string | null]> = [];
  const order = project.order;
  if (order.length > 0) spreads.push([null, order[0]!]);
  for (let i = 1; i < order.length; i += 2) spreads.push([order[i]!, order[i + 1] ?? null]);
  const rows = Math.max(1, Math.ceil(spreads.length / perRow));
  const sw = pw * 2 + 4;
  const out = makeCanvas(perRow * (sw + gap) + gap, rows * (ph + 40 + gap) + gap);
  const c = ctx2d(out);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, out.width, out.height);
  c.font = '600 22px "M PLUS 1p", sans-serif';
  c.textAlign = 'center';
  c.fillStyle = '#333';
  for (const [s, [right, left]] of spreads.entries()) {
    const col = perRow - 1 - (s % perRow);
    const row = Math.floor(s / perRow);
    const x0 = gap + col * (sw + gap);
    const y0 = gap + row * (ph + 40 + gap);
    for (const [id, x] of [[left, x0], [right, x0 + pw + 4]] as const) {
      c.strokeStyle = '#bbb';
      c.strokeRect(x, y0, pw, ph);
      const page = id != null ? project.pages.get(id) : undefined;
      if (page == null) continue;
      const comp = page.composite(true);
      c.drawImage(comp, x, y0, pw, ph);
      comp.width = 0;
      c.fillText(String(project.pageNumber(id!)), x + pw / 2, y0 + ph + 28);
    }
  }
  download((await jpeg(out, 0.88)) as BlobPart, `${safeName(project.name)}_mini.jpg`, 'image/jpeg');
}

/** Dialogue list in reading order (pages, then right-to-left / top-to-bottom). */
export function exportScriptText(project: Project): void {
  const lines: string[] = [`# ${project.name}`, ''];
  for (const [i, id] of project.order.entries()) {
    const texts = [...(project.pages.get(id)?.texts ?? [])].filter((t) => t.content.trim().length > 0);
    if (texts.length === 0) continue;
    // Bands of 120px top-to-bottom, right-to-left inside a band: a total order.
    const band = (t: { y: number }) => Math.floor(t.y / 120);
    texts.sort((a, b) => band(a) - band(b) || b.x + b.w - (a.x + a.w));
    void i;
    lines.push(`[P${project.pageNumber(id)}]`);
    for (const t of texts) lines.push(t.content.replace(/\n/g, ' '));
    lines.push('');
  }
  download(lines.join('\n'), `${safeName(project.name)}_serifu.txt`, 'text/plain;charset=utf-8');
}
