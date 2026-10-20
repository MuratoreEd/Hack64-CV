// P3 probe: invisible-wall detection by faithful step simulation.
//
// Game mechanic (mario_step.c, perform_ground_quarter_step — verified verbatim
// against n64decomp/sm64):
//   0. `resolve_and_return_wall_collisions(nextPos, 30.0f, 24.0f)` then
//      `(nextPos, 60.0f, 50.0f)` — wall pushes move the step target BEFORE any
//      floor/ceiling is looked up. The lower one is what stops Mario at walls
//      too short to reach +60 (curbs, low ledge faces).
//   1. `if (floor == NULL) return GROUND_STEP_HIT_WALL_STOP_QSTEPS;`
//   2. leave-ground branch `nextPos[1] > floorHeight + 100`:
//        `if (nextPos[1] + 160 >= ceilHeight) return HIT_WALL_STOP_QSTEPS;`
//   3. grounded: `if (floorHeight + 160 >= ceilHeight) return HIT_WALL_STOP_QSTEPS;`
// where ceilHeight = find_ceil(x, floorHeight + 80, z) (vec3f_find_ceil). Every
// one of those early returns presents to the player as a wall — and when no
// wall surface is actually there, an INVISIBLE wall.
//
// perform_air_quarter_step blocks the same way with different constants: wall
// pushes (150, 50) then (30, 50), then `floorHeight = find_floor(x, MARIO'S y,
// z)` and `ceilHeight` from that floor + 80 — so a ceiling's blocked band
// extends from ceilHeight−160 all the way up to the next floor that find_floor
// RESOLVES to, even when the gap below it clears Mario and walking under is
// fine (`if (nextPos[1] + 160.0f > ceilHeight) ... return AIR_STEP_HIT_WALL`).
// Ground marching alone misses that class (verified live: a near-vertical tri
// classified as ceiling — ny −0.069 — walled airborne Mario ~2800 units above
// the tri's own top edge, with walking under it unobstructed), so ceiling
// edges get a second, air-step check; see checkAirStep.
//
// Step 0 is why walls "cap" leaked ceilings: the target can never come to rest
// within the push radius in front of a front-facing wall, so a ceiling leaking
// less than that past its wall is unreachable and never blocks — while a
// deeper leak leaves a reachable blocked band (the real invisible wall). We
// simulate the push with the faithful findWallCollisions and take every
// floor/ceiling verdict at the PUSHED target, exactly like the game.
//
// The walkable↔blocked boundary can only move where the column contents change:
// at ceiling footprint edges (a leaked ceiling starts blocking) and at floor
// edges (a drop-off exposes a roofed room below, or the floor vanishes into a
// truncation crack). So we march the edges of every static ceiling AND floor
// triangle, probe just inside/outside with ONLY the faithful queries, and emit
// segments where a step from the walkable side is blocked with no capping wall.
//
// Anomaly kinds — two spatial metrics:
//   - "exposed-ceiling": the blocked region sits above a ceiling and below the
//     next floor over the column. Branches 2 and 3 are the same phenomenon
//     reached grounded vs leaving ground (every point above a ceiling is a
//     blocked step target until a floor above resets find_floor), so they emit
//     one kind. When Mario doesn't fit between floor and ceiling the pocket
//     UNDER the ceiling is blocked too and the region reaches the floor.
//   - "out-of-bounds": floor == NULL in a narrow crack (branch 1); wide voids
//     are level boundaries (intentional) and are skipped
//
// Each segment carries the full blocked vertical interval [yLow, yHigh],
// truncated by the surfaces that bound it (or capped just above the level's
// highest geometry when the column is open to the sky).
//
// Scale note: 160 (hitbox), 100 (leave-ground), and the wall pushes' offsets /
// radii live in mario_step.c and compare WORLD units → pass each /scale in
// collision units. (Frame's patch confirms it for walls: on extended-boundary
// ROMs its wall routine multiplies position, offset and radius by 1/4.) The +80
// ceil offset and ±78 buffers live inside the collision routines and stay raw
// (verified live against the 4× hack).

import type { Surface } from "../collision/surface";
import type { FloorSelect, WallModel } from "../collision/profile";
import { SurfaceKind, deriveLevelBounds } from "../collision/surface";
import { SpatialPartition, deriveBoundary } from "../collision/partition";
import {
  SURFACE_CAMERA_BOUNDARY,
  SURFACE_FLAG_DYNAMIC,
  SURFACE_INTANGIBLE,
} from "../collision/constants";

export type InvisibleWallKind = "exposed-ceiling" | "out-of-bounds";

export interface InvisibleWallSegment {
  /** Segment endpoints along the marched edge (collision space). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Walkable-side floor height (where Mario stands when he hits the wall). */
  yBase: number;
  /** Full blocked vertical interval at the target column: from the floor or
   * ceiling the region rests on up to the floor that ends it (or the sky cap
   * just above the level's highest geometry when nothing does). */
  yLow: number;
  yHigh: number;
  kind: InvisibleWallKind;
  /** The blocking ceiling surface (0 for out-of-bounds). */
  blockerAddr: number;
  /** Pool index of the surface whose edge was being marched. */
  sourceIndex: number;
  /** Number of probe samples merged into this segment. */
  samples: number;
  /** The blocked unit columns themselves: x/z is the INTEGER column the
   * step was actually blocked at (the probe samples integer columns, matching
   * the game's find_floor cell math), yLow/yHigh the blocked interval there.
   * Deduplicated — a rim marched from both of its triangles contributes each
   * cell once. The renderer draws each as a unit-footprint box, so what's on
   * screen is exactly the set of cells the probe proved blocked. */
  columns: { x: number; z: number; yLow: number; yHigh: number }[];
}

