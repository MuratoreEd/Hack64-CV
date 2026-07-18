// Faithful ports of SM64's surface query routines (src/engine/surface_collision.c):
// find_floor_from_list / find_ceil_from_list / find_wall_collisions_from_list,
// plus the s16 position truncation the game applies before every query.
//
// These operate on a plain list of surfaces (the surfaces registered in one
// spatial-partition cell) so they can be unit-tested in isolation; partition.ts
// feeds them the right cell.
//
// Fidelity notes (verified against n64decomp/sm64):
//  - Floor/ceil point-in-triangle uses s32 INTEGER cross products, which can
//    overflow and wrap in the game. We reproduce that with Math.imul + `| 0`.
//    (This s16/s32 truncation is the root of gap-based invisible walls.)
//  - Wall in-plane tests use f32 arithmetic — plain JS numbers approximate that.
//  - The height/offset planes are f32 in-game; we use f64, which differs only by
//    ~1e-3 and can flip the ±78 buffer only when Mario is right on the threshold.

import type { Surface } from "./surface";
import {
  FLOOR_LOWER_LIMIT,
  CELL_HEIGHT_LIMIT,
  SURFACE_Y_BUFFER,
  WALL_MAX_RADIUS,
  SURFACE_CAMERA_BOUNDARY,
} from "./constants";

/**
 * Emulate C's `(s16)floatVal`: truncate toward zero to an integer, then take the
 * low 16 bits as a signed value. Reproducing this exactly matters — it is the
 * source of several collision quirks (Parallel Universes, truncation gaps).
 */
export function toS16(v: number): number {
  const i = Math.trunc(v); // float -> int, truncating toward zero
  return (i << 16) >> 16; // narrow to s16, sign-extended
}

/** s32 2D cross-product term `a0*a1 - b0*b1`, emulating the game's integer
 * overflow: Math.imul is a 32-bit signed multiply; `| 0` wraps the subtraction
 * back into s32. Floor/ceil bounds checks depend on this exact behavior. */
function crossS32(a0: number, a1: number, b0: number, b1: number): number {
  return (Math.imul(a0, a1) - Math.imul(b0, b1)) | 0;
}

export interface SurfaceHit {
  /** The surface found, or null if none. */
  surface: Surface | null;
  /** Plane height at the query XZ (default limit if none found). */
  height: number;
}

/**
 * s32-faithful XZ point-in-triangle test for a FLOOR winding (all three integer
 * cross terms ≥ 0). Shared by find_floor and the partition's floorsAt column
 * scan so both agree on exactly which floors "contain" a column, truncation
 * and all.
 */
export function floorContainsXZ(surf: Surface, x: number, z: number): boolean {
  const x1 = surf.vertices[0][0];
  const z1 = surf.vertices[0][2];
  const x2 = surf.vertices[1][0];
  const z2 = surf.vertices[1][2];
  if (crossS32(z1 - z, x2 - x1, x1 - x, z2 - z1) < 0) return false;

  const x3 = surf.vertices[2][0];
  const z3 = surf.vertices[2][2];
  if (crossS32(z2 - z, x3 - x2, x2 - x, z3 - z2) < 0) return false;
  if (crossS32(z3 - z, x1 - x3, x3 - x, z1 - z3) < 0) return false;
  return true;
}

/**
 * Port of `find_floor_from_list`. `x`,`y`,`z` are already s16-truncated ints.
 * Returns the FIRST surface in list order whose XZ footprint contains (x,z) and
 * whose plane is within 78 units above y — preserving first-hit-wins (the
 * floor-overlap bug). Height defaults to FLOOR_LOWER_LIMIT when nothing hits.
 */
export function findFloorFromList(
  list: Surface[],
  x: number,
  y: number,
  z: number,
): SurfaceHit {
  const out: SurfaceHit = { surface: null, height: 0 };
  findFloorFromListInto(list, x, y, z, out);
  return out;
}

/** Allocation-free core of findFloorFromList: writes the hit into `out`.
 * Bulk callers (the probe fires millions of queries) reuse one object. */
export function findFloorFromListInto(
  list: Surface[],
  x: number,
  y: number,
  z: number,
  out: SurfaceHit,
): void {
  for (let i = 0; i < list.length; i++) {
    const surf = list[i];
    if (!floorContainsXZ(surf, x, z)) continue;

    // Not checking for the camera: ignore camera-only floors.
    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;

    const ny = surf.normal.y;
    if (ny === 0) continue; // wall remnant; should never occur in a floor list

    const height = -(x * surf.normal.x + surf.normal.z * z + surf.originOffset) / ny;
    // 78-unit buffer: skip floors more than 78 units above y.
    if (y - (height + -SURFACE_Y_BUFFER) < 0) continue;

    out.surface = surf;
    out.height = height;
    return;
  }
  out.surface = null;
  out.height = FLOOR_LOWER_LIMIT;
}

/**
 * Port of `find_ceil_from_list`. Opposite winding sign to floors (`> 0`), and a
 * 78-unit buffer below y. Height defaults to CELL_HEIGHT_LIMIT when none hit.
 */
export function findCeilFromList(
  list: Surface[],
  x: number,
  y: number,
  z: number,
): SurfaceHit {
  const out: SurfaceHit = { surface: null, height: 0 };
  findCeilFromListInto(list, x, y, z, out);
  return out;
}

