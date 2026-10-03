// Reference material: a PDF viewer sheet in space (range-drag extracts body text
// without ruby) and a plain-text script list that feeds dialogue to the text tool.
import {
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  type Entity,
  type UIKitMLAsset,
  type World,
} from '@iwsdk/core';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import { inRect, joinBody, sanitize, scriptLines, toItems, type PdfTextItem } from './pdf-text.js';
import { canvasTexture, ctx2d, makeCanvas, type Project } from './project.js';
import * as storage from './storage.js';
import type { StudioApi } from './studio-ctx.js';
import type { ToolController } from './tools.js';
import { bindButton, setChip, setText } from './ui-kit.js';

const SHEET_H = 0.5;
const RENDER_LONG_EDGE = 1600;
const SCRIPT_ROWS = 5;

interface UvEvent {
  uv?: { x: number; y: number };
}

export class References {
  private pdf: PDFDocumentProxy | null = null;
  private pdfPage = 1;
  private viewport: PageViewport | null = null;
  private items: PdfTextItem[] = [];
  private extracted = '';
  private sanitizeText = false;
  private readonly sheet: Mesh;
  private readonly sheetRoot = new Group();
  private readonly canvas = makeCanvas(RENDER_LONG_EDGE, RENDER_LONG_EDGE);
  private readonly texture = canvasTexture(this.canvas);
  private readonly rectLine: Line;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private scriptPage = 0;
  private renderToken = 0;
  /** True while the pending text came from the script (auto-advance). */
  private fromScript = false;
  private readonly fileInput = document.createElement('input');

