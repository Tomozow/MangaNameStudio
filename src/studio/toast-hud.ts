// Toasts show on the tool palette. While the palette is put away on a wrist they show
// for a few seconds just below the line of sight instead, so none goes unseen.
import {
  CanvasTexture,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Entity,
  type World,
} from '@iwsdk/core';
import { ctx2d, makeCanvas } from './project.js';

/** Placement (meters, 1/s) and how long a toast stays (ms). */
const HUD = { ahead: 0.6, below: 0.2, width: 0.4, follow: 6, ms: 5000 };
const PX = { w: 1024, h: 192, font: 44, line: 56 };
const UP = new Vector3(0, 1, 0);

export class ToastHud {
  private readonly canvas = makeCanvas(PX.w, PX.h);
  private readonly texture = new CanvasTexture(this.canvas);
  private readonly mesh: Mesh;
  private until = 0;
  private settled = false;
  private readonly head = new Vector3();
  private readonly at = new Vector3();
  private readonly v = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();

  constructor(
    private readonly world: World,
    parent: Entity,
    cleanup: Array<() => void>,
  ) {
    this.texture.colorSpace = SRGBColorSpace;
    // Drawn over everything: it is a notice, not part of the room.
    const material = new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new Mesh(new PlaneGeometry(HUD.width, (HUD.width * PX.h) / PX.w), material);
    this.mesh.name = 'ToastHud';
    this.mesh.renderOrder = 1000;
    this.mesh.raycast = () => undefined;
    this.mesh.visible = false;
    const entity = world.createTransformEntity(this.mesh, { parent });
    cleanup.push(() => {
      entity.dispose();
      this.texture.dispose();
    });
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  show(message: string): void {
    const c = ctx2d(this.canvas);
    c.clearRect(0, 0, PX.w, PX.h);
    c.font = `600 ${PX.font}px "M PLUS 1p", sans-serif`;
    // Wrap by measured width, at most three lines.
    const lines: string[] = [];
    let line = '';
    for (const ch of message) {
      if (c.measureText(line + ch).width > PX.w - 64 && line !== '') {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
    lines.push(line);
    lines.splice(3);
    const h = lines.length * PX.line + 32;
    const top = (PX.h - h) / 2;
    c.fillStyle = 'rgba(20,22,26,0.88)';
    c.beginPath();
    c.roundRect(8, top, PX.w - 16, h, 28);
    c.fill();
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    lines.forEach((text, i) => c.fillText(text, PX.w / 2, top + 16 + PX.line * (i + 0.5)));
    this.texture.needsUpdate = true;
    this.until = performance.now() + HUD.ms;
    if (!this.mesh.visible) this.settled = false;
    this.mesh.visible = true;
  }

  update(delta: number): void {
    if (!this.mesh.visible) return;
    if (performance.now() > this.until) {
      this.mesh.visible = false;
      return;
    }
    const camera = this.world.camera;
    const parent = this.mesh.parent;
    if (parent == null) return;
    camera.getWorldPosition(this.head);
    // Ahead along the view and a little below it, facing the head; it trails the head so it does not jitter.
    this.at
      .copy(this.head)
      .addScaledVector(this.v.set(0, 0, -1).transformDirection(camera.matrixWorld), HUD.ahead)
      .addScaledVector(this.v.set(0, 1, 0).transformDirection(camera.matrixWorld), -HUD.below);
    this.q.setFromRotationMatrix(this.m.lookAt(this.head, this.at, UP));
    parent.worldToLocal(this.at);
    this.q.premultiply(parent.getWorldQuaternion(this.q2).invert());
    const k = this.settled ? 1 - Math.exp(-delta * HUD.follow) : 1;
    this.settled = true;
    this.mesh.position.lerp(this.at, k);
    this.mesh.quaternion.slerp(this.q, k);
  }
}
