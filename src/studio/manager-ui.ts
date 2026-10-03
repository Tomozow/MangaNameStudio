// Right panel: page operations, view, name stock / trash, files.
import { type CanvasTexture, type UIKitMLAsset } from '@iwsdk/core';
import { readingSpreads, spreadIndexOf, type StockItem } from './doc.js';
import * as ops from './page-ops.js';
import { canvasTexture, composeClip } from './project.js';
import * as storage from './storage.js';
import type { StudioApi } from './studio-ctx.js';
import { applyJapaneseFont, bindButton, setChip, setProps, setText, setVisible } from './ui-kit.js';

type Tab = 'pages' | 'stock' | 'refs' | 'files';
const TABS: Tab[] = ['pages', 'stock', 'refs', 'files'];
const STOCK_SLOTS = 8;
const FILE_ROWS = 4;

export interface ManagerActions {
  turn(dir: number): void;
  zoom(factor: number): void;
  resetZoom(): void;
  setSingle(single: boolean): void;
  recenter(): void;
  nudge(dy: number, dz: number): void;
  newProject(pages: number): void;
  openProject(id: string): void;
  deleteProject(id: string): void;
  renameProject(): void;
  exportZip(): void;
  exportSpread(): void;
  exportOther(kind: 'pdf' | 'mini' | 'text'): void;
  backup(): void;
  importBackup(): void;
  emptyTrash(): void;
  pasteClip(id: string): void;
  /** Bring the stock item's card in front of the user. */
  recallStock(id: string): void;
}

export class ManagerUi {
  tab: Tab = 'pages';
  private stockMode: 'stock' | 'trash' = 'stock';
  private stockPage = 0;
  private stockSel: string | null = null;
  private files: storage.ProjectMeta[] = [];
  private filePage = 0;
  private fileSel: string | null = null;
  private armed: { key: string; time: number } | null = null;
  private readonly clipTextures = new Map<string, CanvasTexture>();

  constructor(
    private readonly panel: UIKitMLAsset,
    private readonly studio: StudioApi,
    private readonly actions: ManagerActions,
    cleanup: Array<() => void>,
  ) {
    const c = cleanup;
    applyJapaneseFont(panel, 'manager-root');
    for (const tab of TABS) bindButton(panel, `tab-${tab}`, () => this.setTab(tab), c);
    bindButton(panel, 'nav-next', () => actions.turn(1), c);
    bindButton(panel, 'nav-prev', () => actions.turn(-1), c);
    bindButton(panel, 'page-append', () => ops.appendPage(studio), c);
    bindButton(panel, 'page-insert', () => ops.insertAfterCurrent(studio), c);
    bindButton(panel, 'page-duplicate', () => ops.duplicateCurrent(studio), c);
    bindButton(panel, 'page-move-later', () => ops.moveCurrent(studio, 1), c);
    bindButton(panel, 'page-move-earlier', () => ops.moveCurrent(studio, -1), c);
    bindButton(panel, 'page-to-stock', () => ops.removeCurrent(studio, 'stock'), c);
    bindButton(panel, 'page-trash', () => ops.removeCurrent(studio, 'trash'), c);
    bindButton(panel, 'page-clear', () => {
      if (this.confirm('clear', 'page-clear')) ops.clearCurrentInk(studio);
    }, c);
    bindButton(panel, 'view-spread', () => actions.setSingle(false), c);
    bindButton(panel, 'view-single', () => actions.setSingle(true), c);
    bindButton(panel, 'view-zoom-out', () => actions.zoom(1 / 1.25), c);
    bindButton(panel, 'view-zoom-in', () => actions.zoom(1.25), c);
    bindButton(panel, 'view-zoom-reset', () => actions.resetZoom(), c);
    bindButton(panel, 'view-recenter', () => actions.recenter(), c);
    bindButton(panel, 'view-lower', () => actions.nudge(-0.05, 0), c);
    bindButton(panel, 'view-raise', () => actions.nudge(0.05, 0), c);
    bindButton(panel, 'view-nearer', () => actions.nudge(0, 0.05), c);
    bindButton(panel, 'view-farther', () => actions.nudge(0, -0.05), c);

    bindButton(panel, 'stock-mode-stock', () => this.setStockMode('stock'), c);
    bindButton(panel, 'stock-mode-trash', () => this.setStockMode('trash'), c);
    bindButton(panel, 'stock-prev', () => this.pageStock(-1), c);
    bindButton(panel, 'stock-next', () => this.pageStock(1), c);
    for (let i = 0; i < STOCK_SLOTS; i++) {
      bindButton(panel, `stock-slot-${i}`, () => this.pickStock(i), c);
    }
    bindButton(panel, 'stock-restore', () => this.restoreStock(), c);
    bindButton(panel, 'stock-delete', () => this.deleteStock(), c);
    bindButton(panel, 'stock-recall', () => {
      // The selection may have left the stock meanwhile (its card was dropped on the name).
      const entry = this.entries().find((e) => e.id === this.stockSel);
      if (this.stockMode === 'stock' && entry != null) actions.recallStock(entry.id);
      else this.studio.toast('ストックの項目を選んでください');
    }, c);

    bindButton(panel, 'file-rename', () => actions.renameProject(), c);
    for (const n of [8, 16, 24, 32]) bindButton(panel, `file-new-${n}`, () => actions.newProject(n), c);
    bindButton(panel, 'file-prev', () => this.pageFiles(-1), c);
    bindButton(panel, 'file-next', () => this.pageFiles(1), c);
    for (let i = 0; i < FILE_ROWS; i++) bindButton(panel, `file-item-${i}`, () => this.pickFile(i), c);
    bindButton(panel, 'file-open', () => {
      if (this.fileSel != null) actions.openProject(this.fileSel);
    }, c);
    bindButton(panel, 'file-delete', () => {
      if (this.fileSel == null) return;
      if (this.confirm(`delete:${this.fileSel}`, 'file-delete-label', '本当に削除')) actions.deleteProject(this.fileSel);
    }, c);
    bindButton(panel, 'file-export-zip', () => actions.exportZip(), c);
    bindButton(panel, 'file-export-spread', () => actions.exportSpread(), c);
    bindButton(panel, 'file-export-pdf', () => actions.exportOther('pdf'), c);
    bindButton(panel, 'file-export-mini', () => actions.exportOther('mini'), c);
    bindButton(panel, 'file-export-text', () => actions.exportOther('text'), c);
    bindButton(panel, 'file-backup', () => actions.backup(), c);
    bindButton(panel, 'file-import', () => actions.importBackup(), c);
    cleanup.push(() => {
      for (const t of this.clipTextures.values()) t.dispose();
    });
  }

