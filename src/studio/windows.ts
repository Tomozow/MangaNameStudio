// Movable windows. Each window gets a grab bar under its bottom edge: point at the bar
// and hold the trigger (or pinch, or drag with the mouse) to move the window along the
// ray, or reach the bar and squeeze / pinch to carry it by hand. A window turns to
// face the viewer while it moves so it always stays readable. A grip off the
// bottom-right corner resizes it the same ways. Dropped next to a wrist (or, for the
// tool palette, in front of the waist) a window docks there instead (see docks.ts);
// windows sharing a wrist show one at a time with tabs above them.
import {
  Box3,
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PokeInteractable,
  Quaternion,
  RayInteractable,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Entity,
  type Object3D,
  type UIKitMLAsset,
  type World,
} from '@iwsdk/core';
import { HandleStore, type HandleOptions } from '@pmndrs/handle';
import { SIDES, type Side } from './doc.js';
import type { DirectGrab, GrabLevel, GrabTarget } from './direct-grab.js';
import { DOCK_TUNING, Docks } from './docks.js';
import { prefs, savePrefs, type Dock } from './prefs.js';
import { ctx2d, makeCanvas } from './project.js';

/** Bar placement and turn rate (meters, 1/s). */
const BAR = {
  /** Bar centre below the window's bottom edge, and in front of its face. */
  gap: 0.024,
  forward: 0.006,
  /** Turn-to-face rate while moving. */
  face: 12,
};
/** Resize grip: offset out from the corner (meters), and size limits relative to the authored size. */
const GRIP = { out: 0.014, min: 0.35, max: 3 };
/** Tabs over a wrist's window when several windows share the wrist (meters). */
const TAB = { w: 0.056, h: 0.017, gap: 0.006, above: 0.012, px: 330 };
const COLOR = { idle: 0xffffff, active: 0x4c8dff, dock: 0x3ecf8e };

const UP = new Vector3(0, 1, 0);
const faceM = new Matrix4();
const faceQ = new Quaternion();
const faceP = new Quaternion();
const faceV = new Vector3();
const faceE = new Vector3();

/** Turn `object` (front +Z) a step `k` (0..1) toward `head` (world), upright; `level` turns it about the vertical only. */
export function faceToward(object: Object3D, head: Vector3, k: number, level = false): void {
  const parent = object.parent;
  if (parent == null) return;
  object.updateWorldMatrix(true, false);
  faceV.setFromMatrixPosition(object.matrixWorld);
  faceM.lookAt(level ? faceE.set(head.x, faceV.y, head.z) : head, faceV, UP);
  parent.getWorldQuaternion(faceP).invert();
  object.quaternion.slerp(faceQ.setFromRotationMatrix(faceM).premultiply(faceP), k);
}

export interface WindowSpec {
  /** Key for the saved layout. */
  readonly id: string;
  /** The object that moves (a panel, or an anchor carrying a board, sheet or stage). */
  readonly object: Object3D;
  /** Entity of `object`'s parent; the bar is created there as its sibling. */
  readonly parent: Entity;
  /** The window in `object`'s own space: the bar hangs under its bottom-front edge, the grip off its bottom-right corner. */
  bounds(out: Box3): Box3;
  /** A corner grip resizes it. */
  readonly resize?: boolean;
  /** Turns only about the vertical while it moves (a stage rather than a sheet). */
  readonly level?: boolean;
  /** It can dock on a wrist (labelled `title` there), and on the belt when `belt` is set: their default scales. */
  readonly dock?: { readonly title: string; readonly wrist: number; readonly belt?: number };
}

interface Knob {
  /** Invisible slab that takes rays and hands, kept next to the window. */
  readonly hit: Mesh;
  /** What shows: the bar's pill or the grip's corner arc. */
  readonly look: Mesh;
  readonly store: HandleStore<void>;
  readonly target: GrabTarget;
  /** Pointers whose rays are over it. */
  readonly hovers: Set<number>;
  level: GrabLevel;
  /** Moved by a ray / carried by a hand, and from which side. */
  dragged: boolean;
  carried: boolean;
  side: Side | null;
}

