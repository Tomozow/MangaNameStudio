// Spatial diorama: a 1:12 stage with grabbable figures and props, gaze lines, a
// director camera whose view can be pasted onto the current page as an underlay.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DistanceGrabbable,
  Grabbed,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  PerspectiveCamera,
  PlaneGeometry,
  Pressed,
  RayInteractable,
  RingGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  UIKitMLAsset,
  Vector3,
  WebGLRenderTarget,
  createSystem,
  type Entity,
  type Object3D,
} from '@iwsdk/core';
import { DioramaItem } from '../components.js';
import {
  applyPose,
  createCameraProp,
  createFigure,
  createProp,
  createStage,
  type Pose,
  type PropKind,
} from '../scene-assets/diorama.scene-asset.js';
import { newId, type DioramaSave } from './doc.js';
import { ctx2d, makeCanvas } from './project.js';
import { studioBridge } from './studio-ctx.js';
import { applyJapaneseFont, bindButton, setChip, setText } from './ui-kit.js';

const MINI = 1 / 12;
const STAGE_RADIUS = 3.6;
const RT_W = 768;
const RT_H = 576;
// Layers 1 and 2 are used by WebXR for per-eye rendering, so pick a free one.
const LAYER = 5;

interface FigureSpec {
  color: string;
  label: string;
  height: number;
}

const FIGURES: Record<string, FigureSpec> = {
  'fig-a': { color: '#e05555', label: 'A', height: 1.7 },
  'fig-b': { color: '#4a7fd9', label: 'B', height: 1.75 },
  'fig-c': { color: '#49a86b', label: 'C', height: 1.62 },
  'fig-d': { color: '#e2b13c', label: 'D', height: 1.66 },
  'fig-child': { color: '#e58fb5', label: '子', height: 1.2 },
  'fig-mob': { color: '#9aa1ab', label: 'モブ', height: 1.7 },
};

const FOV = { wide: 68, normal: 42, tele: 22 } as const;


interface Piece {
  id: string;
  kind: string;
  entity: Entity;
  object: Object3D;
  pose: Pose;
  gaze: Line | null;
}

export function labelSprite(text: string, color: string): Sprite {
  const canvas = makeCanvas(256, 128);
  const c = ctx2d(canvas);
  c.fillStyle = 'rgba(20,22,26,0.82)';
  c.beginPath();
  c.roundRect(8, 16, 240, 96, 40);
  c.fill();
  c.fillStyle = color;
  c.font = '700 64px "M PLUS 1p", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 128, 66);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(0.6, 0.3, 1);
  sprite.raycast = () => undefined;
  return sprite;
}

/** Turn a rendered view into a light-blue underlay (edges + soft fill). */
export function toUnderlay(src: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const lum = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4; // GL rows are bottom-up
      const l = (0.299 * src[i]! + 0.587 * src[i + 1]! + 0.114 * src[i + 2]!) / 255;
      lum[y * w + x] = l;
      alpha[y * w + x] = src[i + 3]! / 255;
    }
  }
  const out = makeCanvas(w, h);
  const c = ctx2d(out);
  const img = c.createImageData(w, h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = lum[p + 1]! - lum[p - 1]! + 0.5 * (lum[p - w + 1]! - lum[p - w - 1]! + lum[p + w + 1]! - lum[p + w - 1]!);
      const gy = lum[p + w]! - lum[p - w]! + 0.5 * (lum[p + w - 1]! - lum[p - w - 1]! + lum[p + w + 1]! - lum[p - w + 1]!);
      const edge = Math.min(1, Math.hypot(gx, gy) * 2.4);
      const fill = alpha[p]! * (1 - lum[p]!) * 0.35;
      const a = Math.min(1, Math.max(edge, fill));
      const o = p * 4;
      img.data[o] = 70;
      img.data[o + 1] = 130;
      img.data[o + 2] = 220;
      img.data[o + 3] = Math.round(a * 200);
    }
  }
  c.putImageData(img, 0, 0);
  return out;
}

