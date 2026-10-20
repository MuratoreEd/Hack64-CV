// Collision PROFILE: the handful of engine behaviors that ROM-level collision
// patches change. The core stays a faithful port; the profile says *which*
// engine it is faithful to.
//
// What "Frame's collision patch" (FramePerfection/SM64CollisionPatcher) really
// changes — read from the patcher's own Program.cs and its _misc C sources, and
// cross-checked against the MIPS it injects (2026-09-29):
//
//   1. WALL THRESHOLD. add_surface_to_cell classifies by normal.y: vanilla
//      sends |ny| <= 0.01 to the wall list, the patch rewrites the two rodata
//      doubles to ±0.05. Also confirmed live by reading the game's OWN partition
//      lists out of RDRAM (patchDetect.ts): 21 surfaces of the user's level 15
//      in the [0.01, 0.05) band all sit in wall lists.
//
//   2. WALL COLLISION (find_wall_collisions_from_list is replaced wholesale):
//      walls are ONE-SIDED (a point behind the plane never collides), a point
//      whose projection lands on the face is pushed out along the normal, one
//      that misses the face is pushed radially off the nearest vertical edge
//      (edges act like capsules, radius - 1), and pushes ACCUMULATE — each wall
//      is tested from the already-pushed position, so the vanilla over-push
//      quirk is gone. See queries.ts findWallCollisionsFromListFrame.
//
//   3. perform_air_step and check_ledge_climb_down are rewritten, but only in
//      their wall bookkeeping (which wall to bonk / grab). The blocking rules the
//      probe relies on — pushes (150, 50) then (30, 50), floor NULL → wall,
//      nextY + 160 > ceil → blocked — are unchanged. perform_ground_quarter_step
//      is explicitly NOT part of the binary patch.
//
// The patcher does NOT touch find_floor / find_ceil. Its _misc sources contain
// rewritten versions (float positions, highest floor / lowest ceiling, a 1.5
// unit ceiling margin) but Program.cs never injects them.
//
// FLOOR/CEILING SELECTION is therefore a separate question. On the user's hack
// the game was observed live picking the HIGHEST containing floor where vanilla
// first-hit-wins would not (0x8067cb60 plane 1407.25 is first in the cell's
// vertex1[1]-sorted list and passes every vanilla test, yet the game reported
// 0x8067d0d0 at 1464.13, the highest of the three), so that hack carries some
// other find_floor change. That association is EMPIRICAL — main.ts treats a
// patched threshold as a hint for "extreme" selection only until the oracle
// observes the rule directly (oracle.detectFloorSelect), and says which it is.

/** How find_floor / find_ceil pick among the containing surfaces in a cell. */
export type FloorSelect =
  /** Vanilla: first hit in the cell's sorted order wins (surface cucking). */
  | "first"
  /** Highest floor / lowest ceiling wins (cucking fixed). */
  | "extreme";

/** Which find_wall_collisions_from_list the ROM runs. */
export type WallModel =
  /** Vanilla: two-sided, axis-projected in-plane test, pushes all computed from
   * the original position (over-push quirk). */
  | "vanilla"
  /** Frame's patch: one-sided, face + edge pushes, pushes accumulate. */
  | "frame";

export interface CollisionProfile {
  /** |normal.y| at or below which a surface is a WALL rather than floor/ceiling. */
  wallThreshold: number;
  select: FloorSelect;
  walls: WallModel;
}

/** Unmodified SM64 (n64decomp/sm64). */
export const VANILLA_PROFILE: CollisionProfile = {
  wallThreshold: 0.01,
  select: "first",
  walls: "vanilla",
};

/** Frame's collision patch as observed on the user's hack: the patcher's own
 * threshold and wall routine, plus the highest-floor selection seen live on that
 * hack (see the header — the patcher itself doesn't change selection). */
export const PATCHED_PROFILE: CollisionProfile = {
  wallThreshold: 0.05,
  select: "extreme",
  walls: "frame",
};

/** The wall routine that goes with a detected wall threshold, when nothing
 * more direct is known: Frame's patcher writes its ±0.05 threshold and its
 * wall routine in the same run. */
export function wallsForThreshold(wallThreshold: number): WallModel {
  return wallThreshold === PATCHED_PROFILE.wallThreshold ? "frame" : "vanilla";
}
