// Live oracle: run our reimplemented queries at Mario's position and compare the
// results to the game's own gMarioState->floor / ->ceil / ->wall (streamed in the
// StateMessage). Floor/ceil are exact pointer-identity checks — the reliable
// proof that the collision core is faithful. Walls are lenient (see below).
//
// WORLD SCALE: some ROM hacks run collision at a reduced scale — the surface
// vertices are stored at 1/scale of Mario's world coordinates, and the engine
// queries at pos/scale then returns height*scale. We detect that factor from a
// flat floor and apply it here, keeping the collision core itself pure (the
// decomp find_floor has no scale, and its s16 truncation must happen in the
// small "collision space", so we divide the query position, not the vertices).

import type { StateMessage } from "../net/protocol";
import type { SpatialPartition } from "./partition";
import type { Surface } from "./surface";
import type { FloorSelect } from "./profile";
import { toS16 } from "./queries";

/**
 * World → collision coordinate for a scaled hack. The game truncates the world
 * position to s16 and then arithmetic-shifts by log2(scale) — i.e. FLOOR
 * division, not truncation toward zero. This one-unit difference for negative
 * coordinates decides which triangle owns the point at seams/cell borders, so it
 * must match exactly. For scale 1 this is just the vanilla `(s16)pos`.
 */
function toCollision(world: number, scale: number): number {
  return Math.floor(toS16(world) / scale);
}

export interface FieldOracle {
  ok: boolean;
  ourAddr: number;
  gameAddr: number;
  ourHeight: number;
  gameHeight: number;
  /** The pointers differ but both surfaces lie on the same plane (the sibling
   * triangle of the same quad), so the physical result — the height — is
   * identical. Happens on seam crossings because the game computes floor/ceil
   * BEFORE the act moves Mario, while we sample his position after. */
  coplanar: boolean;
}

export interface WallOracle {
  /** True if the game recorded no wall, or its wall is among the ones we found,
   * or its wall is a coplanar sibling of one we found, or it's stale (see below). */
  ok: boolean;
  gameAddr: number;
  ourAddrs: number[];
  /** The game only recomputes gMarioState->wall inside a ground/air step (while
   * moving). When Mario is stationary the pointer is left over from an earlier
   * position, so it can't be validated against a query at his current spot. */
  stale: boolean;
  /** The game's wall isn't one we found by address, but a wall we found lies on
   * the same plane (same normal + originOffset) — the sibling triangle of the
   * same physical wall. Which triangle the game stored depends on sub-unit
   * position, so this counts as a match. */
  coplanar: boolean;
}

export interface OracleResult {
  floor: FieldOracle;
  ceil: FieldOracle;
  wall: WallOracle;
  /** Headline match = floor AND ceil pointer identity (the exact core check). */
  ok: boolean;
}

const CLEAN_SCALES = [1, 2, 4, 8, 16];

// The (offsetY, radius) pairs, in WORLD units, the game itself uses to set
// gMarioState->wall: perform_ground_quarter_step runs (30, 24) then (60, 50);
// perform_air_quarter_step runs (150, 50) then (30, 50) (mario_step.c). We
// union the walls found across all of them so the membership test reflects
// what the game's own routines detect near Mario, whichever act last wrote the
// pointer. Divided by the world scale like every mario_step.c constant — Frame's
// extended-boundary wall routine visibly scales offset and radius by 1/4.
// (An earlier table had the air pair as (60, 150): 3× the real radius, which
// only made the check more lenient.)
const GAME_WALL_QUERIES: readonly [number, number][] = [
  [30, 24],
  [60, 50],
  [150, 50],
  [30, 50],
];

/** Two triangles belong to the same physical surface when they share a plane:
 * equal normal (within float noise) and equal originOffset. A quad is two such
 * triangles, and which one a query returns is sub-unit position dependent —
 * but the plane (and thus any height computed from it) is identical. */
function samePlane(a: Surface, b: Surface): boolean {
  return (
    Math.abs(a.normal.x - b.normal.x) < 1e-3 &&
    Math.abs(a.normal.y - b.normal.y) < 1e-3 &&
    Math.abs(a.normal.z - b.normal.z) < 1e-3 &&
    Math.abs(a.originOffset - b.originOffset) < 1
  );
}

