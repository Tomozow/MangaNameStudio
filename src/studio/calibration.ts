// Lay the board on a real surface. Pivoting a real pen's tip on one point measures how
// far the tip sits past the hand; touching the surface's corners then gives its place,
// angle and size. The board sits exactly on that surface, so drawing with the real pen
// on the real board has the touch feedback the floating board lacks.
import {
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  VisibilityState,
  type Object3D,
  type UIKitMLAsset,
  type World,
} from '@iwsdk/core';
import { PAPER_Z, WINDOW_H, WINDOW_W } from './board.js';
import { SIDES, type Side } from './doc.js';
import { PEN_TUNING, type PenRig } from './pens.js';
import { prefs, savePrefs, type Surface } from './prefs.js';
import type { StudioCtx } from './studio-ctx.js';
import { bindButton, setText } from './ui-kit.js';
import type { Windows } from './windows.js';

/** Calibration knobs (meters / seconds). Tune on device. */
export const CALIB_TUNING = {
  /** A tip staying within `still` for `dwell` seconds records a corner. */
  still: 0.003,
  dwell: 0.8,
  /** Corners closer than this to another corner, or to where the pen was when the step began, are ignored. */
  apart: 0.03,
  /** The optional fourth corner must land this close to where the first three put it. */
  fourth: 0.04,
  /** Pivoting: time to get the tip onto a point, then sampling time. */
  prep: 1.5,
  pivot: 4,
  /** The pen has to tilt at least this much (rms, radians) and its tip stay within `pivotRms`. */
  pivotSpread: 0.12,
  pivotRms: 0.008,
  /** A new surface sits this far (mm) in front of the touched points, so a touch reliably lands. */
  lift: 1.5,
};

const SAMPLES = 1200;
const CORNERS = ['左上', '右上', '右下', '左下'] as const;

/** Manual tuning steps: [x mm, y mm, height mm, rotation deg, size %]. */
const ADJUST = [
  ['x', 0, 1],
  ['y', 1, 1],
  ['z', 2, 0.5],
  ['rot', 3, 0.25],
  ['size', 4, 0.5],
] as const;

/**
 * Pen length from (base, dir) samples taken while the tip stays on one point:
 * minimises |base + reach * dir - P| over all samples (P falls out in closed form).
 */
export function solvePivot(s: Float32Array, n: number): { reach: number; rms: number; spread: number } {
  const mb = [0, 0, 0];
  const ma = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      mb[k]! += s[i * 6 + k]! / n;
      ma[k]! += s[i * 6 + 3 + k]! / n;
    }
  }
  let uv = 0;
  let vv = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = s[i * 6 + 3 + k]! - ma[k]!;
      uv += (s[i * 6 + k]! - mb[k]!) * v;
      vv += v * v;
    }
  }
  const reach = vv > 0 ? -uv / vv : 0;
  let err = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const e = s[i * 6 + k]! - mb[k]! + reach * (s[i * 6 + 3 + k]! - ma[k]!);
      err += e * e;
    }
  }
  return { reach, rms: Math.sqrt(err / Math.max(1, n)), spread: Math.sqrt(vv / Math.max(1, n)) };
}

/** A rectangle from its corners touched top-left, top-right, bottom-right (and optionally bottom-left), or why not. */
export function fitCorners(p: readonly Vector3[]): Pick<Surface, 'pose' | 'size'> | string {
  const [a, b, c] = p as [Vector3, Vector3, Vector3];
  const d = p[3] ?? new Vector3().addVectors(a, c).sub(b);
  const x = new Vector3().subVectors(b, a).add(new Vector3().subVectors(c, d));
  const y = new Vector3().subVectors(a, d).add(new Vector3().subVectors(b, c));
  const w = (a.distanceTo(b) + d.distanceTo(c)) / 2;
  const h = (a.distanceTo(d) + b.distanceTo(c)) / 2;
  if (w < 0.05 || h < 0.05) return '角どうしが近すぎます。板の角を順に打ってください';
  if (Math.abs(x.clone().normalize().dot(y.clone().normalize())) > 0.35) {
    return '角が直角になりません。左上・右上・右下の順に打ち直してください';
  }
  const z = new Vector3().crossVectors(x, y).normalize();
  x.addScaledVector(z, -x.dot(z)).normalize();
  y.crossVectors(z, x);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
  const center = new Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25);
  return { pose: [...center.toArray(), ...q.toArray()], size: [w, h] };
}

const smP = new Vector3();
const smQ = new Quaternion();
const smR = new Quaternion();
const smS = new Vector3();
const Z = new Vector3(0, 0, 1);

