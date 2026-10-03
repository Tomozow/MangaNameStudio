// Orchestrates the studio: boot, project lifecycle, board input (XR rays sampled
// per frame for smooth strokes, mouse/poke via pointer events), controller and
// keyboard shortcuts, autosave and panel refresh.
import {
  InputComponent,
  PokeInteractable,
  RayInteractable,
  Vector3,
  VisibilityState,
  createSystem,
  type Entity,
  type Object3D,
  type UIKitMLAsset,
} from '@iwsdk/core';
import { createToolSet, setToolLook } from '../scene-assets/tool-models.scene-asset.js';
import { Autosave } from './autosave.js';
import { BoardView, WINDOW_H, WINDOW_W } from './board.js';
import { DioramaSystem } from './diorama.js';
import { DirectGrab, type GrabTarget } from './direct-grab.js';
import { INNER_FRAME, PX_PER_M, SIDES, TOOL_NAMES, readingSpreads, spreadIndexOf, type Side, type ToolId } from './doc.js';
import * as exporter from './export.js';
import { History } from './history.js';
import { ManagerUi } from './manager-ui.js';
import { Navigator, STRIP_H } from './navigator.js';
import * as ops from './page-ops.js';
import { PaletteUi } from './palette-ui.js';
import { PenRig } from './pens.js';
import { Project, loadTemplate, type PageRt } from './project.js';
import { References } from './refs.js';
import * as storage from './storage.js';
import { studioBridge, type StudioApi } from './studio-ctx.js';
import { TextInput } from './text-input.js';
import { loadTextFont } from './text-render.js';
import { applyJapaneseFont } from './ui-kit.js';
import { ToolController, type BoardPoint } from './tools.js';
import { Windows, panelBottom, type WindowSpec } from './windows.js';
import { WristMenu } from './wrist-menu.js';

const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** Paper surface height in board-root space. */
const PAPER_Z = 0.002;
/** Pen contact with the board, in meters above the paper (negative: through it). */
const CONTACT = {
  /** Touch down at this height and lift above `up`: the gap swallows tracking jitter. */
  down: 0.004,
  up: 0.018,
  /** The board has no physical surface, so keep drawing while the tip sinks this far behind it. */
  behind: 0.08,
  /** Penetration that reaches full pressure. */
  fullPress: 0.015,
  /** Show the approach marker from this height. */
  hover: 0.07,
};

function penPressure(height: number): number {
  return 0.35 + 0.65 * Math.min(1, Math.max(0, (CONTACT.down - height) / CONTACT.fullPress));
}

interface BoardPointerEvent {
  pointerId: number;
  point: Vector3;
  nativeEvent?: { pressure?: number; pointerType?: string };
}

interface ActivePointer {
  id: number;
  side: Side | null;
  /** XR controller rays and pen tips are sampled every frame; others follow events. */
  sampled: boolean;
  /** Driven by a pen tip touching the board rather than a pointer event. */
  pen: boolean;
  pressure: number;
  pan: { x: number; y: number } | null;
}

export class StudioSystem extends createSystem({}) implements StudioApi {
  project!: Project;
  board!: BoardView;
  readonly history = new History();
  textInput!: TextInput;
  tools!: ToolController;
  private navigator!: Navigator;
  private palette: PaletteUi | null = null;
  private manager: ManagerUi | null = null;
  private refs: References | null = null;
  private wrist: WristMenu | null = null;
  private autosave!: Autosave;
  private pens!: PenRig;
  private grab!: DirectGrab;
  private windows!: Windows;
  /** What each held pen tip may press: panels and the page strip (the board has its own contact logic). */
  private readonly uiTargets: Record<Side, Object3D[]> = { left: [], right: [] };
  private rig!: Object3D;
  private ready = false;
  private active: ActivePointer | null = null;
  private lastSide: Side = 'right';
  private hoverPoint: BoardPoint | null = null;
  private thumbCursor = 0;
  private wasImmersive = false;
  private domReleased = false;
  private triggerAtDown = 0;
  private yHeld = 0;
  private zoomLabel = 100;
  /** Two-hand zoom: last midpoint and spread while both hands hold the board. */
  private readonly grip = { active: false, held: 0, mx: 0, my: 0, dist: 1 };
  /** Last input kind announced with a how-to toast. */
  private announced: 'hand' | 'controller' | null = null;
  private readonly armed: Record<Side, boolean> = { left: false, right: true };
  /** A pen that touched down must lift before it can touch down again. */
  private readonly penLatch: Record<Side, boolean> = { left: false, right: false };
  private penHovering = false;
  private readonly openListeners: Array<(p: Project) => void> = [];
  private readonly p: BoardPoint = { x: 0, y: 0 };
  private readonly hoverStore: BoardPoint = { x: 0, y: 0 };
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly v4 = new Vector3();
  private readonly rayHit = new Vector3();
  private readonly foot = new Vector3();
  private readonly footLocal = { x: 0, y: 0 };
  private readonly penHoverPoint: BoardPoint = { x: 0, y: 0 };

  init(): void {
    studioBridge.studio = this;
    // Swap fonts before the first layout pass to avoid missing-glyph frames.
    for (const [node, root] of [
      ['tool-palette', 'tool-root'],
      ['manager', 'manager-root'],
      ['diorama-palette', 'diorama-root'],
      ['wrist-menu', 'wrist-root'],
    ] as const) {
      const panel = this.world.getSceneObject<UIKitMLAsset>(node);
      if (panel != null) applyJapaneseFont(panel, root);
    }
    this.cleanupFuncs.push(() => {
      if (studioBridge.studio === this) studioBridge.studio = null;
    });
    void this.boot().catch((error) => {
      console.error('[MangaNameStudio] boot failed', error);
    });
  }