export interface OracleOptions {
  /** Did Mario move since the previous frame? When false, gMarioState->wall is
   * stale (not recomputed this frame) and the wall check is treated as passing.
   * Defaults to true (strict) so callers/tests that don't track motion still get
   * an exact comparison. */
  moved?: boolean;
  /** address -> Surface, so the game's wall can be looked up for the coplanar
   * sibling test even when it isn't one of the walls we detected. */
  surfaceByAddr?: Map<number, Surface>;
}

/** Plane height of a surface at a collision-space (x, z). */
function planeHeight(s: Surface, x: number, z: number): number {
  return -(x * s.normal.x + z * s.normal.z + s.originOffset) / s.normal.y;
}

/**
 * Detect the world→collision scale from the floor the game reports.
 *
 * For each candidate scale we convert Mario's world position the way the engine
 * does, evaluate the reported floor's PLANE at that column, and scale the
 * result back up: the true scale is the one that reproduces the game's own
 * floorHeight. Sloped floors work — the plane is evaluated at the column rather
 * than assumed constant — which matters because a hack's Mario spends most of
 * his time on slopes. (The old version required |normal.y| >= 0.99 and so
 * returned null forever on sloped ground, silently leaving the scale at its
 * previous value: live level 15 ran the whole probe at scale 1 instead of 4,
 * making Mario's hitbox 4x too tall in collision units and inventing a mass of
 * ceiling-blocked columns.)
 *
 * Also independent of the floor SELECTION rule (first-hit vs highest), so it
 * stays valid on patched ROMs — it only ever asks "where is this surface's
 * plane", never "which surface would we pick".
 *
 * Returns null when undeterminable this frame (no floor, floor not in our pool,
 * or two candidates fit equally well); callers keep the previous value.
 */
export function detectWorldScale(
  surfaces: Surface[],
  state: StateMessage,
): number | null {
  if (!state.floorAddr) return null;
  const s = surfaces.find((s) => s.address === state.floorAddr);
  if (!s || s.normal.y === 0) return null;
  const fits: { scale: number; err: number }[] = [];
  for (const scale of CLEAN_SCALES) {
    const cx = toCollision(state.pos.x, scale);
    const cz = toCollision(state.pos.z, scale);
    const err = Math.abs(planeHeight(s, cx, cz) * scale - state.floorHeight);
    // The plane formula is the game's own, so a correct scale reproduces
    // floorHeight to float noise; 1 world unit is generous.
    if (err < 1) fits.push({ scale, err });
  }
  if (fits.length === 0) return null;
  fits.sort((a, b) => a.err - b.err);
  // Ambiguous (e.g. a flat floor at height 0 fits every scale): don't guess.
  if (fits.length > 1 && fits[1].err - fits[0].err < 1e-6) return null;
  return fits[0].scale;
}

/** What the game's reported floor tells us about its selection rule. Returns
 * null when this frame can't distinguish them.
 *
 * Vanilla find_floor_from_list takes the FIRST containing floor in the cell's
 * vertex1[1]-sorted order; a patched engine takes the HIGHEST. When those are
 * different surfaces, the game's own pointer says which engine we're talking
 * to. Verified live on this hack: the first-in-order floor (0x8067cb60, plane
 * 1407.25) passes every vanilla test, yet the game reported 1464.13 — the
 * highest of the three floors over Mario's column. */
export function detectFloorSelect(
  partition: SpatialPartition,
  state: StateMessage,
  scale: number,
): FloorSelect | null {
  if (!state.floorAddr) return null;
  const cx = toCollision(state.pos.x, scale);
  const cy = toCollision(state.pos.y, scale);
  const cz = toCollision(state.pos.z, scale);
  const first = partition.findFloorWith(cx, cy, cz, "first");
  const extreme = partition.findFloorWith(cx, cy, cz, "extreme");
  if (!first.surface || !extreme.surface) return null;
  const firstAddr = first.surface.address >>> 0;
  const extremeAddr = extreme.surface.address >>> 0;
  if (firstAddr === extremeAddr) return null; // no disagreement to learn from
  const game = state.floorAddr >>> 0;
  if (game === extremeAddr) return "extreme";
  if (game === firstAddr) return "first";
  return null; // neither: a dynamic surface, or a pool/state skew
}