export interface ProbeOptions {
  /** Mario's hitbox height in collision units (world 160 / scale). */
  marioHeight?: number;
  /** Leave-ground threshold in collision units (world 100 / scale). */
  ledgeGrace?: number;
  /** Sampling step along each edge, collision units. */
  step?: number;
  /** Perpendicular probe distance from the edge. */
  sideOffset?: number;
  /** Wall-push y offset in collision units (world 60 / scale). The ground
   * step's lower push (30 / 24) and the air pushes are scaled from this and
   * wallRadius / marioHeight. */
  wallOffset?: number;
  /** Wall-push radius in collision units (world 50 / scale). */
  wallRadius?: number;
  /** Which wall routine the ROM runs (CollisionProfile.walls). Defaults to
   * "vanilla". */
  walls?: WallModel;
  /** Frame's edge margin in collision units (1 / worldScale). */
  edgeMargin?: number;
  /** Upper bound on samples per edge (guards absurd triangles). Past it the
   * spacing exceeds one unit and single-column pinholes can be stepped over,
   * so it sits well above any real edge length. */
  maxSamplesPerEdge?: number;
  /** Level boundary for the probe's partition. Defaults to deriving it from
   * the FULL surface list (matching the game), not the static subset. */
  boundary?: number;
  /** Merge collinear/duplicate segments (from shared edges) before returning.
   * Defaults to true; set false to inspect the raw per-edge output. */
  merge?: boolean;
  /** Use the partition's fine-grid pre-filter (identical results, ~10× fewer
   * candidates per query). Defaults to true; benchmarks flip it off. */
  accel?: boolean;
  /** Run the air-step pass over ceiling edges (perform_air_quarter_step walls
   * that ground marching cannot see). Defaults to true; A/B diagnostics and
   * regression tests flip it off to isolate the ground pass. */
  airPass?: boolean;
  /** Steepness gate for the air pass: only ceilings with normal.y ABOVE this
   * participate. Default −0.5 = steeper than 60° from horizontal, i.e. only
   * surfaces that read as walls but are classified as ceilings. See the
   * air-pass comment for why roofs are excluded. */
  airMaxNormalY?: number;
  /** Drop blocked columns that lie INSIDE solid geometry — behind the front
   * face of a wall bounding the same structure — since nothing there is
   * reachable and the block is the visible solid, not an invisible wall.
   * Defaults to true; set false to see the raw step verdicts. */
  cullInsideSolid?: boolean;
  /** Floor/ceiling selection rule for the probe's own partition
   * (CollisionProfile.select). Must match the running ROM — it decides both
   * which surfaces queries resolve to and whether floorAbove treats shadowed
   * floors as region-terminating. Defaults to "first" (vanilla). */
  select?: FloorSelect;
}

export interface ProbeResult {
  segments: InvisibleWallSegment[];
  ceilingsProbed: number;
  floorsProbed: number;
  samplesProbed: number;
  elapsedMs: number;
}

/** Plane height of a surface at (x, z): h = -(nx·x + nz·z + oo) / ny. */
function planeHeight(s: Surface, x: number, z: number): number {
  return -(x * s.normal.x + z * s.normal.z + s.originOffset) / s.normal.y;
}

// Segment merge tolerances (collision units). Segments derive from integer
// columns, so the same wall's pieces sit on the exact same line (perp ≈ 0);
// a small gap bridges the 1–2 columns where a lone interior sample failed.
const MERGE_PERP_TOL = 1.0;
const MERGE_GAP_TOL = 3.0;

/** If A and B share a kind+blocker, lie on one XZ line, and their extents
 * overlap or nearly touch, return their union; otherwise null. */
