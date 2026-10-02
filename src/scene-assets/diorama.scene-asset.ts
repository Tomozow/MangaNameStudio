// Procedural diorama kit, authored in real-world meters (1 unit = 1 m) with the
// origin on the floor and +Z as the "front". The studio shows it at 1:12.
import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from '@iwsdk/core';

const materials = new Map<string, MeshStandardMaterial>();

export function kitMaterial(color: string, roughness = 0.75): MeshStandardMaterial {
  const key = `${color}:${roughness}`;
  let m = materials.get(key);
  if (m == null) {
    m = new MeshStandardMaterial({ color, roughness, metalness: 0 });
    materials.set(key, m);
  }
  return m;
}

function part(
  geometry: BufferGeometry,
  material: Material,
  x: number,
  y: number,
  z: number,
  name?: string,
): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (name) mesh.name = name;
  return mesh;
}

function box(w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, name?: string): Mesh {
  return part(new BoxGeometry(w, h, d), mat, x, y, z, name);
}

function joint(name: string, x: number, y: number, z: number): Group {
  const g = new Group();
  g.name = name;
  g.position.set(x, y, z);
  return g;
}

/** Articulated drawing mannequin (デッサン人形). Joints are named for poses. */
export function createFigure(color: string, height = 1.7): Group {
  const k = height / 1.7;
  const skin = kitMaterial(color, 0.6);
  const jointMat = kitMaterial('#3b3f46', 0.5);
  const face = kitMaterial('#1d1f23', 0.4);
  const root = new Group();
  root.name = 'Figure';
  const body = joint('Body', 0, 0, 0);
  root.add(body);
  const pelvis = joint('Pelvis', 0, 0.95 * k, 0);
  body.add(pelvis);
  pelvis.add(part(new CapsuleGeometry(0.14 * k, 0.08 * k, 4, 10), skin, 0, 0, 0, 'Hip'));
  const spine = joint('Spine', 0, 0.06 * k, 0);
  pelvis.add(spine);
  spine.add(part(new CapsuleGeometry(0.16 * k, 0.3 * k, 4, 12), skin, 0, 0.27 * k, 0, 'Torso'));
  const neck = joint('Neck', 0, 0.55 * k, 0);
  spine.add(neck);
  neck.add(part(new CylinderGeometry(0.045 * k, 0.05 * k, 0.08 * k, 8), jointMat, 0, 0.03 * k, 0));
  const head = part(new SphereGeometry(0.11 * k, 16, 12), skin, 0, 0.16 * k, 0, 'Head');
  head.scale.set(0.92, 1.08, 1);
  neck.add(head);
  // Face marks make the facing direction readable from any angle.
  const eyeGeo = new SphereGeometry(0.016 * k, 8, 6);
  neck.add(part(eyeGeo, face, -0.038 * k, 0.18 * k, 0.095 * k, 'EyeL'));
  neck.add(part(eyeGeo, face, 0.038 * k, 0.18 * k, 0.095 * k, 'EyeR'));
  const nose = part(new ConeGeometry(0.02 * k, 0.05 * k, 8), skin, 0, 0.15 * k, 0.11 * k, 'Nose');
  nose.rotation.x = Math.PI / 2;
  neck.add(nose);
  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    const shoulder = joint(`Shoulder${tag}`, side * 0.21 * k, 0.48 * k, 0);
    spine.add(shoulder);
    shoulder.add(part(new SphereGeometry(0.055 * k, 10, 8), jointMat, 0, 0, 0));
    shoulder.add(part(new CapsuleGeometry(0.045 * k, 0.22 * k, 4, 8), skin, 0, -0.16 * k, 0));
    const elbow = joint(`Elbow${tag}`, 0, -0.32 * k, 0);
    shoulder.add(elbow);
    elbow.add(part(new SphereGeometry(0.042 * k, 8, 6), jointMat, 0, 0, 0));
    elbow.add(part(new CapsuleGeometry(0.038 * k, 0.2 * k, 4, 8), skin, 0, -0.14 * k, 0));
    elbow.add(part(new SphereGeometry(0.045 * k, 8, 6), skin, 0, -0.3 * k, 0, `Hand${tag}`));
    const hip = joint(`Leg${tag}`, side * 0.095 * k, -0.04 * k, 0);
    pelvis.add(hip);
    hip.add(part(new SphereGeometry(0.065 * k, 10, 8), jointMat, 0, 0, 0));
    hip.add(part(new CapsuleGeometry(0.06 * k, 0.3 * k, 4, 8), skin, 0, -0.22 * k, 0));
    const knee = joint(`Knee${tag}`, 0, -0.45 * k, 0);
    hip.add(knee);
    knee.add(part(new SphereGeometry(0.052 * k, 8, 6), jointMat, 0, 0, 0));
    knee.add(part(new CapsuleGeometry(0.05 * k, 0.3 * k, 4, 8), skin, 0, -0.22 * k, 0));
    knee.add(box(0.1 * k, 0.06 * k, 0.22 * k, jointMat, 0, -0.44 * k, 0.04 * k, `Foot${tag}`));
  }
  return root;
}

