// Quick menu on the left wrist. With hands it shows while the left palm faces the
// head; with controllers a left stick click toggles it. It follows the hand and
// turns to face the head, and the other hand's pen, finger or ray presses it.
import {
  InputComponent,
  Matrix4,
  Quaternion,
  Vector3,
  VisibilityState,
  type UIKitMLAsset,
  type World,
} from '@iwsdk/core';
import { TOOL_NAMES, type Side, type ToolId } from './doc.js';
import { handJointMatrix } from './pens.js';
import { bindButton, setProps, setText } from './ui-kit.js';

/** Placement knobs (meters, 1/s). */
export const WRIST_TUNING = {
  /** Palm-toward-head alignment that shows / hides the menu (hysteresis). */
  showDot: 0.6,
  hideDot: 0.4,
  /**
   * Offset from the wrist joint: along the fingers, off the palm, and to the right
   * in view so the menu sits between the hands however the palm is turned.
   */
  alongFingers: 0.05,
  offPalm: 0.03,
  viewRight: 0.1,
  /** Height above the left controller while toggled on. */
  aboveController: 0.12,
  /** Follow rate: higher sticks closer to the hand, lower is calmer. */
  follow: 16,
};

const WRIST_JOINT = 0;
const UP = new Vector3(0, 1, 0);

export interface WristActions {
  undo(): void;
  redo(): void;
  /** +1 is the next page (to the left in a right-to-left book). */
  turn(dir: number): void;
  zoom(factor: number): void;
  swap(): void;
  recenter(): void;
  /** Put every moved window back where it started. */
  resetLayout(): void;
}

/** A second press within this time confirms the layout reset (ms). */
const CONFIRM_MS = 3000;
const LAYOUT_LABEL = 'ウィンドウ配置を戻す';

export class WristMenu {
  private shown = false;
  /** Last palm-toward-head alignment (dev diagnostics). */
  facing = 0;
  private toggled = false;
  private settled = false;
  private shownLeft: ToolId | null = null;
  private shownRight: ToolId | null = null;
  /** When the layout reset was first pressed (0: not armed). */
  private resetArmed = 0;
  private readonly m = new Matrix4();
  private readonly look = new Matrix4();
  private readonly q = new Quaternion();
  private readonly head = new Vector3();
  private readonly target = new Vector3();
  private readonly palm = new Vector3();
  private readonly fingers = new Vector3();
  private readonly right = new Vector3();
  private readonly tmp = new Vector3();

  constructor(
    private readonly world: World,
    readonly panel: UIKitMLAsset,
    private readonly hands: Readonly<Record<Side, ToolId>>,
    actions: WristActions,
    cleanup: Array<() => void>,
  ) {
    bindButton(panel, 'wrist-undo', () => actions.undo(), cleanup);
    bindButton(panel, 'wrist-redo', () => actions.redo(), cleanup);
    bindButton(panel, 'wrist-next', () => actions.turn(1), cleanup);
    bindButton(panel, 'wrist-prev', () => actions.turn(-1), cleanup);
    bindButton(panel, 'wrist-zoom-out', () => actions.zoom(1 / 1.25), cleanup);
    bindButton(panel, 'wrist-zoom-in', () => actions.zoom(1.25), cleanup);
    bindButton(panel, 'wrist-swap', () => actions.swap(), cleanup);
    bindButton(panel, 'wrist-recenter', () => actions.recenter(), cleanup);
    bindButton(panel, 'wrist-layout', () => {
      if (this.resetArmed > 0 && performance.now() - this.resetArmed < CONFIRM_MS) {
        this.disarm();
        actions.resetLayout();
        return;
      }
      this.resetArmed = performance.now();
      setText(panel, 'wrist-layout-label', 'もう一度押して確定');
      setProps(panel, 'wrist-layout', { variant: 'negative' });
    }, cleanup);
    panel.visible = false;
  }

  get visible(): boolean {
    return this.shown;
  }

  private disarm(): void {
    this.resetArmed = 0;
    setText(this.panel, 'wrist-layout-label', LAYOUT_LABEL);
    setProps(this.panel, 'wrist-layout', { variant: 'secondary' });
  }

  update(delta: number): void {
    if (this.resetArmed > 0 && performance.now() - this.resetArmed >= CONFIRM_MS) this.disarm();
    const xr = this.world.input.xr;
    let show = false;
    this.world.camera.getWorldPosition(this.head);
    if (handJointMatrix(this.world, 'left', WRIST_JOINT, this.m)) {
      this.toggled = false;
      // Joint frames: -Y leaves the palm and -Z runs toward the fingers.
      const wrist = this.target.setFromMatrixPosition(this.m);
      this.palm.setFromMatrixColumn(this.m, 1).normalize().negate();
      this.fingers.setFromMatrixColumn(this.m, 2).normalize().negate();
      this.right.setFromMatrixColumn(this.world.camera.matrixWorld, 0).normalize();
      const facing = this.palm.dot(this.tmp.subVectors(this.head, wrist).normalize());
      this.facing = facing;
      show = facing > (this.shown ? WRIST_TUNING.hideDot : WRIST_TUNING.showDot);
      wrist
        .addScaledVector(this.fingers, WRIST_TUNING.alongFingers)
        .addScaledVector(this.palm, WRIST_TUNING.offPalm)
        .addScaledVector(this.right, WRIST_TUNING.viewRight);
    } else if (xr.isPrimary('controller', 'left')) {
      if (xr.gamepads.left?.getButtonDown(InputComponent.Thumbstick)) this.toggled = !this.toggled;
      show = this.toggled;
      const grip = this.world.player.gripSpaces.left;
      grip.updateWorldMatrix(true, false);
      this.target.setFromMatrixPosition(grip.matrixWorld);
      this.target.y += WRIST_TUNING.aboveController;
    }
    if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) show = false;
    if (show !== this.shown) {
      this.shown = show;
      this.panel.visible = show;
      this.settled = false;
    }
    if (!show) return;
    this.refreshHands();
    const panel = this.panel;
    const parent = panel.parent;
    if (parent != null) parent.worldToLocal(this.target);
    // Snap into place when it appears, then follow smoothly so it does not jitter with the hand.
    const k = this.settled ? 1 - Math.exp(-delta * WRIST_TUNING.follow) : 1;
    this.settled = true;
    panel.position.lerp(this.target, k);
    // Panels face +Z: build a frame whose +Z points from the menu to the head, upright.
    if (parent != null) parent.worldToLocal(this.head);
    this.look.lookAt(this.head, panel.position, UP);
    this.q.setFromRotationMatrix(this.look);
    panel.quaternion.slerp(this.q, k);
  }

  private refreshHands(): void {
    const { left, right } = this.hands;
    if (left === this.shownLeft && right === this.shownRight) return;
    this.shownLeft = left;
    this.shownRight = right;
    setText(this.panel, 'wrist-hands', `左手 ${TOOL_NAMES[left]} / 右手 ${TOOL_NAMES[right]}`);
  }
}