/** The board anchor's world matrix on surface `s`: the window fitted inside it, its paper on the surface. */
export function surfaceMatrix(s: Surface, out: Matrix4): Matrix4 {
  const [dx, dy, dz, rot, size] = s.adjust as [number, number, number, number, number];
  const k = Math.min(s.size[0]! / WINDOW_W, s.size[1]! / WINDOW_H) * (1 + size / 100);
  smQ.fromArray(s.pose, 3);
  smR.setFromAxisAngle(Z, (rot * Math.PI) / 180).premultiply(smQ);
  smP.set(dx / 1000, dy / 1000, dz / 1000).applyQuaternion(smQ);
  smP.add(smS.set(0, 0, -PAPER_Z * k).applyQuaternion(smR));
  smP.x += s.pose[0]!;
  smP.y += s.pose[1]!;
  smP.z += s.pose[2]!;
  return out.compose(smP, smR, smS.setScalar(k));
}

type Step = 'idle' | 'pivot' | 'corners';

export class Calibration {
  step: Step = 'idle';
  /** The board sits on the real surface (immersive, with a surface set). */
  placed = false;
  private t = 0;
  private side: Side | null = null;
  private source: 'hand' | 'controller' = 'hand';
  private count = 0;
  private readonly samples = new Float32Array(SAMPLES * 6);
  private readonly corners: Vector3[] = [];
  private readonly starts: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  private readonly dwell: Record<Side, { at: Vector3; t: number }> = {
    left: { at: new Vector3(), t: 0 },
    right: { at: new Vector3(), t: 0 },
  };
  private readonly markers = new Group();
  private readonly cornerMarks: Mesh[] = [];
  private readonly progress: Record<Side, Mesh>;
  private readonly m = new Matrix4();
  private readonly inv = new Matrix4();
  private readonly guess = new Vector3();
  private guideText = '';
  /** The last pen measurement, for the F8 dump. */
  private lastPivot: ReturnType<typeof solvePivot> | null = null;

  constructor(
    private readonly world: World,
    private readonly studio: StudioCtx,
    private readonly pens: PenRig,
    private readonly windows: Windows,
    private readonly anchor: Object3D,
    private readonly panel: UIKitMLAsset | null,
    cleanup: Array<() => void>,
  ) {
    const dot = new SphereGeometry(0.004, 12, 8);
    const mark = (color: number) => {
      const mesh = new Mesh(dot, new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      mesh.renderOrder = 40;
      mesh.raycast = () => undefined;
      mesh.visible = false;
      this.markers.add(mesh);
      return mesh;
    };
    for (let i = 0; i < 4; i++) this.cornerMarks.push(mark(0x4c8dff));
    this.progress = { left: mark(0xffffff), right: mark(0xffffff) };
    this.markers.name = 'SurfaceMarkers';
    world.createTransformEntity(this.markers, { persistent: true });

    if (panel != null) {
      bindButton(panel, 'surface-pivot', () => (this.step === 'pivot' ? this.end('ペン先の測定を中止しました') : this.begin('pivot')), cleanup);
      bindButton(panel, 'surface-corners', () => {
        if (this.step !== 'corners') this.begin('corners');
        else this.end(prefs.surface != null ? '面合わせを終えました。そのまま描けます' : '面合わせを中止しました');
      }, cleanup);
      bindButton(panel, 'surface-clear', () => {
        this.end();
        prefs.surface = null;
        savePrefs();
        this.studio.toast('面合わせを解除しました (浮いた画面に戻ります)');
        this.refresh();
      }, cleanup);
      for (const [id, index, step] of ADJUST) {
        bindButton(panel, `surface-${id}-minus`, () => this.adjust(index, -step), cleanup);
        bindButton(panel, `surface-${id}-plus`, () => this.adjust(index, step), cleanup);
      }
      bindButton(panel, 'surface-reach-minus', () => this.adjustReach(-0.001), cleanup);
      bindButton(panel, 'surface-reach-plus', () => this.adjustReach(0.001), cleanup);
    }
    this.refresh();
  }

  /** Measuring right now: the board must not take the pens. */
  get busy(): boolean {
    return this.step !== 'idle';
  }

  /** Run the current step, then place the board (after the windows moved this frame). */
  update(delta: number): void {
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (this.busy && !immersive) this.end();
    if (this.step === 'pivot') this.pivotStep(delta);
    else if (this.step === 'corners') this.cornerStep(delta);
    const surface = prefs.surface;
    const place = immersive && surface != null;
    if (place) {
      const parent = this.anchor.parent;
      surfaceMatrix(surface, this.m);
      if (parent != null) {
        parent.updateWorldMatrix(true, false);
        this.m.premultiply(this.inv.copy(parent.matrixWorld).invert());
      }
      this.m.decompose(this.anchor.position, this.anchor.quaternion, this.anchor.scale);
    } else if (this.placed) {
      this.windows.restorePose('board');
    }
    this.placed = place;
  }

  debugState(): Record<string, unknown> {
    return { step: this.step, placed: this.placed, corners: this.corners.length, samples: this.count, lastPivot: this.lastPivot, dwell: [this.dwell.left.t, this.dwell.right.t] };
  }

  /** Back in XR with a surface from an earlier session: the room origin may have moved since. */
  announceRestored(): void {
    if (prefs.surface != null) this.studio.toast('前回の面合わせを復元しました。板とずれていたら合わせ直してください');
  }

  private begin(step: Step): void {
    if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) {
      this.studio.toast('面合わせはVRの中で使えます');
      return;
    }
    this.end();
    this.step = step;
    this.t = 0;
    this.count = 0;
    this.side = null;
    this.corners.length = 0;
    for (const side of SIDES) {
      this.starts[side].copy(this.pens.pens[side].tip);
      this.dwell[side].t = 0;
    }
    this.refresh();
  }