export const POSES = ['stand', 'walk', 'sit', 'point', 'lie'] as const;
export type Pose = (typeof POSES)[number];

/** Apply a preset pose by rotating the named joints of a figure. */
export function applyPose(figure: Object3D, pose: Pose): void {
  const j = (name: string) => figure.getObjectByName(name);
  const set = (name: string, x = 0, y = 0, z = 0) => j(name)?.rotation.set(x, y, z);
  for (const name of ['Body', 'Pelvis', 'Spine', 'Neck', 'ShoulderL', 'ShoulderR', 'ElbowL', 'ElbowR', 'LegL', 'LegR', 'KneeL', 'KneeR']) {
    set(name);
  }
  const body = j('Body');
  body?.position.set(0, 0, 0);
  set('ShoulderL', 0, 0, -0.12);
  set('ShoulderR', 0, 0, 0.12);
  const h = (figure.userData.height as number | undefined) ?? 1.7;
  const k = h / 1.7;
  switch (pose) {
    case 'walk':
      set('LegL', -0.45);
      set('KneeL', 0.25);
      set('LegR', 0.35);
      set('KneeR', 0.35);
      set('ShoulderL', 0.45, 0, -0.1);
      set('ShoulderR', -0.45, 0, 0.1);
      set('ElbowL', -0.2);
      set('ElbowR', -0.35);
      break;
    case 'sit':
      body?.position.set(0, -0.47 * k, -0.05 * k);
      set('LegL', -Math.PI / 2, 0, 0.06);
      set('LegR', -Math.PI / 2, 0, -0.06);
      set('KneeL', Math.PI / 2);
      set('KneeR', Math.PI / 2);
      set('ShoulderL', -0.3, 0, -0.1);
      set('ShoulderR', -0.3, 0, 0.1);
      set('ElbowL', -0.7);
      set('ElbowR', -0.7);
      break;
    case 'point':
      set('ShoulderR', -1.45, 0, 0.05);
      set('Neck', 0, -0.15, 0);
      break;
    case 'lie':
      body?.rotation.set(-Math.PI / 2, 0, 0);
      body?.position.set(0, 0.16 * k, -0.95 * k);
      set('ShoulderL', 0, 0, -0.35);
      set('ShoulderR', 0, 0, 0.35);
      break;
    default:
      break;
  }
}

