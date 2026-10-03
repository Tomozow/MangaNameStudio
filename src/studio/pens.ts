// Pens held in each hand or controller. Hands grip the pen between thumb and
// index (pose from the tracked joints); controllers carry it along the ray.
// Each pen tip doubles as a touch pointer, so a held pen presses UIKit panels.
import { Matrix4, Quaternion, Vector3, type Object3D, type World } from '@iwsdk/core';
import { createTouchPointer, type Pointer } from '@pmndrs/pointer-events';
import { SIDES, type Side } from './doc.js';
import { OneEuro } from './tools.js';

/** Calibration knobs (meters / Hz). Real hands and controllers differ: tune on device. */
export const PEN_TUNING = {
  /** Tip distance past the thumb/index grip point, along the pen axis. */
  handReach: 0.028,
  /** Tip distance past the controller ray origin. */
  controllerReach: 0.085,
  /** The tool model leans up this far at the ray origin so its head clears the controller. */
  controllerLift: 0.03,
  /** Thumb–index tip distance that closes / opens the grip (hysteresis). */
  gripOn: 0.04,
  gripOff: 0.06,
  /** One Euro smoothing of the tracked grip points. */
  minCutoff: 2.4,
  beta: 12,
  /** UI touch pointer: hover reach and press depth from the tip. */
  uiHover: 0.06,
  uiDown: 0.008,
};

// WebXR XRHand joint order.
const THUMB_PROXIMAL = 2;
const THUMB_TIP = 4;
const INDEX_PROXIMAL = 6;
const INDEX_TIP = 9;
const JOINTS = 25;

const UP = new Vector3(0, 1, 0);

export interface Pen {
  readonly side: Side;
  /** What tracks this side right now. */
  source: 'hand' | 'controller' | null;
  /** A tool is assigned, so the pen is shown (the empty hand holds nothing). */
  armed: boolean;
  /** Gripped and able to draw or press. Controllers always hold an armed pen. */
  held: boolean;
  /** World-space tip and unit axis (butt → tip). */
  readonly tip: Vector3;
  readonly axis: Vector3;
  /** Hands only: the smoothed point between thumb and index tips. */
  readonly pinch: Vector3;
  /** The hand's tool set: origin at the tip, body along +Y, face along +Z. */
  readonly model: Object3D;
  /** Touch pointer at the tip for UI panels. */
  readonly pointer: Pointer;
  readonly filters: OneEuro[];
  fresh: boolean;
}

type SceneWithTargets = Object3D & { interactableDescendants?: Object3D[] };

interface HandAdapter {
  jointTransforms?: Float32Array;
}

function jointPosition(joints: Float32Array, joint: number, grip: Matrix4, out: Vector3): Vector3 {
  return out.set(joints[joint * 16 + 12]!, joints[joint * 16 + 13]!, joints[joint * 16 + 14]!).applyMatrix4(grip);
}

/** World matrix of a tracked hand joint (WebXR joint order); false when that hand is not tracked. */
export function handJointMatrix(world: World, side: Side, joint: number, out: Matrix4): boolean {
  if (!world.input.xr.isPrimary('hand', side)) return false;
  const joints = (world.input.xr.visualAdapters.hand[side] as unknown as HandAdapter).jointTransforms;
  const grip = world.player.gripSpaces[side];
  if (joints == null || joints.length < JOINTS * 16 || grip == null) return false;
  grip.updateWorldMatrix(true, false);
  out.fromArray(joints, joint * 16).premultiply(grip.matrixWorld);
  return true;
}

/** Same rule IWSDK's own pointers use: UIKit's semantic visibility wins over Object3D.visible. */
function visibleForPointer(object: Object3D): boolean {
  for (let o: Object3D | null = object; o != null; o = o.parent) {
    const c = o as Object3D & { isVisible?: { value: unknown }; needsRenderTraversal?: { value: unknown } };
    const semantic = typeof c.isVisible?.value === 'boolean' && typeof c.needsRenderTraversal?.value === 'boolean';
    if (!(semantic ? c.isVisible!.value : o.visible)) return false;
  }
  return true;
}

export class PenRig {
  readonly pens: Record<Side, Pen>;
  private readonly m = new Matrix4();
  private readonly inv = new Matrix4();
  private readonly q = new Quaternion();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly nativeEvent = { timeStamp: 0 };

  constructor(
    private readonly world: World,
    createModel: (side: Side) => Object3D,
  ) {
    const make = (side: Side): Pen => {
      const model = createModel(side);
      model.name = `Tools-${side}`;
      model.visible = false;
      world.createTransformEntity(model, { parent: world.playerEntity, persistent: true });
      const pointer = createTouchPointer(() => world.camera, { current: model }, {}, {
        hoverRadius: PEN_TUNING.uiHover,
        downRadius: PEN_TUNING.uiDown,
        clickThresholdMs: 800,
        button: 0,
        filter: visibleForPointer,
      });
      pointer.setEnabled(false, this.nativeEvent, false);
      return {
        side,
        source: null,
        armed: false,
        held: false,
        tip: new Vector3(),
        axis: new Vector3(0, 0, -1),
        pinch: new Vector3(),
        model,
        pointer,
        filters: Array.from({ length: 6 }, () => new OneEuro(0)),
        fresh: true,
      };
    };
    this.pens = { left: make('left'), right: make('right') };
  }

  /** Whether `pointerId` belongs to one of the pen tips. */
  sideOfPointer(pointerId: number): Side | null {
    for (const side of SIDES) if (this.pens[side].pointer.id === pointerId) return side;
    return null;
  }