export function evaluateOracle(
  partition: SpatialPartition,
  state: StateMessage,
  scale = 1,
  opts: OracleOptions = {},
): OracleResult {
  // Query in collision space; heights come back in collision units, so scale
  // them up to compare against the game's world-space values. Floor/ceil use the
  // faithfully-floored integer coords; walls use the float collision position
  // (find_wall's in-plane test is float, and the check is lenient anyway).
  const cx = toCollision(state.pos.x, scale);
  const cy = toCollision(state.pos.y, scale);
  const cz = toCollision(state.pos.z, scale);

  // Exact pointer identity is the gold standard, but it can't hold 100% of the
  // time: the game computes floor/ceil at the PRE-step position and we sample
  // pos post-step, so a seam crossing compares two adjacent triangles. When
  // those are coplanar the physical answer is identical — count it, marked.
  const fieldOracle = (
    ourSurf: Surface | null,
    ourHeight: number,
    gameAddr: number,
    gameHeight: number,
  ): FieldOracle => {
    const ourAddr = ourSurf ? ourSurf.address >>> 0 : 0;
    const exact = ourAddr === (gameAddr >>> 0);
    const gameSurf = exact ? undefined : opts.surfaceByAddr?.get(gameAddr >>> 0);
    const coplanar =
      gameSurf != null && ourSurf != null && samePlane(ourSurf, gameSurf);
    return {
      ok: exact || coplanar,
      ourAddr,
      gameAddr: gameAddr >>> 0,
      ourHeight,
      gameHeight,
      coplanar,
    };
  };

  const fh = partition.findFloor(cx, cy, cz);
  const floor = fieldOracle(
    fh.surface,
    fh.surface ? fh.height * scale : 0,
    state.floorAddr,
    state.floorHeight,
  );

  // The game finds the ceiling from `floorHeight + 80`, not Mario's position
  // (vec3f_find_ceil in update_mario_geometry_inputs), so a low ceiling near his
  // feet is skipped. The +80 is an unscaled collision-space constant. With no
  // floor, floorHeight is FLOOR_LOWER_LIMIT (fh.height already holds it).
  const ceilY = fh.height + 80;
  const ch = partition.findCeil(cx, ceilY, cz);
  const ceil = fieldOracle(
    ch.surface,
    ch.surface ? ch.height * scale : 0,
    state.ceilAddr,
    state.ceilHeight,
  );

  // Walls: replicate the game's own wall checks (the (offsetY, radius) pairs its
  // ground/air quarter-steps use) and union everything they detect near Mario.
  // gMarioState->wall is whichever of those wrote last, so if our core is
  // faithful the game's wall is in this set. Wall triangles are float-tested (no
  // s16 truncation), so we query at the float collision position.
  const ourWalls = new Set<number>();
  const ourWallSurfaces: Surface[] = [];
  const wx = state.pos.x / scale;
  const wy = state.pos.y / scale;
  const wz = state.pos.z / scale;
  for (const [offsetY, radius] of GAME_WALL_QUERIES) {
    const wc = partition.findWallCollisions(wx, wy, wz, offsetY / scale, radius / scale);
    for (const w of wc.walls) {
      const a = w.address >>> 0;
      if (!ourWalls.has(a)) {
        ourWalls.add(a);
        ourWallSurfaces.push(w);
      }
    }
  }

  const gameWallAddr = state.wallAddr >>> 0;
  const exact = ourWalls.has(gameWallAddr);
  // Stale when Mario didn't move this frame: the game skips the ground/air step
  // that recomputes m->wall, so its value is left over from an earlier position.
  const stale = opts.moved === false;
  // Coplanar match only counts when it isn't already an exact hit (a wall is
  // trivially coplanar with itself).
  const gameWall = exact ? undefined : opts.surfaceByAddr?.get(gameWallAddr);
  const coplanar =
    gameWall != null && ourWallSurfaces.some((w) => samePlane(w, gameWall));
  const wall: WallOracle = {
    ok: gameWallAddr === 0 || stale || exact || coplanar,
    gameAddr: gameWallAddr,
    ourAddrs: [...ourWalls],
    stale,
    coplanar,
  };

  return { floor, ceil, wall, ok: floor.ok && ceil.ok };
}