export const PROP_KINDS = [
  'chair',
  'table',
  'sofa',
  'bed',
  'box',
  'lamp',
  'wall',
  'door',
  'window',
  'tree',
  'car',
  'building',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export function createProp(kind: PropKind): Group {
  const g = new Group();
  g.name = kind;
  const wood = kitMaterial('#a8794f');
  const darkWood = kitMaterial('#6b4a32');
  const fabric = kitMaterial('#7d8ba3', 0.9);
  const white = kitMaterial('#e9e6df');
  const wallMat = kitMaterial('#d8d2c6', 0.95);
  const metal = kitMaterial('#596270', 0.45);
  switch (kind) {
    case 'chair': {
      g.add(box(0.46, 0.05, 0.46, wood, 0, 0.45, 0, 'Seat'));
      g.add(box(0.46, 0.5, 0.05, wood, 0, 0.72, -0.205, 'Back'));
      for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]] as const) {
        g.add(box(0.04, 0.45, 0.04, darkWood, x, 0.225, z));
      }
      break;
    }
    case 'table': {
      g.add(box(1.2, 0.05, 0.75, wood, 0, 0.72, 0, 'Top'));
      for (const [x, z] of [[-0.55, -0.32], [0.55, -0.32], [-0.55, 0.32], [0.55, 0.32]] as const) {
        g.add(box(0.05, 0.7, 0.05, darkWood, x, 0.35, z));
      }
      break;
    }
    case 'sofa': {
      g.add(box(1.8, 0.4, 0.85, fabric, 0, 0.2, 0, 'Base'));
      g.add(box(1.8, 0.45, 0.2, fabric, 0, 0.62, -0.33, 'Back'));
      g.add(box(0.18, 0.25, 0.85, fabric, -0.81, 0.52, 0));
      g.add(box(0.18, 0.25, 0.85, fabric, 0.81, 0.52, 0));
      break;
    }
    case 'bed': {
      g.add(box(1.4, 0.3, 2.0, darkWood, 0, 0.15, 0, 'Frame'));
      g.add(box(1.34, 0.2, 1.94, white, 0, 0.4, 0, 'Mattress'));
      g.add(box(1.4, 0.7, 0.08, darkWood, 0, 0.55, -1.0, 'Headboard'));
      g.add(box(0.6, 0.12, 0.35, kitMaterial('#f5f3ee'), 0, 0.56, -0.75, 'Pillow'));
      break;
    }
    case 'box':
      g.add(box(0.5, 0.5, 0.5, kitMaterial('#c19a6b'), 0, 0.25, 0, 'Crate'));
      break;
    case 'lamp': {
      g.add(part(new CylinderGeometry(0.06, 0.09, 3.2, 10), metal, 0, 1.6, 0, 'Pole'));
      g.add(box(0.5, 0.12, 0.22, metal, 0.2, 3.2, 0, 'Head'));
      g.add(box(0.36, 0.03, 0.16, kitMaterial('#fff3c4', 0.3), 0.2, 3.13, 0, 'Bulb'));
      break;
    }
    case 'wall':
      g.add(box(2.0, 2.4, 0.12, wallMat, 0, 1.2, 0, 'Wall'));
      break;
    case 'door': {
      g.add(box(0.55, 2.4, 0.12, wallMat, -0.725, 1.2, 0));
      g.add(box(0.55, 2.4, 0.12, wallMat, 0.725, 1.2, 0));
      g.add(box(0.9, 0.4, 0.12, wallMat, 0, 2.2, 0));
      const leaf = box(0.86, 1.98, 0.05, wood, 0.43, 0.99, 0, 'DoorLeaf');
      const hinge = joint('Hinge', -0.43, 0, 0.04);
      hinge.add(leaf);
      hinge.rotation.y = -0.6;
      g.add(hinge);
      break;
    }
    case 'window': {
      g.add(box(2.0, 0.9, 0.12, wallMat, 0, 0.45, 0));
      g.add(box(2.0, 0.4, 0.12, wallMat, 0, 2.2, 0));
      g.add(box(0.45, 1.1, 0.12, wallMat, -0.775, 1.45, 0));
      g.add(box(0.45, 1.1, 0.12, wallMat, 0.775, 1.45, 0));
      const glass = new MeshStandardMaterial({ color: '#9cc7e6', roughness: 0.1, transparent: true, opacity: 0.45 });
      g.add(box(1.1, 1.1, 0.02, glass, 0, 1.45, 0, 'Glass'));
      g.add(box(0.04, 1.1, 0.06, white, 0, 1.45, 0));
      break;
    }
    case 'tree': {
      g.add(part(new CylinderGeometry(0.12, 0.18, 1.4, 8), darkWood, 0, 0.7, 0, 'Trunk'));
      const leaf = kitMaterial('#4f8f4a', 0.9);
      g.add(part(new IcosahedronGeometry(0.95, 1), leaf, 0, 2.0, 0, 'Crown'));
      g.add(part(new IcosahedronGeometry(0.7, 1), leaf, 0.35, 2.7, 0.1));
      g.add(part(new IcosahedronGeometry(0.6, 1), leaf, -0.4, 2.5, -0.2));
      break;
    }
    case 'car': {
      const paint = kitMaterial('#c8463d', 0.4);
      g.add(box(1.75, 0.7, 4.2, paint, 0, 0.6, 0, 'Body'));
      g.add(box(1.55, 0.6, 2.1, kitMaterial('#2d3640', 0.3), 0, 1.2, -0.2, 'Cabin'));
      const wheelGeo = new CylinderGeometry(0.33, 0.33, 0.24, 14);
      const tire = kitMaterial('#1e1f22', 0.9);
      for (const [x, z] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]] as const) {
        const w = part(wheelGeo, tire, x, 0.33, z);
        w.rotation.z = Math.PI / 2;
        g.add(w);
      }
      g.add(box(1.5, 0.12, 0.05, kitMaterial('#fff6d0', 0.3), 0, 0.72, 2.11, 'Headlights'));
      break;
    }
    case 'building': {
      const concrete = kitMaterial('#9aa3ad', 0.95);
      g.add(box(6, 12, 6, concrete, 0, 6, 0, 'Block'));
      const glass = kitMaterial('#5b7591', 0.25);
      for (let floor = 0; floor < 4; floor++) {
        g.add(box(5.2, 1.0, 0.05, glass, 0, 2 + floor * 2.8, 3.01));
        g.add(box(0.05, 1.0, 5.2, glass, 3.01, 2 + floor * 2.8, 0));
        g.add(box(0.05, 1.0, 5.2, glass, -3.01, 2 + floor * 2.8, 0));
      }
      g.add(box(1.6, 2.2, 0.06, kitMaterial('#3c4450'), 0, 1.1, 3.02, 'Entrance'));
      break;
    }
  }
  return g;
}