export class DioramaSystem extends createSystem({
  items: { required: [DioramaItem] },
  grabbed: { required: [DioramaItem, Grabbed] },
  pressed: { required: [DioramaItem, Pressed] },
}) {
  private anchor!: Object3D;
  private stageRoot!: Group;
  private stageEntity!: Entity;
  private panel: UIKitMLAsset | null = null;
  private readonly pieces = new Map<string, Piece>();
  private selected: Piece | null = null;
  private ring!: Mesh;
  private rt!: WebGLRenderTarget;
  private rtCamera!: PerspectiveCamera;
  private cameraPiece: Piece | null = null;
  private stageYaw = 0;
  private lifeSize = false;
  private gaze = true;
  private frame = 0;
  private captureRequested = false;
  private viewDirty = true;
  private axis!: Line;
  private pair: [Piece, Piece] | null = null;
  private cameraSide = 0;
  private crossed = false;
  private axisKey = NaN;
  private cutArmed = { key: '', time: 0 };
  private clearArmed = 0;
  private readonly pixels = new Uint8Array(RT_W * RT_H * 4);
  private readonly tmpV = new Vector3();
  private readonly clearColor = new Color();

  init(): void {
    const anchorEntity = this.world.requireSceneEntity('diorama-anchor');
    this.anchor = anchorEntity.object3D!;
    const pedestal = new Mesh(
      new RingGeometry(0.02, 0.36, 64),
      new MeshBasicMaterial({ color: 0x23262c, transparent: true, opacity: 0.85 }),
    );
    pedestal.rotation.x = -Math.PI / 2;
    pedestal.position.y = -0.035;
    pedestal.raycast = () => undefined;
    this.anchor.add(pedestal);

    this.stageRoot = new Group();
    this.stageRoot.name = 'DioramaStageRoot';
    this.stageRoot.add(createStage(STAGE_RADIUS));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(4, 8, 6);
    const fill = new DirectionalLight(0xdde6ff, 0.9);
    fill.position.set(-5, 3, -4);
    for (const light of [sun, fill]) {
      light.layers.set(LAYER);
      this.stageRoot.add(light);
    }
    this.stageRoot.traverse((o) => o.layers.enable(LAYER));
    this.ring = new Mesh(
      new RingGeometry(0.5, 0.62, 40),
      new MeshBasicMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.ring.visible = false;
    this.ring.raycast = () => undefined;
    this.stageRoot.add(this.ring);
    // Imaginary line (180-degree rule) between the last two selected characters.
    const axisGeo = new BufferGeometry();
    axisGeo.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    this.axis = new Line(axisGeo, new LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.9 }));
    this.axis.visible = false;
    this.axis.frustumCulled = false;
    this.axis.raycast = () => undefined;
    this.stageRoot.add(this.axis);
    this.stageEntity = this.world.createTransformEntity(this.stageRoot, { parent: anchorEntity });
    this.applyStageTransform();

    this.rt = new WebGLRenderTarget(RT_W, RT_H);
    this.rt.texture.colorSpace = SRGBColorSpace;
    this.rtCamera = new PerspectiveCamera(FOV.normal, RT_W / RT_H, 0.05, 300);
    this.rtCamera.layers.set(LAYER);
    const monitor = new Mesh(new PlaneGeometry(0.32, 0.24), new MeshBasicMaterial({ map: this.rt.texture }));
    const bezel = new Mesh(new PlaneGeometry(0.34, 0.27), new MeshBasicMaterial({ color: 0x15171b }));
    bezel.position.set(0, 0.008, -0.002);
    monitor.add(bezel);
    monitor.position.set(0, 0.3, -0.34);
    monitor.rotation.x = -0.12;
    monitor.raycast = () => undefined;
    bezel.raycast = () => undefined;
    monitor.add(monitorCaption());
    this.anchor.add(monitor);

    this.cleanupFuncs.push(
      this.queries.grabbed.subscribe('disqualify', (entity) => this.onReleased(entity)),
      this.queries.grabbed.subscribe('qualify', (entity) => this.selectEntity(entity)),
      this.queries.pressed.subscribe('qualify', (entity) => this.selectEntity(entity)),
      () => this.rt.dispose(),
    );
    this.bindPanel();
    const bridge = studioBridge.studio;
    if (bridge != null) {
      this.cleanupFuncs.push(bridge.onProjectOpened((project) => this.load(project.diorama)));
      this.load(bridge.project.diorama);
    }
  }

  update(): void {
    if (this.selected != null) {
      const o = this.selected.object;
      this.ring.position.set(o.position.x, 0.02, o.position.z);
    }
    this.updateAxis();
    this.frame++;
    if (this.lifeSize && this.frame % 30 === 0) this.applyStageTransform();
    // Re-render the camera view only when something can have changed.
    const moving = this.queries.grabbed.entities.size > 0;
    studioBridge.dioramaGrabbing = moving;
    if (moving) this.viewDirty = true;
    if (this.cameraPiece == null) return;
    if (!this.captureRequested && (!this.viewDirty || this.frame % 2 !== 0)) return;
    this.viewDirty = moving;
    const renderer = this.world.renderer;
    const scene = this.world.scene;
    const capture = this.captureRequested;
    const xrEnabled = renderer.xr.enabled;
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    const background = scene.background;
    renderer.xr.enabled = false;
    scene.background = null;
    renderer.setRenderTarget(this.rt);
    // Monitor gets a cool grey backdrop for contrast; captures stay transparent.
    renderer.setClearColor(capture ? 0xffffff : 0xc9ced6, capture ? 0 : 1);
    renderer.clear();
    renderer.render(scene, this.rtCamera);
    if (capture) renderer.readRenderTargetPixels(this.rt, 0, 0, RT_W, RT_H, this.pixels);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clearColor, prevAlpha);
    scene.background = background;
    renderer.xr.enabled = xrEnabled;
    if (capture) {
      this.captureRequested = false;
      this.frame = 2; // repaint the opaque monitor view next frame
      studioBridge.studio?.pasteOnPage(toUnderlay(this.pixels, RT_W, RT_H), 'ジオラマ下絵の配置');
      this.studioToast('カメラの構図を下絵として貼りました。動かして確定してください');
    }
  }

  private updateAxis(): void {
    const pair = this.pair;
    if (pair == null || !this.pieces.has(pair[0].id) || !this.pieces.has(pair[1].id)) {
      this.axis.visible = false;
      return;
    }
    const a = pair[0].object.position;
    const b = pair[1].object.position;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) {
      this.axis.visible = false;
      return;
    }
    const cam0 = this.cameraPiece?.object.position;
    const key = a.x + a.z * 7 + b.x * 13 + b.z * 17 + (cam0 ? cam0.x * 19 + cam0.z * 23 : 0);
    if (key === this.axisKey && this.axis.visible) return;
    this.axisKey = key;
    const ext = 5 / len;
    const attr = this.axis.geometry.getAttribute('position') as BufferAttribute;
    const arr = attr.array as Float32Array;
    arr[0] = a.x - dx * ext; arr[1] = 0.015; arr[2] = a.z - dz * ext;
    arr[3] = b.x + dx * ext; arr[4] = 0.015; arr[5] = b.z + dz * ext;
    attr.needsUpdate = true;
    this.axis.visible = true;
    const cam = this.cameraPiece?.object.position;
    if (cam == null) return;
    const side = Math.sign(dx * (cam.z - a.z) - dz * (cam.x - a.x));
    const crossed = this.cameraSide !== 0 && side !== 0 && side !== this.cameraSide;
    if (crossed !== this.crossed) {
      this.crossed = crossed;
      (this.axis.material as LineBasicMaterial).color.set(crossed ? 0xff5a5a : 0xffd34d);
      if (crossed) this.studioToast('イマジナリーラインを越えました (左右の位置関係が反転します)');
    }
    // The reference side is fixed when the pair is chosen or a cut is saved; dropping the
    // camera across the line keeps the warning (that is the point of the 180-degree rule).
    if (side !== 0 && this.cameraSide === 0) this.cameraSide = side;
  }

  // ---------- pieces ----------

  private spawn(kind: string, save?: DioramaSave): Piece {
    let object: Object3D;
    const fig = FIGURES[kind];
    if (fig != null) {
      object = createFigure(fig.color, fig.height);
      object.userData.height = fig.height;
      const label = labelSprite(fig.label, fig.color);
      label.position.set(0, fig.height + 0.45, 0);
      object.add(label);
    } else if (kind === 'camera') {
      object = createCameraProp();
    } else {
      object = createProp(kind as PropKind);
    }
    // Per-piece materials so disposing one piece never touches another.
    object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = (mesh.material as MeshBasicMaterial).clone();
    });
    // Yaw-first order: handle clamps decompose in this order, so pieces can face backwards.
    object.rotation.order = 'YXZ';
    const id = save?.id ?? newId('dio');
    if (save != null) {
      object.position.set(save.x, save.y, save.z);
      object.rotation.set(save.pitch ?? 0, save.yaw, 0, 'YXZ');
    } else if (kind === 'camera') {
      object.position.set(0, 1.5, 3.1);
      object.rotation.set(-0.12, Math.PI, 0, 'YXZ');
    } else {
      // Spread new pieces along an arc in front of the camera so none hide another.
      const n = Math.max(0, this.pieces.size - 1);
      const slot = n % 7;
      const ring = 1 + Math.floor(n / 7);
      const angle = ((slot - 3) / 7) * Math.PI * 0.9;
      object.position.set(Math.sin(angle) * ring * 0.9, 0, -Math.cos(angle) * ring * 0.9 + 0.6);
    }
    if (kind !== 'camera') {
      object.traverse((o) => {
        if (!(o instanceof Sprite)) o.layers.enable(LAYER);
      });
    }
    const entity = this.world.createTransformEntity(object, { parent: this.stageEntity });
    entity.addComponent(DioramaItem, { itemId: id, kind });
    entity.addComponent(RayInteractable);
    const upright = kind !== 'camera';
    const rotateMin: [number, number, number] = upright ? [0, -Infinity, 0] : [-Infinity, -Infinity, -Infinity];
    const rotateMax: [number, number, number] = upright ? [0, Infinity, 0] : [Infinity, Infinity, Infinity];
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      scale: false,
      rotate: true,
      rotateMin,
      rotateMax,
    });
    // One grab handle per entity: GrabSystem ignores a second grabbable type, so ray grab only.
    const piece: Piece = { id, kind, entity, object, pose: 'stand', gaze: null };
    if (fig != null) {
      piece.gaze = this.makeGaze(fig.color, fig.height);
      object.getObjectByName('Neck')?.add(piece.gaze);
      piece.gaze.visible = this.gaze;
      piece.pose = (save?.pose ?? 'stand') as Pose;
      applyPose(object, piece.pose);
    }
    if (kind === 'camera') {
      this.cameraPiece = piece;
      this.rtCamera.removeFromParent();
      this.rtCamera.position.set(0, 0, 0.45);
      this.rtCamera.rotation.set(0, Math.PI, 0);
      object.add(this.rtCamera);
    }
    this.pieces.set(id, piece);
    return piece;
  }

  private makeGaze(color: string, height: number): Line {
    const k = height / 1.7;
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0.18 * k, 0.12 * k, 0, 0.18 * k, 4.5]), 3),
    );
    const line = new Line(geometry, new LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    line.raycast = () => undefined;
    line.name = 'Gaze';
    return line;
  }

  private remove(piece: Piece): void {
    if (piece === this.cameraPiece) {
      this.studioToast('カメラは削除できません');
      return;
    }
    this.pieces.delete(piece.id);
    if (this.selected === piece) this.select(null);
    piece.entity.dispose();
  }

  private load(saves: readonly DioramaSave[]): void {
    for (const piece of [...this.pieces.values()]) {
      if (piece === this.cameraPiece) this.rtCamera.removeFromParent();
      piece.entity.dispose();
    }
    this.pieces.clear();
    this.pair = null;
    this.cameraPiece = null;
    this.select(null);
    for (const save of saves) this.spawn(save.kind, save);
    if (this.cameraPiece == null) this.spawn('camera');
  }

  private persist(): void {
    this.viewDirty = true;
    const bridge = studioBridge.studio;
    if (bridge == null) return;
    bridge.project.diorama = [...this.pieces.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      color: FIGURES[p.kind]?.color ?? '',
      label: FIGURES[p.kind]?.label ?? '',
      pose: p.pose,
      x: p.object.position.x,
      y: p.object.position.y,
      z: p.object.position.z,
      yaw: p.object.rotation.y,
      pitch: p.kind === 'camera' ? p.object.rotation.x : 0,
    }));
    bridge.markDirty();
  }

  private pieceOf(entity: Entity): Piece | undefined {
    return this.pieces.get(String(entity.getValue(DioramaItem, 'itemId')));
  }

  private selectEntity(entity: Entity): void {
    const piece = this.pieceOf(entity);
    if (piece != null) this.select(piece);
  }

  private select(piece: Piece | null): void {
    const prev = this.selected;
    if (piece != null && prev != null && piece !== prev && FIGURES[piece.kind] != null && FIGURES[prev.kind] != null) {
      this.pair = [prev, piece];
      this.cameraSide = 0;
    }
    this.selected = piece;
    this.ring.visible = piece != null && piece.kind !== 'camera';
    const panel = this.panel;
    if (panel == null) return;
    const label =
      piece == null ? 'なし' : (FIGURES[piece.kind]?.label ?? KIND_LABELS[piece.kind] ?? piece.kind);
    setText(panel, 'dio-sel-label', `選択: ${label}`);
    const figure = piece != null && FIGURES[piece.kind] != null;
    for (const pose of POSE_IDS) setChip(panel, `dio-pose-${pose}`, figure && piece.pose === pose);
  }

  private onReleased(entity: Entity): void {
    const piece = this.pieceOf(entity);
    if (piece == null) return;
    const o = piece.object;
    if (piece.kind !== 'camera') {
      o.rotation.set(0, o.rotation.y, 0, 'YXZ');
      o.position.y = 0;
    } else {
      o.rotation.set(o.rotation.x, o.rotation.y, 0, 'YXZ');
      o.position.y = Math.max(0.2, o.position.y);
    }
    const r = Math.hypot(o.position.x, o.position.z);
    const max = STAGE_RADIUS * 1.6;
    if (r > max) {
      o.position.x *= max / r;
      o.position.z *= max / r;
    }
    this.persist();
  }

  private applyStageTransform(): void {
    this.viewDirty = true;
    const root = this.stageRoot;
    if (!this.lifeSize) {
      root.position.set(0, 0, 0);
      root.scale.setScalar(MINI);
      root.rotation.set(0, this.stageYaw, 0);
      return;
    }
    // Life size: put the stage on the real floor in front of the viewer.
    const rig = this.world.requireSceneObject('studio-rig');
    rig.updateWorldMatrix(true, false);
    this.anchor.updateWorldMatrix(true, false);
    const target = this.tmpV.set(0, 0, -2.6).applyMatrix4(rig.matrixWorld);
    target.y = 0;
    this.anchor.worldToLocal(target);
    root.position.copy(target);
    root.scale.setScalar(1);
    const e = rig.matrixWorld.elements;
    const a = this.anchor.matrixWorld.elements;
    const rigYaw = Math.atan2(e[8]!, e[10]!);
    const anchorYaw = Math.atan2(a[8]!, a[10]!);
    root.rotation.set(0, rigYaw - anchorYaw + this.stageYaw, 0);
  }

  private studioToast(message: string): void {
    studioBridge.studio?.toast(message);
    if (this.panel != null) setText(this.panel, 'dio-status', message);
  }

  // ---------- palette ----------

  private bindPanel(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('diorama-palette');
    if (panel == null) return;
    this.panel = panel;
    applyJapaneseFont(panel, 'diorama-root');
    const c = this.cleanupFuncs;
    for (const kind of [...Object.keys(FIGURES), ...Object.keys(KIND_LABELS)]) {
      if (kind !== 'camera') bindButton(panel, `dio-${kind}`, () => this.add(kind), c);
    }
    const turn = (rad: number) => {
      if (this.selected == null) return;
      this.selected.object.rotation.y += rad;
      this.persist();
    };
    bindButton(panel, 'dio-rotl', () => turn(Math.PI / 4), c);
    bindButton(panel, 'dio-rotr', () => turn(-Math.PI / 4), c);
    bindButton(panel, 'dio-dup', () => this.duplicate(), c);
    bindButton(panel, 'dio-delete', () => {
      if (this.selected == null) return;
      this.remove(this.selected);
      this.persist();
    }, c);
    for (const pose of POSE_IDS) {
      bindButton(panel, `dio-pose-${pose}`, () => this.pose(pose), c);
    }
    bindButton(panel, 'dio-stage-rotl', () => this.turnStage(Math.PI / 4), c);
    bindButton(panel, 'dio-stage-rotr', () => this.turnStage(-Math.PI / 4), c);
    bindButton(panel, 'dio-scale', () => {
      this.lifeSize = !this.lifeSize;
      this.applyStageTransform();
      setText(panel, 'dio-scale-label', this.lifeSize ? 'ミニに戻す' : '原寸で見る');
      setChip(panel, 'dio-scale', this.lifeSize);
      this.studioToast(this.lifeSize ? '原寸表示: 正面の床に置きました。歩いて確認できます' : 'ミニチュア表示に戻しました');
    }, c);
    bindButton(panel, 'dio-gaze', () => {
      this.gaze = !this.gaze;
      for (const p of this.pieces.values()) if (p.gaze != null) p.gaze.visible = this.gaze;
      setChip(panel, 'dio-gaze', this.gaze);
    }, c);
    bindButton(panel, 'dio-clear', () => this.clearAll(), c);
    for (const lens of LENSES) {
      bindButton(panel, `dio-cam-${lens}`, () => {
        this.rtCamera.fov = FOV[lens];
        this.rtCamera.updateProjectionMatrix();
        this.viewDirty = true;
        for (const l of LENSES) setChip(panel, `dio-cam-${l}`, l === lens);
      }, c);
    }
    bindButton(panel, 'dio-cut-save', () => {
      const bridge = studioBridge.studio;
      const pageId = bridge?.project.currentPage;
      if (bridge == null || pageId == null) return;
      if (bridge.project.cuts[pageId] != null && !this.armCut(`save:${pageId}`, 'このページのカットを上書きします。もう一度押して確定')) return;
      this.persist();
      bridge.project.cuts[pageId] = bridge.project.diorama.map((d) => ({ ...d }));
      // The camera side at save time becomes the reference for the 180-degree rule.
      this.cameraSide = 0;
      this.crossed = false;
      bridge.markDirty();
      this.studioToast(`P${bridge.project.pageNumber(pageId)} のカットとして配置とカメラを保存しました`);
    }, c);
    bindButton(panel, 'dio-cut-load', () => {
      const bridge = studioBridge.studio;
      const pageId = bridge?.project.currentPage;
      const cut = pageId != null ? bridge?.project.cuts[pageId] : undefined;
      if (bridge == null || pageId == null || cut == null) {
        this.studioToast('このページに保存したカットはありません');
        return;
      }
      if (!this.armCut(`load:${pageId}`, '今の配置を置き換えます。もう一度押して呼出 (先に「このページに保存」で残せます)')) return;
      this.persist();
      const pairIds = this.pair?.map((p) => p.id);
      this.load(cut);
      if (pairIds != null) {
        const a = this.pieces.get(pairIds[0]!);
        const b = this.pieces.get(pairIds[1]!);
        if (a != null && b != null) this.pair = [a, b];
      }
      this.persist();
      this.studioToast(`P${bridge.project.pageNumber(pageId)} のカットを呼び出しました`);
    }, c);
    bindButton(panel, 'dio-cam-paste', () => {
      this.captureRequested = true;
    }, c);
  }

  /** Two presses within 3 s confirm a destructive cut action. */
  private armCut(key: string, message: string): boolean {
    const now = performance.now();
    if (this.cutArmed.key === key && now - this.cutArmed.time < 3000) {
      this.cutArmed = { key: '', time: 0 };
      return true;
    }
    this.cutArmed = { key, time: now };
    this.studioToast(message);
    return false;
  }

  private add(kind: string): void {
    const piece = this.spawn(kind);
    this.select(piece);
    this.persist();
    this.studioToast(`${FIGURES[kind]?.label ?? KIND_LABELS[kind] ?? kind} を置きました`);
  }

  private duplicate(): void {
    const src = this.selected;
    if (src == null || src === this.cameraPiece) return;
    const o = src.object;
    const copy = this.spawn(src.kind, {
      id: newId('dio'),
      kind: src.kind,
      color: '',
      label: '',
      pose: src.pose,
      x: o.position.x + 0.5,
      y: o.position.y,
      z: o.position.z + 0.3,
      yaw: o.rotation.y,
    });
    this.select(copy);
    this.persist();
  }

  private pose(pose: Pose): void {
    const piece = this.selected;
    if (piece == null || FIGURES[piece.kind] == null) {
      this.studioToast('キャラクターを選んでからポーズを変えます');
      return;
    }
    piece.pose = pose;
    applyPose(piece.object, pose);
    this.select(piece);
    this.persist();
  }

  private turnStage(rad: number): void {
    this.stageYaw += rad;
    this.applyStageTransform();
  }

  private clearAll(): void {
    const panel = this.panel;
    const now = performance.now();
    if (now - this.clearArmed > 2500) {
      this.clearArmed = now;
      if (panel != null) setText(panel, 'dio-clear-label', 'もう一度で消去');
      return;
    }
    this.clearArmed = 0;
    if (panel != null) setText(panel, 'dio-clear-label', '全消去');
    for (const p of [...this.pieces.values()]) if (p !== this.cameraPiece) this.remove(p);
    this.persist();
  }
}

const POSE_IDS = ['stand', 'walk', 'sit', 'point', 'lie'] as const;
const LENSES = ['wide', 'normal', 'tele'] as const;

const KIND_LABELS: Record<string, string> = {
  chair: '椅子',
  table: '机',
  sofa: 'ソファ',
  bed: 'ベッド',
  box: '箱',
  lamp: '街灯',
  wall: '壁',
  door: 'ドア',
  window: '窓',
  tree: '木',
  car: '車',
  building: '建物',
  camera: 'カメラ',
};

function monitorCaption(): Mesh {
  const canvas = makeCanvas(512, 64);
  const c = ctx2d(canvas);
  c.fillStyle = '#cfd5de';
  c.font = '600 34px "M PLUS 1p", sans-serif';
  c.textBaseline = 'middle';
  c.fillText('カメラビュー', 8, 32);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(0.16, 0.02), new MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.position.set(-0.08, 0.133, 0.001);
  mesh.raycast = () => undefined;
  return mesh;
}
