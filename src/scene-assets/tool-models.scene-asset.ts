// Hand-held tool models, one per board tool, authored in meters: origin at the
// contact tip, body along +Y, gripped between thumb and index about 2.8 cm up.
// Flat faces (ruler, stamp label, icon heads) look along +Z; PenRig rolls each model
// about its axis so +Z faces the viewer. Materials are created per instance so each
// hand's set shows its own tool and fades on its own.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from '@iwsdk/core';
import type { ToolId } from '../studio/doc.js';
import { bevelBox } from './lib/hardsurface.js';

/** Tools that put something in the hand ('hand' is the empty hand). */
export const HELD_TOOLS = ['pen', 'eraser', 'line', 'frame', 'text', 'select', 'lasso'] as const;
export type HeldTool = (typeof HELD_TOOLS)[number];

/** Signature colour per tool, matching the palette's accents. */
const TOOL_COLORS: Record<Exclude<HeldTool, 'pen'>, string> = {
  eraser: '#ff7f98',
  line: '#4c8dff',
  frame: '#2a9d8f',
  text: '#e2b13c',
  select: '#9b7bff',
  lasso: '#c45cd6',
};

const SEGMENTS = 28;
/** Lathe poles keep a hair of radius: a zero radius collapses the cap triangles. */
const POLE = 0.0002;
/** Opacity of a tool that is shown but not gripped. */
const IDLE_FADE = 0.4;

function mat(name: string, color: string, roughness: number, metalness = 0, opacity = 1): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ name, color, roughness, metalness });
  m.userData.baseOpacity = opacity;
  if (opacity < 1) {
    m.transparent = true;
    m.opacity = opacity;
    m.depthWrite = false;
  }
  return m;
}

function named<T extends Object3D>(object: T, name: string, x = 0, y = 0, z = 0): T {
  object.name = name;
  object.position.set(x, y, z);
  return object;
}

/** Lathe a profile of [radius, y] pairs (bottom to top) around +Y. */
function lathe(name: string, profile: ReadonlyArray<readonly [number, number]>, material: MeshStandardMaterial): Mesh {
  return named(new Mesh(new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), SEGMENTS), material), name);
}

/** Flat outline of a w x h rectangle with stroke `t`, centred, lying in XY. */
function rectOutline(w: number, h: number, t: number): ShapeGeometry {
  const outer = new Shape();
  outer.moveTo(-w / 2, -h / 2).lineTo(w / 2, -h / 2).lineTo(w / 2, h / 2).lineTo(-w / 2, h / 2).closePath();
  const hole = new Shape();
  const iw = w / 2 - t;
  const ih = h / 2 - t;
  hole.moveTo(-iw, -ih).lineTo(-iw, ih).lineTo(iw, ih).lineTo(iw, -ih).closePath();
  outer.holes.push(hole);
  return new ShapeGeometry(outer);
}

// ---------- pen: a 14 cm stylus whose nib and band show the ink ----------

function createPen(): Group {
  const body = mat('PenBody', '#e9ebef', 0.32, 0.05);
  const grip = mat('PenGrip', '#2b2f36', 0.85);
  const trim = mat('PenTrim', '#a3aab4', 0.28, 0.7);
  const nib = mat('PenNib', '#1a1a1a', 0.4, 0.25);
  const band = mat('PenBand', '#1a1a1a', 0.38, 0.1);

  const front = named(new Group(), 'Front');
  front.add(
    lathe('Nib', [[POLE, 0], [0.0006, 0.0012], [0.0011, 0.004], [0.0014, 0.0065]], nib),
    lathe('Cone', [[0.0014, 0.0065], [0.0022, 0.0102], [0.0034, 0.0162], [0.0041, 0.0212], [0.0043, 0.023]], body),
    lathe('Collar', [[0.0043, 0.023], [0.0047, 0.0236], [0.0047, 0.0254], [0.0043, 0.026]], trim),
    lathe('Grip', [[0.0043, 0.026], [0.0047, 0.0292], [0.0045, 0.0375], [0.0043, 0.0438], [0.0046, 0.0515], [0.0047, 0.056]], grip),
  );
  const barrel = named(new Group(), 'Barrel');
  barrel.add(
    lathe('BarrelFront', [[0.0047, 0.056], [0.0049, 0.0705], [0.0049, 0.099]], body),
    lathe('InkBand', [[0.0049, 0.099], [0.0053, 0.0996], [0.0053, 0.1064], [0.0049, 0.107]], band),
    lathe('BarrelRear', [[0.0049, 0.107], [0.0048, 0.1245], [0.0046, 0.13]], body),
    lathe('EndCap', [[0.0046, 0.13], [0.0044, 0.1342], [0.0036, 0.1376], [0.002, 0.1395], [POLE, 0.14]], trim),
  );
  // Pocket clip: a root block on the end cap and a spring arm running down the barrel.
  const clip = named(new Group(), 'Clip');
  clip.add(
    named(new Mesh(new BoxGeometry(0.003, 0.005, 0.0016), trim), 'ClipRoot', 0, 0.1305, 0.0049),
    named(new Mesh(new BoxGeometry(0.0026, 0.03, 0.0008), trim), 'ClipArm', 0, 0.1165, 0.0058),
    named(new Mesh(new BoxGeometry(0.0026, 0.0024, 0.0014), trim), 'ClipFoot', 0, 0.1018, 0.0055),
  );
  const root = named(new Group(), 'Pen');
  root.add(front, barrel, clip);
  return root;
}