  /** Two-press confirmation for destructive buttons. */
  private confirm(key: string, labelId: string, armedText = 'もう一度押して実行'): boolean {
    const now = performance.now();
    if (this.armed?.key === key && now - this.armed.time < 3000) {
      // A pen tip bouncing on the key (touch has no hysteresis) is not a confirmation.
      if (now - this.armed.time < 400) return false;
      this.armed = null;
      this.refreshLabels();
      return true;
    }
    this.armed = { key, time: now };
    if (labelId.endsWith('-label')) setText(this.panel, labelId, armedText);
    this.studio.toast(`${armedText} (3秒以内)`);
    setTimeout(() => this.refreshLabels(), 3100);
    return false;
  }

  private refreshLabels(): void {
    setText(this.panel, 'file-delete-label', '削除');
    setText(this.panel, 'stock-delete-label', this.stockMode === 'trash' ? 'ゴミ箱を空にする' : '削除');
  }

  setTab(tab: Tab): void {
    this.tab = tab;
    for (const t of TABS) {
      setChip(this.panel, `tab-${t}`, t === tab);
      setVisible(this.panel, `pane-${t}`, t === tab);
    }
    if (tab === 'files') void this.loadFiles();
    this.refresh();
  }

  refresh(single = false, zoom = 1): void {
    const project = this.studio.project;
    const panel = this.panel;
    const n = project.order.length;
    const cur = project.currentPage == null ? 0 : project.order.indexOf(project.currentPage) + 1;
    const spread = spreadIndexOf(project.order, project.currentPage);
    const spreads = readingSpreads(project.order).length;
    setText(panel, 'page-info', n === 0 ? 'ページなし (ストックから戻すか追加)' : `${cur} / ${n} ページ  (見開き ${spread + 1}/${spreads})`);
    setChip(panel, 'view-spread', !single);
    setChip(panel, 'view-single', single);
    setText(panel, 'zoom-label', `${Math.round(zoom * 100)}%`);
    setText(panel, 'file-name', project.name);
    if (this.tab === 'stock') this.renderStock();
  }

  // ---------- stock ----------

  private entries(): StockItem[] {
    const project = this.studio.project;
    return this.stockMode === 'stock' ? project.stock : project.trash.map((id) => ({ kind: 'page' as const, id }));
  }

  private setStockMode(mode: 'stock' | 'trash'): void {
    this.stockMode = mode;
    this.stockPage = 0;
    this.stockSel = null;
    setChip(this.panel, 'stock-mode-stock', mode === 'stock');
    setChip(this.panel, 'stock-mode-trash', mode === 'trash');
    setVisible(this.panel, 'stock-recall', mode === 'stock');
    this.refreshLabels();
    setText(this.panel, 'stock-restore-label', 'ネームに戻す');
    this.renderStock();
  }

  private pageStock(dir: number): void {
    const pages = Math.max(1, Math.ceil(this.entries().length / STOCK_SLOTS));
    this.stockPage = Math.min(pages - 1, Math.max(0, this.stockPage + dir));
    this.renderStock();
  }

  private pickStock(i: number): void {
    const entry = this.entries()[this.stockPage * STOCK_SLOTS + i];
    this.stockSel = entry?.id ?? null;
    if (entry != null) {
      setText(this.panel, 'stock-restore-label', entry.kind === 'clip' ? 'ページに貼る' : 'ネームに戻す');
    }
    this.renderStock();
  }

