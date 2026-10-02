// Tool palette (left panel): tools, colours, sizes, context sections, undo/redo.
import { VisibilityState, type UIKitMLAsset, type World } from '@iwsdk/core';
import { PALETTE, newId, type ToolId } from './doc.js';
import { addClipToStock } from './page-ops.js';
import type { StudioApi } from './studio-ctx.js';
import type { ToolController } from './tools.js';
import { applyJapaneseFont, bindButton, setChip, setProps, setText, setVisible } from './ui-kit.js';

const TOOLS: ToolId[] = ['pen', 'eraser', 'line', 'frame', 'text', 'select', 'lasso', 'hand'];
const SIZE_PRESETS = [3, 8, 18];
const ERASER_PRESETS = [16, 40, 90];
const TEXT_COLORS = ['#1A1A1A', '#FFFFFF', '#D64545', '#3D5A80'];
const SAVE_LABEL = { saved: '保存済み', pending: '未保存', saving: '保存中...', error: '保存失敗' } as const;

export class PaletteUi {
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly world: World,
    private readonly panel: UIKitMLAsset,
    private readonly studio: StudioApi,
    private readonly tools: ToolController,
    private readonly actions: { undo(): void; redo(): void; setTool(tool: ToolId): void },
    cleanup: Array<() => void>,
  ) {
    const c = cleanup;
    applyJapaneseFont(panel, 'tool-root');
    for (const tool of TOOLS) bindButton(panel, `tool-${tool}`, () => actions.setTool(tool), c);
    for (const [i, color] of PALETTE.entries()) {
      bindButton(panel, `swatch-${i}`, () => this.patch({ penColor: color }), c);
    }
    const s = () => this.studio.project.tools;
    const eraser = () => this.tools.tool === 'eraser';
    const sizeStep = (dir: number) => {
      const cur = eraser() ? s().eraserSize : s().penSize;
      const step = cur < 6 ? 1 : cur < 20 ? 2 : 6;
      const next = Math.max(1, Math.min(200, cur + dir * step));
      this.patch(eraser() ? { eraserSize: next } : { penSize: next });
    };
    bindButton(panel, 'size-minus', () => sizeStep(-1), c);
    bindButton(panel, 'size-plus', () => sizeStep(1), c);
    for (let i = 0; i < 3; i++) {
      bindButton(panel, `size-p${i}`, () =>
        this.patch(eraser() ? { eraserSize: ERASER_PRESETS[i]! } : { penSize: SIZE_PRESETS[i]! }), c);
    }
    const opacityStep = (dir: number) => {
      const cur = eraser() ? s().eraserOpacity : s().penOpacity;
      const next = Math.round(Math.max(0.1, Math.min(1, cur + dir * 0.1)) * 10) / 10;
      this.patch(eraser() ? { eraserOpacity: next } : { penOpacity: next });
    };
    bindButton(panel, 'opacity-minus', () => opacityStep(-1), c);
    bindButton(panel, 'opacity-plus', () => opacityStep(1), c);
    // 下書き: light blue at 40% (MangaSketcher draws drafts as a colour, not a layer).
    bindButton(panel, 'opacity-p0', () => this.patch({ penColor: '#5B9BD5', penOpacity: 0.4 }), c);
    bindButton(panel, 'opacity-p1', () => this.patch(eraser() ? { eraserOpacity: 1 } : { penOpacity: 1 }), c);
    const stabStep = (dir: number) =>
      this.patch({ stabilizer: Math.round(Math.max(0, Math.min(0.9, s().stabilizer + dir * 0.1)) * 10) / 10 });
    bindButton(panel, 'stab-minus', () => stabStep(-1), c);
    bindButton(panel, 'stab-plus', () => stabStep(1), c);
    bindButton(panel, 'opt-pressure', () => this.patch({ pressure: !s().pressure }), c);
    bindButton(panel, 'opt-snap', () => this.patch({ angleSnap: !s().angleSnap }), c);

    const textSize = (dir: number) => {
      const cur = this.tools.currentText()?.text.fontSize ?? s().textSize;
      const next = Math.max(12, Math.min(160, Math.round(cur + dir * (cur < 40 ? 4 : 8))));
      if (this.tools.currentText() != null) this.tools.updateText({ fontSize: next }, '文字サイズ');
      this.patch({ textSize: next });
    };
    bindButton(panel, 'text-size-minus', () => textSize(-1), c);
    bindButton(panel, 'text-size-plus', () => textSize(1), c);
    for (const mode of ['vertical', 'horizontal'] as const) {
      bindButton(panel, `text-${mode}`, () => {
        if (this.tools.currentText() != null) this.tools.updateText({ mode }, '書字方向');
        this.patch({ textMode: mode });
      }, c);
    }
    for (const [i, color] of TEXT_COLORS.entries()) {
      bindButton(panel, `tswatch-${i}`, () => {
        if (this.tools.currentText() != null) this.tools.updateText({ color }, '文字色');
        this.patch({ textColor: color });
      }, c);
    }
    bindButton(panel, 'text-edit', () => this.tools.editText(), c);
    bindButton(panel, 'text-delete', () => this.tools.deleteText(), c);

    const sel = this.tools.selection;
    bindButton(panel, 'sel-commit', () => sel.commit(), c);
    bindButton(panel, 'sel-cancel', () => sel.cancel(), c);
    bindButton(panel, 'sel-dup', () => sel.duplicate(), c);
    bindButton(panel, 'sel-delete', () => sel.remove(), c);
    bindButton(panel, 'sel-flip', () => sel.flip(), c);
    bindButton(panel, 'sel-rotl', () => sel.rotateBy(Math.PI / 12), c);
    bindButton(panel, 'sel-rotr', () => sel.rotateBy(-Math.PI / 12), c);
    bindButton(panel, 'sel-smaller', () => sel.scaleBy(1 / 1.15), c);
    bindButton(panel, 'sel-bigger', () => sel.scaleBy(1.15), c);
    bindButton(panel, 'sel-stock', () => {
      const canvas = sel.snapshotCanvas();
      if (canvas == null) {
        this.studio.toast('先に範囲を選択してください');
        return;
      }
      addClipToStock(this.studio, canvas, newId('clip'));
      this.studio.toast('選択範囲をネームストックに保存しました');
    }, c);

    bindButton(panel, 'undo-button', () => actions.undo(), c);
    bindButton(panel, 'redo-button', () => actions.redo(), c);
    bindButton(panel, 'xr-button', () => world.launchXR(), c);
    bindButton(panel, 'exit-button', () => world.exitXR(), c);
    if (!world.xrEnabled) {
      setVisible(panel, 'xr-button', false);
    } else {
      cleanup.push(
        world.visibilityState.subscribe((state) => {
          const flat = state === VisibilityState.NonImmersive;
          setVisible(panel, 'xr-button', flat);
          setVisible(panel, 'exit-button', !flat);
        }),
      );
    }
    cleanup.push(() => {
      if (this.toastTimer != null) clearTimeout(this.toastTimer);
    });
  }

  private patch(p: Partial<StudioApi['project']['tools']>): void {
    Object.assign(this.studio.project.tools, p);
    this.studio.project.emit('tools');
    this.studio.markDirty();
    this.refresh();
  }

  refresh(): void {
    const panel = this.panel;
    const t = this.studio.project.tools;
    const tool = this.tools.tool;
    for (const id of TOOLS) setChip(panel, `tool-${id}`, id === tool);
    const ink = tool === 'pen' || tool === 'eraser' || tool === 'line' || tool === 'frame' || tool === 'hand';
    setVisible(panel, 'section-ink', ink);
    setVisible(panel, 'section-text', tool === 'text');
    setVisible(panel, 'section-select', tool === 'select' || tool === 'lasso');
    for (const [i, color] of PALETTE.entries()) {
      const active = color.toLowerCase() === t.penColor.toLowerCase();
      setProps(panel, `swatch-${i}`, { borderColor: active ? '#ffffff' : '#2a2f37', borderWidth: active ? 0.35 : 0.25 });
    }
    const eraser = tool === 'eraser';
    const size = eraser ? t.eraserSize : t.penSize;
    setText(panel, 'size-label', `${eraser ? '消し幅' : '太さ'} ${size}`);
    const presets = eraser ? ERASER_PRESETS : SIZE_PRESETS;
    for (let i = 0; i < 3; i++) setChip(panel, `size-p${i}`, presets[i] === size, 'tertiary');
    const opacity = eraser ? t.eraserOpacity : t.penOpacity;
    setText(panel, 'opacity-label', `濃さ ${Math.round(opacity * 100)}%`);
    setChip(panel, 'opacity-p0', !eraser && t.penOpacity < 0.5 && t.penColor === '#5B9BD5', 'tertiary');
    setChip(panel, 'opacity-p1', opacity === 1, 'tertiary');
    setText(panel, 'stab-label', `補正 ${Math.round(t.stabilizer * 100)}%`);
    setChip(panel, 'opt-pressure', t.pressure);
    setChip(panel, 'opt-snap', t.angleSnap);
    const sel = this.tools.currentText()?.text;
    setText(panel, 'text-size-label', `文字 ${Math.round(sel?.fontSize ?? t.textSize)}`);
    const mode = sel?.mode ?? t.textMode;
    setChip(panel, 'text-vertical', mode === 'vertical');
    setChip(panel, 'text-horizontal', mode === 'horizontal');
    const color = (sel?.color ?? t.textColor).toLowerCase();
    for (const [i, c] of TEXT_COLORS.entries()) {
      setProps(panel, `tswatch-${i}`, { borderColor: c.toLowerCase() === color ? '#4c8dff' : '#2a2f37' });
    }
    const pending = this.tools.pendingText;
    setText(panel, 'pending-text', pending != null ? `配置待ち: ${pending.replace(/\n/g, ' ').slice(0, 24)}` : '配置待ち: なし');
    const active = this.tools.selection.active;
    setText(
      panel,
      'select-hint',
      active ? '中をドラッグで移動 / 角で拡大縮小 / 上の丸で回転 / 外をタップで確定' : 'ドラッグで範囲を切り取り (投げ縄は自由形)',
    );
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    setProps(this.panel, 'undo-button', { disabled: !canUndo });
    setProps(this.panel, 'redo-button', { disabled: !canRedo });
  }

  setSaveState(state: keyof typeof SAVE_LABEL): void {
    setText(this.panel, 'save-status', SAVE_LABEL[state]);
    setProps(this.panel, 'save-status', { color: state === 'error' ? '#ff7a7a' : state === 'saved' ? '#7fd49b' : '#98a2b0' });
  }

  setProjectName(name: string): void {
    setText(this.panel, 'project-name', name);
  }

  toast(message: string): void {
    setText(this.panel, 'toast', message);
    if (this.toastTimer != null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => setText(this.panel, 'toast', ''), 5000);
  }
}