// ---------- eraser: a sleeved block, rubbed on its bottom face ----------

function createEraser(): Group {
  const rubber = mat('EraserRubber', '#f3f0e8', 0.95);
  const sleeve = mat('EraserSleeve', TOOL_COLORS.eraser, 0.6);
  const stripe = mat('EraserStripe', '#ffffff', 0.6);
  const ink = mat('EraserInk', '#2b2f36', 0.6);
  const root = named(new Group(), 'Eraser');
  // 2.4 x 1.2 cm section, 5.8 cm long; the worn bottom is the contact face.
  root.add(named(new Mesh(bevelBox(0.024, 0.058, 0.012, 0.0022, 0.003), rubber), 'Block', 0, 0.029, 0));
  // Paper sleeve over the upper body, open at both ends so the rubber shows.
  const wrap = named(new Group(), 'Sleeve');
  wrap.add(
    named(new Mesh(bevelBox(0.0248, 0.034, 0.0128, 0.0008, 0.0026), sleeve), 'Paper', 0, 0.035, 0),
    named(new Mesh(bevelBox(0.0251, 0.007, 0.0131, 0.0008, 0.0027), stripe), 'Band', 0, 0.041, 0),
    named(new Mesh(bevelBox(0.0252, 0.0018, 0.0132, 0.0006, 0.0027), ink), 'Rule', 0, 0.0362, 0),
  );
  root.add(wrap);
  return root;
}

// ---------- line: a clear 15 cm ruler drawn along at its bottom edge ----------

