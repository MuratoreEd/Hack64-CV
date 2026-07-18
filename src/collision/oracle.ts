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

// The (offsetY, radius) pairs the game itself uses to set gMarioState->wall:
// perform_ground_quarter_step runs (30, 24) then (60, 50); perform_air_quarter_step
// runs (30, 50) then (60, 150). We union the walls found across all four so the
// membership test reflects exactly what the game's own routines would detect near
// Mario, regardless of which act (ground vs air) last wrote the pointer.
const GAME_WALL_QUERIES: readonly [number, number][] = [
  [30, 24],
  [60, 50],
  [30, 50],
  [60, 150],
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

/**
 * Detect the world→collision scale from the floor the game reports, using a flat
 * floor (|normal.y| ~ 1) whose plane height is constant, so
 *   scale = gameFloorHeight / (collision plane height).
 * Returns a clean power-of-two-ish factor, or null when it can't be determined
 * this frame (no floor, floor not in pool, sloped floor, plane through origin).
 */
export function detectWorldScale(
  surfaces: Surface[],
  state: StateMessage,
): number | null {
  if (!state.floorAddr) return null;
  const s = surfaces.find((s) => s.address === state.floorAddr);
  if (!s || Math.abs(s.normal.y) < 0.99) return null;
  const collisionHeight = -s.originOffset / s.normal.y;
  if (Math.abs(collisionHeight) < 1) return null; // near origin: unreliable
  const raw = state.floorHeight / collisionHeight;
  let best = CLEAN_SCALES[0];
  for (const c of CLEAN_SCALES) if (Math.abs(c - raw) < Math.abs(best - raw)) best = c;
  return Math.abs(best - raw) < 0.05 ? best : null;
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
  // feet is skipped. The +80 is an unscaled collision-space constant.
  const ceilY = (fh.surface ? fh.height : cy) + 80;
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
    const wc = partition.findWallCollisions(wx, wy, wz, offsetY, radius);
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
