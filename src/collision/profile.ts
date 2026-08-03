// Collision PROFILE: the handful of engine behaviors that ROM-level collision
// patches change. The core stays a faithful port; the profile says *which*
// engine it is faithful to.
//
// Motivating case (verified live, 2026-07-29, this hack + "Frame's collision
// patch" / FramePerfection's SM64CollisionPatcher):
//
//   1. WALL THRESHOLD. add_surface_to_cell classifies by normal.y: vanilla
//      sends |ny| <= 0.01 to the wall list, the patch raises that to 0.05.
//      Confirmed by reading the game's OWN partition lists out of RDRAM: every
//      cell chain holding a surface with |ny| in [0.01, 0.05) contained no
//      steep floors and no steep ceilings, i.e. those surfaces sit in wall
//      lists. 21 surfaces in the user's level 15 are in that band.
//
//   2. FLOOR/CEILING SELECTION. Vanilla find_floor_from_list returns the FIRST
//      containing surface in the cell's list, which is sorted by vertex1[1] —
//      and since a triangle's first vertex isn't its highest, a lower triangle
//      can be sorted above a higher one and shadow it ("surface cucking", a
//      bug the decomp itself comments on). The patch scans the whole list and
//      keeps the extreme (highest floor / lowest ceiling), fixing it.
//      Confirmed live: walking the game's own cell chain, 0x8067cb60 (plane
//      1407.25 at Mario's column) is FIRST and passes every vanilla test, yet
//      gMarioState->floorHeight was 1464.13 = 0x8067d0d0, the second entry and
//      the highest of the three containing floors. Vanilla cannot produce that.
//
// Both knobs matter far beyond the oracle: "extreme" selection means a floor
// above a blocked column always resolves, so invisible-wall regions terminate
// there instead of running to the sky — see the probe's floorAbove.

/** How find_floor / find_ceil pick among the containing surfaces in a cell. */
export type FloorSelect =
  /** Vanilla: first hit in the cell's sorted order wins (surface cucking). */
  | "first"
  /** Patched: highest floor / lowest ceiling wins (cucking fixed). */
  | "extreme";

export interface CollisionProfile {
  /** |normal.y| at or below which a surface is a WALL rather than floor/ceiling. */
  wallThreshold: number;
  select: FloorSelect;
}

/** Unmodified SM64 (n64decomp/sm64). */
export const VANILLA_PROFILE: CollisionProfile = {
  wallThreshold: 0.01,
  select: "first",
};

/** Frame's collision patch (FramePerfection/SM64CollisionPatcher) — the
 * two behaviors above. Its other changes (one-sided walls, reworked
 * check_ledge_climb_down) are not modeled yet; see PROFILE_NOTES. */
export const PATCHED_PROFILE: CollisionProfile = {
  wallThreshold: 0.05,
  select: "extreme",
};

/** Known-but-unmodeled patch behaviors, so the gap is documented rather than
 * silently assumed away. Wall BACKSIDES: the patch replaces
 * find_wall_collisions_from_list so only a wall's front face collides, where
 * vanilla engages both sides (pushing Mario forward through the plane from
 * behind). Our wall queries are still two-sided, so wall-capped seams and the
 * probe's step pushes can differ from this ROM near back-facing walls. */
export const PROFILE_NOTES = "wall backsides still modeled as two-sided";
