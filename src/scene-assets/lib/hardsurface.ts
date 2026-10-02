/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Bevelled block construction for procedural models (trimmed from the IWSDK hard-surface kit). */

import { BufferGeometry, ExtrudeGeometry, Shape } from '@iwsdk/core';

/* ------------------------------------------------------------------ *
 * Bevelled box — the hard-surface workhorse
 * ------------------------------------------------------------------ */

function roundedRectShape(width: number, height: number, radius: number): Shape {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(radius, hw - 1e-5, hh - 1e-5));
  const shape = new Shape();
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  if (r > 0) {shape.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);}
  shape.lineTo(hw, hh - r);
  if (r > 0) {shape.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);}
  shape.lineTo(-hw + r, hh);
  if (r > 0) {shape.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);}
  shape.lineTo(-hw, -hh + r);
  if (r > 0) {shape.absarc(-hw + r, -hh + r, r, Math.PI, 1.5 * Math.PI, false);}
  return shape;
}

/**
 * A bevelled, optionally round-cornered box centred on the origin, extruded
 * along local +Z. Sized so the finished solid measures exactly w x h x d.
 */
export function bevelBox(
  width: number,
  height: number,
  depth: number,
  bevel = 0.01,
  cornerRadius?: number,
  curveSegments = 2,
): BufferGeometry {
  const b = Math.max(
    1e-4,
    Math.min(bevel, width * 0.24, height * 0.24, depth * 0.45),
  );
  const shapeW = Math.max(2e-4, width - 2 * b);
  const shapeH = Math.max(2e-4, height - 2 * b);
  const radius = Math.max(
    0,
    Math.min(cornerRadius ?? b * 1.5, shapeW / 2 - 1e-5, shapeH / 2 - 1e-5),
  );
  const extrudeDepth = Math.max(1e-4, depth - 2 * b);
  const geometry = new ExtrudeGeometry(
    roundedRectShape(shapeW, shapeH, radius),
    {
      depth: extrudeDepth,
      bevelEnabled: true,
      bevelThickness: b,
      bevelSize: b,
      bevelOffset: 0,
      bevelSegments: 1,
      curveSegments,
      steps: 1,
    },
  );
  geometry.translate(0, 0, -extrudeDepth / 2);
  geometry.computeVertexNormals();
  return geometry;
}