interface Tab {
  readonly mesh: Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  /** Drawn as the shown tab (null: not drawn yet). */
  drawn: boolean | null;
}

interface Item {
  readonly spec: WindowSpec;
  /** `spec.bounds`, refreshed every frame. */
  readonly bounds: Box3;
  bar: Knob;
  grip: Knob | null;
  tab: Tab | null;
  /** The knob in use: one at a time. */
  busy: Knob | null;
  /** Pose in space: [x, y, z, qx, qy, qz, qw, scale] in the parent's space. */
  space: number[];
  /** Authored pose, for a layout reset. */
  readonly home: readonly number[];
  dock: Dock | null;
  /** The dock it is placed on now; null outside XR, where docked windows keep their space pose. */
  riding: Dock | null;
  /** Snapped into its dock since it appeared there (then it follows smoothly). */
  settled: boolean;
  /** Where releasing the bar now would dock it. */
  hint: Dock | null;
  /** Where the moving bar has to be (parent space). */
  readonly goal: Vector3;
  /** Grip drag start: scale, the corner that stays put (parent space) and the diagonal to the grip. */
  readonly resize: { s0: number; readonly corner: Vector3; readonly fixed: Vector3; readonly diag: Vector3 };
}

const pose = (o: Object3D): number[] => [...o.position.toArray(), ...o.quaternion.toArray(), o.scale.x];

function apply(o: Object3D, t: readonly number[]): void {
  o.position.fromArray(t);
  o.quaternion.fromArray(t, 3);
  o.scale.setScalar(t[7]!);
}

const isWrist = (dock: Dock | null): dock is Side => dock === 'left' || dock === 'right';

/** A centred rectangle `2 * halfW` by `2 * halfH`. */
export function rectBounds(out: Box3, halfW: number, halfH: number): Box3 {
  out.min.set(-halfW, -halfH, 0);
  out.max.set(halfW, halfH, 0);
  return out;
}

const boundsV = new Vector3();
const boundsM = new Matrix4();

/** A UIKitML panel (root element `rootId`) in the panel's own space. */
export function panelBounds(panel: UIKitMLAsset, rootId: string, out: Box3): Box3 {
  const root = panel.getElementById(rootId) as unknown as (Object3D & { size: { peek(): unknown } }) | null;
  if (root == null || root.size.peek() == null) return rectBounds(out, 0.1, 0.1);
  // The root element is its own background quad: a unit square scaled to the laid-out size.
  root.updateWorldMatrix(true, false);
  boundsM.copy(panel.matrixWorld).invert().multiply(root.matrixWorld);
  out.makeEmpty();
  out.expandByPoint(boundsV.set(-0.5, -0.5, 0).applyMatrix4(boundsM));
  return out.expandByPoint(boundsV.set(0.5, 0.5, 0).applyMatrix4(boundsM));
}

export class Windows {
  readonly docks: Docks;
  /** Tabs, for the pens to press. */
  readonly pressables: Object3D[] = [];
  private readonly items: Item[] = [];
  /** The window each wrist shows. */
  private readonly shown: Record<Side, Item | null> = { left: null, right: null };
  private readonly pillGeometry = new CapsuleGeometry(0.0055, 0.07, 4, 12).rotateZ(Math.PI / 2).scale(1, 1, 0.5);
  private readonly barHit = new BoxGeometry(0.12, 0.04, 0.02);
  /** A quarter ring round the corner, its centre on the corner. */
  private readonly arcGeometry = new RingGeometry(0.011, 0.017, 10, 1, -Math.PI / 2, Math.PI / 2);
  private readonly gripHit = new BoxGeometry(0.03, 0.03, 0.02);
  private readonly tabGeometry = new PlaneGeometry(TAB.w, TAB.h);
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly p = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();

  constructor(
    private readonly world: World,
    private readonly grab: DirectGrab,
    private readonly sideOf: (pointerId: number) => Side | undefined,
    private readonly cleanup: Array<() => void>,
  ) {
    this.docks = new Docks(world);
  }