  private async boot(): Promise<void> {
    await Promise.all([
      loadTemplate(asset('textures/page_template.jpg')),
      loadTextFont(asset('fonts/GenEiAntiqueNv6-M.ttf')),
      document.fonts.load('16px "M PLUS 1p"').catch(() => undefined),
    ]);
    storage.requestPersistentStorage();
    this.project = await this.initialProject();
    this.textInput = new TextInput();
    this.cleanupFuncs.push(() => this.textInput.dispose());
    this.tools = new ToolController(this);
    this.tools.onSelectionChange = () => this.palette?.refresh();
    this.autosave = new Autosave(() => this.project);
    this.autosave.onState = (state) => {
      this.palette?.setSaveState(state);
      if (state === 'error') {
        this.toast(
          this.autosave.lastError === 'quota'
            ? '保存容量が不足しています。不要なプロジェクトを削除するかバックアップを書き出してください'
            : '保存できていません。自動で再試行します (念のためバックアップを書き出してください)',
        );
      }
    };
    this.history.onChange = () => this.palette?.setHistory(this.history.canUndo, this.history.canRedo);

    this.rig = this.world.requireSceneObject('studio-rig');
    this.buildBoard();
    this.bindPanels();
    this.buildPens();
    this.buildWindows();
    this.bindDomInput();
    this.watchImmersive();
    this.ready = true;
    this.attachProject();
    this.world.registerSystem(DioramaSystem);
    if (import.meta.env.DEV) (window as unknown as { __mns: unknown }).__mns = this;
    this.toast('ようこそ。VRではペンを持って描けます (マウスでも描画できます)');
  }

  private async initialProject(): Promise<Project> {
    const last = storage.lastProjectId();
    const loaded = last != null ? await Project.load(last).catch(() => null) : null;
    if (loaded != null) return loaded;
    const metas = await storage.listProjects().catch(() => []);
    for (const meta of metas) {
      const p = await Project.load(meta.id).catch(() => null);
      if (p != null) return p;
    }
    return Project.blank(16, defaultName());
  }

  // ---------- StudioApi ----------

  toast(message: string): void {
    this.palette?.toast(message);
  }

  haptic(strength = 0.3): void {
    const source = this.input.xr.getPrimaryInputSource(this.lastSide);
    const actuator = source?.gamepad?.hapticActuators?.[0] as { pulse?: (v: number, ms: number) => void } | undefined;
    actuator?.pulse?.(strength, 18);
  }

  markDirty(): void {
    this.autosave?.schedule();
  }

  onProjectOpened(listener: (project: Project) => void): () => void {
    this.openListeners.push(listener);
    return () => this.openListeners.splice(this.openListeners.indexOf(listener), 1);
  }

  addGrabTarget(target: GrabTarget): () => void {
    return this.grab.add(target);
  }

  addWindow(spec: WindowSpec): void {
    this.windows.add(spec);
  }

  pasteOnPage(canvas: HTMLCanvasElement, label: string): void {
    const slot = this.currentSlot();
    if (slot < 0) {
      this.toast('貼り付け先のページがありません');
      return;
    }
    this.setTool('select');
    const r = this.board.slotRect(slot);
    const fit = INNER_FRAME.w / PX_PER_M;
    this.tools.selection.float(canvas, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, label, canvas.width / PX_PER_M > fit ? fit : undefined);
    this.palette?.refresh();
  }

  refreshTexts(page?: PageRt): void {
    if (!this.ready) return;
    const sel = this.tools.selectedText;
    for (const slot of this.board.slots) {
      if (slot.page == null || (page != null && slot.page !== page)) continue;
      slot.renderTexts(slot.page.texts, this.tools.textFramesVisible, sel?.page === slot.page ? sel.id : null);
    }
  }

  refreshBoard(): void {
    if (!this.ready) return;
    const project = this.project;
    const ids = this.displayedIds();
    const changed = this.board.slots.some((slot, i) => (slot.page?.id ?? null) !== ids[i]);
    // A floating clip rides along to the new spread instead of being baked.
    const carry = changed && this.tools.selection.active;
    if (changed) {
      this.textInput.commit();
      if (carry) {
        if (this.tools.busy) this.tools.cancel();
        this.tools.selectText(null);
      } else {
        this.tools.settle();
      }
    }
    const spread = readingSpreads(project.order)[spreadIndexOf(project.order, project.currentPage)];
    const isBlank = (slot: unknown) => !this.board.single && slot != null && typeof slot === 'object' && 'blank' in slot;
    const blanks = [isBlank(spread?.right), isBlank(spread?.left)];
    for (let i = 0; i < 2; i++) {
      const id = ids[i] ?? null;
      const page = project.page(id) ?? null;
      const blank = blanks[i]!;
      this.board.slots[i]!.show(page, blank, id != null ? project.pageNumber(id) : 0, id === project.currentPage);
    }
    this.board.layoutSlots();
    if (carry) this.tools.selection.carryToDisplayed();
    this.refreshTexts();
    this.navigator.refresh(project);
    this.manager?.refresh(this.board.single, this.board.zoom);
    this.palette?.refresh();
  }

  // ---------- setup ----------

  private buildBoard(): void {
    const anchor = this.world.requireSceneEntity('board-anchor');
    this.board = new BoardView();
    this.board.root.name = 'Board';
    const boardEntity = this.world.createTransformEntity(this.board.root, { parent: anchor });
    const hit = this.world.createTransformEntity(this.board.hitPlane, { parent: boardEntity });
    hit.addComponent(RayInteractable);
    this.listen(this.board.hitPlane, {
      pointerdown: (e) => this.onBoardDown(e),
      pointermove: (e) => this.onBoardMove(e),
      pointerup: (e) => this.onBoardUp(e.pointerId),
      pointercancel: (e) => this.onBoardUp(e.pointerId),
      pointerleave: (e) => {
        if (this.active?.id !== e.pointerId) this.setHover(null);
      },
    });

    this.navigator = new Navigator({
      select: (id) => ops.goToPage(this, id),
      append: () => ops.appendPage(this),
      reorder: (id, index) => ops.reorder(this, id, index),
    });
    this.navigator.root.position.set(0, WINDOW_H / 2 + STRIP_H / 2 + 0.025, 0);
    const navEntity: Entity = this.world.createTransformEntity(this.navigator.root, { parent: boardEntity });
    const navHit = this.world.createTransformEntity(this.navigator.hitPlane, { parent: navEntity });
    navHit.addComponent(RayInteractable);
    navHit.addComponent(PokeInteractable);
    let navPointer: number | null = null;
    this.listen(this.navigator.hitPlane, {
      pointerdown: (e) => {
        navPointer = e.pointerId;
        this.navigator.pointerDown(e.point);
      },
      pointermove: (e) => {
        if (navPointer === e.pointerId) this.navigator.pointerMove(e.point);
      },
      pointerup: (e) => {
        if (navPointer !== e.pointerId) return;
        navPointer = null;
        this.navigator.pointerUp(e.point);
      },
      pointerleave: (e) => {
        if (navPointer !== e.pointerId) return;
        navPointer = null;
        this.navigator.pointerUp(null);
      },
    });
  }