function fuse(
  a: InvisibleWallSegment,
  b: InvisibleWallSegment,
): InvisibleWallSegment | null {
  // Direction along A (fall back to B, then to a coincidence test for points).
  let ux = a.x1 - a.x0;
  let uz = a.z1 - a.z0;
  let ulen = Math.hypot(ux, uz);
  if (ulen < 1e-6) {
    ux = b.x1 - b.x0;
    uz = b.z1 - b.z0;
    ulen = Math.hypot(ux, uz);
  }
  if (ulen < 1e-6) {
    if (Math.hypot(b.x0 - a.x0, b.z0 - a.z0) > MERGE_GAP_TOL) return null;
    ux = 1;
    uz = 0;
    ulen = 1;
  }
  ux /= ulen;
  uz /= ulen;
  // Perpendicular distance of B's endpoints from A's line — both must be ~0.
  const perp = (x: number, z: number) =>
    Math.abs(-uz * (x - a.x0) + ux * (z - a.z0));
  if (perp(b.x0, b.z0) > MERGE_PERP_TOL || perp(b.x1, b.z1) > MERGE_PERP_TOL)
    return null;
  // Project all four endpoints onto the axis; require overlap or a small gap.
  const t = (x: number, z: number) => ux * (x - a.x0) + uz * (z - a.z0);
  const ta = [t(a.x0, a.z0), t(a.x1, a.z1)];
  const tb = [t(b.x0, b.z0), t(b.x1, b.z1)];
  const aMin = Math.min(...ta),
    aMax = Math.max(...ta);
  const bMin = Math.min(...tb),
    bMax = Math.max(...tb);
  if (bMin > aMax + MERGE_GAP_TOL || aMin > bMax + MERGE_GAP_TOL) return null;
  const lo = Math.min(aMin, bMin);
  const hi = Math.max(aMax, bMax);
  return {
    x0: a.x0 + ux * lo,
    z0: a.z0 + uz * lo,
    x1: a.x0 + ux * hi,
    z1: a.z0 + uz * hi,
    yBase: Math.min(a.yBase, b.yBase),
    // Union of the blocked vertical intervals.
    yLow: Math.min(a.yLow, b.yLow),
    yHigh: Math.max(a.yHigh, b.yHigh),
    kind: a.kind,
    blockerAddr: a.blockerAddr,
    sourceIndex: a.sourceIndex,
    samples: a.samples + b.samples,
    columns: [...a.columns, ...b.columns],
  };
}

/** Collapse a fused segment's columns to one entry per integer cell (two
 * triangles marching a shared rim both contribute it), taking the union of
 * the blocked intervals. */
function dedupeColumns(
  columns: InvisibleWallSegment["columns"],
): InvisibleWallSegment["columns"] {
  const byCell = new Map<string, InvisibleWallSegment["columns"][number]>();
  for (const c of columns) {
    const key = `${c.x},${c.z}`;
    const e = byCell.get(key);
    if (e) {
      e.yLow = Math.min(e.yLow, c.yLow);
      e.yHigh = Math.max(e.yHigh, c.yHigh);
    } else {
      byCell.set(key, { ...c });
    }
  }
  return [...byCell.values()];
}

/**
 * Collapse duplicate and fragmented segments. Two floor triangles sharing a
 * marched rim edge each emit a segment along it, and a run can break where a
 * lone interior sample fails then resumes — so the raw list holds many
 * collinear, overlapping pieces of the same wall. Merges within groups keyed by
 * kind+blocker (out-of-bounds segments all share blocker 0, which is correct:
 * they are the same crack kind and never carry a distinct surface to confuse).
 * Disjoint blocked ranges stacked in one column (two ceilings in a two-story
 * building) never fuse into one tall quad: their blockers differ.
 */