/** Merged graduation quads on the ruler face: every 5 mm, longer at each centimetre. */
function graduations(length: number, edgeX: number, z: number): BufferGeometry {
  const quads: number[] = [];
  const w = 0.0005;
  for (let mm = 5; mm < length * 1000 - 4; mm += 5) {
    const y = mm / 1000;
    const len = mm % 10 === 0 ? 0.0065 : 0.0035;
    const x0 = edgeX;
    const x1 = edgeX + len;
    quads.push(x0, y - w / 2, z, x1, y - w / 2, z, x1, y + w / 2, z, x0, y - w / 2, z, x1, y + w / 2, z, x0, y + w / 2, z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(quads), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createRuler(): Group {
  const acrylic = mat('RulerAcrylic', '#9ccaff', 0.12, 0, 0.42);
  const edge = mat('RulerEdge', TOOL_COLORS.line, 0.35);
  const print = mat('RulerPrint', '#173462', 0.5);
  const root = named(new Group(), 'Ruler');
  const length = 0.15;
  const width = 0.028;
  const thick = 0.003;
  root.add(named(new Mesh(bevelBox(width, length, thick, 0.0007, 0.0012), acrylic), 'Plate', 0, length / 2, 0));
  // Opaque straightedge stripe along one side gives the clear plate a readable outline.
  root.add(named(new Mesh(bevelBox(0.003, length - 0.004, thick + 0.0004, 0.0005), edge), 'Edge', width / 2 - 0.0015, length / 2, 0));
  root.add(named(new Mesh(graduations(length, -width / 2 + 0.0012, thick / 2 + 0.0002), print), 'Graduations'));
  // Hanging hole near the top end and a drawing-point chevron at the contact edge.
  root.add(named(new Mesh(new TorusGeometry(0.0028, 0.0005, 6, 24), print), 'HangHole', 0.002, length - 0.009, 0));
  const chevron = new Shape();
  chevron.moveTo(0, 0.0015).lineTo(0.0032, 0.0065).lineTo(-0.0032, 0.0065).closePath();
  root.add(named(new Mesh(new ShapeGeometry(chevron), edge), 'DrawPoint', 0, 0, thick / 2 + 0.0002));
  return root;
}

// ---------- frame: a panel stamp; its face and labels carry the panel border ----------

/** White label with a black panel border, lying in XY facing +Z. */
function panelLabel(name: string, w: number, h: number, paper: MeshStandardMaterial, ink: MeshStandardMaterial): Group {
  const label = named(new Group(), name);
  label.add(named(new Mesh(new BoxGeometry(w, h, 0.0004), paper), 'Paper'));
  label.add(named(new Mesh(rectOutline(w * 0.72, h * 0.62, Math.min(w, h) * 0.12), ink), 'Border', 0, 0, 0.00022));
  return label;
}

function createStamp(): Group {
  const handle = mat('StampHandle', TOOL_COLORS.frame, 0.45);
  const mount = mat('StampMount', '#30353d', 0.55);
  const rubber = mat('StampRubber', '#1c1d20', 0.9);
  const paper = mat('StampPaper', '#f6f4ee', 0.7);
  const ink = mat('StampInk', '#16181c', 0.6);
  const root = named(new Group(), 'Stamp');
  // Rubber face (the contact) under a mount block, 3.6 x 2.4 cm: a wide manga panel.
  root.add(named(new Mesh(bevelBox(0.034, 0.003, 0.022, 0.0006, 0.001), rubber), 'Face', 0, 0.0015, 0));
  root.add(named(new Mesh(bevelBox(0.036, 0.012, 0.024, 0.0016, 0.002), mount), 'Mount', 0, 0.009, 0));
  root.add(panelLabel('FrontLabel', 0.028, 0.0075, paper, ink));
  root.getObjectByName('FrontLabel')!.position.set(0, 0.009, 0.0122);
  // Turned knob: a neck to pinch, a bulb above the fingers, the stamp image on its cap.
  root.add(
    lathe('Knob', [
      [0.0085, 0.015], [0.0072, 0.0168], [0.0058, 0.022], [0.0056, 0.031], [0.0068, 0.038],
      [0.0098, 0.0445], [0.0112, 0.05], [0.0108, 0.0545], [0.0092, 0.0575], [0.006, 0.0592], [POLE, 0.0596],
    ], handle),
  );
  const cap = panelLabel('CapLabel', 0.011, 0.0075, paper, ink);
  cap.position.set(0, 0.0598, 0);
  cap.rotation.x = -Math.PI / 2;
  root.add(cap);
  return root;
}

// ---------- shared wand: pointed tip, finger grip and a shaft carrying an icon ----------

function wand(name: string, color: string, top: number): Group {
  const shaft = mat(`${name}Shaft`, color, 0.42, 0.05);
  const nib = mat(`${name}Nib`, '#2b2f36', 0.4, 0.2);
  const grip = mat(`${name}Grip`, '#2b2f36', 0.85);
  const stick = named(new Group(), 'Wand');
  stick.add(
    lathe('Nib', [[POLE, 0], [0.0008, 0.0016], [0.0016, 0.006]], nib),
    lathe('Cone', [[0.0016, 0.006], [0.0032, 0.014], [0.0042, 0.021]], shaft),
    lathe('Grip', [[0.0042, 0.021], [0.0047, 0.026], [0.0045, 0.038], [0.0047, 0.05], [0.0043, 0.054]], grip),
    lathe('Shaft', [[0.0043, 0.054], [0.0034, 0.06], [0.003, top - 0.004], [0.0038, top]], shaft),
  );
  return stick;
}

// ---------- text: a speech bubble with lines of dialogue ----------

function createTextWand(): Group {
  const white = mat('BubbleFill', '#fbfaf6', 0.55);
  const outline = mat('BubbleOutline', '#16181c', 0.5);
  const lines = mat('BubbleLines', '#3a3f48', 0.6);
  const root = named(new Group(), 'TextWand');
  const top = 0.086;
  root.add(wand('Text', TOOL_COLORS.text, top));
  // Ellipse body whose tail runs down into the shaft top.
  const cx = 0.005;
  const cy = top + 0.026;
  const shape = new Shape();
  shape.absellipse(cx, cy, 0.027, 0.0185, -1.42, -2.02 + Math.PI * 2, false, 0);
  shape.lineTo(0, top - 0.001);
  shape.closePath();
  const depth = 0.004;
  const bevel = 0.0016;
  const extrude = (s: Shape) => {
    const g = new ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 40 });
    g.translate(0, 0, -depth / 2);
    return g;
  };
  const bubble = named(new Group(), 'Bubble');
  bubble.add(named(new Mesh(extrude(shape), white), 'Fill'));
  // Ink rim: the same outline grown about the bubble centre, set just behind.
  const rim = named(new Mesh(extrude(shape), outline), 'Rim');
  rim.geometry.translate(-cx, -cy, 0).scale(1.075, 1.11, 0.8).translate(cx, cy, -0.0006);
  bubble.add(rim);
  const front = depth / 2 + bevel + 0.0002;
  [0.03, 0.025, 0.016].forEach((w, i) => {
    const line = new Mesh(bevelBox(w, 0.0028, 0.0006, 0.0002, 0.0012), lines);
    bubble.add(named(line, `Line${i}`, cx - (0.03 - w) / 2, cy + 0.0062 - i * 0.0062, front));
  });
  root.add(bubble);
  return root;
}

// ---------- select: a dashed marquee with corner handles ----------

function createSelectWand(): Group {
  const fill = mat('MarqueeFill', '#c9b8ff', 0.4, 0, 0.55);
  const dash = mat('MarqueeDash', '#f7f5ff', 0.45);
  const handleMat = mat('MarqueeHandle', '#ffffff', 0.4);
  const handleRim = mat('MarqueeHandleRim', TOOL_COLORS.select, 0.4);
  const root = named(new Group(), 'SelectWand');
  const top = 0.088;
  root.add(wand('Select', TOOL_COLORS.select, top));
  const side = 0.038;
  const cy = top + side / 2;
  const marquee = named(new Group(), 'Marquee');
  marquee.position.set(0, cy, 0);
  marquee.add(named(new Mesh(new BoxGeometry(side, side, 0.0012), fill), 'Area'));
  // Tab joining the shaft to the bottom edge, in the gap between its middle dashes.
  marquee.add(named(new Mesh(bevelBox(0.0075, 0.006, 0.0042, 0.0008, 0.0012), handleRim), 'Mount', 0, -side / 2 + 0.0005, 0));
  // Four dashes per side between the corner handles.
  const t = 0.0022;
  const run = side - 0.008;
  const dashLen = run / 7;
  const dashGeoH = new BoxGeometry(dashLen, t, 0.0026);
  const dashGeoV = new BoxGeometry(t, dashLen, 0.0026);
  for (let k = 0; k < 4; k++) {
    const offset = -run / 2 + dashLen / 2 + k * 2 * dashLen;
    marquee.add(
      named(new Mesh(dashGeoH, dash), `DashTop${k}`, offset, side / 2, 0),
      named(new Mesh(dashGeoH, dash), `DashBottom${k}`, offset, -side / 2, 0),
      named(new Mesh(dashGeoV, dash), `DashLeft${k}`, -side / 2, offset, 0),
      named(new Mesh(dashGeoV, dash), `DashRight${k}`, side / 2, offset, 0),
    );
  }
  const knob = bevelBox(0.0062, 0.0062, 0.0036, 0.0008, 0.0012);
  const knobRim = bevelBox(0.0078, 0.0078, 0.003, 0.0008, 0.0016);
  for (const [i, [sx, sy]] of ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).entries()) {
    const corner = named(new Group(), `Handle${i}`, (sx * side) / 2, (sy * side) / 2, 0);
    corner.add(named(new Mesh(knobRim, handleRim), 'Rim'), named(new Mesh(knob, handleMat), 'Knob'));
    marquee.add(corner);
  }
  root.add(marquee);
  return root;
}

