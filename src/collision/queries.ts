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
import type { FloorSelect } from "./profile";
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

/**
 * World → collision coordinate on a scaled hack: the engine truncates the
 * world position to s16 and then arithmetic-shifts by log2(scale) — FLOOR
 * division, not truncation toward zero. That one-unit difference for negative
 * coordinates decides which triangle owns the point at seams and cell borders,
 * so it has to match exactly (verified live on a 4× hack). For scale 1 this is
 * just the vanilla `(s16)pos`.
 */
export function worldToCollision(world: number, scale: number): number {
  return Math.floor(toS16(world) / scale);
}

/**
 * The integer column a COLLISION-space float lands in when the engine looks it
 * up: the same conversion as worldToCollision, applied to `c × scale`. Integers
 * map to themselves; only fractional positions (a step target a wall push
 * moved) differ from plain truncation, and only at negative coordinates on a
 * scaled hack — where truncating picks the neighbouring column. No s16 wrap:
 * the caller's own lookup applies the vanilla one.
 */
export function collisionColumn(c: number, scale: number): number {
  // `+ 0` turns the -0 that truncating (-1, 0) yields into a plain 0.
  return (
    (scale === 1 ? Math.trunc(c) : Math.floor(Math.trunc(c * scale) / scale)) + 0
  );
}

/**
 * The collision-space interval of positions that land in integer column `c`
 * (the inverse of collisionColumn) — where a blocked column physically is.
 * Truncation toward zero makes it lopsided: at scale 1 column 5 is [5, 6),
 * column -5 is (-6, -5], and column 0 is the double-width (-1, 1).
 */