  private listen(
    target: Object3D,
    handlers: Partial<Record<'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave', (e: BoardPointerEvent) => void>>,
  ): void {
    const t = target as unknown as {
      addEventListener(type: string, fn: (e: BoardPointerEvent) => void): void;
      removeEventListener(type: string, fn: (e: BoardPointerEvent) => void): void;
    };
    for (const [type, fn] of Object.entries(handlers)) {
      t.addEventListener(type, fn);
      this.cleanupFuncs.push(() => t.removeEventListener(type, fn));
    }
  }

  private bindPanels(): void {
    const c = this.cleanupFuncs;
    const toolPanel = this.world.getSceneObject<UIKitMLAsset>('tool-palette');
    if (toolPanel != null) {
      this.palette = new PaletteUi(this.world, toolPanel, this, this.tools, {
        undo: () => this.undo(),
        redo: () => this.redo(),
        setTool: (tool, pointerId) => this.setTool(tool, this.sideOfPointer(pointerId)),
      }, c);
    }
    const managerPanel = this.world.getSceneObject<UIKitMLAsset>('manager');
    if (managerPanel != null) {
      this.manager = new ManagerUi(managerPanel, this, {
        turn: (dir) => this.turn(dir),
        zoom: (k) => this.zoom(k),
        resetZoom: () => {
          this.board.resetZoom();
          this.manager?.refresh(this.board.single, 1);
        },
        setSingle: (single) => {
          this.textInput.commit();
          this.tools.settle();
          this.board.single = single;
          this.board.resetZoom();
          this.refreshBoard();
        },
        recenter: () => this.recenter(),
        nudge: (dy, dz) => this.nudge(dy, dz),
        newProject: (n) => void this.newProject(n),
        openProject: (id) => void this.openProject(id),
        deleteProject: (id) => void this.deleteProject(id),
        renameProject: () => this.renameProject(),
        exportZip: () => void this.runExport('zip'),
        exportSpread: () => void this.runExport('spread'),
        exportOther: (kind) => void this.runExport(kind),
        backup: () => void this.runExport('backup'),
        importBackup: () => this.pickBackup(),
        emptyTrash: () => {
          const n = this.project.emptyTrash();
          this.history.clear();
          this.manager?.renderStock();
          this.markDirty();
          this.toast(`ゴミ箱の${n}ページを完全に削除しました`);
        },
        pasteClip: (id) => {
          const canvas = this.project.clips.get(id);
          if (canvas != null) this.pasteOnPage(canvas, 'クリップの貼り付け');
        },
      }, c);
      this.refs = new References(this.world, this, this.tools, managerPanel, c);
    }
    const wristPanel = this.world.getSceneObject<UIKitMLAsset>('wrist-menu');
    if (wristPanel != null) {
      this.wrist = new WristMenu(this.world, wristPanel, this.tools.hands, {
        undo: () => this.undo(),
        redo: () => this.redo(),
        turn: (dir) => this.turn(dir),
        zoom: (k) => this.zoom(k),
        swap: () => this.swapHands(),
        recenter: () => this.recenter(),
      }, c);
    }
  }

  private buildPens(): void {
    this.pens = new PenRig(this.world, createToolSet);
    for (const id of ['tool-palette', 'manager', 'diorama-palette']) {
      const panel = this.world.getSceneObject(id);
      if (panel != null) this.uiTargets.left.push(panel);
    }
    this.uiTargets.left.push(this.navigator.hitPlane);
    this.uiTargets.right.push(...this.uiTargets.left);
    // The menu rides on the left wrist, so only the right pen can press it.
    if (this.wrist != null) this.uiTargets.right.push(this.wrist.panel);
  }

  /** Grab bars under the panels, the board and the PDF sheet (the diorama adds its monitor). */
  private buildWindows(): void {
    this.grab = new DirectGrab(this.world, this.pens);
    this.windows = new Windows(this.world, this.grab, this.cleanupFuncs);
    const rig = this.world.requireSceneEntity('studio-rig');
    for (const [id, root] of [['tool-palette', 'tool-root'], ['manager', 'manager-root'], ['diorama-palette', 'diorama-root']] as const) {
      const panel = this.world.getSceneObject<UIKitMLAsset>(id);
      if (panel != null) this.windows.add({ object: panel, parent: rig, bottomCenter: (out) => panelBottom(panel, root, out) });
    }
    const below = (object: Object3D, depth: () => number): WindowSpec => ({
      object,
      parent: rig,
      bottomCenter: (out) => {
        object.updateMatrix();
        return out.set(0, -depth(), 0).applyMatrix4(object.matrix);
      },
    });
    this.windows.add(below(this.world.requireSceneObject('board-anchor'), () => WINDOW_H / 2 + 0.015));
    const refs = this.refs;
    if (refs != null) this.windows.add(below(this.world.requireSceneObject('pdf-anchor'), () => refs.sheetHalfHeight));
  }