export function mergeSegments(
  segments: InvisibleWallSegment[],
): InvisibleWallSegment[] {
  const groups = new Map<string, InvisibleWallSegment[]>();
  for (const s of segments) {
    const key = `${s.kind}:${s.blockerAddr}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }

  const out: InvisibleWallSegment[] = [];
  for (const group of groups.values()) {
    const items = group.slice();
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < items.length && !merged; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const f = fuse(items[i], items[j]);
          if (f) {
            items[i] = f;
            items.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    for (const s of items)
      out.push({ ...s, columns: dedupeColumns(s.columns) });
  }
  return out;
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** The air pass tests this far above the marched ceiling's top vertex. */
const AIR_TEST_LIFT = 2;

interface StepBlock {
  kind: InvisibleWallKind;
  /** Full blocked vertical interval at the target column. */
  yLow: number;
  yHigh: number;
  blockerAddr: number;
}

export function findInvisibleWalls(
  surfaces: Surface[],
  opts: ProbeOptions = {},
): ProbeResult {
  // The probe world is STATIC geometry only: dynamic (object) surfaces move
  // every frame, so anomalies they cause are transient and would be stale by
  // the time they render. The boundary still comes from the full list so cell
  // membership matches the game's.
  const staticSurfaces = surfaces.filter(
    (s) => (s.flags & SURFACE_FLAG_DYNAMIC) === 0,
  );
  const partition = new SpatialPartition(staticSurfaces, {
    boundary: opts.boundary ?? deriveBoundary(surfaces),
    // Millions of queries over a static world: the fine-grid pre-filter
    // returns identical results with ~10× fewer candidates per query.
    // Measured in-browser (the real environment): ~5× faster with the fine
    // grid (3.1s vs 15.9s, 7337-surface pool). Node benchmarks via tsx are
    // misleading here — its keep-names wrappers dwarf the per-query savings.
    accel: opts.accel ?? true,
    select: opts.select ?? "first",
    walls: opts.walls ?? "vanilla",
    edgeMargin: opts.edgeMargin ?? 1,
    // The probe never queries walls wider than its own push radius, so the
    // fine grid only needs to inflate wall footprints that far — the default
    // 200 over-inflates by 16× on a 4× hack and buries every bin in walls the
    // query can't reach. Wall lookups are the probe's hottest path (up to
    // four per sample, millions of samples).
    wallReach: opts.wallRadius ?? 50,
  });
  const marioHeight = opts.marioHeight ?? 160;
  const ledgeGrace = opts.ledgeGrace ?? 100;
  const step = opts.step ?? 1;
  const side = opts.sideOffset ?? 1.5;
  const wallOffset = opts.wallOffset ?? 60;
  const wallRadius = opts.wallRadius ?? 50;
  const maxSamples = opts.maxSamplesPerEdge ?? 32768;
  const airPass = opts.airPass ?? true;
  const airMaxNormalY = opts.airMaxNormalY ?? -0.5;
  const cullInsideSolid = opts.cullInsideSolid ?? true;
  // perform_ground_quarter_step pushes (30, 24) BEFORE (60, 50); scaled from
  // the configured upper push, like everything else in mario_step.c.
  const groundLowerOffset = (30 / 60) * wallOffset;
  const groundLowerRadius = (24 / 50) * wallRadius;
  // perform_air_quarter_step's wall pushes sit at +150/+30 world units with
  // the same 50 radius; scale like marioHeight.
  const airUpperOffset = (150 / 160) * marioHeight;
  const airLowerOffset = (30 / 160) * marioHeight;

  // Where an open column's blocked region visually ends: just above the
  // level's highest geometry (derived per level — never a hardcoded bound).
  const levelBounds = deriveLevelBounds(staticSurfaces);
  const skyCap = Number.isFinite(levelBounds.maxY)
    ? levelBounds.maxY +
      Math.max((levelBounds.maxY - levelBounds.minY) * 0.05, marioHeight)
    : marioHeight;

  const t0 = now();
  const segments: InvisibleWallSegment[] = [];
  let ceilingsProbed = 0;
  let floorsProbed = 0;
  let samplesProbed = 0;

  // Scratch objects reused across the probe's millions of queries — the Into
  // query variants exist so this loop allocates nothing per sample.
  const wFloor = { surface: null, height: 0 } as ReturnType<typeof partition.findFloor>;
  const wCeil = { surface: null, height: 0 } as ReturnType<typeof partition.findCeil>;
  const tFloor = { surface: null, height: 0 } as ReturnType<typeof partition.findFloor>;
  const tCeil = { surface: null, height: 0 } as ReturnType<typeof partition.findCeil>;
  const wallData = {
    x: 0, y: 0, z: 0, offsetY: 0, radius: 0,
    walls: [] as Surface[], numWalls: 0,
  };

  /** Walkable-side floor height at column (x, z) found from y, or NaN when
   * Mario can't exist standing there. */
  const walkableAt = (x: number, y: number, z: number): number => {
    partition.findFloorInto(x, y, z, wFloor);
    if (!wFloor.surface) return NaN;
    partition.findCeilInto(x, wFloor.height + 80, z, wCeil);
    return wCeil.height - wFloor.height > marioHeight ? wFloor.height : NaN;
  };

  /** Apply two wall pushes in order at (x, y, z); wallData holds the result. */
  const push2 = (
    x: number, y: number, z: number,
    off1: number, rad1: number, off2: number, rad2: number,
  ): void => {
    wallData.x = x;
    wallData.y = y;
    wallData.z = z;
    wallData.offsetY = off1;
    wallData.radius = rad1;
    wallData.walls.length = 0;
    wallData.numWalls = 0;
    partition.findWallCollisionsInto(wallData);
    wallData.offsetY = off2;
    wallData.radius = rad2;
    wallData.walls.length = 0;
    wallData.numWalls = 0;
    partition.findWallCollisionsInto(wallData);
  };

  /**
   * Can Mario actually be standing at the approach column? The game applies
   * the wall pushes to his position every frame, so he is never inside a
   * wall's push radius in front of it: an approach column the pushes would
   * move is somewhere he can't stand, and a block "seen" from there is not
   * one he can walk into.
   *
   * Only asked under Frame's walls. Vanilla walls also push from BEHIND,
   * shoving a step target that crossed the plane back out in front — which is
   * what already keeps vanilla steps from sneaking past a wall from an
   * unreachable approach (and what makes a back-facing wall a real, verified
   * invisible wall). One-sided walls do neither, so without this every seam
   * capped by a front-facing wall would light up. Checked only after a block
   * is found: blocks are rare, pushes are the probe's hottest cost.
   */
  const frameWalls = partition.walls === "frame";
  const approachStable = (
    x: number, y: number, z: number,
    off1: number, rad1: number, off2: number, rad2: number,
  ): boolean => {
    push2(x, y, z, off1, rad1, off2, rad2);
    return Math.abs(wallData.x - x) < 0.01 && Math.abs(wallData.z - z) < 0.01;
  };

  /**
   * Simulate perform_ground_quarter_step from approach height `py` into column
   * (tx, tz). Returns the blocking condition, or null when the step is free.
   * `dirX/dirZ` point from the walkable side toward the target (used to tell a
   * narrow crack from an intentional level-boundary void).
   */
  /** Lowest floor plane above `y` that ACTUALLY ends the blocked region, or
   * the sky cap.
   *
   * Under VANILLA first-hit-wins selection, a floor above only resets
   * find_floor if find_floor RESOLVES to it: the cell sort (vertices[0].y
   * desc) can shadow a floor behind one sorted earlier whose plane sits far
   * lower at this column (the floor-overlap bug), and a shadowed floor never
   * truncates — queries from above it still fall through to the low floor,
   * keep finding the blocking ceiling, and stay blocked. Verified live on a
   * scale-4 hack (alcove slab whose top floor is shadowed by a ramp → steps
   * blocked hundreds of units above the slab, far past the geometric cap).
   *
   * Under "extreme" selection the shadowing cannot happen — the engine scans
   * the whole list and takes the highest floor — so every geometrically
   * present floor above truncates, and the resolve check must NOT be applied.
   * Applying it anyway sent regions to the sky cap all over a patched ROM's
   * level: the "huge invisible walls" report that uncovered this. */
  const shadowAware = partition.select === "first";
  const aFloor = { surface: null, height: 0 } as ReturnType<typeof partition.findFloor>;
  const floorAbove = (x: number, z: number, y: number): number => {
    const above = partition
      .floorsAt(x, z)
      // An intangible floor never resets find_floor (Mario falls through it),
      // under either selection rule.
      .filter((f) => f.height > y && f.surface.type !== SURFACE_INTANGIBLE)
      .sort((a, b) => a.height - b.height);
    for (const f of above) {
      if (!shadowAware) return f.height;
      partition.findFloorInto(x, f.height + 1, z, aFloor);
      if (aFloor.surface && aFloor.height >= f.height - 0.01) return f.height;
    }
    return skyCap;
  };

  /**
   * Does stepping from the walkable column to the target cross INTO solid
   * geometry? True when a wall's front face lies between them, meaning the
   * target sits behind the shell of the structure whose ceiling is blocking.
   *
   * Why this is worth culling, and why the existing wall-cap logic misses it
   * (verified live, level 15 world (-5304, 1432, 812)): a solid wedge had its
   * sloped underside (ceiling, ny -0.632) meeting its own west wall exactly at
   * x = -1326 — a properly sealed solid, nothing leaking. Mario on the floor at
   * y 358 with the underside at 379 doesn't fit (needs 40), so the ground step
   * is genuinely blocked; but the wedge's west wall spans y 379..609, entirely
   * ABOVE his +15/+60 push offsets, so no wall engages and the seam reads as
   * uncapped. The region then ran from his feet up through the wedge's solid
   * interior to its roof. Nothing about that is invisible — you can see the ramp
   * is too low. The genuine pathology is the opposite geometry: a ceiling whose
   * footprint LEAKS past its bounding wall, leaving you blocked in open air
   * BESIDE the structure, where the approach and the target are both outside
   * the shell and this test finds no crossing.
   *
   * Deliberately height-agnostic about Mario (the bounding wall is usually
   * above him) but not about the region: the wall must span some of the blocked
   * interval it is supposed to be enclosing, so an unrelated wall elsewhere in
   * the column can't cull a real ground-level wall.
   */
  // One-entry memo: sampling walks an edge, so consecutive samples land in the
  // same blocked cell with the same interval far more often than not, and the
  // verdict is a pure function of those. Wall bins hold ~100 surfaces, so not
  // re-scanning is worth more than the comparison costs.
  let memoX = NaN;
  let memoZ = NaN;
  let memoWX = NaN;
  let memoWZ = NaN;
  let memoLow = NaN;
  let memoHigh = NaN;
  let memoVerdict = false;

  const entersSolid = (
    wx: number,
    wz: number,
    tx: number,
    tz: number,
    yLow: number,
    yHigh: number,
  ): boolean => {
    if (
      tx === memoX && tz === memoZ && wx === memoWX && wz === memoWZ &&
      yLow === memoLow && yHigh === memoHigh
    ) {
      return memoVerdict;
    }
    const walls = partition.wallsAt(tx, tz);
    // Region mid-height: walls are near-vertical, so the ny term barely
    // participates, and one height serves the whole interval.
    const yMid = (yLow + yHigh) / 2;
    let verdict = false;
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      // Cheapest rejections first — the bin is dominated by walls nowhere near
      // this column (the fine grid inflates wall footprints by the push reach).
      if (w.upperY < yLow || w.lowerY > yHigh) continue;
      if (w.type === SURFACE_CAMERA_BOUNDARY) continue;
      const v = w.vertices;
      const ax = v[0][0], bx2 = v[1][0], cx2 = v[2][0];
      if (tx + 1 < (ax < bx2 ? (ax < cx2 ? ax : cx2) : (bx2 < cx2 ? bx2 : cx2))) continue;
      if (tx - 1 > (ax > bx2 ? (ax > cx2 ? ax : cx2) : (bx2 > cx2 ? bx2 : cx2))) continue;
      const az = v[0][2], bz2 = v[1][2], cz2 = v[2][2];
      if (tz + 1 < (az < bz2 ? (az < cz2 ? az : cz2) : (bz2 < cz2 ? bz2 : cz2))) continue;
      if (tz - 1 > (az > bz2 ? (az > cz2 ? az : cz2) : (bz2 > cz2 ? bz2 : cz2))) continue;
      // Front (positive) side to back (non-positive) = entering the solid. The
      // reverse means the walkable side was already inside, which a marched
      // floor/ceiling edge shouldn't be, and equality means neither point moved
      // relative to the plane.
      const n = w.normal;
      const base = yMid * n.y + w.originOffset;
      if (!(wx * n.x + wz * n.z + base > 0)) continue;
      if (tx * n.x + tz * n.z + base > 0) continue;
      verdict = true;
      break;
    }
    memoX = tx; memoZ = tz; memoWX = wx; memoWZ = wz;
    memoLow = yLow; memoHigh = yHigh; memoVerdict = verdict;
    return verdict;
  };

  const checkStep = (
    py: number,
    tx: number,
    tz: number,
    dirX: number,
    dirZ: number,
  ): StepBlock | null => {
    // Step 0: the game's wall pushes move the target before anything else —
    // the lower (30, 24) and then the upper (60, 50), exactly in that order.
    // A wall engaged from the front holds Mario outside (a wall caps its seam
    // however shallow the leak). From behind, vanilla shoves him forward
    // through the plane, while Frame's patch ignores the back side; the
    // partition runs whichever routine the ROM has (ProbeOptions.walls).
    push2(tx, py, tz, groundLowerOffset, groundLowerRadius, wallOffset, wallRadius);
    tx = wallData.x;
    tz = wallData.z;
    partition.findFloorInto(tx, py, tz, tFloor);
    if (!tFloor.surface) {
      // Branch 1: floor NULL. Only a narrow crack counts — if the floor never
      // comes back a few units further, this is the level boundary / a real
      // pit edge, which the player reads as intentional.
      for (let ext = 2; ext <= 6; ext += 2) {
        partition.findFloorInto(
          Math.round(tx + dirX * ext),
          py,
          Math.round(tz + dirZ * ext),
          tFloor,
        );
        if (tFloor.surface) {
          // The crack blocks from the approach floor up to the first surface
          // over its column (a floor resets find_floor; a ceiling starts an
          // exposed-ceiling region instead), else it is open to the sky.
          let yHigh = floorAbove(tx, tz, py);
          partition.findCeilInto(tx, py + 1, tz, tCeil);
          if (tCeil.surface && tCeil.height > py && tCeil.height < yHigh) {
            yHigh = tCeil.height;
          }
          return { kind: "out-of-bounds", yLow: py, yHigh, blockerAddr: 0 };
        }
      }
      return null;
    }
    const floorH = tFloor.height;
    partition.findCeilInto(tx, floorH + 80, tz, tCeil);
    // Branch 2 (leave ground) vs branch 3 (grounded) pick the compared height.
    const blockY = py > floorH + ledgeGrace ? py : floorH;
    if (!(blockY + marioHeight >= tCeil.height)) return null;
    if (!tCeil.surface) return null; // blocked only by the numeric limit — never
    // Everything above the blocking ceiling is a blocked step target until the
    // next floor above resets find_floor; when Mario doesn't fit between floor
    // and ceiling the pocket below the ceiling is blocked too, so the region
    // reaches down to the floor.
    return {
      kind: "exposed-ceiling",
      yLow: floorH + marioHeight >= tCeil.height ? floorH : tCeil.height,
      yHigh: floorAbove(tx, tz, tCeil.height),
      blockerAddr: tCeil.surface.address >>> 0,
    };
  };

  /**
   * Air-only invisible walls (perform_air_quarter_step): tried at ceiling-edge
   * samples where the GROUND step passed. Tested just above the marched
   * ceiling's highest vertex — where blocked collision is, by definition, not
   * explained by the visible surface.
   *
   * STEEPNESS GATE (airMaxNormalY, default −0.5). Only ceilings steeper than
   * 60° from horizontal participate. The column above ANY ceiling is blocked
   * until a floor resets find_floor — that is universal SM64 behavior (find_
   * floor ignores ceilings), true of every roof in every level including
   * vanilla, and it is co-located with obvious visible geometry: Mario is
   * directly over a solid roof. Reporting it buries the real findings (live
   * level 15: flat roofs produced 34233 of 36679 air columns, 14× everything
   * else) and flags no defect. A near-VERTICAL ceiling is the opposite: its
   * normal.y sits just past the engine's ±0.01 wall cutoff, so the author drew
   * a wall and the engine kept a roof — and its blocked band stands in open
   * air far from the thin sliver of geometry that causes it. That is the
   * "slams into nothing" pathology this probe exists to find (verified live:
   * ny −0.069, band ~2800 units above the triangle's own top edge).
   * The ground pass is unaffected — flat roofs keep every ground detection
   * they had (12667 columns on that level, including all roofed-drop rims).
   *
   * Two further filters keep legit solids silent:
   *   - the air wall pushes (150/30, radius 50): a solid box's side walls cap
   *     horizontal entry whenever the box is thicker than the lower push
   *     offset (30), exactly as in the game;
   *   - the blocked band must extend more than a hitbox above the blocker's
   *     own top vertex: a thinner slab's band ends at its landable deck
   *     (find_floor resolves the deck right above the test height), so a
   *     bridge reads as "the bridge is solid", not as an invisible wall.
   * A leaked ceiling has neither wall nor deck, and its band runs to the next
   * resolvable floor or the sky — that is the wall this check reports.
   */
  const checkAirStep = (
    tx: number,
    tz: number,
    wx: number,
    wz: number,
    surfTopY: number,
  ): StepBlock | null => {
    const yTest = surfTopY + AIR_TEST_LIFT;
    // The approach column must be free air at the test height: over a void the
    // approach itself is an air wall (floor NULL → AIR_STEP_HIT_WALL), and on
    // interior seams both sides are blocked — neither is observable from
    // gameplay-reachable space.
    partition.findFloorInto(wx, yTest, wz, wFloor);
    if (!wFloor.surface) return null;
    partition.findCeilInto(wx, wFloor.height + 80, wz, wCeil);
    if (wCeil.surface && yTest + marioHeight > wCeil.height) return null;
    // Air wall pushes move the target first: upper (150) then lower (30).
    push2(tx, yTest, tz, airUpperOffset, wallRadius, airLowerOffset, wallRadius);
    const ax = wallData.x;
    const az = wallData.z;
    partition.findFloorInto(ax, yTest, az, tFloor);
    if (!tFloor.surface) return null; // air OOB: ground marching covers cracks
    const floorH = tFloor.height;
    partition.findCeilInto(ax, floorH + 80, az, tCeil);
    if (!tCeil.surface) return null;
    if (!(yTest + marioHeight > tCeil.height)) return null;
    const cSurf = tCeil.surface;
    // The surface actually walling Mario must be the wall-like kind (see the
    // steepness gate above) — a roof resolved here is ordinary engine
    // behavior even when the marched edge belonged to a steep neighbor.
    if (cSurf.normal.y <= airMaxNormalY) return null;
    const cTop = Math.max(
      cSurf.vertices[0][1],
      cSurf.vertices[1][1],
      cSurf.vertices[2][1],
    );
    const yHigh = floorAbove(ax, az, tCeil.height);
    // Suppress only bands capped by a REAL landable floor near the blocker's
    // top (a slab's deck). A sky-open column is never suppressed — even when
    // the blocker is the level's topmost geometry and the sky cap sits just
    // a hitbox above it.
    if (yHigh !== skyCap && yHigh <= cTop + marioHeight) return null;
    return {
      kind: "exposed-ceiling",
      yLow: floorH + marioHeight >= tCeil.height ? floorH : tCeil.height,
      yHigh,
      blockerAddr: cSurf.address >>> 0,
    };
  };

  // Per-sample target-column scratch (blocked-side candidates, at most 3).
  const targetX = [0, 0, 0];
  const targetZ = [0, 0, 0];

  /**
   * March one triangle edge (a→b, third vertex c marking the footprint's
   * inside). `walkSide` says which side of the edge is the walkable approach:
   * "out" for ceiling edges (outside the leaky footprint), "in" for floor
   * edges (standing on the floor, stepping off it).
   */
  const marchEdge = (
    surf: Surface,
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    walkSide: "in" | "out",
  ): void => {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return; // edge is vertical in XZ — no footprint boundary
    // Highest vertex of the marched ceiling: the air check tests just above
    // it, where blocking cannot be explained by the surface itself.
    const surfTopY = Math.max(a[1], b[1], c[1]);
    // Steepness gate (see checkAirStep): roofs are skipped outright, so the
    // air queries never run for the overwhelming majority of ceiling edges.
    const airStepEdge =
      airPass && walkSide === "out" && surf.normal.y > airMaxNormalY;

    // Unit perpendicular oriented toward the third vertex (footprint inside).
    let px = -dz / len;
    let pz = dx / len;
    const inwards = px * (c[0] - a[0]) + pz * (c[2] - a[2]);
    if (inwards === 0) return; // zero-area footprint
    if (inwards < 0) {
      px = -px;
      pz = -pz;
    }
    // Walkable side sign along the perpendicular: ceilings are approached from
    // outside the footprint, floors are stood on inside it.
    const wSign = walkSide === "in" ? 1 : -1;

    const n = Math.max(1, Math.min(Math.ceil(len / step), maxSamples));

    let prevI = -2;
    let run: {
      x0: number; z0: number; x1: number; z1: number;
      yBase: number; yLow: number; yHigh: number; kind: InvisibleWallKind;
      addr: number; count: number;
      columns: { x: number; z: number; yLow: number; yHigh: number }[];
    } | null = null;

    const flush = () => {
      if (!run) return;
      segments.push({
        x0: run.x0, z0: run.z0, x1: run.x1, z1: run.z1,
        yBase: run.yBase, yLow: run.yLow, yHigh: run.yHigh,
        kind: run.kind,
        blockerAddr: run.addr,
        sourceIndex: surf.index,
        samples: run.count,
        columns: run.columns,
      });
      run = null;
    };

    for (let i = 0; i <= n; i++) {
      const mx = a[0] + (dx * i) / n;
      const mz = a[2] + (dz * i) / n;
      const wx = Math.round(mx + px * side * wSign);
      const wz = Math.round(mz + pz * side * wSign);
      // Blocked-side candidate columns: ON the seam line and 1–2 units past it.
      // Truncation pinholes live exactly on triangle seams — a single fixed
      // ±1.5 offset steps right over them (verified live: a seam full of
      // roofed pinhole columns produced zero hits until offset 0/1 probing).
      let nTargets = 0;
      for (let k = 0; k <= 2; k++) {
        const tx = Math.round(mx - px * k * wSign);
        const tz = Math.round(mz - pz * k * wSign);
        if (tx === wx && tz === wz) continue;
        let dup = false;
        for (let t = 0; t < nTargets; t++) {
          if (targetX[t] === tx && targetZ[t] === tz) {
            dup = true;
            break;
          }
        }
        if (!dup) {
          targetX[nTargets] = tx;
          targetZ[nTargets] = tz;
          nTargets++;
        }
      }
      if (nTargets === 0) continue;
      samplesProbed++;

      // Walkable-side seed: for ceiling edges, the topmost floor at/below the
      // ceiling plane (79 cancels the ±78 buffer — never a floor above the
      // ceiling); for floor edges, just above this floor's own plane.
      const seedY =
        walkSide === "out"
          ? Math.trunc(planeHeight(surf, wx, wz)) - 79
          : Math.trunc(planeHeight(surf, wx, wz)) + 1;

      const floorH = walkableAt(wx, seedY, wz);

      let block: StepBlock | null = null;
      let bx = 0;
      let bz = 0;
      if (!Number.isNaN(floorH)) {
        for (let t = 0; t < nTargets; t++) {
          const tx = targetX[t];
          const tz = targetZ[t];
          const dx = tx - wx;
          const dz = tz - wz;
          const dLen = Math.max(1, Math.sqrt(dx * dx + dz * dz));
          block = checkStep(floorH, tx, tz, dx / dLen, dz / dLen);
          if (block) {
            bx = tx;
            bz = tz;
            break;
          }
        }
        if (
          block && frameWalls &&
          !approachStable(
            wx, floorH, wz,
            groundLowerOffset, groundLowerRadius, wallOffset, wallRadius,
          )
        ) {
          block = null;
        }
      }
      // Air pass, steep ceiling edges only, and only where the ground step
      // found nothing (never double-flags a cell). Runs even when there is no
      // standable approach under the ceiling — airborne Mario needs none.
      // A steep ceiling's band lives over its own footprint, so marching that
      // ceiling reaches it; gating here also skips the queries for every roof.
      if (!block && airStepEdge) {
        for (let t = 0; t < nTargets; t++) {
          block = checkAirStep(targetX[t], targetZ[t], wx, wz, surfTopY);
          if (block) {
            bx = targetX[t];
            bz = targetZ[t];
            break;
          }
        }
        if (
          block && frameWalls &&
          !approachStable(
            wx, surfTopY + AIR_TEST_LIFT, wz,
            airUpperOffset, wallRadius, airLowerOffset, wallRadius,
          )
        ) {
          block = null;
        }
      }
      if (!block) continue;
      // Unreachable interior of a sealed structure: the block is the visible
      // solid, not an invisible wall.
      if (cullInsideSolid && entersSolid(wx, wz, bx, bz, block.yLow, block.yHigh)) {
        continue;
      }
      // Where Mario "stands" when he hits it: the walkable-side floor, or for
      // an air-only wall with no standable approach, the region's own base.
      const base = Number.isNaN(floorH) ? block.yLow : floorH;

      // A run continues only while the SAME surface blocks: a change of blocker
      // along one edge (two ceilings meeting over it) starts a new segment, so
      // every column is attributed — and inspected, and merged — by the
      // ceiling that actually blocks it.
      if (
        run !== null && i === prevI + 1 && run.kind === block.kind &&
        run.addr === block.blockerAddr
      ) {
        run.x1 = mx;
        run.z1 = mz;
        run.yBase = Math.min(run.yBase, base);
        run.yLow = Math.min(run.yLow, block.yLow);
        run.yHigh = Math.max(run.yHigh, block.yHigh);
        run.count++;
        // Sub-unit sample spacing can land two samples in the same integer
        // column — widen that column's interval instead of duplicating it.
        const last = run.columns[run.columns.length - 1];
        if (last.x === bx && last.z === bz) {
          last.yLow = Math.min(last.yLow, block.yLow);
          last.yHigh = Math.max(last.yHigh, block.yHigh);
        } else {
          run.columns.push({ x: bx, z: bz, yLow: block.yLow, yHigh: block.yHigh });
        }
      } else {
        flush();
        run = {
          x0: mx, z0: mz, x1: mx, z1: mz,
          yBase: base,
          yLow: block.yLow,
          yHigh: block.yHigh,
          kind: block.kind,
          addr: block.blockerAddr,
          count: 1,
          columns: [{ x: bx, z: bz, yLow: block.yLow, yHigh: block.yHigh }],
        };
      }
      prevI = i;
    }
    flush();
  };

  for (const surf of staticSurfaces) {
    if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;
    // find_floor never returns an intangible floor to Mario, so what his steps
    // see doesn't change across its edges — nothing to march.
    if (surf.type === SURFACE_INTANGIBLE && surf.kind === SurfaceKind.Floor) continue;
    const walkSide =
      surf.kind === SurfaceKind.Ceiling
        ? ("out" as const)
        : surf.kind === SurfaceKind.Floor
          ? ("in" as const)
          : null;
    if (walkSide === null) continue;
    if (walkSide === "out") ceilingsProbed++;
    else floorsProbed++;

    for (let e = 0; e < 3; e++) {
      marchEdge(
        surf,
        surf.vertices[e],
        surf.vertices[(e + 1) % 3],
        surf.vertices[(e + 2) % 3],
        walkSide,
      );
    }
  }

  const finalSegments =
    (opts.merge ?? true) ? mergeSegments(segments) : segments;

  return {
    segments: finalSegments,
    ceilingsProbed,
    floorsProbed,
    samplesProbed,
    elapsedMs: now() - t0,
  };
}
