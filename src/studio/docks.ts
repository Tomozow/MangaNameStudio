// Where docked windows ride. A wrist shows its windows while the back of that hand
// faces the head (a controller toggles them with its stick click); the belt is a
// body-locked spot in front of the waist that turns only when the body does.
import { InputComponent, Matrix4, Quaternion, Vector3, VisibilityState, type World } from '@iwsdk/core';
import { SIDES, type Side } from './doc.js';
import { handJointMatrix } from './pens.js';
import { prefs } from './prefs.js';

/** Placement knobs (meters, radians, 1/s). Real hands differ: tune on device. */
export const DOCK_TUNING = {
  /** Back-of-hand-toward-head alignment that shows / hides a wrist's windows (hysteresis). */
  showDot: 0.6,
  hideDot: 0.4,
  /** A docked window's bottom edge sits this far off the back of the hand, shifted toward the other hand. */
  offBack: 0.05,
  inward: 0.03,
  /** With controllers: the bottom edge above the grip and to the side (the left one clears the quick menu). */
  aboveController: 0.06,
  besideController: { left: 0.16, right: -0.06 } as Record<Side, number>,
  /** Dropping a window's bar this close to a wrist (or where its windows sit) docks it there. */
  wristSnap: 0.12,
  /** Dropping a window's bar (or a belt window's centre) this close to the belt point puts it on the belt. */
  beltSnap: 0.22,
  /** Belt point from the head in the body frame (+X right, -Z forward) until the user moves it. */
  belt: [0, -0.55, -0.36] as readonly number[],
  /** The belt turns once the head looks further than this to one side. */
  beltYaw: 0.6,
  /** How fast the belt follows the head (low, so leaning in to press does not chase it). */
  beltFollow: 1.5,
  /** How fast a docked window follows its wrist or the belt. */
  follow: 16,
};

const WRIST_JOINT = 0;
const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);

export interface Wrist {
  /** The wrist is tracked in an immersive session (windows can dock there). */
  tracked: boolean;
  /** Its windows show. */
  shown: boolean;
  /** Controller stick-click toggle. */
  toggled: boolean;
  /** Wrist joint or controller grip (world). */
  readonly at: Vector3;
  /** Where a docked window's bottom-centre goes (world). */
  readonly base: Vector3;
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class Docks {
  readonly wrists: Record<Side, Wrist> = {
    left: { tracked: false, shown: false, toggled: false, at: new Vector3(), base: new Vector3() },
    right: { tracked: false, shown: false, toggled: false, at: new Vector3(), base: new Vector3() },
  };
  /** In an immersive session: docks only apply there. */
  immersive = false;
  /** Whether the quick menu shows (it reads the same left stick click earlier in the frame). */
  menuShown: (() => boolean) | null = null;
  readonly head = new Vector3();
  /** Body frame (world): the smoothed head position, turned with the body. */
  private readonly body = new Matrix4();
  private readonly bodyInv = new Matrix4();
  private readonly bodyAt = new Vector3();
  private bodyYaw = 0;
  private fresh = true;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly right = new Vector3();
  private readonly back = new Vector3();
  private readonly tmp = new Vector3();

  constructor(private readonly world: World) {}

  update(delta: number): void {
    const camera = this.world.camera;
    camera.getWorldPosition(this.head);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    for (const side of SIDES) this.updateWrist(side);
    this.updateBody(delta);
  }

  /** The belt point (world). */
  beltPoint(out: Vector3): Vector3 {
    return out.fromArray(prefs.belt ?? DOCK_TUNING.belt).applyMatrix4(this.body);
  }

  /** `world` in the body frame, as a belt point to save. */
  toBody(world: Vector3): number[] {
    return this.tmp.copy(world).applyMatrix4(this.bodyInv.copy(this.body).invert()).toArray();
  }

  private updateWrist(side: Side): void {
    const w = this.wrists[side];
    const xr = this.world.input.xr;
    const inward = side === 'left' ? 1 : -1;
    if (handJointMatrix(this.world, side, WRIST_JOINT, this.m)) {
      w.toggled = false;
      w.tracked = true;
      w.at.setFromMatrixPosition(this.m);
      // Joint frames: +Y leaves the back of the hand.
      const back = this.back.setFromMatrixColumn(this.m, 1).normalize();
      const facing = back.dot(this.tmp.subVectors(this.head, w.at).normalize());
      w.shown = facing > (w.shown ? DOCK_TUNING.hideDot : DOCK_TUNING.showDot);
      w.base
        .copy(w.at)
        .addScaledVector(back, DOCK_TUNING.offBack)
        .addScaledVector(this.right, inward * DOCK_TUNING.inward);
    } else if (xr.isPrimary('controller', side)) {
      if (xr.gamepads[side]?.getButtonDown(InputComponent.Thumbstick)) {
        // The left click shows or hides the quick menu too: keep the two in step even after
        // a drop showed this wrist's windows on their own.
        w.toggled = side === 'left' && this.menuShown != null ? this.menuShown() : !w.toggled;
      }
      const grip = this.world.player.gripSpaces[side];
      grip.updateWorldMatrix(true, false);
      w.tracked = true;
      w.shown = w.toggled;
      w.at.setFromMatrixPosition(grip.matrixWorld);
      w.base.copy(w.at).addScaledVector(this.right, DOCK_TUNING.besideController[side]);
      w.base.y += DOCK_TUNING.aboveController;
    } else {
      w.tracked = false;
      w.shown = false;
    }
    if (!this.immersive) {
      w.tracked = false;
      w.shown = false;
    }
  }

  private updateBody(delta: number): void {
    if (!this.immersive) {
      this.fresh = true;
      return;
    }
    const e = this.world.camera.matrixWorld.elements;
    // Forward is -Z; hold the yaw while looking nearly straight down (at the belt) or up.
    const fx = -e[8]!;
    const fz = -e[10]!;
    if (Math.hypot(fx, fz) > 0.3) {
      const yaw = Math.atan2(-fx, -fz);
      if (this.fresh) this.bodyYaw = yaw;
      const diff = wrap(yaw - this.bodyYaw);
      const over = Math.abs(diff) - DOCK_TUNING.beltYaw;
      if (over > 0) this.bodyYaw = wrap(this.bodyYaw + Math.sign(diff) * over);
    }
    if (this.fresh) this.bodyAt.copy(this.head);
    else this.bodyAt.lerp(this.head, 1 - Math.exp(-delta * DOCK_TUNING.beltFollow));
    this.fresh = false;
    this.body.compose(this.bodyAt, this.q.setFromAxisAngle(UP, this.bodyYaw), ONE);
  }
}