  /** Track both pens; `armed` says which sides currently hold a tool. */
  update(dt: number, armed: Record<Side, boolean>): void {
    const xr = this.world.input.xr;
    for (const side of SIDES) {
      const pen = this.pens[side];
      pen.armed = armed[side];
      const hand = xr.isPrimary('hand', side);
      const controller = !hand && xr.isPrimary('controller', side);
      const ok = hand ? this.trackHand(pen, dt) : controller ? this.trackController(pen) : false;
      pen.source = ok ? (hand ? 'hand' : 'controller') : null;
      if (!ok) {
        pen.held = false;
        pen.fresh = true;
      } else if (controller) {
        pen.held = pen.armed;
      }
      pen.model.visible = ok && pen.armed;
      if (pen.model.visible) this.place(pen);
    }
  }

  /**
   * Move the held pens' UI pointers against each side's `targets` only (panels,
   * page strip), the way IWSDK scopes its own pointers. The board has its own
   * contact logic.
   */
  pressUi(targets: Record<Side, Object3D[]>): void {
    const scene = this.world.scene as SceneWithTargets;
    this.nativeEvent.timeStamp = performance.now();
    for (const side of SIDES) {
      const pen = this.pens[side];
      const live = pen.held && pen.armed && pen.source != null;
      const pointer = pen.pointer;
      if (live !== pointer.getEnabled()) pointer.setEnabled(live, this.nativeEvent, true);
      if (!live) continue;
      const saved = scene.interactableDescendants;
      scene.interactableDescendants = targets[side];
      pointer.move(scene, this.nativeEvent);
      scene.interactableDescendants = saved;
    }
  }

  /** True while a pen tip is at a UI target (the board should ignore that pen). */
  onUi(side: Side): boolean {
    const pen = this.pens[side];
    if (!pen.pointer.getEnabled()) return false;
    // Pointers report a "void" hit when nothing is in reach.
    const hit = pen.pointer.getIntersection() as { distance: number; object: { isVoidObject?: boolean } } | undefined;
    return hit != null && hit.object.isVoidObject !== true && hit.distance < PEN_TUNING.uiDown * 3;
  }

  private trackController(pen: Pen): boolean {
    const space = this.world.player.raySpaces[pen.side];
    if (space == null) return false;
    space.updateWorldMatrix(true, false);
    const origin = this.a.setFromMatrixPosition(space.matrixWorld);
    pen.axis.set(0, 0, -1).transformDirection(space.matrixWorld);
    pen.tip.copy(origin).addScaledVector(pen.axis, PEN_TUNING.controllerReach);
    const butt = origin.addScaledVector(this.b.set(0, 1, 0).transformDirection(space.matrixWorld), PEN_TUNING.controllerLift);
    pen.axis.subVectors(pen.tip, butt).normalize();
    pen.fresh = true;
    return true;
  }

  private trackHand(pen: Pen, dt: number): boolean {
    const adapter = this.world.input.xr.visualAdapters.hand[pen.side] as unknown as HandAdapter;
    const joints = adapter.jointTransforms;
    const grip = this.world.player.gripSpaces[pen.side];
    if (joints == null || joints.length < JOINTS * 16 || grip == null) return false;
    grip.updateWorldMatrix(true, false);
    const at = grip.matrixWorld;
    const thumb = jointPosition(joints, THUMB_TIP, at, this.a);
    const index = jointPosition(joints, INDEX_TIP, at, this.b);
    const gap = thumb.distanceTo(index);
    if (pen.held ? gap > PEN_TUNING.gripOff : gap < PEN_TUNING.gripOn) pen.held = !pen.held;
    // Grip point between the finger pads; the pen rests on the thumb–index web behind it.
    const g = thumb.add(index).multiplyScalar(0.5);
    const web = jointPosition(joints, THUMB_PROXIMAL, at, this.c)
      .add(jointPosition(joints, INDEX_PROXIMAL, at, this.d))
      .multiplyScalar(0.5);
    const f = pen.filters;
    const step = Math.max(1 / 120, dt);
    if (pen.fresh) {
      for (let i = 0; i < 3; i++) {
        f[i]!.reset(g.getComponent(i));
        f[i + 3]!.reset(web.getComponent(i));
      }
      pen.fresh = false;
    }
    for (let i = 0; i < 3; i++) {
      g.setComponent(i, f[i]!.filter(g.getComponent(i), step, PEN_TUNING.minCutoff, PEN_TUNING.beta));
      web.setComponent(i, f[i + 3]!.filter(web.getComponent(i), step, PEN_TUNING.minCutoff, PEN_TUNING.beta));
    }
    pen.pinch.copy(g);
    pen.axis.subVectors(g, web);
    if (pen.axis.lengthSq() < 1e-8) return false;
    pen.axis.normalize();
    pen.tip.copy(g).addScaledVector(pen.axis, PEN_TUNING.handReach);
    return true;
  }

  /**
   * Model origin at the tip with its +Y body pointing back along the axis, rolled about
   * that axis so the model's face (+Z) turns toward the viewer and its icon reads.
   */
  private place(pen: Pen): void {
    const model = pen.model;
    const body = this.a.copy(pen.axis).negate();
    const face = this.world.camera.getWorldPosition(this.b).sub(pen.tip);
    face.addScaledVector(body, -face.dot(body));
    if (face.lengthSq() > 1e-8) {
      face.normalize();
      this.m.makeBasis(this.c.crossVectors(body, face), body, face);
      this.q.setFromRotationMatrix(this.m);
    } else {
      this.q.setFromUnitVectors(UP, body);
    }
    this.m.compose(pen.tip, this.q, this.s);
    const parent = model.parent;
    if (parent != null) {
      parent.updateWorldMatrix(true, false);
      this.m.premultiply(this.inv.copy(parent.matrixWorld).invert());
    }
    this.m.decompose(model.position, model.quaternion, model.scale);
    model.updateMatrixWorld(true);
  }
}