// ---------- lasso: a rope end to draw with, a coiled grip and the noose ----------

function createLasso(): Group {
  const rope = mat('LassoRope', '#d6b98a', 0.92);
  const wrap = mat('LassoWrap', TOOL_COLORS.lasso, 0.5);
  const whip = mat('LassoWhipping', '#3a2f28', 0.8);
  const root = named(new Group(), 'Lasso');
  const r = 0.0017;
  // The standing end runs straight up the middle of the coil; its whipped tip draws.
  const core = new CatmullRomCurve3([new Vector3(0, 0.003, 0), new Vector3(0, 0.03, 0), new Vector3(0, 0.054, 0)]);
  root.add(named(new Mesh(new TubeGeometry(core, 12, r, 8, false), rope), 'StandingEnd'));
  root.add(lathe('Whipping', [[POLE, 0], [0.0014, 0.0004], [0.0020, 0.0012], [0.0020, 0.0038], [0.0017, 0.0044]], whip));
  // Six turns of coiled rope form the grip, bound in the tool colour.
  const turns = 6;
  const coilPoints: Vector3[] = [];
  for (let i = 0; i <= turns * 12; i++) {
    const t = i / (turns * 12);
    const a = t * turns * Math.PI * 2;
    coilPoints.push(new Vector3(Math.cos(a) * 0.0062, 0.016 + t * 0.032, Math.sin(a) * 0.0062));
  }
  root.add(named(new Mesh(new TubeGeometry(new CatmullRomCurve3(coilPoints), turns * 24, r, 8, false), rope), 'Coil'));
  root.add(lathe('Binding', [[0.0074, 0.0275], [0.0086, 0.0285], [0.0088, 0.0335], [0.0086, 0.0365], [0.0074, 0.0375]], wrap));
  // Honda knot with the noose: a slightly irregular loop standing in the face plane.
  const knotY = 0.058;
  root.add(named(lathe('Honda', [[POLE, -0.0042], [0.0026, -0.003], [0.0034, 0], [0.0026, 0.0032], [POLE, 0.0044]], rope), 'Honda', 0, knotY, 0));
  const radius = 0.021;
  const loopPoints: Vector3[] = [];
  for (let i = 0; i < 24; i++) {
    const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    const k = radius * (1 + 0.045 * Math.sin(3 * a + 0.7));
    loopPoints.push(new Vector3(Math.cos(a) * k * 1.06, knotY + 0.004 + radius + Math.sin(a) * k, Math.sin(2 * a) * 0.0014));
  }
  root.add(named(new Mesh(new TubeGeometry(new CatmullRomCurve3(loopPoints, true), 120, r, 8, true), rope), 'Noose'));
  return root;
}