  add(spec: WindowSpec): void {
    const object = spec.object;
    const home = pose(object);
    const saved = prefs.windows[spec.id];
    let dock = spec.dock != null ? (prefs.docks[spec.id] ?? null) : null;
    if (dock === 'belt' && spec.dock?.belt == null) dock = null;
    const item: Item = {
      spec,
      bounds: new Box3(),
      bar: null as unknown as Knob,
      grip: null,
      tab: null,
      busy: null,
      space: saved == null ? home.slice() : saved.length === 8 ? saved.slice() : [...saved, home[7]!],
      home,
      dock,
      riding: null,
      settled: false,
      hint: null,
      goal: new Vector3(),
      resize: { s0: 1, corner: new Vector3(), fixed: new Vector3(), diag: new Vector3() },
    };
    apply(object, item.space);
    item.bar = this.knob(item, 'WindowBar', this.barHit, new Mesh(this.pillGeometry, look()), (p) => this.shift(item, p), () => this.drop(item));
    if (spec.resize === true) {
      const arc = new Mesh(this.arcGeometry, look());
      arc.position.set(-GRIP.out, GRIP.out, 0);
      item.grip = this.knob(item, 'WindowGrip', this.gripHit, arc, (p) => this.resizeTo(item, p), () => this.resized(item));
    }
    if (spec.dock != null) item.tab = this.tab(item);
    this.items.push(item);
    this.place(item);
  }

  /** Put every window back where the scene authored it and forget the saved layout. */
  resetLayout(): void {
    for (const item of this.items) {
      for (const knob of [item.bar, item.grip]) {
        if (knob == null) continue;
        knob.store.cancel();
        this.grab.drop(knob.target);
      }
      item.dock = null;
      item.riding = null;
      item.space = item.home.slice();
      apply(item.spec.object, item.space);
      item.spec.object.visible = true;
      this.place(item);
    }
    prefs.windows = {};
    prefs.docks = {};
    prefs.dockScales = {};
    prefs.belt = null;
    savePrefs();
  }

  /** Put window `id` on the belt, or back where it was in space; returns whether it is on the belt now. */
  toggleBelt(id: string): boolean {
    const item = this.items.find((i) => i.spec.id === id);
    if (item?.spec.dock?.belt == null) return false;
    this.setDock(item, item.dock === 'belt' ? null : 'belt');
    savePrefs();
    return item.dock === 'belt';
  }

  belted(id: string): boolean {
    return this.items.find((i) => i.spec.id === id)?.dock === 'belt';
  }

  /** Move dragged windows, ride docked ones on their wrist or the belt, and keep bars next to their windows. */
  update(delta: number): void {
    this.docks.update(delta);
    const now = performance.now();
    const face = 1 - Math.exp(-delta * BAR.face);
    const follow = 1 - Math.exp(-delta * DOCK_TUNING.follow);
    this.pickShown();
    for (const item of this.items) {
      item.bar.store.update(now);
      item.grip?.store.update(now);
      const want = this.docks.immersive ? item.dock : null;
      if (want !== item.riding && item.busy == null) this.switchRide(item, want);
      if (item.busy === item.bar) {
        faceToward(item.spec.object, this.docks.head, face, item.spec.level);
        // Turning pivots about the window's origin: put the bar back under the hand.
        this.shift(item, item.goal);
        const hint = this.dropDock(item);
        if (hint !== item.hint) {
          item.hint = hint;
          this.paint(item.bar, hint != null);
        }
      } else if (item.riding != null) {
        this.ride(item, follow);
      }
      this.place(item);
    }
    this.placeTabs();
  }

