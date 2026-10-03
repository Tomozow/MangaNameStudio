// Name stock as cards in space. Every stocked page or clip is a card that either hand
// can carry (squeeze / pinch) or a ray can drag. Let go of a page card over the board
// or the page strip to put the page back into the name there; let go of a clip card
// over a page to paste it at that spot. Anywhere else the card stays where it was put,
// and its place is saved with the project.
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  Vector3,
  type CanvasTexture,
  type Entity,
  type Object3D,
  type World,
} from '@iwsdk/core';
import { HandleStore, type HandleOptions } from '@pmndrs/handle';
import { WINDOW_H, WINDOW_W } from './board.js';
import { RASTER_H, RASTER_W, type StockItem } from './doc.js';
import { localBounds, type DirectGrab, type GrabLevel, type GrabTarget } from './direct-grab.js';
import type { Navigator } from './navigator.js';
import * as ops from './page-ops.js';
import { canvasTexture, ctx2d, makeCanvas, type Project } from './project.js';
import type { StudioApi } from './studio-ctx.js';
import type { BoardPoint } from './tools.js';
import { faceToward } from './windows.js';

/** Card size and placement (meters, 1/s). */
const CARD = {
  /** Thumbnail height of a page card; clips fit a square of this side. */
  size: 0.11,
  margin: 0.006,
  badge: 0.02,
  /** First hand slot in the studio rig's space (low, to the right of the board), then fanned. */
  slot: [0.24, -0.36, -0.26] as const,
  stepX: 0.1,
  stepY: 0.15,
  perRow: 4,
  face: 12,
};

/** How close to the board or strip (meters, along its normal) a card counts as over it. */
const DROP_DEPTH = { front: 0.15, behind: 0.05 };

const COLORS = { idle: 0x22262d, hover: 0x3a4150, moving: 0x2f4f80, drop: 0x4c8dff };

type Drop = { kind: 'insert'; index: number } | { kind: 'paste'; at: BoardPoint } | null;

interface Card {
  readonly item: StockItem;
  readonly group: Group;
  readonly entity: Entity;
  readonly backing: Mesh<BoxGeometry, MeshBasicMaterial>;
  readonly badge: { canvas: HTMLCanvasElement; texture: CanvasTexture; text: string };
  readonly handle: HandleStore<void>;
  /** Resources this card owns (a page card shows the page's own thumbnail texture). */
  readonly owned: Array<{ dispose(): void }>;
  readonly hovers: Set<number>;
  target: GrabTarget | null;
  unregister: () => void;
  unbind: () => void;
  carried: boolean;
  dragged: boolean;
  grabLevel: GrabLevel;
  drop: Drop;
  /** Let go this frame: act on the drop in the next update, outside the input callbacks. */
  released: boolean;
  /** Place when the move started, to send a pasted clip card back. */
  readonly home: number[];
}

const key = (item: StockItem) => `${item.kind}:${item.id}`;

export class StockCards {
  private readonly cards = new Map<string, Card>();
  private project: Project | null = null;
  private unlisten: (() => void) | null = null;
  private readonly v = new Vector3();
  private readonly local = new Vector3();
  private readonly head = new Vector3();
  private readonly at: BoardPoint = { x: 0, y: 0 };

  constructor(
    private readonly world: World,
    private readonly studio: StudioApi,
    private readonly grab: DirectGrab,
    private readonly navigator: Navigator,
    private readonly rig: Entity,
    cleanup: Array<() => void>,
  ) {
    cleanup.push(
      studio.onProjectOpened((project) => this.attach(project)),
      () => {
        this.unlisten?.();
        for (const card of [...this.cards.values()]) this.remove(card);
      },
    );
  }

  /** Bring the card of stock item `id` in front of the user. */
  recall(id: string): void {
    const card = [...this.cards.values()].find((c) => c.item.id === id);
    if (card == null) return;
    this.cancelMove(card);
    this.toSlot(card.group, this.freeSlot(card));
    this.save(card);
    this.studio.toast('カードを手元に呼びました');
  }

