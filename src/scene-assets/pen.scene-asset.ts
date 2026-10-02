// Stylus held in each hand or controller, authored in meters: origin at the writing
// tip, body along +Y, 14 cm long. Rotationally symmetric, so every section is a lathe
// profile and neighbouring sections share their seam radius. Materials are created
// per instance so each pen can show its own tool and fade on its own.
import {
  BoxGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector2,
  type Object3D,
} from '@iwsdk/core';

export const PEN_LENGTH = 0.14;

/** Band colour per tool; the pen itself shows its ink colour. */
const TOOL_BANDS: Record<string, string> = {
  eraser: '#ff8fa3',
  line: '#4c8dff',
  frame: '#2a9d8f',
  text: '#e2b13c',
  select: '#9b7bff',
  lasso: '#c45cd6',
};

const SEGMENTS = 28;
/** Lathe poles keep a hair of radius: a zero radius collapses the cap triangles. */
const POLE = 0.0002;

/** Lathe a profile of [radius, y] pairs (bottom to top) around +Y. */
function lathe(name: string, profile: ReadonlyArray<readonly [number, number]>, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), SEGMENTS), material);
  mesh.name = name;
  return mesh;
}

export function createPen(): Group {
  const body = new MeshStandardMaterial({ name: 'PenBody', color: '#e9ebef', roughness: 0.32, metalness: 0.05 });
  const grip = new MeshStandardMaterial({ name: 'PenGrip', color: '#2b2f36', roughness: 0.85, metalness: 0 });
  const trim = new MeshStandardMaterial({ name: 'PenTrim', color: '#a3aab4', roughness: 0.28, metalness: 0.7 });
  const nib = new MeshStandardMaterial({ name: 'PenNib', color: '#1a1a1a', roughness: 0.4, metalness: 0.25 });
  const band = new MeshStandardMaterial({ name: 'PenBand', color: '#1a1a1a', roughness: 0.38, metalness: 0.1 });
  const rubber = new MeshStandardMaterial({ name: 'PenEraser', color: '#ff9fb1', roughness: 0.92, metalness: 0 });

  const root = new Group();
  root.name = 'StylusPen';

  const tip = new Group();
  tip.name = 'Tip';
  tip.add(
    lathe('Nib', [[POLE, 0], [0.0006, 0.0012], [0.0011, 0.004], [0.0014, 0.0065]], nib),
    lathe('EraserTip', [[POLE, 0], [0.0024, 0.0005], [0.0037, 0.0019], [0.0044, 0.0042], [0.0045, 0.0085], [0.0042, 0.009]], rubber),
  );
  tip.getObjectByName('EraserTip')!.visible = false;

  const front = new Group();
  front.name = 'Front';
  front.add(
    lathe('Cone', [[0.0014, 0.0065], [0.0022, 0.0102], [0.0034, 0.0162], [0.0041, 0.0212], [0.0043, 0.023]], body),
    lathe('Collar', [[0.0043, 0.023], [0.0047, 0.0236], [0.0047, 0.0254], [0.0043, 0.026]], trim),
    lathe('Grip', [[0.0043, 0.026], [0.0047, 0.0292], [0.0045, 0.0375], [0.0043, 0.0438], [0.0046, 0.0515], [0.0047, 0.056]], grip),
  );

  const barrel = new Group();
  barrel.name = 'Barrel';
  barrel.add(
    lathe('BarrelFront', [[0.0047, 0.056], [0.0049, 0.0705], [0.0049, 0.099]], body),
    lathe('ToolBand', [[0.0049, 0.099], [0.0053, 0.0996], [0.0053, 0.1064], [0.0049, 0.107]], band),
    lathe('BarrelRear', [[0.0049, 0.107], [0.0048, 0.1245], [0.0046, 0.13]], body),
    lathe('EndCap', [[0.0046, 0.13], [0.0044, 0.1342], [0.0036, 0.1376], [0.002, 0.1395], [POLE, 0.14]], trim),
  );

  // Pocket clip: a root block on the end cap and a spring arm running down the barrel.
  const clip = new Group();
  clip.name = 'Clip';
  const clipRoot = new Mesh(new BoxGeometry(0.003, 0.005, 0.0016), trim);
  clipRoot.name = 'ClipRoot';
  clipRoot.position.set(0, 0.1305, 0.0049);
  const clipArm = new Mesh(new BoxGeometry(0.0026, 0.03, 0.0008), trim);
  clipArm.name = 'ClipArm';
  clipArm.position.set(0, 0.1165, 0.0058);
  const clipFoot = new Mesh(new BoxGeometry(0.0026, 0.0024, 0.0014), trim);
  clipFoot.name = 'ClipFoot';
  clipFoot.position.set(0, 0.1018, 0.0055);
  clip.add(clipRoot, clipArm, clipFoot);

  root.add(tip, front, barrel, clip);
  return root;
}

function material(pen: Object3D, mesh: string): MeshStandardMaterial | null {
  const found = pen.getObjectByName(mesh) as Mesh | undefined;
  return (found?.material as MeshStandardMaterial | undefined) ?? null;
}

/**
 * Show `tool` on the pen: ink colour on the nib and band for the pen, a rubber tip for
 * the eraser, a coloured band for the rest. A pen that is not gripped fades out.
 */
export function setPenLook(pen: Object3D, tool: string, inkColor: string, held: boolean): void {
  // Called every frame: bail out without allocating when nothing changed.
  const look = pen.userData as { tool?: string; ink?: string; held?: boolean };
  if (look.tool === tool && look.ink === inkColor && look.held === held) return;
  look.tool = tool;
  look.ink = inkColor;
  look.held = held;
  const eraser = tool === 'eraser';
  pen.getObjectByName('Nib')!.visible = !eraser;
  pen.getObjectByName('EraserTip')!.visible = eraser;
  material(pen, 'Nib')?.color.set(tool === 'pen' ? inkColor : '#30343b');
  material(pen, 'ToolBand')?.color.set(tool === 'pen' ? inkColor : (TOOL_BANDS[tool] ?? '#9aa1ab'));
  const seen = new Set<MeshStandardMaterial>();
  pen.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (m == null || seen.has(m)) return;
    seen.add(m);
    if (m.transparent !== !held) m.needsUpdate = true;
    m.transparent = !held;
    m.opacity = held ? 1 : 0.4;
    m.depthWrite = held;
  });
}

/** Manifest preview prototype: a pen standing on its tip. */
export default function createPenPreview(): Group {
  const pen = createPen();
  setPenLook(pen, 'pen', '#1A1A1A', true);
  return pen;
}