  constructor(
    private readonly world: World,
    private readonly studio: StudioApi,
    private readonly tools: ToolController,
    private readonly panel: UIKitMLAsset,
    cleanup: Array<() => void>,
  ) {
    const anchor = world.requireSceneEntity('pdf-anchor');
    this.sheet = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, side: DoubleSide }),
    );
    this.sheet.name = 'PdfSheet';
    const backing = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0x1c1f24 }));
    backing.position.z = -0.003;
    backing.scale.set(1.04, 1.03, 1);
    backing.raycast = () => undefined;
    this.sheet.add(backing);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(15), 3));
    this.rectLine = new Line(geometry, new LineBasicMaterial({ color: 0xff7a3d, depthTest: false }));
    this.rectLine.renderOrder = 50;
    this.rectLine.visible = false;
    this.rectLine.raycast = () => undefined;
    this.sheetRoot.add(this.sheet, this.rectLine);
    this.showPlaceholder();
    const entity: Entity = world.createTransformEntity(this.sheetRoot, { parent: anchor });
    entity.addComponent(RayInteractable);

    const onDown = (e: UvEvent) => {
      if (e.uv == null || this.pdf == null) return;
      this.drag = { x0: e.uv.x, y0: e.uv.y, x1: e.uv.x, y1: e.uv.y };
      this.drawRect();
    };
    const onMove = (e: UvEvent) => {
      if (this.drag == null || e.uv == null) return;
      this.drag.x1 = e.uv.x;
      this.drag.y1 = e.uv.y;
      this.drawRect();
    };
    const onUp = () => {
      if (this.drag != null) this.extract();
      this.drag = null;
    };
    const target = this.sheet as unknown as {
      addEventListener(type: string, fn: (e: UvEvent) => void): void;
      removeEventListener(type: string, fn: (e: UvEvent) => void): void;
    };
    const onEnter = (e: UvEvent & { pointerId?: number }) => {
      this.hovered = e.pointerId === world.input.xr.multiPointers.right.getPointer('ray').id;
    };
    const onLeave = () => (this.hovered = false);
    target.addEventListener('pointerenter', onEnter);
    target.addEventListener('pointerleave', onLeave);
    cleanup.push(() => {
      target.removeEventListener('pointerenter', onEnter);
      target.removeEventListener('pointerleave', onLeave);
    });
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    cleanup.push(() => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      this.texture.dispose();
      void this.pdf?.destroy();
    });

    this.fileInput.type = 'file';
    this.fileInput.style.display = 'none';
    document.body.append(this.fileInput);
    cleanup.push(() => this.fileInput.remove());

    const c = cleanup;
    bindButton(panel, 'pdf-open', () => this.pick('.pdf,application/pdf', (f) => void this.openPdfFile(f)), c);
    bindButton(panel, 'pdf-prev', () => void this.showPage(this.pdfPage - 1), c);
    bindButton(panel, 'pdf-next', () => void this.showPage(this.pdfPage + 1), c);
    bindButton(panel, 'pdf-place', () => {
      this.fromScript = false;
      this.queue(this.extracted);
    }, c);
    bindButton(panel, 'pdf-sanitize', () => {
      this.sanitizeText = !this.sanitizeText;
      setChip(panel, 'pdf-sanitize', this.sanitizeText);
      if (this.drag == null && this.items.length > 0 && this.lastRect != null) this.extractRect(this.lastRect);
    }, c);
    bindButton(panel, 'script-open', () => this.pick('.txt,text/plain', (f) => void this.openScriptFile(f)), c);
    bindButton(panel, 'script-prev', () => this.pageScript(-1), c);
    bindButton(panel, 'script-next', () => this.pageScript(1), c);
    for (let i = 0; i < SCRIPT_ROWS; i++) {
      bindButton(panel, `script-line-${i}`, () => this.pickLine(this.scriptPage * SCRIPT_ROWS + i), c);
    }
    tools.onPendingPlaced = () => this.advanceScript();
  }

  private lastRect: { x: number; y: number; width: number; height: number } | null = null;
  /** A ray is over the PDF sheet (right stick then zooms the sheet). */
  hovered = false;

  /** Half the sheet's height (with its backing) below the PDF anchor. */
  get sheetHalfHeight(): number {
    return (SHEET_H * this.sheetRoot.scale.y * 1.03) / 2;
  }

  /** Half the sheet's width (with its backing) either side of the PDF anchor. */
  get sheetHalfWidth(): number {
    return (this.sheet.scale.x * this.sheetRoot.scale.x * 1.04) / 2;
  }

  zoomSheet(k: number): void {
    const s = Math.min(2.4, Math.max(0.6, this.sheetRoot.scale.x * k));
    this.sheetRoot.scale.setScalar(s);
  }

  /** Empty sheet that tells the user where PDFs appear and how to open one. */
  private showPlaceholder(): void {
    this.hovered = false;
    const w = 1131;
    const h = RENDER_LONG_EDGE;
    const ctx = ctx2d(this.canvas);
    ctx.fillStyle = '#2a2e35';
    ctx.fillRect(0, 0, RENDER_LONG_EDGE, RENDER_LONG_EDGE);
    ctx.strokeStyle = '#59616d';
    ctx.lineWidth = 8;
    ctx.setLineDash([36, 24]);
    ctx.strokeRect(40, 40, w - 80, h - 80);
    ctx.setLineDash([]);
    ctx.fillStyle = '#cfd5de';
    ctx.textAlign = 'center';
    ctx.font = '600 72px "M PLUS 1p", sans-serif';
    ctx.fillText('PDF資料', w / 2, h / 2 - 90);
    ctx.font = '400 44px "M PLUS 1p", sans-serif';
    ctx.fillStyle = '#98a2b0';
    ctx.fillText('右パネル「資料」→「開く」で', w / 2, h / 2 + 10);
    ctx.fillText('ここに表示されます', w / 2, h / 2 + 76);
    ctx.fillText('(PCではファイルをドロップ)', w / 2, h / 2 + 142);
    this.texture.repeat.set(w / RENDER_LONG_EDGE, 1);
    this.texture.offset.set(0, 0);
    this.texture.needsUpdate = true;
    this.sheet.scale.set((SHEET_H * w) / h, SHEET_H, 1);
    this.rectLine.visible = false;
    this.sheetRoot.visible = true;
  }

  /** Called when a project is opened: restore its PDF and script. */
  async attach(project: Project): Promise<void> {
    this.scriptPage = Math.floor(project.scriptCursor / SCRIPT_ROWS);
    this.renderScript();
    void this.pdf?.destroy();
    this.pdf = null;
    this.showPlaceholder();
    this.extracted = '';
    setText(this.panel, 'pdf-extract', '-');
    setText(this.panel, 'pdf-page-label', '- / -');
    const stored = await storage.loadPdf(project.id);
    if (stored != null && this.studio.project === project) {
      await this.loadPdf(stored.data.slice(0), stored.name, project.pdfPage);
    }
  }

  handleFile(file: File): boolean {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      void this.openPdfFile(file);
      return true;
    }
    if (name.endsWith('.txt')) {
      void this.openScriptFile(file);
      return true;
    }
    return false;
  }

  private pick(accept: string, onFile: (file: File) => void): void {
    this.fileInput.accept = accept;
    this.fileInput.value = '';
    this.fileInput.onchange = () => {
      const file = this.fileInput.files?.[0];
      if (file != null) onFile(file);
    };
    this.fileInput.click();
  }

  private async openPdfFile(file: File): Promise<void> {
    const data = await file.arrayBuffer();
    const project = this.studio.project;
    await storage.savePdf(project.id, file.name, data.slice(0));
    project.pdfName = file.name;
    project.pdfPage = 1;
    this.studio.markDirty();
    await this.loadPdf(data, file.name, 1);
  }

  private async loadPdf(data: ArrayBuffer, name: string, page: number): Promise<void> {
    try {
      setText(this.panel, 'pdf-status', `${name} を読み込み中...`);
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      void this.pdf?.destroy();
      this.pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      this.sheetRoot.visible = true;
      setText(this.panel, 'pdf-status', `${name}: ドラッグで範囲を選ぶと本文(ルビ除去)を抽出`);
      await this.showPage(page);
    } catch (error) {
      console.error('[MangaNameStudio] PDF load failed', error);
      setText(this.panel, 'pdf-status', 'PDFを読み込めませんでした');
      this.studio.toast('PDFを読み込めませんでした');
    }
  }

  private async showPage(n: number): Promise<void> {
    const pdf = this.pdf;
    if (pdf == null) return;
    const page = Math.min(pdf.numPages, Math.max(1, n));
    this.pdfPage = page;
    this.studio.project.pdfPage = page;
    setText(this.panel, 'pdf-page-label', `${page} / ${pdf.numPages}`);
    const token = ++this.renderToken;
    const proxy = await pdf.getPage(page);
    const base = proxy.getViewport({ scale: 1 });
    const scale = RENDER_LONG_EDGE / Math.max(base.width, base.height);
    const viewport = proxy.getViewport({ scale });
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const ctx = ctx2d(this.canvas);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, RENDER_LONG_EDGE, RENDER_LONG_EDGE);
    const off = makeCanvas(w, h);
    await proxy.render({ canvasContext: ctx2d(off), viewport }).promise;
    if (token !== this.renderToken) return;
    ctx.drawImage(off, 0, 0);
    off.width = 0;
    this.viewport = viewport;
    this.texture.repeat.set(w / RENDER_LONG_EDGE, h / RENDER_LONG_EDGE);
    this.texture.offset.set(0, 1 - h / RENDER_LONG_EDGE);
    this.texture.needsUpdate = true;
    this.sheet.scale.set((SHEET_H * w) / h, SHEET_H, 1);
    const content = await proxy.getTextContent();
    if (token !== this.renderToken) return;
    this.items = toItems(content.items);
    this.rectLine.visible = false;
    this.studio.markDirty();
  }

  private drawRect(): void {
    const d = this.drag;
    if (d == null) return;
    const sx = this.sheet.scale.x;
    const sy = this.sheet.scale.y;
    const x0 = (d.x0 - 0.5) * sx;
    const x1 = (d.x1 - 0.5) * sx;
    const y0 = (d.y0 - 0.5) * sy;
    const y1 = (d.y1 - 0.5) * sy;
    const attr = this.rectLine.geometry.getAttribute('position') as BufferAttribute;
    const a = attr.array as Float32Array;
    a.set([x0, y0, 0.002, x1, y0, 0.002, x1, y1, 0.002, x0, y1, 0.002, x0, y0, 0.002]);
    attr.needsUpdate = true;
    this.rectLine.geometry.computeBoundingSphere();
    this.rectLine.visible = true;
  }

  private extract(): void {
    const d = this.drag;
    const viewport = this.viewport;
    if (d == null || viewport == null) return;
    // uv (0..1, y up) -> viewport px (y down) -> PDF user space.
    const toPdf = (u: number, v: number) => viewport.convertToPdfPoint(u * viewport.width, (1 - v) * viewport.height);
    const [ax, ay] = toPdf(d.x0, d.y0);
    const [bx, by] = toPdf(d.x1, d.y1);
    const rect = { x: Math.min(ax!, bx!), y: Math.min(ay!, by!), width: Math.abs(bx! - ax!), height: Math.abs(by! - ay!) };
    this.lastRect = rect;
    this.extractRect(rect);
  }

  private extractRect(rect: { x: number; y: number; width: number; height: number }): void {
    let text = joinBody(inRect(this.items, rect));
    if (this.sanitizeText) text = sanitize(text);
    this.extracted = text;
    setText(this.panel, 'pdf-extract', text.length > 0 ? clip(text, 60) : '(この範囲に本文はありません)');
    if (text.length > 0) this.studio.haptic(0.3);
  }

  /** Hand dialogue to the text tool; the next tap on a page places it. */
  private queue(text: string): void {
    if (text.trim().length === 0) {
      this.studio.toast('先に範囲や台本の行を選んでください');
      return;
    }
    this.tools.pendingText = text;
    this.tools.setTool('text');
    this.tools.onSelectionChange();
    this.studio.toast('配置待ち: ページをタップするとセリフを置きます');
  }

  // ---------- script ----------

  private async openScriptFile(file: File): Promise<void> {
    const raw = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(raw);
    if (text.includes('�')) {
      try {
        text = new TextDecoder('shift_jis').decode(raw);
      } catch {
        // Keep the UTF-8 attempt when Shift_JIS decoding is unavailable.
      }
    }
    const project = this.studio.project;
    project.script = scriptLines(text);
    project.scriptCursor = 0;
    this.scriptPage = 0;
    this.renderScript();
    project.emit('script');
    this.studio.markDirty();
    this.studio.toast(`台本を読み込みました (${project.script.length}行)`);
  }

  private pageScript(dir: number): void {
    const pages = Math.max(1, Math.ceil(this.studio.project.script.length / SCRIPT_ROWS));
    this.scriptPage = Math.min(pages - 1, Math.max(0, this.scriptPage + dir));
    this.renderScript();
  }

  private pickLine(index: number): void {
    const project = this.studio.project;
    const line = project.script[index];
    if (line == null) return;
    project.scriptCursor = index;
    this.renderScript();
    this.fromScript = true;
    this.queue(line);
  }

  private advanceScript(): void {
    const project = this.studio.project;
    if (!this.fromScript || project.script.length === 0 || this.tools.pendingText != null) return;
    const placed = project.script[project.scriptCursor];
    if (placed == null) return;
    const next = project.scriptCursor + 1;
    if (next < project.script.length) {
      project.scriptCursor = next;
      this.scriptPage = Math.floor(next / SCRIPT_ROWS);
      this.renderScript();
      this.tools.pendingText = project.script[next]!;
      this.tools.onSelectionChange();
    } else {
      this.fromScript = false;
    }
    this.studio.markDirty();
  }

  renderScript(): void {
    const project = this.studio.project;
    const lines = project.script;
    const pages = Math.max(1, Math.ceil(lines.length / SCRIPT_ROWS));
    setText(this.panel, 'script-page-label', lines.length === 0 ? '- / -' : `${this.scriptPage + 1} / ${pages}`);
    for (let i = 0; i < SCRIPT_ROWS; i++) {
      const index = this.scriptPage * SCRIPT_ROWS + i;
      const line = lines[index];
      const label =
        line == null
          ? lines.length === 0 && i === 0
            ? '台本(.txt)を読み込むと1行ずつ配置できます'
            : '-'
          : `${index + 1}. ${clip(line, 26)}`;
      setText(this.panel, `script-line-label-${i}`, label);
      setChip(this.panel, `script-line-${i}`, line != null && index === project.scriptCursor, 'tertiary');
    }
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\n/g, ' / ');
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