/** Allocation-free core of findCeilFromList: writes the hit into `out`. */
export function findCeilFromListInto(
  list: Surface[],
  x: number,
  y: number,
  z: number,
  out: SurfaceHit,
): void {
  for (let i = 0; i < list.length; i++) {
    const surf = list[i];
    const x1 = surf.vertices[0][0];
    const z1 = surf.vertices[0][2];
    const x2 = surf.vertices[1][0];
    const z2 = surf.vertices[1][2];
    if (crossS32(z1 - z, x2 - x1, x1 - x, z2 - z1) > 0) continue;

    const x3 = surf.vertices[2][0];
    const z3 = surf.vertices[2][2];
    if (crossS32(z2 - z, x3 - x2, x2 - x, z3 - z2) > 0) continue;
    if (crossS32(z3 - z, x1 - x3, x3 - x, z1 - z3) > 0) continue;

    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;

    const ny = surf.normal.y;
    if (ny === 0) continue;

    const height = -(x * surf.normal.x + surf.normal.z * z + surf.originOffset) / ny;
    // 78-unit buffer: skip ceilings more than 78 units below y.
    if (y - (height - -SURFACE_Y_BUFFER) > 0) continue;

    out.surface = surf;
    out.height = height;
    return;
  }
  out.surface = null;
  out.height = CELL_HEIGHT_LIMIT;
}

/** Mutable state threaded through find_wall_collisions (mirrors WallCollisionData).
 * `x`/`z` are pushed out by each colliding wall; `walls` holds up to 4 hits. */
export interface WallCollisionData {
  x: number;
  y: number;
  z: number;
  offsetY: number;
  radius: number;
  walls: Surface[];
  numWalls: number;
}

/**
 * Port of `find_wall_collisions_from_list`. Pushes `data.x`/`data.z` out of each
 * wall within `radius`, accumulating over the list (the wall-overlap
 * over-push quirk is preserved — px/pz are read once, not re-read after a push).
 * Wall in-plane tests are f32 in-game, so plain float math is faithful here.
 */
export function findWallCollisionsFromList(
  list: Surface[],
  data: WallCollisionData,
): number {
  let numCols = 0;
  let radius = data.radius;
  const x = data.x;
  const y = data.y + data.offsetY;
  const z = data.z;

  if (radius > WALL_MAX_RADIUS) radius = WALL_MAX_RADIUS;

  for (const surf of list) {
    if (y < surf.lowerY || y > surf.upperY) continue;

    const offset =
      surf.normal.x * x + surf.normal.y * y + surf.normal.z * z + surf.originOffset;
    if (offset < -radius || offset > radius) continue;

    const px = x;
    const pz = z;

    if (surf.xProjection) {
      const w1 = -surf.vertices[0][2];
      const w2 = -surf.vertices[1][2];
      const w3 = -surf.vertices[2][2];
      const y1 = surf.vertices[0][1];
      const y2 = surf.vertices[1][1];
      const y3 = surf.vertices[2][1];
      const negPz = -pz;
      if (surf.normal.x > 0) {
        if ((y1 - y) * (w2 - w1) - (w1 - negPz) * (y2 - y1) > 0) continue;
        if ((y2 - y) * (w3 - w2) - (w2 - negPz) * (y3 - y2) > 0) continue;
        if ((y3 - y) * (w1 - w3) - (w3 - negPz) * (y1 - y3) > 0) continue;
      } else {
        if ((y1 - y) * (w2 - w1) - (w1 - negPz) * (y2 - y1) < 0) continue;
        if ((y2 - y) * (w3 - w2) - (w2 - negPz) * (y3 - y2) < 0) continue;
        if ((y3 - y) * (w1 - w3) - (w3 - negPz) * (y1 - y3) < 0) continue;
      }
    } else {
      const w1 = surf.vertices[0][0];
      const w2 = surf.vertices[1][0];
      const w3 = surf.vertices[2][0];
      const y1 = surf.vertices[0][1];
      const y2 = surf.vertices[1][1];
      const y3 = surf.vertices[2][1];
      if (surf.normal.z > 0) {
        if ((y1 - y) * (w2 - w1) - (w1 - px) * (y2 - y1) > 0) continue;
        if ((y2 - y) * (w3 - w2) - (w2 - px) * (y3 - y2) > 0) continue;
        if ((y3 - y) * (w1 - w3) - (w3 - px) * (y1 - y3) > 0) continue;
      } else {
        if ((y1 - y) * (w2 - w1) - (w1 - px) * (y2 - y1) < 0) continue;
        if ((y2 - y) * (w3 - w2) - (w2 - px) * (y3 - y2) < 0) continue;
        if ((y3 - y) * (w1 - w3) - (w3 - px) * (y1 - y3) < 0) continue;
      }
    }

    // Not checking for the camera: ignore camera-only walls.
    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;

    //! (Wall Overlaps) px/pz are not updated after a push, so multiple walls can
    // push more than required — preserved intentionally.
    data.x += surf.normal.x * (radius - offset);
    data.z += surf.normal.z * (radius - offset);

    if (data.numWalls < 4) data.walls[data.numWalls++] = surf;
    numCols++;
  }

  return numCols;
}
