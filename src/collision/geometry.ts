// Faithful port of the surface geometry computation in surface_load.c
// (`read_surface_data`): the plane normal, origin offset, and lowerY/upperY.
// Used to build synthetic surfaces for tests/demos and to reason about planes.

import type { Surface, Vec3s, Vec3f } from "./surface";
import { SurfaceKind, classifyKind } from "./surface";
import { WALL_X_PROJECTION_THRESHOLD, SURFACE_FLAG_X_PROJECTION } from "./constants";

export interface SurfaceGeometry {
  normal: Vec3f;
  originOffset: number;
  lowerY: number;
  upperY: number;
}

// surface_load.c drops surfaces whose normal magnitude is below this (DIV/0 guard).
const DEGENERATE_MAG = 0.0001;

/**
 * Compute a surface's normal, origin offset, and Y bounds from its three
 * vertices, exactly as the game does at load. Normal = (v2-v1) x (v3-v2),
 * normalized; lowerY/upperY get the game's -5/+5 buffer. Returns null for a
 * degenerate (near-zero-area) triangle, which the game discards.
 */
export function computeSurfaceGeometry(
  v1: Vec3s,
  v2: Vec3s,
  v3: Vec3s,
): SurfaceGeometry | null {
  const [x1, y1, z1] = v1;
  const [x2, y2, z2] = v2;
  const [x3, y3, z3] = v3;

  let nx = (y2 - y1) * (z3 - z2) - (z2 - z1) * (y3 - y2);
  let ny = (z2 - z1) * (x3 - x2) - (x2 - x1) * (z3 - z2);
  let nz = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);

  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (mag < DEGENERATE_MAG) return null;

  const inv = 1 / mag;
  nx *= inv;
  ny *= inv;
  nz *= inv;

  return {
    normal: { x: nx, y: ny, z: nz },
    originOffset: -(nx * x1 + ny * y1 + nz * z1),
    lowerY: Math.min(y1, y2, y3) - 5,
    upperY: Math.max(y1, y2, y3) + 5,
  };
}

export interface MakeSurfaceOptions {
  index?: number;
  address?: number;
  type?: number;
  force?: number;
  room?: number;
  flags?: number;
  object?: number;
}

/**
 * Build a fully-formed `Surface` from three vertices (synthetic geometry for
 * tests/demos), computing the normal/classification the same way the game does.
 * Returns null for a degenerate triangle.
 */
export function makeSurface(
  v1: Vec3s,
  v2: Vec3s,
  v3: Vec3s,
  opts: MakeSurfaceOptions = {},
): Surface | null {
  const geo = computeSurfaceGeometry(v1, v2, v3);
  if (!geo) return null;

  const kind = classifyKind(geo.normal.y);
  const xProjection =
    kind === SurfaceKind.Wall &&
    (geo.normal.x < -WALL_X_PROJECTION_THRESHOLD ||
      geo.normal.x > WALL_X_PROJECTION_THRESHOLD);

  let flags = opts.flags ?? 0;
  if (xProjection) flags |= SURFACE_FLAG_X_PROJECTION;

  return {
    index: opts.index ?? 0,
    address: opts.address ?? 0,
    type: opts.type ?? 0,
    force: opts.force ?? 0,
    flags,
    room: opts.room ?? 0,
    lowerY: geo.lowerY,
    upperY: geo.upperY,
    vertices: [
      [v1[0], v1[1], v1[2]],
      [v2[0], v2[1], v2[2]],
      [v3[0], v3[1], v3[2]],
    ],
    normal: geo.normal,
    originOffset: geo.originOffset,
    object: opts.object ?? 0,
    kind,
    xProjection,
  };
}