  /** Dev diagnostics: each window's dock, size and where its centre, bar and grip are (world). */
  debugState(): Record<string, unknown> {
    const r = (v: Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000);
    const wrist = (side: Side) => {
      const w = this.docks.wrists[side];
      return { tracked: w.tracked, shown: w.shown, at: r(w.at), base: r(w.base), tab: this.shown[side]?.spec.id ?? null };
    };
    return {
      immersive: this.docks.immersive,
      left: wrist('left'),
      right: wrist('right'),
      belt: r(this.docks.beltPoint(new Vector3())),
      windows: this.items.map((item) => ({
        id: item.spec.id,
        dock: item.dock,
        riding: item.riding,
        hint: item.hint,
        busy: item.busy === item.bar ? 'bar' : item.busy != null ? 'grip' : null,
        side: item.bar.side,
        visible: item.spec.object.visible,
        scale: Math.round(item.spec.object.scale.x * 1000) / 1000,
        center: r(this.center(item, new Vector3())),
        bar: r(item.bar.hit.getWorldPosition(new Vector3())),
        grip: item.grip != null ? r(item.grip.hit.getWorldPosition(new Vector3())) : null,
        tab: item.tab?.mesh.visible === true ? r(item.tab.mesh.getWorldPosition(new Vector3())) : null,
      })),
    };
  }

  // ---------- knobs ----------

  private knob(item: Item, name: string, hitGeometry: BufferGeometry, look: Mesh, move: (p: Vector3) => void, end: () => void): Knob {
    look.name = `${name}Look`;
    look.raycast = () => undefined;
    // The visible part is slim; a larger invisible slab takes the rays and hands.
    const hit = new Mesh(hitGeometry, new MeshBasicMaterial({ visible: false }));
    hit.name = `${name} ${item.spec.object.name}`;
    hit.add(look);
    const entity = this.world.createTransformEntity(hit, { parent: item.spec.parent });
    entity.addComponent(RayInteractable);
    hitGeometry.computeBoundingBox();
    // One options object: the store reads them every frame of a drag.
    const options: HandleOptions<void> = {
      rotate: false,
      scale: false,
      multitouch: false,
      projectRays: false,
      // One knob of a window at a time, and a knob a hand carries ignores rays.
      filter: () => !knob.carried && (item.busy == null || item.busy === knob),
      apply: (state) => {
        if (!knob.dragged) {
          if (state.last) return;
          knob.dragged = true;
          this.begin(item, knob);
        }
        move(state.current.position);
        if (state.last) {
          knob.dragged = false;
          this.finish(item, knob, end);
        }
      },
    };
    const target: GrabTarget = {
      reach: hit,
      bounds: hitGeometry.boundingBox!.clone(),
      // The hand carries the knob: the window turning to face the viewer pivots about it.
      carry: hit,
      available: () => hit.visible && item.busy == null,
      highlight: (level) => {
        knob.level = level;
        this.paint(knob, knob === item.bar && item.hint != null);
      },
      begin: (side) => {
        knob.carried = true;
        knob.side = side;
        this.begin(item, knob);
      },
      move: (world) => {
        const parent = hit.parent;
        if (parent != null) move(parent.worldToLocal(this.p.setFromMatrixPosition(world)));
      },
      end: () => {
        knob.carried = false;
        this.finish(item, knob, end);
      },
    };
    const knob: Knob = {
      hit,
      look,
      store: new HandleStore<void>(hit, () => options),
      target,
      hovers: new Set<number>(),
      level: 0,
      dragged: false,
      carried: false,
      side: null,
    };
    const events = hit as unknown as {
      addEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
      removeEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
    };
    // Before the store's own listener: a drag must know its side when it begins.
    const down = (e: { pointerId: number }) => {
      if (!knob.carried) knob.side = this.sideOf(e.pointerId) ?? null;
    };
    const enter = (e: { pointerId: number }) => {
      knob.hovers.add(e.pointerId);
      this.paint(knob, knob === item.bar && item.hint != null);
    };
    const leave = (e: { pointerId: number }) => {
      knob.hovers.delete(e.pointerId);
      this.paint(knob, knob === item.bar && item.hint != null);
    };
    events.addEventListener('pointerdown', down);
    events.addEventListener('pointerenter', enter);
    events.addEventListener('pointerleave', leave);
    const unbind = knob.store.bind(hit);
    const unregister = this.grab.add(target);
    this.cleanup.push(() => {
      events.removeEventListener('pointerdown', down);
      events.removeEventListener('pointerenter', enter);
      events.removeEventListener('pointerleave', leave);
      unbind();
      unregister();
      entity.dispose();
    });
    return knob;
  }