/** Director camera with a lens on +Z; it renders the diorama view. */
export function createCameraProp(): Group {
  const g = new Group();
  g.name = 'DioramaCamera';
  const dark = kitMaterial('#2a2e35', 0.4);
  const accent = kitMaterial('#4c8dff', 0.4);
  g.add(box(0.36, 0.26, 0.5, dark, 0, 0, 0, 'Body'));
  const lens = part(new CylinderGeometry(0.1, 0.12, 0.22, 16), kitMaterial('#14161a', 0.2), 0, 0, 0.35, 'Lens');
  lens.rotation.x = Math.PI / 2;
  g.add(lens);
  g.add(box(0.38, 0.05, 0.1, accent, 0, 0.155, -0.1, 'Stripe'));
  g.add(part(new CylinderGeometry(0.02, 0.02, 1.25, 6), dark, 0, -0.75, 0, 'Tripod'));
  return g;
}

/** Round stage (turntable) with a floor grid; top surface at y = 0. */
export function createStage(radius = 3.6): Group {
  const g = new Group();
  g.name = 'DioramaStage';
  const top = part(new CylinderGeometry(radius, radius, 0.3, 64), kitMaterial('#d9d4c8', 0.9), 0, -0.15, 0, 'StageTop');
  const rim = part(new CylinderGeometry(radius + 0.12, radius + 0.2, 0.4, 64), kitMaterial('#3b4049', 0.6), 0, -0.32, 0, 'StageRim');
  g.add(rim, top);
  const lineMat = kitMaterial('#b9b2a4', 0.95);
  for (let i = -3; i <= 3; i++) {
    const len = 2 * Math.sqrt(Math.max(0, radius * radius - i * i));
    g.add(box(len, 0.004, 0.025, lineMat, 0, 0.002, i));
    g.add(box(0.025, 0.004, len, lineMat, i, 0.002, 0));
  }
  const front = part(new ConeGeometry(0.18, 0.4, 3), kitMaterial('#4c8dff', 0.5), 0, 0.01, radius - 0.35, 'FrontMarker');
  front.rotation.x = Math.PI / 2;
  front.scale.y = 1;
  g.add(front);
  return g;
}

/** Manifest preview prototype (figure on its stage). */
export default function createDioramaPreview(): Group {
  const root = new Group();
  root.name = 'DioramaPreview';
  root.add(createStage());
  const fig = createFigure('#e05555');
  root.add(fig);
  return root;
}
