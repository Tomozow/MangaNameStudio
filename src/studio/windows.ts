// Movable windows. Each window gets a grab bar under its bottom edge: point at the bar
// and hold the trigger (or pinch, or drag with the mouse) to move the window along the
// ray, or reach the bar and squeeze / pinch to carry it by hand. A window turns to
// face the viewer while it moves so it always stays readable.
import {
  Box3,
  BoxGeometry,
  CapsuleGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RayInteractable,
  Vector3,
  type Entity,
  type Object3D,
  type UIKitMLAsset,
  type World,
} from '@iwsdk/core';
import { HandleStore, type HandleOptions } from '@pmndrs/handle';
import type { DirectGrab, GrabLevel } from './direct-grab.js';

/** Bar placement and turn rate (meters, 1/s). */
const BAR = {
  /** Bar centre below the window's bottom edge, and in front of its face. */
  gap: 0.024,
  forward: 0.006,
  /** Turn-to-face rate while moving. */
  face: 12,
};

const UP = new Vector3(0, 1, 0);

export interface WindowSpec {
  /** The object that moves (a panel, or an anchor carrying a board or sheet). */
  readonly object: Object3D;
  /** Entity of `object`'s parent; the bar is created there as its sibling. */
  readonly parent: Entity;
  /** Bottom-centre of the window in the parent's space. */
  bottomCenter(out: Vector3): Vector3;
}

interface Item {
  readonly spec: WindowSpec;
  readonly bar: Mesh;
  readonly pill: Mesh;
  readonly handle: HandleStore<void>;
  /** Pointers whose rays are over the bar. */
  readonly hovers: Set<number>;
  /** Carried by a hand (DirectGrab) or dragged by a ray. */
  carried: boolean;
  dragged: boolean;
  grabLevel: GrabLevel;
}

/** Bottom-centre of a UIKitML panel (root element `rootId`) in the panel parent's space. */
export function panelBottom(panel: UIKitMLAsset, rootId: string, out: Vector3): Vector3 {
  const root = panel.getElementById(rootId) as unknown as (Object3D & { size: { peek(): unknown } }) | null;
  if (root == null || root.size.peek() == null || panel.parent == null) return out.copy(panel.position);
  // The root element is its own background quad: a unit square scaled to the laid-out size.
  root.updateWorldMatrix(true, false);
  return panel.parent.worldToLocal(root.localToWorld(out.set(0, -0.5, 0)));
}

export class Windows {
  private readonly items: Item[] = [];
  private readonly pillGeometry = new CapsuleGeometry(0.0055, 0.07, 4, 12).rotateZ(Math.PI / 2).scale(1, 1, 0.5);
  private readonly hitGeometry = new BoxGeometry(0.15, 0.04, 0.02);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly pq = new Quaternion();
  private readonly v = new Vector3();
  private readonly head = new Vector3();

  constructor(
    private readonly world: World,
    private readonly grab: DirectGrab,
    private readonly cleanup: Array<() => void>,
  ) {}

  add(spec: WindowSpec): void {
    const pill = new Mesh(this.pillGeometry, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    pill.name = 'WindowBarPill';
    pill.raycast = () => undefined;
    // The visible pill is slim; a larger invisible slab takes the rays and hands.
    const bar = new Mesh(this.hitGeometry, new MeshBasicMaterial({ visible: false }));
    bar.name = `WindowBar ${spec.object.name}`;
    bar.add(pill);
    const entity = this.world.createTransformEntity(bar, { parent: spec.parent });
    entity.addComponent(RayInteractable);
    // One options object: the store reads them every frame of a drag.
    const options: HandleOptions<void> = {
      rotate: false,
      scale: false,
      multitouch: false,
      projectRays: false,
      // A window a hand is carrying ignores rays.
      filter: () => !item.carried,
      apply: (state, target) => {
        target.position.copy(state.current.position);
        if (item.dragged !== !state.last) {
          item.dragged = !state.last;
          this.paint(item);
        }
      },
    };
    const item: Item = {
      spec,
      bar,
      pill,
      hovers: new Set(),
      carried: false,
      dragged: false,
      grabLevel: 0,
      handle: new HandleStore<void>(spec.object, () => options),
    };
    const target = bar as unknown as {
      addEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
      removeEventListener(type: string, fn: (e: { pointerId: number }) => void): void;
    };
    const enter = (e: { pointerId: number }) => {
      item.hovers.add(e.pointerId);
      this.paint(item);
    };
    const leave = (e: { pointerId: number }) => {
      item.hovers.delete(e.pointerId);
      this.paint(item);
    };
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    const unbind = item.handle.bind(bar);
    const bounds = new Box3();
    this.hitGeometry.computeBoundingBox();
    bounds.copy(this.hitGeometry.boundingBox!);
    const unregister = this.grab.add({
      reach: bar,
      bounds,
      // The hand carries the bar: the window turning to face the viewer pivots about it.
      carry: bar,
      available: () => bar.visible && item.handle.getState() == null,
      highlight: (level) => {
        item.grabLevel = level;
        this.paint(item);
      },
      begin: () => {
        item.carried = true;
      },
      move: (world) => {
        const parent = bar.parent;
        if (parent == null) return;
        // Bar and window share a parent: shift the window by how far its bar must go.
        spec.object.position.add(parent.worldToLocal(this.v.setFromMatrixPosition(world)).sub(bar.position));
      },
      end: () => {
        item.carried = false;
      },
    });
    this.cleanup.push(() => {
      target.removeEventListener('pointerenter', enter);
      target.removeEventListener('pointerleave', leave);
      unbind();
      unregister();
      entity.dispose();
    });
    this.items.push(item);
    this.place(item);
  }

  /** Move dragged windows, turn moving ones toward the viewer and keep bars under their windows. */
  update(delta: number): void {
    const now = performance.now();
    const k = 1 - Math.exp(-delta * BAR.face);
    this.world.camera.getWorldPosition(this.head);
    for (const item of this.items) {
      item.handle.update(now);
      if (item.carried || item.dragged) this.face(item.spec.object, k);
      this.place(item);
    }
  }

  /** Turn `object` (front +Z) toward the viewer's head, upright. */
  private face(object: Object3D, k: number): void {
    const parent = object.parent;
    if (parent == null) return;
    object.updateWorldMatrix(true, false);
    this.v.setFromMatrixPosition(object.matrixWorld);
    this.m.lookAt(this.head, this.v, UP);
    parent.getWorldQuaternion(this.pq).invert();
    this.q.setFromRotationMatrix(this.m).premultiply(this.pq);
    object.quaternion.slerp(this.q, k);
  }

  private place(item: Item): void {
    const { object } = item.spec;
    const bar = item.bar;
    bar.visible = object.visible;
    if (!bar.visible) return;
    item.spec.bottomCenter(bar.position);
    bar.quaternion.copy(object.quaternion);
    bar.position.add(this.v.set(0, -BAR.gap, BAR.forward).applyQuaternion(object.quaternion));
  }

  private paint(item: Item): void {
    const material = item.pill.material as MeshBasicMaterial;
    const active = item.dragged || item.grabLevel === 2;
    const hover = item.hovers.size > 0 || item.grabLevel === 1;
    material.color.setHex(active ? 0x4c8dff : 0xffffff);
    material.opacity = active || hover ? 0.95 : 0.5;
    item.pill.scale.setScalar(active || hover ? 1.15 : 1);
  }
}