export function columnSpan(c: number, scale: number): [number, number] {
  const t0 = c * scale; // lowest truncated world coordinate in the column
  const t1 = t0 + scale - 1; // highest
  return [(t0 > 0 ? t0 : t0 - 1) / scale, (t1 >= 0 ? t1 + 1 : t1) / scale];
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
 * Considers surfaces whose XZ footprint contains (x,z) and whose plane is
 * within 78 units above y. `select` "first" (default) returns the FIRST in list
 * order — vanilla, preserving first-hit-wins (the floor-overlap bug);
 * "extreme" returns the HIGHEST, matching ROMs whose collision patch fixes it.
 * Height defaults to FLOOR_LOWER_LIMIT when nothing hits.
 */
export function findFloorFromList(
  list: Surface[],
  x: number,
  y: number,
  z: number,
  select: FloorSelect = "first",
): SurfaceHit {
  const out: SurfaceHit = { surface: null, height: 0 };
  findFloorFromListInto(list, x, y, z, out, select);
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
  select: FloorSelect = "first",
): void {
  out.surface = null;
  const extreme = select === "extreme"; // hoisted: this loop runs ~10^8 times
  for (let i = 0; i < list.length; i++) {
    const surf = list[i];
    // "extreme" must scan the whole list, which makes the containment test the
    // probe's hottest cost. A floor's plane inside its own triangle is a convex
    // combination of its vertex heights, so it can never exceed upperY: one
    // integer compare discards any candidate that cannot beat the current best.
    if (extreme && out.surface !== null && surf.upperY <= out.height) continue;
    if (!floorContainsXZ(surf, x, z)) continue;

    // Not checking for the camera: ignore camera-only floors.
    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;

    const ny = surf.normal.y;
    if (ny === 0) continue; // wall remnant; should never occur in a floor list

    const height = -(x * surf.normal.x + surf.normal.z * z + surf.originOffset) / ny;
    // 78-unit buffer: skip floors more than 78 units above y.
    if (y - (height + -SURFACE_Y_BUFFER) < 0) continue;

    // Vanilla returns the first hit — the surface-cucking bug, since the cell
    // is sorted by vertex1[1] and a triangle's first vertex isn't its highest.
    // "extreme" keeps scanning for the HIGHEST floor (patched ROMs; see
    // CollisionProfile).
    if (select === "first") {
      out.surface = surf;
      out.height = height;
      return;
    }
    if (out.surface === null || height > out.height) {
      out.surface = surf;
      out.height = height;
    }
  }
  if (out.surface === null) out.height = FLOOR_LOWER_LIMIT;
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
  select: FloorSelect = "first",
): SurfaceHit {
  const out: SurfaceHit = { surface: null, height: 0 };
  findCeilFromListInto(list, x, y, z, out, select);
  return out;
}

/** Allocation-free core of findCeilFromList: writes the hit into `out`. */
export function findCeilFromListInto(
  list: Surface[],
  x: number,
  y: number,
  z: number,
  out: SurfaceHit,
  select: FloorSelect = "first",
): void {
  out.surface = null;
  const extreme = select === "extreme"; // hoisted: this loop runs ~10^8 times
  for (let i = 0; i < list.length; i++) {
    const surf = list[i];
    // Mirror of the floor short-circuit: a ceiling's plane inside its triangle
    // can never fall below lowerY, so it cannot beat the current lowest.
    if (extreme && out.surface !== null && surf.lowerY >= out.height) continue;
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

    // Mirror of the floor case: "extreme" keeps the LOWEST ceiling.
    if (select === "first") {
      out.surface = surf;
      out.height = height;
      return;
    }
    if (out.surface === null || height < out.height) {
      out.surface = surf;
      out.height = height;
    }
  }
  if (out.surface === null) out.height = CELL_HEIGHT_LIMIT;
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
 * Returns the number of pushes applied (= collisions, in vanilla).
 */
export function findWallCollisionsFromList(
  list: readonly Surface[],
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

/** Frame's patch: an edge push only counts as touching the wall (is recorded)
 * when it points mostly along the wall's normal. */
const FRAME_CORNER_THRESHOLD = -0.9;
/** Frame's patch widens the edge margin by this after every edge push. */
const FRAME_MARGIN_GROWTH = 0.01;

/**
 * Port of the find_wall_collisions_from_list that FramePerfection's
 * SM64CollisionPatcher injects (its _misc/surface_collision.c; the shipped
 * machine code was checked against it: margin from the unclamped radius, the
 * `offset < 0` rejection, three sqrtf edge tests, x/z written back at the end).
 *
 * Differences from vanilla, all deliberate in the patch:
 *   - ONE-SIDED: a point behind the plane (offset < 0) never collides.
 *   - The face test is an orthogonal-projection barycentric test in 3D, not the
 *     vanilla axis projection.
 *   - A point that misses the face is pushed radially off each vertical edge it
 *     is within `radius - edgeMargin` of, at its own height — edges behave like
 *     capsules, which rounds wall ends and corners. An edge push is always
 *     applied, but the wall is only RECORDED if the push points mostly along
 *     its normal.
 *   - Pushes ACCUMULATE: every wall is tested from the position the previous
 *     push left, so two walls no longer over-push.
 *
 * `edgeMargin` is the patch's `1.0f` in collision units. On extended-boundary
 * (4×) ROMs the patch computes `radius - 1` in world units and then scales
 * everything by 1/4, so pass 1/worldScale there.
 *
 * Returns the number of pushes applied, which can exceed the recorded walls
 * (edge pushes that fail the corner test move the point without recording).
 */
export function findWallCollisionsFromListFrame(
  list: readonly Surface[],
  data: WallCollisionData,
  edgeMargin = 1,
): number {
  let radius = data.radius;
  let x = data.x;
  const y = data.y + data.offsetY;
  let z = data.z;
  // Taken from the UNCLAMPED radius, before the 200 clamp, as the patch does.
  let marginRadius = radius - edgeMargin;
  let pushes = 0;

  if (radius > WALL_MAX_RADIUS) radius = WALL_MAX_RADIUS;

  for (let i = 0; i < list.length; i++) {
    const surf = list[i];
    if (y < surf.lowerY || y > surf.upperY) continue;

    const n = surf.normal;
    const offset = n.x * x + n.y * y + n.z * z + surf.originOffset;
    if (offset < 0 || offset > radius) continue;

    // Not checking for the camera: ignore camera-only walls. (Vanish-cap walls
    // stay solid — Mario isn't wearing the cap.)
    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;

    const a = surf.vertices[0];
    const b = surf.vertices[1];
    const c = surf.vertices[2];
    const v0x = b[0] - a[0];
    const v0y = b[1] - a[1];
    const v0z = b[2] - a[2];
    const v1x = c[0] - a[0];
    const v1y = c[1] - a[1];
    const v1z = c[2] - a[2];
    const v2x = x - a[0];
    const v2y = y - a[1];
    const v2z = z - a[2];

    // Face: barycentric coordinates of the point's projection onto the plane.
    // The tests are written exactly as the patch's `goto edge_1_2` conditions
    // so a NaN falls through to the face push the same way it does in C.
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
    const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
    const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
    const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
    const invDenom = 1 / (d00 * d11 - d01 * d01);
    const v = (d11 * d20 - d01 * d21) * invDenom;
    if (!(v < 0 || v > 1)) {
      const w = (d00 * d21 - d01 * d20) * invDenom;
      if (!(w < 0 || w > 1 || v + w > 1)) {
        x += n.x * (radius - offset);
        z += n.z * (radius - offset);
        pushes++;
        if (data.numWalls < 4) data.walls[data.numWalls++] = surf;
        continue;
      }
    }

    // Edges 1-2, 1-3 (from vertex 1), then 2-3 (from vertex 2). The first edge
    // spanning the point's height and within the margin pushes and ends this
    // wall's test; a wall only reaches the next edge when the previous one
    // didn't engage, so x/z are still the values the face test saw.
    const e = edgePush(v0x, v0y, v0z, v2x, v2y, v2z, marginRadius, n.x, n.z) ??
      edgePush(v1x, v1y, v1z, v2x, v2y, v2z, marginRadius, n.x, n.z) ??
      edgePush(
        c[0] - b[0], c[1] - b[1], c[2] - b[2],
        x - b[0], y - b[1], z - b[2],
        marginRadius, n.x, n.z,
      );
    if (e === null) continue;
    x += e.dx;
    z += e.dz;
    marginRadius += FRAME_MARGIN_GROWTH;
    pushes++;
    if (e.recorded && data.numWalls < 4) data.walls[data.numWalls++] = surf;
  }

  data.x = x;
  data.z = z;
  return pushes;
}

/** Scratch result for edgePush (the probe calls this millions of times). */
const edgeScratch = { dx: 0, dz: 0, recorded: false };

/**
 * One of the Frame patch's edge tests. `(ex, ey, ez)` is the edge vector from
 * its start vertex, `(qx, qy, qz)` the query point relative to that vertex.
 * Returns the horizontal push (and whether the wall counts as touched), or null
 * when the edge doesn't span the point's height or is out of reach.
 *
 * Deviation, deliberately: at zero horizontal distance the patch divides 0/0
 * and the game's position becomes NaN. A point exactly on an edge projects onto
 * the triangle and takes the face push first, so this is only reachable when
 * float rounding makes the face test miss — we push straight out along the
 * wall normal instead of propagating a NaN into the probe.
 */
function edgePush(
  ex: number, ey: number, ez: number,
  qx: number, qy: number, qz: number,
  marginRadius: number,
  nx: number, nz: number,
): typeof edgeScratch | null {
  if (ey === 0) return null;
  const t = qy / ey;
  if (t < 0 || t > 1) return null;
  let dx = ex * t - qx;
  let dz = ez * t - qz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const offset = dist - marginRadius;
  if (offset > 0) return null;
  if (dist === 0) {
    edgeScratch.dx = nx * marginRadius;
    edgeScratch.dz = nz * marginRadius;
    edgeScratch.recorded = true;
    return edgeScratch;
  }
  const k = offset / dist;
  dx *= k;
  dz *= k;
  edgeScratch.dx = dx;
  edgeScratch.dz = dz;
  edgeScratch.recorded = !(dx * nx + dz * nz < FRAME_CORNER_THRESHOLD * offset);
  return edgeScratch;
}
