// Direct (near) grabbing with either hand: squeeze a controller or close thumb and
// index next to a target to pick it up, and it follows the hand until released.
// Anything registered as a GrabTarget can be carried: diorama pieces, the director
// camera and the window grab bars.
import { Box3, InputComponent, Matrix4, Quaternion, Vector3, type Object3D, type World } from '@iwsdk/core';
import { SIDES, type Side } from './doc.js';
import type { PenRig } from './pens.js';

/** Reach knobs (meters): how close the hand must be to a target's surface to take it. */
export const GRAB_TUNING = {
  handReach: 0.035,
  controllerReach: 0.06,
};

/** 0: idle, 1: a hand is close enough to take it, 2: held. */
export type GrabLevel = 0 | 1 | 2;

export interface GrabTarget {
  /** Measured for reach, with `bounds` in its own space. */
  readonly reach: Object3D;
  readonly bounds: Box3;
  /** Carried by the hand: `move` receives its new world transform each frame. */
  readonly carry: Object3D;
  /** False while it cannot be taken (hidden, held by a ray, ...). */
  available(): boolean;
  highlight(level: GrabLevel): void;
  begin(side: Side): void;
  move(world: Matrix4): void;
  end(): void;
}

interface Hold {
  target: GrabTarget | null;
  /** Hand frame to carried object, fixed when the grab starts. */
  readonly offset: Matrix4;
}