  private end(message?: string): void {
    this.step = 'idle';
    for (const m of this.markers.children) m.visible = false;
    if (message != null) this.studio.toast(message);
    this.refresh();
  }

  /** The held pen (right first). */
  private heldSide(): Side | null {
    for (const side of ['right', 'left'] as const) {
      const pen = this.pens.pens[side];
      if (pen.held && pen.source != null) return side;
    }
    return null;
  }

  // ---------- pen length ----------

  private pivotStep(delta: number): void {
    const side = this.side ?? this.heldSide();
    const pen = side != null ? this.pens.pens[side] : null;
    if (pen == null || !pen.held || pen.source == null) {
      // Wait for a held pen; a pen that let go mid-way starts over.
      this.side = null;
      this.t = 0;
      this.count = 0;
      this.guide('ペンを持って、ペン先を板の1点に当ててください');
      return;
    }
    this.side = side;
    this.source = pen.source;
    this.t += delta;
    const { prep, pivot } = CALIB_TUNING;
    if (this.t < prep) {
      this.guide(`ペン先を板の1点に当ててください (${Math.ceil(prep + pivot - this.t)})`);
      return;
    }
    if (this.count < SAMPLES) {
      pen.base.toArray(this.samples, this.count * 6);
      pen.dir.toArray(this.samples, this.count * 6 + 3);
      this.count++;
    }
    this.guide(`ペン先を当てたまま、ペンを大きく傾けて回してください (${Math.ceil(prep + pivot - this.t)})`);
    if (this.t >= prep + pivot) this.finishPivot();
  }

  private finishPivot(): void {
    const r = solvePivot(this.samples, this.count);
    this.lastPivot = r;
    const mm = (v: number) => (v * 1000).toFixed(1);
    if (this.count < 30 || r.spread < CALIB_TUNING.pivotSpread) {
      this.end('傾きが足りません。ペン先を当てたまま、もっと大きく傾けて回してください');
    } else if (r.rms > CALIB_TUNING.pivotRms || r.reach <= 0 || r.reach > 0.25) {
      this.end(`ペン先が動いたようです (誤差 ${mm(r.rms)}mm)。1点に当てたままやり直してください`);
    } else {
      prefs.penReach[this.source] = r.reach;
      savePrefs();
      this.end(`ペン先を${(r.reach * 100).toFixed(1)}cmに合わせました (誤差 ${mm(r.rms)}mm)`);
      this.studio.haptic(0.6);
    }
  }

  // ---------- corners ----------

  private cornerStep(delta: number): void {
    const n = this.corners.length;
    this.guide(
      n < 3
        ? `ペン先を板の${CORNERS[n]}の角に当てて止めてください (${n}/3)`
        : '面を合わせました。4点目(左下)は任意。「完了」で描けます',
    );
    if (n === 3) fourthCorner(this.corners, this.guess);
    for (const side of SIDES) {
      const pen = this.pens.pens[side];
      const d = this.dwell[side];
      const mark = this.progress[side];
      // A pen pausing in front of a panel (just after pressing a button) is not on a corner.
      if (!pen.held || pen.source == null || this.pens.onUi(side, PEN_TUNING.uiHover)) {
        d.t = 0;
        mark.visible = false;
        continue;
      }
      if (pen.tip.distanceTo(d.at) > CALIB_TUNING.still) {
        d.at.copy(pen.tip);
        d.t = 0;
      } else {
        d.t += delta;
      }
      const ok = this.acceptable(d.at, side);
      // A dot at the tip grows while it holds still; the corner is taken when it is full size.
      mark.visible = ok && d.t > 0.1;
      mark.position.copy(d.at);
      mark.scale.setScalar(0.4 + 0.6 * Math.min(1, d.t / CALIB_TUNING.dwell));
      if (ok && d.t >= CALIB_TUNING.dwell) {
        d.t = 0;
        mark.visible = false;
        this.record(d.at);
        return;
      }
    }
  }

