// Quiet studio floor: a dark disc with a faint 1 m grid as a comfort reference.
import { CircleGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from '@iwsdk/core';

export default function createStudioFloor(): Group {
  const root = new Group();
  root.name = 'StudioFloor';
  const disc = new Mesh(
    new CircleGeometry(7, 72),
    new MeshStandardMaterial({ color: '#202329', roughness: 0.95, metalness: 0 }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.name = 'FloorDisc';
  root.add(disc);
  const lineMat = new MeshStandardMaterial({ color: '#2d3139', roughness: 1, metalness: 0 });
  const lineGeo = new PlaneGeometry(0.012, 12);
  for (let i = -6; i <= 6; i++) {
    const a = new Mesh(lineGeo, lineMat);
    a.rotation.x = -Math.PI / 2;
    a.position.set(i, 0.002, 0);
    const b = new Mesh(lineGeo, lineMat);
    b.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    b.position.set(0, 0.002, i);
    root.add(a, b);
  }
  return root;
}