  private begin(item: Item, knob: Knob): void {
    item.busy = knob;
    // A hand takes the bar a frame before it first moves it: hold it where it is.
    if (knob === item.bar) this.barPoint(item, item.goal);
    if (knob === item.grip) {
      const o = item.spec.object;
      const b = item.bounds;
      const r = item.resize;
      o.updateMatrix();
      r.s0 = o.scale.x;
      // The opposite corner stays put: top-left (back-left on a stage).
      r.corner.set(b.min.x, b.max.y, b.min.z);
      r.fixed.copy(r.corner).applyMatrix4(o.matrix);
      r.diag.subVectors(knob.hit.position, r.fixed);
    }
    this.paint(knob, false);
  }

  private finish(item: Item, knob: Knob, end: () => void): void {
    item.busy = null;
    end();
    this.paint(knob, false);
  }

  private paint(knob: Knob, dock: boolean): void {
    const material = knob.look.material as MeshBasicMaterial;
    const active = knob.dragged || knob.carried || knob.level === 2;
    const hover = knob.hovers.size > 0 || knob.level === 1;
    material.color.setHex(dock ? COLOR.dock : active ? COLOR.active : COLOR.idle);
    material.opacity = active || hover || dock ? 0.95 : 0.5;
    knob.look.scale.setScalar(active || hover ? 1.15 : 1);
  }

  /** The bar moved to `p` (parent space): bar and window share a parent, so shift the window as far. */
  private shift(item: Item, p: Vector3): void {
    item.goal.copy(p);
    item.spec.object.position.add(this.v.copy(item.goal).sub(this.barPoint(item, this.v2)));
  }

  /** Where the bar belongs under the window (parent space). */
  private barPoint(item: Item, out: Vector3): Vector3 {
    const o = item.spec.object;
    const b = item.bounds;
    o.updateMatrix();
    out.set((b.min.x + b.max.x) / 2, b.min.y, b.max.z).applyMatrix4(o.matrix);
    return out.add(this.v3.set(0, -BAR.gap, BAR.forward).applyQuaternion(o.quaternion));
  }

  /** The grip moved to `p` (parent space): scale about the opposite corner by how far along the diagonal it went. */
  private resizeTo(item: Item, p: Vector3): void {
    const r = item.resize;
    const along = this.v.subVectors(p, r.fixed).dot(r.diag) / Math.max(1e-6, r.diag.lengthSq());
    const home = item.home[7]!;
    this.rescale(item, Math.min(home * GRIP.max, Math.max(home * GRIP.min, r.s0 * along)), r.corner);
  }

  private resized(item: Item): void {
    const { object, id } = item.spec;
    if (item.riding != null) prefs.dockScales[`${id}@${item.riding === 'belt' ? 'belt' : 'wrist'}`] = object.scale.x;
    else this.saveSpace(item);
    savePrefs();
  }

  /** Scale the window to `s`, keeping its own point `local` where it is. */
  private rescale(item: Item, s: number, local: Vector3): void {
    const o = item.spec.object;
    o.updateMatrix();
    const before = this.v2.copy(local).applyMatrix4(o.matrix);
    o.scale.setScalar(s);
    o.updateMatrix();
    o.position.add(before.sub(this.v3.copy(local).applyMatrix4(o.matrix)));
  }

  // ---------- docks ----------

  /** The bar was let go: dock the window where it was dropped, or leave it in space. */
  private drop(item: Item): void {
    const dock = this.dropDock(item);
    item.hint = null;
    if (dock == null && item.riding != null) {
      // Off a dock: back to its size in space, the bar staying where it was dropped.
      const b = item.bounds;
      this.rescale(item, item.space[7]!, this.v.set((b.min.x + b.max.x) / 2, b.min.y, b.max.z));
      item.riding = null;
    }
    if (dock == null) this.saveSpace(item);
    // Moved along the belt: it stays where it was put.
    if (dock === 'belt' && item.dock === 'belt') prefs.belt = this.docks.toBody(this.center(item, this.v));
    this.setDock(item, dock);
    savePrefs();
  }