  update(delta: number): void {
    const now = performance.now();
    const k = 1 - Math.exp(-delta * CARD.face);
    this.world.camera.getWorldPosition(this.head);
    let previewing = false;
    for (const card of this.cards.values()) {
      if (card.released) {
        card.released = false;
        this.land(card);
        // Landing can restore the page and so remove this card (and others): stop here.
        return;
      }
      card.handle.update(now);
      if (!card.carried && !card.dragged) continue;
      faceToward(card.group, this.head, k);
      this.setDrop(card, this.dropAt(card));
      previewing ||= card.item.kind === 'page' && card.drop?.kind === 'insert';
    }
    if (!previewing) this.navigator.hideDrop();
  }

  // ---------- sync with the project ----------

  private attach(project: Project): void {
    this.unlisten?.();
    for (const card of [...this.cards.values()]) this.remove(card);
    this.project = project;
    this.unlisten = project.onChange((kind) => {
      if (kind === 'struct') this.sync();
    });
    this.sync();
  }

  private sync(): void {
    const project = this.project;
    if (project == null) return;
    const live = new Set(project.stock.map(key));
    for (const [k, card] of [...this.cards]) if (!live.has(k)) this.remove(card);
    for (const item of project.stock) {
      if (this.cards.has(key(item))) continue;
      const card = this.create(item);
      if (card == null) continue;
      const place = project.stockPlaces[item.id];
      if (place?.length === 7 && place.every(Number.isFinite)) {
        card.group.position.fromArray(place);
        card.group.quaternion.fromArray(place, 3);
      } else {
        // New to the stock: lay it out by the hand and remember the spot.
        this.toSlot(card.group, this.freeSlot(card));
        project.stockPlaces[item.id] = this.transform(card.group);
      }
    }
  }