// ---------- the set held in one hand ----------

const BUILDERS: Record<HeldTool, () => Group> = {
  pen: createPen,
  eraser: createEraser,
  line: createRuler,
  frame: createStamp,
  text: createTextWand,
  select: createSelectWand,
  lasso: createLasso,
};

/** One hand's tools: a child per held tool, all hidden until `setToolLook` picks one. */
export function createToolSet(): Group {
  const set = new Group();
  set.name = 'HandTools';
  for (const tool of HELD_TOOLS) {
    const model = BUILDERS[tool]();
    model.name = `Tool-${tool}`;
    model.visible = false;
    set.add(model);
  }
  return set;
}

/**
 * Show `tool` from the set: the pen's nib and band take the ink colour, and a tool that
 * is not gripped fades. Called every frame: returns early without allocating when nothing changed.
 */
export function setToolLook(set: Object3D, tool: ToolId, inkColor: string, held: boolean): void {
  const look = set.userData as { tool?: ToolId; ink?: string; held?: boolean };
  if (look.tool === tool && look.ink === inkColor && look.held === held) return;
  look.tool = tool;
  look.ink = inkColor;
  look.held = held;
  for (const child of set.children) child.visible = child.name === `Tool-${tool}`;
  const model = set.getObjectByName(`Tool-${tool}`);
  if (model == null) return;
  if (tool === 'pen') {
    for (const part of ['Nib', 'InkBand']) ((model.getObjectByName(part) as Mesh).material as MeshStandardMaterial).color.set(inkColor);
  }
  model.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (m == null) return;
    const base = (m.userData.baseOpacity as number | undefined) ?? 1;
    const opacity = held ? base : base * IDLE_FADE;
    const transparent = opacity < 1;
    if (m.transparent !== transparent) m.needsUpdate = true;
    m.transparent = transparent;
    m.opacity = opacity;
    m.depthWrite = !transparent;
  });
}

/** Manifest preview prototype: every held tool standing on its tip, left to right. */
export default function createToolSetPreview(): Group {
  const set = createToolSet();
  HELD_TOOLS.forEach((tool, i) => {
    const model = set.getObjectByName(`Tool-${tool}`)!;
    model.visible = true;
    model.position.x = (i - (HELD_TOOLS.length - 1) / 2) * 0.06;
  });
  setToolLook(set, 'pen', '#1A1A1A', true);
  for (const child of set.children) child.visible = true;
  return set;
}