  private setDock(item: Item, dock: Dock | null): void {
    const id = item.spec.id;
    item.dock = dock;
    if (dock == null) delete prefs.docks[id];
    else prefs.docks[id] = dock;
    if (isWrist(dock)) this.shown[dock] = item;
  }

  private saveSpace(item: Item): void {
    item.space = pose(item.spec.object);
    prefs.windows[item.spec.id] = item.space;
  }

  /** Where the window would dock if its bar were let go now. */
  private dropDock(item: Item): Dock | null {
    const dock = item.spec.dock;
    if (dock == null || !this.docks.immersive) return null;
    const bar = item.bar.hit.getWorldPosition(this.v);
    for (const side of SIDES) {
      // Never onto the wrist of the hand that is moving it.
      const wrist = this.docks.wrists[side];
      if (side === item.bar.side || !wrist.tracked) continue;
      if (Math.min(bar.distanceTo(wrist.at), bar.distanceTo(wrist.base)) < DOCK_TUNING.wristSnap) return side;
    }
    if (dock.belt != null) {
      // The hand brings the bar to the waist; a belt window nudged in place keeps its centre there.
      const belt = this.docks.beltPoint(this.v3);
      if (Math.min(bar.distanceTo(belt), this.center(item, this.v2).distanceTo(belt)) < DOCK_TUNING.beltSnap) return 'belt';
    }
    return null;
  }