  private bindDomInput(): void {
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    // Canvas pointer events reach the scene a frame later, so a DOM release only
    // ends the stroke in update(), after that frame's queued moves were applied.
    const onWindowUp = () => {
      this.domReleased = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (this.hoverPoint == null) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, this.hoverPoint);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file == null) return;
      if (file.name.toLowerCase().endsWith('.zip')) void this.importFile(file);
      else if (!this.refs?.handleFile(file)) this.toast('PDF / .txt / バックアップzip をドロップしてください');
    };
    // Quest hides the page when the headset comes off and may kill it soon after:
    // bake any floating cut and typed text before the flush.
    const onHidden = (e: Event) => {
      if (e.type !== 'pagehide' && document.visibilityState !== 'hidden') return;
      this.textInput.commit();
      if (this.tools.busy) this.tools.cancel();
      this.tools.settle();
      void this.autosave.flush();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', onWindowUp, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onHidden);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onWindowUp, true);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      this.autosave.dispose();
    });
  }

  private watchImmersive(): void {
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const immersive = state !== VisibilityState.NonImmersive;
        // Bring the desk in front of the user once the headset pose is valid.
        if (immersive && !this.wasImmersive) setTimeout(() => this.recenter(), 350);
        this.wasImmersive = immersive;
        this.autosave.fast = immersive;
      }),
    );
  }

  private attachProject(): void {
    this.history.clear();
    this.board.resetZoom();
    this.palette?.setProjectName(this.project.name);
    this.palette?.setSaveState('saved');
    this.refreshBoard();
    void this.refs?.attach(this.project);
    for (const listener of this.openListeners) listener(this.project);
    storage.rememberProject(this.project.id);
  }

  // ---------- board input ----------

  /** Which hand a pointer (pen tip, ray or fingertip) belongs to; undefined for the mouse. */
  sideOfPointer(pointerId: number | undefined): Side | undefined {
    if (pointerId == null) return undefined;
    return this.pens?.sideOfPointer(pointerId) ?? this.sideOf(pointerId).side ?? undefined;
  }

  private sideOf(pointerId: number): { side: Side | null; ray: boolean; hand: boolean } {
    for (const side of SIDES) {
      const pointers = this.input.xr.multiPointers[side];
      const hand = this.input.xr.getPrimaryInputSource(side)?.hand != null;
      if (pointers.getPointer('ray').id === pointerId) return { side, ray: true, hand };
      if (pointers.getPointer('touch').id === pointerId) return { side, ray: false, hand };
    }
    return { side: null, ray: false, hand: false };
  }

  private triggerValue(side: Side): number {
    const pad = this.input.xr.gamepads[side];
    return pad?.getButtonValue(InputComponent.Trigger) ?? 1;
  }

  private onBoardDown(e: BoardPointerEvent): void {
    if (!this.ready || this.active != null) return;
    if (this.textInput.active) this.textInput.commit();
    const { side, ray, hand } = this.sideOf(e.pointerId);
    // Mouse and pen tablets act as the right hand.
    this.tools.useHand(side ?? 'right');
    // Hands act on the board through their pens; an empty hand's pinch ray only moves it.
    if (ray && hand && this.tools.tool !== 'hand') return;
    if (side != null) this.lastSide = side;
    const sampled = ray && !hand && side != null;
    let pressure = 1;
    if (sampled) pressure = 1;
    else if (side != null) pressure = 0.6;
    else if (e.nativeEvent?.pointerType === 'pen') pressure = e.nativeEvent.pressure ?? 0.5;
    // Trigger pulls jitter the ray: ~1.2 deg at board distance is about 50 raster px.
    this.tools.tapSlopPx = sampled ? 48 : side != null ? 24 : 10;
    this.triggerAtDown = sampled ? this.triggerValue(side!) : 0;
    if (sampled) pressure = this.pressureFromTrigger(side!);
    const active: ActivePointer = { id: e.pointerId, side, sampled, pen: false, pressure, pan: null };
    this.active = active;
    this.board.toBoard(e.point, this.p);
    this.focusPageAt(this.p);
    if (this.tools.tool === 'hand') {
      const w = this.board.root.worldToLocal(this.v1.copy(e.point));
      active.pan = { x: w.x, y: w.y };
      return;
    }
    this.tools.down(e.pointerId, this.p, pressure);
    if (!this.tools.busy) this.active = null;
  }

  private onBoardMove(e: BoardPointerEvent): void {
    if (!this.ready) return;
    const active = this.active;
    if (active == null || active.id !== e.pointerId) {
      if (active == null) {
        this.board.toBoard(e.point, this.p);
        this.setHover(this.p);
      }
      return;
    }
    if (active.sampled) return;
    if (e.nativeEvent?.pointerType === 'pen') active.pressure = e.nativeEvent.pressure ?? active.pressure;
    this.moveActive(e.point);
  }

  private moveActive(world: Vector3): void {
    const active = this.active!;
    if (active.pan != null) {
      const w = this.board.root.worldToLocal(this.v2.copy(world));
      this.board.pan(w.x - active.pan.x, w.y - active.pan.y);
      active.pan.x = w.x;
      active.pan.y = w.y;
      return;
    }
    this.board.toBoard(world, this.p);
    this.tools.move(active.id, this.p, active.pressure);
    this.hoverPoint = this.p;
  }

  private onBoardUp(pointerId: number): void {
    const active = this.active;
    if (active == null || active.id !== pointerId) return;
    this.active = null;
    if (active.pan == null) this.tools.up(pointerId);
    this.palette?.refresh();
  }

  /** Pressure relative to the trigger travel left after the click point. */
  private pressureFromTrigger(side: Side): number {
    const down = Math.min(0.9, this.triggerAtDown);
    const t = (this.triggerValue(side) - down) / Math.max(0.1, 1 - down);
    return 0.35 + 0.65 * Math.min(1, Math.max(0, t));
  }

  private setHover(p: BoardPoint | null, tool?: ToolId): void {
    if (p == null) {
      this.hoverPoint = null;
    } else {
      this.hoverStore.x = p.x;
      this.hoverStore.y = p.y;
      this.hoverPoint = this.hoverStore;
    }
    this.tools.hover(p, tool);
  }

  /** Clicking on the other page of a spread makes it the current page. */
  private focusPageAt(p: BoardPoint): void {
    const slot = this.board.slotAt(p.x, p.y);
    const page = slot >= 0 ? this.board.slots[slot]!.page : null;
    if (page == null || page.id === this.project.currentPage) return;
    this.project.currentPage = page.id;
    for (let i = 0; i < 2; i++) {
      const s = this.board.slots[i]!;
      s.highlight.visible = s.page?.id === page.id;
    }
    this.navigator.refresh(this.project);
    this.manager?.refresh(this.board.single, this.board.zoom);
  }

  /** XR controller ray against the board plane, independent of pointer hits. */
  private sampleRay(side: Side, out: Vector3): boolean {
    const space = this.player.raySpaces[side];
    if (space == null) return false;
    space.updateWorldMatrix(true, false);
    const origin = this.v1.setFromMatrixPosition(space.matrixWorld);
    const dir = this.v2.set(0, 0, -1).transformDirection(space.matrixWorld);
    const root = this.board.root;
    const normal = this.v3.set(0, 0, 1).transformDirection(root.matrixWorld);
    const point = this.v4.setFromMatrixPosition(root.matrixWorld);
    const denom = normal.dot(dir);
    if (Math.abs(denom) < 1e-4) return false;
    const t = normal.dot(point.sub(origin)) / denom;
    if (t < 0) return false;
    out.copy(origin).addScaledVector(dir, t);
    return true;
  }

  update(delta: number): void {
    if (!this.ready) return;
    // Place the wrist menu before the pens probe it this frame.
    this.wrist?.update(delta);
    this.updatePens(delta);
    // After the windows moved this frame, so a carried board clips where it is drawn.
    this.board.updateClipPlanes();
    const active = this.active;
    if (active?.pen && active.side != null) {
      this.trackPen(active, active.side);
    } else if (active?.sampled && active.side != null) {
      const pad = this.input.xr.gamepads[active.side];
      const held = pad?.getButtonPressed(InputComponent.Trigger) ?? false;
      if (!held) {
        this.onBoardUp(active.id);
      } else if (this.sampleRay(active.side, this.rayHit)) {
        active.pressure = this.pressureFromTrigger(active.side);
        this.moveActive(this.rayHit);
      }
    }
    if (this.domReleased) {
      this.domReleased = false;
      if (this.active != null && !this.active.sampled) this.onBoardUp(this.active.id);
    }
    this.penContacts();
    this.announceInput();
    this.controllerShortcuts(delta);
    // Refresh at most two stale thumbnails per frame, never mid-stroke.
    const order = this.project.order;
    let budget = this.tools.busy ? 0 : 2;
    for (let n = 0; n < order.length && budget > 0; n++) {
      this.thumbCursor = (this.thumbCursor + 1) % order.length;
      if (this.project.pages.get(order[this.thumbCursor]!)?.refreshThumb()) budget--;
    }
  }

  // ---------- pens ----------

  /** Track pens and keep IWSDK's own pointers out of a pen hand's way. */
  private updatePens(delta: number): void {
    const hands = this.tools.hands;
    this.armed.left = hands.left !== 'hand';
    this.armed.right = hands.right !== 'hand';
    this.pens.update(delta, this.armed);
    this.grab.update();
    this.windows.update(delta);
    const ink = this.project.tools.penColor;
    for (const side of SIDES) {
      const pen = this.pens.pens[side];
      const carrying = this.grab.holding(side);
      // A hand carrying a window or diorama piece puts its tool away until it lets go.
      if (carrying) {
        pen.armed = false;
        pen.model.visible = false;
      }
      if (pen.model.visible) setToolLook(pen.model, hands[side], ink, pen.held);
      const pointers = this.input.xr.multiPointers[side];
      // A pen grip reads as a pinch, so a hand holding a pen never fires its ray.
      pointers.toggleSubPointer('ray', !(pen.armed && pen.source === 'hand') && !carrying);
      // While the pen is held its tip replaces the fingertip (or controller) poke.
      pointers.toggleSubPointer('touch', !(pen.armed && pen.held) && !carrying);
    }
    this.pens.pressUi(this.uiTargets);
  }

  /**
   * Height of a held pen's tip above the paper, leaving its foot point in
   * `foot` (world) and `footLocal` (board root). Null when off the board.
   */
  private penHeight(side: Side, margin: number): number | null {
    const pen = this.pens.pens[side];
    if (!pen.armed || !pen.held || pen.source == null) return null;
    const root = this.board.root;
    const local = root.worldToLocal(this.v1.copy(pen.tip));
    if (Math.abs(local.x) > WINDOW_W / 2 + margin || Math.abs(local.y) > WINDOW_H / 2 + margin) return null;
    this.footLocal.x = local.x;
    this.footLocal.y = local.y;
    root.localToWorld(this.foot.set(local.x, local.y, PAPER_Z));
    return local.z - PAPER_Z;
  }

  private trackPen(active: ActivePointer, side: Side): void {
    const height = this.penHeight(side, 0.02);
    if (height == null || height > CONTACT.up || height < -CONTACT.behind) {
      this.onBoardUp(active.id);
      return;
    }
    active.pressure = penPressure(height);
    this.moveActive(this.foot);
  }

  /** Touch-down, approach markers and the brush cursor for held pens. */
  private penContacts(): void {
    let nearest: Side | null = null;
    let best = Infinity;
    for (const side of SIDES) {
      const height = this.penHeight(side, 0);
      if (height == null || height > CONTACT.up) this.penLatch[side] = false;
      if (height == null || height > CONTACT.hover || height < -CONTACT.behind) {
        this.board.hideTipMarker(side);
        continue;
      }
      const drawing = this.active?.pen === true && this.active.side === side;
      this.board.showTipMarker(side, this.footLocal.x, this.footLocal.y, Math.max(0, height), drawing, CONTACT.hover);
      if (height < best) {
        best = height;
        nearest = side;
        this.board.toBoard(this.foot, this.penHoverPoint);
      }
      if (this.active == null && !this.penLatch[side] && height <= CONTACT.down && !this.pens.onUi(side)) {
        this.penLatch[side] = true;
        this.beginPen(side, height);
      }
    }
    if (nearest != null) {
      this.penHovering = true;
      if (this.active == null) this.setHover(this.penHoverPoint, this.tools.hands[nearest]);
    } else if (this.penHovering) {
      this.penHovering = false;
      if (this.active == null) this.setHover(null);
    }
  }

  /** A held pen touched the board: start a session as that hand's tool. */
  private beginPen(side: Side, height: number): void {
    const pen = this.pens.pens[side];
    if (this.textInput.active) this.textInput.commit();
    this.tools.useHand(side);
    this.lastSide = side;
    // Fingers wobble more than a controller when tapping.
    this.tools.tapSlopPx = pen.source === 'hand' ? 28 : 16;
    const pressure = penPressure(height);
    const active: ActivePointer = { id: pen.pointer.id, side, sampled: true, pen: true, pressure, pan: null };
    this.active = active;
    this.board.toBoard(this.foot, this.p);
    this.focusPageAt(this.p);
    this.tools.down(active.id, this.p, pressure);
    if (!this.tools.busy) {
      this.active = null;
      return;
    }
    this.haptic(0.2);
  }

  /** An empty hand (no pen) is pinching, as the system reports it (select held on its ray). */
  private emptyHandPinch(side: Side): boolean {
    const pen = this.pens.pens[side];
    return pen.source === 'hand' && !pen.armed && this.input.xr.multiPointers[side].getPointer('ray').getButtonsDown().size > 0;
  }

  /**
   * Both grips (controllers) or both empty hands pinching hold the board: move the
   * hands apart/together to zoom, move them together to pan.
   */
  private twoHandBoard(delta: number): boolean {
    const l = this.input.xr.gamepads.left;
    const r = this.input.xr.gamepads.right;
    const grips = (l?.getButtonPressed(InputComponent.Squeeze) ?? false) && (r?.getButtonPressed(InputComponent.Squeeze) ?? false);
    const pinches = !grips && this.emptyHandPinch('left') && this.emptyHandPinch('right');
    const grip = this.grip;
    // Never zoom under an active stroke/drag or while a hand carries something.
    if (!(grips || pinches) || this.tools.busy || this.dioramaHeld() || this.grab.active) {
      grip.active = false;
      grip.held = 0;
      return false;
    }
    grip.held += delta;
    // The first pinch may have started a one-hand pan; the second hand takes over.
    if (this.active?.pan != null) this.onBoardUp(this.active.id);
    const root = this.board.root;
    const pens = this.pens.pens;
    const a = root.worldToLocal(pinches ? this.v1.copy(pens.left.pinch) : this.v1.setFromMatrixPosition(this.player.gripSpaces.left.matrixWorld));
    const b = root.worldToLocal(pinches ? this.v2.copy(pens.right.pinch) : this.v2.setFromMatrixPosition(this.player.gripSpaces.right.matrixWorld));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dist = Math.max(0.02, Math.hypot(a.x - b.x, a.y - b.y));
    // Fingers are still closing for a moment after a pinch registers: let that settle first.
    if (grip.active && (grips || grip.held > 0.15)) {
      const board = this.board;
      // Zoom about the hands' midpoint, then follow the midpoint.
      const cx = (mx - board.panX) / board.zoom;
      const cy = (my - board.panY) / board.zoom;
      board.zoomAt(dist / grip.dist, cx, cy);
      board.pan(mx - grip.mx, my - grip.my);
      const label = Math.round(board.zoom * 100);
      if (label !== this.zoomLabel) {
        this.zoomLabel = label;
        this.manager?.setZoom(board.zoom);
      }
    }
    grip.active = true;
    grip.mx = mx;
    grip.my = my;
    grip.dist = dist;
    return true;
  }

  /** Say how to work once whenever the input switches between hands and controllers. */
  private announceInput(): void {
    const xr = this.input.xr;
    const kind = xr.isPrimary('hand', 'right') || xr.isPrimary('hand', 'left')
      ? 'hand'
      : xr.isPrimary('controller', 'right') || xr.isPrimary('controller', 'left')
        ? 'controller'
        : null;
    if (kind == null || kind === this.announced) return;
    this.announced = kind;
    this.toast(
      kind === 'hand'
        ? 'ペンをつまむように持ち、ペン先でボードに触れて描きます / 左手のひらを向けるとメニュー'
        : 'ペン先をボードに当てるかトリガーで描画 / A:取り消し B:やり直し / 左スティック押し込みでメニュー',
    );
  }

  private dioramaHeld(): boolean {
    return studioBridge.dioramaGrabbing;
  }

  private controllerShortcuts(delta: number): void {
    if (this.twoHandBoard(delta)) return;
    const right = this.input.xr.gamepads.right;
    const left = this.input.xr.gamepads.left;
    if (right != null) {
      if (right.getButtonDown(InputComponent.A_Button)) this.undo();
      if (right.getButtonDown(InputComponent.B_Button)) this.redo();
      const stick = right.getAxesValues(InputComponent.Thumbstick);
      if (this.refs?.hovered && stick != null && Math.abs(stick.y) > 0.3) {
        this.refs.zoomSheet(1 - stick.y * delta * 1.5);
      } else if (stick != null && Math.hypot(stick.x, stick.y) > 0.25) {
        const speed = 0.35 * delta * this.board.zoom;
        this.board.pan(-stick.x * speed, stick.y * speed);
      }
    }
    if (left != null) {
      if (left.getButtonDown(InputComponent.X_Button)) {
        const side = this.lastSide;
        this.setTool(this.tools.hands[side] === 'pen' ? 'eraser' : 'pen', side);
      }
      // Recenter on a 0.5 s hold so a stray press never yanks the desk away.
      if (left.getButtonPressed(InputComponent.Y_Button)) {
        this.yHeld += delta;
        if (this.yHeld >= 0.5 && this.yHeld - delta < 0.5) this.recenter();
      } else {
        this.yHeld = 0;
      }
      if (left.getAxesEnteringLeft(InputComponent.Thumbstick)) this.turn(1);
      if (left.getAxesEnteringRight(InputComponent.Thumbstick)) this.turn(-1);
      const stick = left.getAxesValues(InputComponent.Thumbstick);
      if (stick != null && Math.abs(stick.y) > 0.35 && Math.abs(stick.x) < 0.5) {
        this.zoom(1 - stick.y * delta * 1.6, this.hoverPoint ?? undefined);
      }
    }
  }

  // ---------- actions ----------

  /** Trade the tools in the two hands. */
  private swapHands(): void {
    if (this.tools.busy) return;
    const { left, right } = this.tools.hands;
    const focus = this.tools.focus;
    this.tools.setTool(right, 'left');
    this.tools.setTool(left, 'right');
    this.tools.useHand(focus);
    this.palette?.refresh();
    this.toast(`持ち替え: 左手 ${TOOL_NAMES[right]} / 右手 ${TOOL_NAMES[left]}`);
  }

  /** Hand `side` (default: the acting hand) a tool. */
  setTool(tool: ToolId, side?: Side): void {
    if (this.tools.busy) return;
    this.tools.setTool(tool, side);
    if (side != null) this.lastSide = side;
    this.palette?.refresh();
    this.haptic(0.2);
  }

  undo(): void {
    this.textInput.commit();
    if (this.tools.busy) this.tools.cancel();
    if (this.tools.selection.active) {
      this.tools.selection.cancel();
      this.toast('切り取りを取り消しました');
      this.palette?.refresh();
      return;
    }
    const label = this.history.undo();
    this.afterHistory(label != null ? `取り消し: ${label}` : 'これ以上取り消せません');
  }

  redo(): void {
    this.textInput.commit();
    if (this.tools.busy) return;
    if (this.tools.selection.active) {
      this.toast('選択中です。確定か取消をしてからやり直してください');
      return;
    }
    const label = this.history.redo();
    this.afterHistory(label != null ? `やり直し: ${label}` : 'やり直す操作がありません');
  }

  private afterHistory(message: string): void {
    this.tools.selectText(null);
    this.refreshBoard();
    this.toast(message);
    this.markDirty();
  }

  private turn(dir: number): void {
    const moved = this.board.single ? ops.turnPage(this, dir) : ops.turnSpread(this, dir);
    if (moved) this.haptic(0.25);
  }

  private zoom(factor: number, at?: BoardPoint): void {
    const b = this.board;
    const cx = at?.x ?? -b.panX / b.zoom;
    const cy = at?.y ?? -b.panY / b.zoom;
    b.zoomAt(factor, cx, cy);
    const label = Math.round(b.zoom * 100);
    if (label !== this.zoomLabel) {
      this.zoomLabel = label;
      this.manager?.setZoom(b.zoom);
    }
  }

  private currentSlot(): number {
    const id = this.project.currentPage;
    return this.board.slots.findIndex((s, i) => s.page?.id === id && !(this.board.single && i === 1));
  }

  private displayedIds(): Array<string | null> {
    const project = this.project;
    if (this.board.single) return [project.currentPage, null];
    const spread = readingSpreads(project.order)[spreadIndexOf(project.order, project.currentPage)];
    const id = (slot: unknown) => (slot != null && typeof slot === 'object' && 'page' in slot ? (slot as { page: string }).page : null);
    return [id(spread?.right), id(spread?.left)];
  }

  recenter(): void {
    const camera = this.world.camera;
    camera.updateWorldMatrix(true, false);
    const head = camera.getWorldPosition(this.v1);
    const forward = this.v2.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const yaw = Math.atan2(-forward.x, -forward.z);
    this.rig.position.copy(head);
    this.rig.rotation.set(0, yaw, 0);
    this.toast('作業台を正面に呼びました (左Y)');
  }

  private nudge(dy: number, dz: number): void {
    this.rig.position.y += dy;
    if (dz !== 0) {
      const forward = this.v1.set(0, 0, -1).applyQuaternion(this.rig.quaternion);
      this.rig.position.addScaledVector(forward, -dz);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.ready || this.textInput.active) return;
    const target = e.target as HTMLElement | null;
    if (target != null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (import.meta.env.DEV && e.key === 'F8') {
      console.info('[mns-debug]', JSON.stringify(this.debugState()));
      return;
    }
    if (import.meta.env.DEV && e.key === 'F9') {
      void import('./selftest.js').then((m) => m.runSelfTest(this));
      return;
    }
    if (mod || e.altKey) return;
    const tools: Record<string, ToolId> = { p: 'pen', b: 'pen', e: 'eraser', l: 'line', f: 'frame', t: 'text', m: 'select', s: 'select', a: 'lasso', h: 'hand', ' ': 'hand' };
    if (tools[key] != null) {
      this.setTool(tools[key]!);
      return;
    }
    switch (e.key) {
      case 'ArrowLeft':
        this.turn(1);
        break;
      case 'ArrowRight':
        this.turn(-1);
        break;
      case '+':
      case '=':
        this.zoom(1.2, this.hoverPoint ?? undefined);
        break;
      case '-':
        this.zoom(1 / 1.2, this.hoverPoint ?? undefined);
        break;
      case '0':
        this.board.resetZoom();
        this.manager?.refresh(this.board.single, 1);
        break;
      case 'Enter':
        if (this.tools.selection.active) this.tools.selection.commit();
        else if (this.tools.currentText() != null) this.tools.editText();
        break;
      case 'Escape':
        if (this.tools.selection.active) this.tools.selection.cancel();
        else this.tools.selectText(null);
        break;
      case 'Delete':
      case 'Backspace':
        if (this.tools.selection.active) this.tools.selection.remove();
        else this.tools.deleteText();
        break;
      case '[':
      case ']': {
        const t = this.project.tools;
        const k = e.key === ']' ? 1.2 : 1 / 1.2;
        if (this.tools.tool === 'eraser') t.eraserSize = Math.max(2, Math.min(200, Math.round(t.eraserSize * k)));
        else t.penSize = Math.max(1, Math.min(200, Math.round(t.penSize * k + (k > 1 ? 0.5 : 0))));
        this.palette?.refresh();
        this.markDirty();
        break;
      }
      default:
        return;
    }
    this.palette?.refresh();
  }

  /** Dev-only snapshot of input state for emulator checks (F8 logs it). */
  private debugState(): Record<string, unknown> {
    const round = (v: Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000);
    const pens: Record<string, unknown> = {};
    for (const side of SIDES) {
      const pen = this.pens.pens[side];
      const pointers = this.input.xr.multiPointers[side];
      pens[side] = {
        source: pen.source,
        armed: pen.armed,
        held: pen.held,
        tip: round(pen.tip),
        axis: round(pen.axis),
        height: this.penHeight(side, 0),
        uiPointer: pen.pointer.getEnabled(),
        rayDown: pointers.getPointer('ray').getButtonsDown().size,
        pinchStrength: Math.round(this.input.xr.visualAdapters.hand[side].getPinchStrength() * 100) / 100,
        ray: pointers.getPointer('ray').getEnabled(),
        touch: pointers.getPointer('touch').getEnabled(),
      };
    }
    const wrist = this.wrist;
    return {
      wrist: wrist != null ? { visible: wrist.visible, facing: Math.round(wrist.facing * 100) / 100 } : null,
      tool: this.tools.tool,
      hands: this.tools.hands,
      focus: this.tools.focus,
      busy: this.tools.busy,
      active: this.active,
      zoom: Math.round(this.board.zoom * 100) / 100,
      grip: this.grip.active,
      grab: this.grab.debugTargets(),
      history: (this.history as unknown as { past: Array<{ label: string }> }).past.map((h) => h.label),
      pens,
    };
  }

  // ---------- projects ----------

  private async switchTo(project: Project): Promise<boolean> {
    this.textInput.commit();
    this.tools.settle();
    if (!this.project.deleted) {
      if (!(await this.autosave.idle())) {
        this.toast('保存に失敗しているため切り替えを中止しました。バックアップを書き出してください');
        return false;
      }
    } else {
      this.autosave.cancel();
    }
    const old = this.project;
    this.project = project;
    for (const slot of this.board.slots) slot.page = null;
    this.attachProject();
    if (old !== project) old.dispose();
    return true;
  }

  private async newProject(pages: number): Promise<void> {
    const project = Project.blank(pages, defaultName());
    if (!(await this.switchTo(project))) return;
    this.markDirty();
    await this.autosave.flush();
    void this.manager?.loadFiles();
    this.toast(`${pages}ページの新しいネームを作りました`);
  }

  private async openProject(id: string): Promise<void> {
    if (id === this.project.id) {
      this.toast('このプロジェクトは開いています');
      return;
    }
    await this.autosave.flush();
    const project = await Project.load(id);
    if (project == null) {
      this.toast('プロジェクトを開けませんでした');
      return;
    }
    if (!(await this.switchTo(project))) {
      project.dispose();
      return;
    }
    void this.manager?.loadFiles();
    this.toast(`「${project.name}」を開きました`);
  }

  private async deleteProject(id: string): Promise<void> {
    const current = id === this.project.id;
    if (current) {
      // Let any in-flight write land first, then forbid further writes of this project.
      await this.autosave.idle();
      this.project.deleted = true;
      this.autosave.cancel();
    }
    try {
      await storage.deleteProject(id);
    } catch (error) {
      console.error('[MangaNameStudio] delete failed', error);
      if (current) {
        this.project.deleted = false;
        this.autosave.schedule();
      }
      this.toast('削除に失敗しました');
      return;
    }
    if (current) {
      const rest = await storage.listProjects();
      const next = rest.length > 0 ? await Project.load(rest[0]!.id) : null;
      await this.switchTo(next ?? Project.blank(16, defaultName()));
      this.markDirty();
    }
    void this.manager?.loadFiles();
    this.toast('プロジェクトを削除しました');
  }

  private renameProject(): void {
    const project = this.project;
    this.textInput.open({
      title: 'プロジェクト名',
      value: project.name,
      multiline: false,
      onInput: () => undefined,
      onCommit: (value) => {
        const name = value.trim();
        if (name.length === 0 || name === project.name) return;
        project.name = name;
        project.emit('meta');
        this.palette?.setProjectName(name);
        this.manager?.refresh(this.board.single, this.board.zoom);
        this.markDirty();
        void this.autosave.flush().then(() => this.manager?.loadFiles());
      },
    });
  }

  private async runExport(kind: 'zip' | 'spread' | 'backup' | 'pdf' | 'mini' | 'text'): Promise<void> {
    this.tools.settle();
    this.manager?.setFileStatus('書き出し中...');
    if (this.wasImmersive) this.toast('書き出したファイルはブラウザのダウンロードに保存されます (VRを出ると確認できます)');
    try {
      if (kind === 'zip') {
        const n = await exporter.exportPagesZip(this.project);
        this.manager?.setFileStatus(`${n}ページをPNG(zip)で書き出しました`);
      } else if (kind === 'pdf') {
        const n = await exporter.exportPdf(this.project);
        this.manager?.setFileStatus(`${n}ページをPDFで書き出しました`);
      } else if (kind === 'mini') {
        await exporter.exportMiniJpg(this.project);
        this.manager?.setFileStatus('ミニネーム(一覧画像)を書き出しました');
      } else if (kind === 'text') {
        exporter.exportScriptText(this.project);
        this.manager?.setFileStatus('セリフ一覧(.txt)を書き出しました');
      } else if (kind === 'spread') {
        await exporter.exportSpreadPng(this.project, this.displayedIds());
        this.manager?.setFileStatus('見開きをPNGで書き出しました');
      } else {
        await exporter.exportBackup(this.project);
        this.manager?.setFileStatus('バックアップを保存しました (別端末で読込できます)');
      }
    } catch (error) {
      console.error('[MangaNameStudio] export failed', error);
      this.manager?.setFileStatus('書き出しに失敗しました');
    }
  }

  private pickBackup(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file != null) void this.importFile(file);
    };
    input.click();
  }

  private async importFile(file: File): Promise<void> {
    try {
      const id = await exporter.importBackup(file);
      await this.openProject(id);
    } catch (error) {
      console.error('[MangaNameStudio] import failed', error);
      this.toast(`読込に失敗しました: ${(error as Error).message}`);
    }
  }
}

function defaultName(): string {
  const d = new Date();
  return `ネーム ${d.getMonth() + 1}月${d.getDate()}日`;
}