/** Bounds of `object`'s meshes in its own space (sprites and lines are ignored). */
export function localBounds(object: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  object.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(object.matrixWorld).invert();
  const m = new Matrix4();
  const box = new Box3();
  object.traverse((o) => {
    const mesh = o as Object3D & { isMesh?: boolean; geometry?: { boundingBox: Box3 | null; computeBoundingBox(): void } };
    if (mesh.isMesh !== true || mesh.geometry == null) return;
    if (mesh.geometry.boundingBox == null) mesh.geometry.computeBoundingBox();
    out.union(box.copy(mesh.geometry.boundingBox!).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
  });
  return out;
}

export class DirectGrab {
  private readonly targets = new Set<GrabTarget>();
  private readonly holds: Record<Side, Hold> = {
    left: { target: null, offset: new Matrix4() },
    right: { target: null, offset: new Matrix4() },
  };
  private readonly near: Record<Side, GrabTarget | null> = { left: null, right: null };
  private readonly closed: Record<Side, boolean> = { left: false, right: false };
  private readonly frames: Record<Side, Matrix4> = { left: new Matrix4(), right: new Matrix4() };
  private lit: GrabTarget[] = [];
  private want: GrabTarget[] = [];
  private readonly levels = new Map<GrabTarget, GrabLevel>();
  private readonly inv = new Matrix4();
  private readonly carried = new Matrix4();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor(
    private readonly world: World,
    private readonly pens: PenRig,
  ) {}

  /** Register a target; the returned function unregisters it (dropping it if held). */
  add(target: GrabTarget): () => void {
    this.targets.add(target);
    return () => {
      for (const side of SIDES) if (this.holds[side].target === target) this.release(side);
      this.targets.delete(target);
      if ((this.levels.get(target) ?? 0) > 0) target.highlight(0);
      this.levels.delete(target);
      const at = this.lit.indexOf(target);
      if (at >= 0) this.lit.splice(at, 1);
    };
  }

  holding(side: Side): boolean {
    return this.holds[side].target != null;
  }

  get active(): boolean {
    return this.holds.left.target != null || this.holds.right.target != null;
  }

  /** Dev diagnostics: each target's carried object, world-space reach centre and holder. */
  debugTargets(): Array<{ name: string; at: number[]; held: Side | null }> {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return [...this.targets].map((t) => {
      t.reach.updateWorldMatrix(true, false);
      const c = t.bounds.getCenter(new Vector3()).applyMatrix4(t.reach.matrixWorld);
      const held = SIDES.find((side) => this.holds[side].target === t) ?? null;
      return { name: t.carry.name, at: [round(c.x), round(c.y), round(c.z)], held };
    });
  }

  /** Run after the pens are tracked (hands use the pen rig's pinch). */
  update(): void {
    for (const side of SIDES) {
      const frame = this.frames[side];
      const tracked = this.handFrame(side, frame);
      const closed = tracked && this.isClosed(side);
      const hold = this.holds[side];
      if (hold.target != null) {
        if (!closed || !this.targets.has(hold.target)) {
          this.release(side);
        } else {
          hold.target.move(this.carried.multiplyMatrices(frame, hold.offset));
        }
      }
      this.near[side] = hold.target == null && tracked ? this.nearest(side, frame) : null;
      // Only a fresh squeeze or pinch takes: a hand already closed (holding the pen) passes by.
      const candidate = this.near[side];
      if (closed && !this.closed[side] && candidate != null) this.take(side, candidate, frame);
      this.closed[side] = closed;
    }
    this.refreshHighlights();
  }

  /** The hand's grab frame: controller grip, or the pinch point turned like the wrist. */
  private handFrame(side: Side, out: Matrix4): boolean {
    const xr = this.world.input.xr;
    const grip = this.world.player.gripSpaces[side];
    if (grip == null) return false;
    if (xr.isPrimary('hand', side)) {
      const pen = this.pens.pens[side];
      if (pen.source !== 'hand') return false;
      grip.updateWorldMatrix(true, false);
      grip.matrixWorld.decompose(this.p, this.q, this.s);
      out.compose(pen.pinch, this.q, this.s.set(1, 1, 1));
      return true;
    }
    if (!xr.isPrimary('controller', side)) return false;
    grip.updateWorldMatrix(true, false);
    out.copy(grip.matrixWorld);
    return true;
  }

  private isClosed(side: Side): boolean {
    if (this.world.input.xr.isPrimary('hand', side)) return this.pens.pens[side].held;
    return this.world.input.xr.gamepads[side]?.getButtonPressed(InputComponent.Squeeze) ?? false;
  }

  private nearest(side: Side, frame: Matrix4): GrabTarget | null {
    const reach = this.world.input.xr.isPrimary('hand', side) ? GRAB_TUNING.handReach : GRAB_TUNING.controllerReach;
    let best: GrabTarget | null = null;
    let bestDistance = reach;
    for (const target of this.targets) {
      if (!target.available()) continue;
      const object = target.reach;
      object.updateWorldMatrix(true, false);
      const local = this.p.setFromMatrixPosition(frame).applyMatrix4(this.inv.copy(object.matrixWorld).invert());
      const distance = target.bounds.distanceToPoint(local) * object.matrixWorld.getMaxScaleOnAxis();
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = target;
      }
    }
    return best;
  }

  private take(side: Side, target: GrabTarget, frame: Matrix4): void {
    // Passing a held target to the other hand releases it there first.
    for (const other of SIDES) if (other !== side && this.holds[other].target === target) this.release(other);
    const hold = this.holds[side];
    target.carry.updateWorldMatrix(true, false);
    hold.offset.copy(frame).invert().multiply(target.carry.matrixWorld);
    hold.target = target;
    this.near[side] = null;
    target.begin(side);
    this.pulse(side, 0.35);
  }

  private release(side: Side): void {
    const hold = this.holds[side];
    const target = hold.target;
    if (target == null) return;
    hold.target = null;
    target.end();
    this.pulse(side, 0.15);
  }

  private refreshHighlights(): void {
    const want = this.want;
    want.length = 0;
    for (const side of SIDES) {
      const held = this.holds[side].target;
      const near = this.near[side];
      if (held != null && !want.includes(held)) want.push(held);
      if (near != null && !want.includes(near)) want.push(near);
    }
    for (const target of this.lit) {
      if (!want.includes(target)) {
        this.levels.set(target, 0);
        target.highlight(0);
      }
    }
    for (const target of want) {
      const level: GrabLevel = this.holds.left.target === target || this.holds.right.target === target ? 2 : 1;
      if (this.levels.get(target) !== level) {
        this.levels.set(target, level);
        target.highlight(level);
      }
    }
    // Swap the arrays instead of allocating a new one each frame.
    this.want = this.lit;
    this.lit = want;
  }

  private pulse(side: Side, strength: number): void {
    const source = this.world.input.xr.getPrimaryInputSource(side);
    const actuator = source?.gamepad?.hapticActuators?.[0] as { pulse?: (v: number, ms: number) => void } | undefined;
    actuator?.pulse?.(strength, 22);
  }
}