  /** The window's face centre (world). */
  private center(item: Item, out: Vector3): Vector3 {
    const b = item.bounds;
    item.spec.object.updateWorldMatrix(true, false);
    return out.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).applyMatrix4(item.spec.object.matrixWorld);
  }

  private switchRide(item: Item, want: Dock | null): void {
    const o = item.spec.object;
    if (want == null) {
      apply(o, item.space);
      o.visible = true;
    } else {
      const sizes = item.spec.dock!;
      const fallback = want === 'belt' ? sizes.belt : sizes.wrist;
      o.scale.setScalar(prefs.dockScales[`${item.spec.id}@${want === 'belt' ? 'belt' : 'wrist'}`] ?? fallback ?? item.space[7]!);
    }
    item.riding = want;
    item.settled = false;
  }

  /** Each wrist shows the window last docked or picked by tab, while it is still there. */
  private pickShown(): void {
    for (const side of SIDES) {
      if (this.shown[side]?.dock === side) continue;
      this.shown[side] = null;
      for (const item of this.items) {
        if (item.dock === side) {
          this.shown[side] = item;
          break;
        }
      }
    }
  }

  /** Place a docked window facing the head: standing on its wrist, or centred on the belt point. */
  private ride(item: Item, follow: number): void {
    const o = item.spec.object;
    const dock = item.riding!;
    const shown = dock === 'belt' || (this.docks.wrists[dock].shown && this.shown[dock] === item);
    o.visible = shown;
    const parent = o.parent;
    if (!shown || parent == null) {
      item.settled = false;
      return;
    }
    const b = item.bounds;
    const s = o.scale.x;
    const at = dock === 'belt' ? this.docks.beltPoint(this.v) : this.v.copy(this.docks.wrists[dock].base);
    // Panels face +Z: build a frame whose +Z points from the window to the head, upright.
    this.m.lookAt(this.docks.head, at, UP);
    this.q.setFromRotationMatrix(this.m);
    if (dock !== 'belt') at.addScaledVector(this.v2.set(0, 1, 0).applyQuaternion(this.q), ((b.max.y - b.min.y) / 2) * s);
    // From the face centre to the window's origin.
    at.sub(this.v2.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).multiplyScalar(s).applyQuaternion(this.q));
    parent.worldToLocal(at);
    this.q.premultiply(parent.getWorldQuaternion(this.q2).invert());
    // Snap into place when it appears, then follow smoothly so it does not jitter with the hand.
    const k = item.settled ? follow : 1;
    item.settled = true;
    o.position.lerp(at, k);
    o.quaternion.slerp(this.q, k);
  }

  // ---------- tabs ----------

  private tab(item: Item): Tab {
    const canvas = makeCanvas(TAB.px, Math.round((TAB.px * TAB.h) / TAB.w));
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(this.tabGeometry, new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.name = `WindowTab ${item.spec.id}`;
    mesh.visible = false;
    const entity = this.world.createTransformEntity(mesh, { parent: item.spec.parent });
    entity.addComponent(RayInteractable);
    entity.addComponent(PokeInteractable);
    const events = mesh as unknown as {
      addEventListener(type: string, fn: () => void): void;
      removeEventListener(type: string, fn: () => void): void;
    };
    // On press, not click: a pen resting on the tab longer than a click still switches.
    const press = () => {
      if (isWrist(item.dock)) this.shown[item.dock] = item;
    };
    events.addEventListener('pointerdown', press);
    this.cleanup.push(() => {
      events.removeEventListener('pointerdown', press);
      entity.dispose();
      texture.dispose();
    });
    this.pressables.push(mesh);
    return { mesh, canvas, texture, drawn: null };
  }

  /** A row of tabs over a wrist's shown window, while two or more windows share the wrist. */
  private placeTabs(): void {
    for (const item of this.items) if (item.tab != null && !isWrist(item.riding)) item.tab.mesh.visible = false;
    for (const side of SIDES) {
      let n = 0;
      for (const item of this.items) if (item.tab != null && item.riding === side) n++;
      const host = this.shown[side];
      const show = n >= 2 && host != null && host.riding === side && host.spec.object.visible;
      let i = 0;
      for (const item of this.items) {
        const tab = item.tab;
        if (tab == null || item.riding !== side) continue;
        tab.mesh.visible = show;
        if (!show) continue;
        this.drawTab(item, tab, item === host);
        const o = host.spec.object;
        const b = host.bounds;
        o.updateMatrix();
        tab.mesh.position.set((b.min.x + b.max.x) / 2, b.max.y, b.max.z).applyMatrix4(o.matrix);
        tab.mesh.quaternion.copy(o.quaternion);
        tab.mesh.position.add(this.v.set((i - (n - 1) / 2) * (TAB.w + TAB.gap), TAB.above + TAB.h / 2, BAR.forward).applyQuaternion(o.quaternion));
        i++;
      }
    }
  }

  private drawTab(item: Item, tab: Tab, shown: boolean): void {
    if (tab.drawn === shown) return;
    tab.drawn = shown;
    const { width: w, height: h } = tab.canvas;
    const c = ctx2d(tab.canvas);
    c.clearRect(0, 0, w, h);
    c.fillStyle = shown ? '#4c8dff' : 'rgba(34,38,44,0.92)';
    c.beginPath();
    c.roundRect(2, 2, w - 4, h - 4, h / 2 - 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = '600 46px "M PLUS 1p", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(item.spec.dock!.title, w / 2, h / 2 + 2);
    tab.texture.needsUpdate = true;
  }

  // ---------- layout ----------

  /** Keep the bar under the window and the grip off its bottom-right corner. */
  private place(item: Item): void {
    const o = item.spec.object;
    item.spec.bounds(item.bounds);
    const visible = o.visible;
    item.bar.hit.visible = visible;
    if (item.grip != null) item.grip.hit.visible = visible;
    if (!visible) return;
    const b = item.bounds;
    this.barPoint(item, item.bar.hit.position);
    item.bar.hit.quaternion.copy(o.quaternion);
    const grip = item.grip?.hit;
    if (grip == null) return;
    grip.position.set(b.max.x, b.min.y, b.max.z).applyMatrix4(o.matrix);
    grip.quaternion.copy(o.quaternion);
    grip.position.add(this.v.set(GRIP.out, -GRIP.out, BAR.forward).applyQuaternion(o.quaternion));
  }
}

function look(): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: COLOR.idle, transparent: true, opacity: 0.5, depthWrite: false });
}