  private restoreStock(): void {
    const entry = this.entries().find((e) => e.id === this.stockSel);
    if (entry == null) {
      this.studio.toast('ストックの項目を選んでください');
      return;
    }
    if (entry.kind === 'clip') {
      this.actions.pasteClip(entry.id);
      return;
    }
    ops.restorePage(this.studio, entry.id, this.stockMode);
    this.stockSel = null;
    this.renderStock();
  }

  private deleteStock(): void {
    if (this.stockMode === 'trash') {
      if (this.studio.project.trash.length === 0) return;
      if (this.confirm('empty-trash', 'stock-delete-label')) this.actions.emptyTrash();
      return;
    }
    const entry = this.entries().find((e) => e.id === this.stockSel);
    if (entry == null) return;
    if (entry.kind === 'clip') ops.removeStockClip(this.studio, entry.id);
    else ops.stockPageToTrash(this.studio, entry.id);
    this.stockSel = null;
    this.renderStock();
  }

  renderStock(): void {
    const project = this.studio.project;
    const panel = this.panel;
    const list = this.entries();
    const pages = Math.max(1, Math.ceil(list.length / STOCK_SLOTS));
    this.stockPage = Math.min(this.stockPage, pages - 1);
    setText(panel, 'stock-page-label', `${this.stockPage + 1}/${pages}`);
    for (let i = 0; i < STOCK_SLOTS; i++) {
      const entry = list[this.stockPage * STOCK_SLOTS + i];
      if (entry == null) {
        setProps(panel, `stock-slot-${i}`, { opacity: 0.35, borderColor: '#2b3038' });
        setProps(panel, `stock-img-${i}`, { src: undefined });
        setText(panel, `stock-cap-${i}`, '-');
        continue;
      }
      let texture: CanvasTexture | undefined;
      if (entry.kind === 'page') {
        const page = project.pages.get(entry.id);
        page?.refreshThumb();
        texture = page?.thumbTex;
      } else {
        const canvas = project.clips.get(entry.id);
        if (canvas != null) {
          texture = this.clipTextures.get(entry.id);
          if (texture == null) {
            // Texts cut with the ink show on the thumbnail (a text-only clip has no ink).
            texture = canvasTexture(composeClip(canvas, entry.texts));
            this.clipTextures.set(entry.id, texture);
          }
        }
      }
      const selected = entry.id === this.stockSel;
      setProps(panel, `stock-slot-${i}`, { opacity: 1, borderColor: selected ? '#4c8dff' : '#2b3038' });
      setProps(panel, `stock-img-${i}`, { src: texture });
      setText(panel, `stock-cap-${i}`, entry.kind === 'clip' ? 'クリップ' : this.stockMode === 'trash' ? '削除済み' : 'ページ');
    }
    const hint =
      list.length === 0
        ? this.stockMode === 'trash'
          ? 'ゴミ箱は空です'
          : 'ページ管理の「ストックへ」や選択範囲の「ストックへ」で保存できます'
        : this.stockMode === 'trash'
          ? '選んで「ネームに戻す」で復元。空にすると取り消せません'
          : '選んで「ネームに戻す」/クリップは「ページに貼る」';
    setText(panel, 'stock-hint', hint);
  }

  // ---------- files ----------

  async loadFiles(): Promise<void> {
    this.files = await storage.listProjects();
    this.renderFiles();
  }

  private pageFiles(dir: number): void {
    const pages = Math.max(1, Math.ceil(this.files.length / FILE_ROWS));
    this.filePage = Math.min(pages - 1, Math.max(0, this.filePage + dir));
    this.renderFiles();
  }

  private pickFile(i: number): void {
    this.fileSel = this.files[this.filePage * FILE_ROWS + i]?.id ?? null;
    this.renderFiles();
  }

  private renderFiles(): void {
    const panel = this.panel;
    const pages = Math.max(1, Math.ceil(this.files.length / FILE_ROWS));
    this.filePage = Math.min(this.filePage, pages - 1);
    setText(panel, 'file-page-label', `${this.filePage + 1}/${pages}`);
    for (let i = 0; i < FILE_ROWS; i++) {
      const meta = this.files[this.filePage * FILE_ROWS + i];
      const open = meta?.id === this.studio.project.id;
      const date = meta != null ? new Date(meta.updatedAt) : null;
      const stamp = date != null ? `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
      setText(
        panel,
        `file-item-label-${i}`,
        meta == null ? '-' : `${open ? '● ' : ''}${meta.name}  ${meta.pageCount}P  ${stamp}`,
      );
      setChip(panel, `file-item-${i}`, meta != null && meta.id === this.fileSel, 'tertiary');
    }
  }

  setZoom(zoom: number): void {
    setText(this.panel, 'zoom-label', `${Math.round(zoom * 100)}%`);
  }

  setFileStatus(text: string): void {
    setText(this.panel, 'file-status', text);
  }
}