  private acceptable(p: Vector3, side: Side): boolean {
    const apart = CALIB_TUNING.apart;
    if (p.distanceTo(this.starts[side]) < apart) return false;
    for (const c of this.corners) if (p.distanceTo(c) < apart) return false;
    return this.corners.length < 3 || p.distanceTo(this.guess) < CALIB_TUNING.fourth;
  }

  private record(p: Vector3): void {
    const n = this.corners.length;
    this.corners.push(p.clone());
    const mark = this.cornerMarks[n]!;
    mark.position.copy(p);
    mark.visible = true;
    this.studio.haptic(0.5);
    if (n + 1 < 3) {
      this.studio.toast(`${CORNERS[n]}を記録しました。次は${CORNERS[n + 1]}`);
      return;
    }
    const fit = fitCorners(this.corners);
    if (typeof fit === 'string') {
      if (n + 1 === 4) {
        // The first three still stand.
        this.corners.pop();
        mark.visible = false;
        return;
      }
      this.corners.length = 0;
      for (const m of this.cornerMarks) m.visible = false;
      this.studio.toast(fit);
      return;
    }
    // A new surface keeps the height that was tuned for this pen and hand.
    const lift = prefs.surface?.adjust[2] ?? CALIB_TUNING.lift;
    prefs.surface = { ...fit, adjust: [0, 0, lift, 0, 0] };
    savePrefs();
    const size = `${(fit.size[0]! * 100).toFixed(1)}x${(fit.size[1]! * 100).toFixed(1)}cm`;
    if (n + 1 === 4) this.end(`4点で面を合わせました (${size})`);
    else this.studio.toast(`面を合わせました (${size})。左下も打つと精度が上がります`);
    this.refresh();
  }

  // ---------- manual tuning ----------

  private adjust(index: number, step: number): void {
    const s = prefs.surface;
    if (s == null) {
      this.studio.toast('先に「角を打つ」で面を合わせてください');
      return;
    }
    s.adjust[index] = Math.round((s.adjust[index]! + step) * 100) / 100;
    savePrefs();
    this.refresh();
  }

  /** The pen of whatever tracks now: hands and controllers keep their own length. */
  private adjustReach(step: number): void {
    const source = this.pens.pens.right.source ?? this.pens.pens.left.source ?? 'hand';
    prefs.penReach[source] = Math.min(0.25, Math.max(0.005, prefs.penReach[source] + step));
    savePrefs();
    this.refresh();
  }

  private guide(text: string): void {
    if (text === this.guideText || this.panel == null) return;
    this.guideText = text;
    setText(this.panel, 'surface-guide', text);
  }

  private refresh(): void {
    const panel = this.panel;
    if (panel == null) return;
    const s = prefs.surface;
    setText(
      panel,
      'surface-status',
      s == null ? '未設定 (浮いた画面で描きます)' : `板 ${(s.size[0]! * 100).toFixed(1)}x${(s.size[1]! * 100).toFixed(1)}cm に合わせています`,
    );
    if (this.step === 'idle') this.guide('現実のペンと板を用意し、1.ペン先を測る 2.角を打つ の順に合わせます');
    setText(panel, 'surface-pivot-label', this.step === 'pivot' ? '中止' : 'ペン先を測る');
    setText(panel, 'surface-corners-label', this.step === 'corners' ? '完了' : '角を打つ');
    const a = s?.adjust ?? [0, 0, 0, 0, 0];
    const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);
    setText(panel, 'surface-x-label', `${sign(a[0]!)}mm`);
    setText(panel, 'surface-y-label', `${sign(a[1]!)}mm`);
    setText(panel, 'surface-z-label', `${sign(a[2]!)}mm`);
    setText(panel, 'surface-rot-label', `${sign(a[3]!)}°`);
    setText(panel, 'surface-size-label', `${sign(a[4]!)}%`);
    const r = prefs.penReach;
    setText(panel, 'surface-reach-label', `手 ${(r.hand * 100).toFixed(1)} / コントローラー ${(r.controller * 100).toFixed(1)}cm`);
  }
}

/** Where the fourth corner of the rectangle through the first three lies. */
function fourthCorner(p: readonly Vector3[], out: Vector3): Vector3 {
  return out.addVectors(p[0]!, p[2]!).sub(p[1]!);
}
