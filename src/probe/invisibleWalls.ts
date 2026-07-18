// P3 probe: invisible-wall detection by faithful step simulation.
//
// Game mechanic (mario_step.c, perform_ground_quarter_step — verified verbatim
// against n64decomp/sm64):
//   0. `resolve_and_return_wall_collisions(nextPos, 60.0f, 50.0f)` — wall
//      pushes move the step target BEFORE any floor/ceiling is looked up.
//   1. `if (floor == NULL) return GROUND_STEP_HIT_WALL_STOP_QSTEPS;`
//   2. leave-ground branch `nextPos[1] > floorHeight + 100`:
//        `if (nextPos[1] + 160 >= ceilHeight) return HIT_WALL_STOP_QSTEPS;`
//   3. grounded: `if (floorHeight + 160 >= ceilHeight) return HIT_WALL_STOP_QSTEPS;`
// where ceilHeight = find_ceil(x, floorHeight + 80, z) (vec3f_find_ceil). Every
// one of those early returns presents to the player as a wall — and when no
// wall surface is actually there, an INVISIBLE wall.
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
// Scale note: 160 (hitbox), 100 (leave-ground), and the wall push's 60 offset /
// 50 radius live in mario_step.c and compare WORLD units → pass each /scale in
// collision units. The +80 ceil offset and ±78 buffers live inside the
// collision routines and stay raw (verified live against the 4× hack).

import type { Surface } from "../collision/surface";
import { SurfaceKind, deriveLevelBounds } from "../collision/surface";
import { SpatialPartition, deriveBoundary } from "../collision/partition";
import {
  SURFACE_CAMERA_BOUNDARY,
  SURFACE_FLAG_DYNAMIC,
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
  /** Wall-push y offset in collision units (world 60 / scale). */
  wallOffset?: number;
  /** Wall-push radius in collision units (world 50 / scale). */
  wallRadius?: number;
  /** Upper bound on samples per edge (guards huge triangles). */
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
  });
  const marioHeight = opts.marioHeight ?? 160;
  const ledgeGrace = opts.ledgeGrace ?? 100;
  const step = opts.step ?? 1;
  const side = opts.sideOffset ?? 1.5;
  const wallOffset = opts.wallOffset ?? 60;
  const wallRadius = opts.wallRadius ?? 50;
  const maxSamples = opts.maxSamplesPerEdge ?? 2048;

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

  /**
   * Simulate perform_ground_quarter_step from approach height `py` into column
   * (tx, tz). Returns the blocking condition, or null when the step is free.
   * `dirX/dirZ` point from the walkable side toward the target (used to tell a
   * narrow crack from an intentional level-boundary void).
   */
  /** Lowest floor plane above `y` at the column, or the sky cap. A floor above
   * ends a blocked region: find_floor resolves to it from up there. */
  const floorAbove = (x: number, z: number, y: number): number => {
    let best = skyCap;
    for (const f of partition.floorsAt(x, z)) {
      if (f.height > y && f.height < best) best = f.height;
    }
    return best;
  };

  const checkStep = (
    py: number,
    tx: number,
    tz: number,
    dirX: number,
    dirZ: number,
  ): StepBlock | null => {
    // Step 0: the game's wall pushes move the target before anything else.
    // The push is one-sided in effect — engaged from the front it holds Mario
    // outside (a wall caps its seam however shallow the leak); engaged from
    // behind it shoves him forward through the plane. findWallCollisions
    // preserves both, including the multi-wall over-push quirk.
    wallData.x = tx;
    wallData.y = py;
    wallData.z = tz;
    wallData.offsetY = wallOffset;
    wallData.radius = wallRadius;
    wallData.walls.length = 0;
    wallData.numWalls = 0;
    partition.findWallCollisionsInto(wallData);
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
      if (Number.isNaN(floorH)) continue;

      let block: StepBlock | null = null;
      let bx = 0;
      let bz = 0;
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
      if (!block) continue;

      if (run !== null && i === prevI + 1 && run.kind === block.kind) {
        run.x1 = mx;
        run.z1 = mz;
        run.yBase = Math.min(run.yBase, floorH);
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
          yBase: floorH,
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