  private create(item: StockItem): Card | null {
    const project = this.project!;
    const owned: Array<{ dispose(): void }> = [];
    let map: CanvasTexture;
    let w: number;
    let h: number;
    if (item.kind === 'page') {
      const page = project.pages.get(item.id);
      if (page == null) return null;
      page.refreshThumb();
      map = page.thumbTex;
      h = CARD.size;
      w = (h * RASTER_W) / RASTER_H;
    } else {
      const canvas = project.clips.get(item.id);
      if (canvas == null) return null;
      map = canvasTexture(canvas);
      owned.push(map);
      const s = CARD.size / Math.max(canvas.width, canvas.height);
      w = Math.max(0.03, canvas.width * s);
      h = Math.max(0.03, canvas.height * s);
    }
    const group = new Group();
    group.name = `StockCard ${item.kind}`;
    // Dark card with the thumbnail on top and a caption strip below it.
    const cardW = w + 2 * CARD.margin;
    const cardH = h + 3 * CARD.margin + CARD.badge;
    const backing = new Mesh(new BoxGeometry(cardW, cardH, 0.004), new MeshBasicMaterial({ color: COLORS.idle }));
    backing.name = 'CardBacking';
    const thumbY = cardH / 2 - CARD.margin - h / 2;
    const paper = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: 0xf6f4ee }));
    paper.position.set(0, thumbY, 0.0021);
    const thumb = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map, transparent: true }));
    thumb.position.set(0, thumbY, 0.0023);
    const badgeCanvas = makeCanvas(512, Math.round((512 * CARD.badge) / w));
    const badgeTexture = canvasTexture(badgeCanvas);
    owned.push(badgeTexture);
    const badgeMesh = new Mesh(new PlaneGeometry(w, CARD.badge), new MeshBasicMaterial({ map: badgeTexture, transparent: true }));
    badgeMesh.position.set(0, -cardH / 2 + CARD.margin + CARD.badge / 2, 0.0022);
    for (const mesh of [paper, thumb, badgeMesh]) mesh.raycast = () => undefined;
    group.add(backing, paper, thumb, badgeMesh);
    for (const mesh of [backing, paper, thumb, badgeMesh]) owned.push(mesh.geometry, mesh.material);
    const entity = this.world.createTransformEntity(group, { parent: this.rig });
    entity.addComponent(RayInteractable);

    const options: HandleOptions<void> = {
      rotate: false,
      scale: false,
      multitouch: false,
      projectRays: false,
      filter: () => !card.carried,
      apply: (state, target) => {
        target.position.copy(state.current.position);
        if (state.first) this.beginMove(card);
        if (card.dragged !== !state.last) {
          card.dragged = !state.last;
          if (state.last) card.released = true;
          this.paint(card);
        }
      },
    };
    const card: Card = {
      item,
      group,
      entity,
      backing,
      badge: { canvas: badgeCanvas, texture: badgeTexture, text: '' },
      handle: new HandleStore<void>(group, () => options),
      owned,
      hovers: new Set(),
      target: null,
      unregister: () => {},
      unbind: () => {},
      carried: false,
      dragged: false,
      grabLevel: 0,
      drop: null,
      released: false,
      home: [],
    };
    card.unbind = card.handle.bind(backing);
    const events = backing as unknown as {
      addEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
      removeEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
    };
    const enter = (e: { pointerId: number }) => {
      card.hovers.add(e.pointerId);
      this.paint(card);
    };
    const leave = (e: { pointerId: number }) => {
      card.hovers.delete(e.pointerId);
      this.paint(card);
    };
    events.addEventListener('pointerenter', enter);
    events.addEventListener('pointerleave', leave);
    const unbindHandle = card.unbind;
    card.unbind = () => {
      events.removeEventListener('pointerenter', enter);
      events.removeEventListener('pointerleave', leave);
      unbindHandle();
    };
    const bounds = localBounds(backing, new Box3());
    card.target = {
      reach: group,
      bounds,
      carry: group,
      available: () => card.handle.getState() == null && !card.released,
      highlight: (level) => {
        card.grabLevel = level;
        this.paint(card);
      },
      begin: () => {
        card.carried = true;
        this.beginMove(card);
        this.paint(card);
      },
      move: (world) => {
        const parent = group.parent;
        if (parent != null) group.position.copy(parent.worldToLocal(this.v.setFromMatrixPosition(world)));
      },
      end: () => {
        card.carried = false;
        card.released = true;
        this.paint(card);
      },
    };
    card.unregister = this.grab.add(card.target);
    this.cards.set(key(item), card);
    this.paint(card);
    return card;
  }

  private remove(card: Card): void {
    this.cancelMove(card);
    card.unregister();
    card.unbind();
    this.cards.delete(key(card.item));
    // Keep the page thumbnail alive: the strip and stock tab share it.
    card.entity.dispose({ disposeResources: false });
    for (const resource of card.owned) resource.dispose();
  }

  // ---------- moving and dropping ----------

  private beginMove(card: Card): void {
    card.home.length = 0;
    card.home.push(...this.transform(card.group));
  }

  private cancelMove(card: Card): void {
    card.handle.cancel();
    if (card.target != null) this.grab.drop(card.target);
    card.released = false;
    this.setDrop(card, null);
  }

  /** What letting go here would do. */
  private dropAt(card: Card): Drop {
    const project = this.project;
    if (project == null) return null;
    const world = card.group.getWorldPosition(this.v);
    if (card.item.kind === 'page') {
      const index = this.navigator.dropIndex(world);
      if (index != null) return { kind: 'insert', index };
    }
    const board = this.studio.board;
    const local = board.root.worldToLocal(this.local.copy(world));
    if (Math.abs(local.x) > WINDOW_W / 2 || Math.abs(local.y) > WINDOW_H / 2) return null;
    if (local.z > DROP_DEPTH.front || local.z < -DROP_DEPTH.behind) return null;
    board.toBoard(world, this.at);
    const slot = board.slotAt(this.at.x, this.at.y);
    const page = slot >= 0 ? board.slots[slot]!.page : null;
    if (card.item.kind === 'clip') return page != null ? { kind: 'paste', at: { x: this.at.x, y: this.at.y } } : null;
    // A page dropped on the board goes right after the page it was dropped on.
    const anchor = page?.id ?? project.currentPage;
    return { kind: 'insert', index: anchor != null ? project.order.indexOf(anchor) + 1 : project.order.length };
  }

  private land(card: Card): void {
    const drop = this.dropAt(card);
    this.setDrop(card, null);
    this.navigator.hideDrop();
    this.paint(card);
    const project = this.project;
    if (project == null) return;
    if (drop?.kind === 'insert' && card.item.kind === 'page') {
      ops.restorePage(this.studio, card.item.id, 'stock', drop.index);
      this.studio.toast(`ページをネームの${drop.index + 1}ページ目に戻しました`);
      return;
    }
    if (drop?.kind === 'paste' && card.item.kind === 'clip') {
      const canvas = project.clips.get(card.item.id);
      // The clip stays in the stock for reuse: its card goes back where it was.
      if (card.home.length === 7) {
        card.group.position.fromArray(card.home);
        card.group.quaternion.fromArray(card.home, 3);
      }
      if (canvas != null) this.studio.pasteOnPage(canvas, 'クリップの貼り付け', drop.at);
      return;
    }
    this.save(card);
  }

  private setDrop(card: Card, drop: Drop): void {
    card.drop = drop;
    const moving = card.carried || card.dragged;
    const page = card.item.kind === 'page';
    let text: string;
    if (drop?.kind === 'insert') text = `離すと${drop.index + 1}ページ目に戻す`;
    else if (drop?.kind === 'paste') text = '離すとここに貼る';
    else if (moving) text = page ? 'ボードかページ列で離すと戻す' : 'ページの上で離すと貼る';
    else text = page ? 'ストックのページ' : 'ストックの切り抜き';
    this.drawBadge(card, text);
    this.paint(card);
  }

  private drawBadge(card: Card, text: string): void {
    const badge = card.badge;
    if (badge.text === text) return;
    badge.text = text;
    const c = ctx2d(badge.canvas);
    const { width, height } = badge.canvas;
    c.clearRect(0, 0, width, height);
    c.fillStyle = '#e6e9ee';
    c.font = `600 ${Math.round(height * 0.62)}px "M PLUS 1p", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, width / 2, height / 2, width - 8);
    badge.texture.needsUpdate = true;
  }

  private paint(card: Card): void {
    if (card.badge.text === '') this.drawBadge(card, card.item.kind === 'page' ? 'ストックのページ' : 'ストックの切り抜き');
    const moving = card.carried || card.dragged;
    const color = moving && card.drop != null
      ? COLORS.drop
      : moving || card.grabLevel === 2
        ? COLORS.moving
        : card.hovers.size > 0 || card.grabLevel === 1
          ? COLORS.hover
          : COLORS.idle;
    card.backing.material.color.setHex(color);
  }

  // ---------- places ----------

  /** Hand slot `n` in the rig's space. */
  private slot(n: number, out: Vector3): Vector3 {
    const col = n % CARD.perRow;
    const row = Math.floor(n / CARD.perRow);
    const [x, y, z] = CARD.slot;
    return out.set(x + col * CARD.stepX, y + row * CARD.stepY, z - col * 0.03);
  }

  /** First hand slot no other card sits in (the last one when all are taken). */
  private freeSlot(self: Card): number {
    const last = CARD.perRow * 4 - 1;
    for (let n = 0; n < last; n++) {
      const at = this.slot(n, this.local);
      let taken = false;
      for (const card of this.cards.values()) {
        if (card !== self && card.group.position.distanceTo(at) < CARD.stepX / 2) taken = true;
      }
      if (!taken) return n;
    }
    return last;
  }

  /** Put `object` in hand slot `n` facing the viewer. */
  private toSlot(object: Object3D, n: number): void {
    this.slot(n, object.position);
    this.world.camera.getWorldPosition(this.head);
    faceToward(object, this.head, 1);
  }

  private transform(object: Object3D): number[] {
    return [...object.position.toArray(), ...object.quaternion.toArray()];
  }

  private save(card: Card): void {
    const project = this.project;
    if (project == null) return;
    project.stockPlaces[card.item.id] = this.transform(card.group);
    this.studio.markDirty();
  }
}
