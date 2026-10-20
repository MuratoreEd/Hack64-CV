// Faithful reconstruction of SM64's spatial partition (src/engine/surface_load.c)
// plus the find_floor / find_ceil / find_wall_collisions wrappers
// (surface_collision.c). Building the partition ourselves — rather than reading
// the game's live linked lists — lets the collision core run offline and be unit
// tested, and it reproduces the game's exact per-cell scan order.
//
// The level boundary is HACK-DEPENDENT. Vanilla is [-8192, 8192] with 16x16
// cells; hacks routinely extend it. We derive the boundary from the loaded
// geometry (see deriveBoundary), defaulting to vanilla, and size the cells the
// same way the game does (CELL_SIZE = 2*boundary / NUM_CELLS).

import type { Surface } from "./surface";
import { SurfaceKind, deriveLevelBounds } from "./surface";
import {
  SURFACE_FLAG_DYNAMIC,
  VANILLA_LEVEL_BOUNDARY_MAX,
  VANILLA_NUM_CELLS,
  FLOOR_LOWER_LIMIT,
  CELL_HEIGHT_LIMIT,
  SURFACE_CAMERA_BOUNDARY,
  SURFACE_INTANGIBLE,
} from "./constants";
import type { FloorSelect, WallModel } from "./profile";
import {
  toS16,
  findFloorFromListInto,
  findCeilFromListInto,
  findWallCollisionsFromList,
  findWallCollisionsFromListFrame,
  floorContainsXZ,
  type SurfaceHit,
  type WallCollisionData,
} from "./queries";

/** One partition cell: the three surface lists the game keeps, already sorted. */
interface Cell {
  floors: Surface[];
  ceilings: Surface[];
  walls: Surface[];
}

/** Standard boundary values ROM hacks pick from (each doubles the vanilla box). */
const STANDARD_BOUNDARIES = [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000];

/**
 * Derive the effective LEVEL_BOUNDARY_MAX from geometry: the smallest standard
 * boundary that still contains every vertex. Defaults to vanilla (8192).
 * Geometry that pokes past the true boundary (registered into clamped edge
 * cells) can over-estimate this, but that is rare and only affects queries out
 * near the boundary, which the caller can override.
 */
export function deriveBoundary(surfaces: Surface[]): number {
  const b = deriveLevelBounds(surfaces);
  if (!Number.isFinite(b.minX)) return VANILLA_LEVEL_BOUNDARY_MAX;
  const maxAbs = Math.max(
    Math.abs(b.minX),
    Math.abs(b.maxX),
    Math.abs(b.minZ),
    Math.abs(b.maxZ),
  );
  for (const cand of STANDARD_BOUNDARIES) {
    if (maxAbs <= cand) return cand;
  }
  return STANDARD_BOUNDARIES[STANDARD_BOUNDARIES.length - 1];
}

export interface PartitionOptions {
  /** Effective LEVEL_BOUNDARY_MAX. Derived from geometry when omitted. */
  boundary?: number;
  /** Cells per axis (vanilla 16). */
  numCells?: number;
  /** Build a per-cell fine-grid pre-filter (FINE×FINE bins per cell, surfaces
   * scattered by XZ bbox, walls inflated by the max wall reach). Queries then
   * scan only the bin containing the point — a provable superset of every
   * surface that can affect the result, in the cell list's exact order — so
   * results are identical while candidate counts drop ~10×. Off by default;
   * the probe's bulk workloads (millions of queries) turn it on. */
  accel?: boolean;
  /** Floor/ceiling selection rule (CollisionProfile.select): "first" = vanilla
   * first-hit-wins, "extreme" = highest floor / lowest ceiling (ROMs whose
   * collision patch fixes surface cucking). Defaults to "first". */
  select?: FloorSelect;
  /** The largest wall-query radius the fine grid is built for. Defaults to
   * WALL_MAX_RADIUS (200), correct for any radius the game itself uses. A
   * caller that only ever queries with a small radius can pass that instead
   * and get far smaller wall bins: the probe uses radius 50/scale, so on a 4×
   * hack 200 over-inflates by 16× and stuffs every bin with walls it can never
   * touch. Queries with a radius LARGER than this automatically fall back to
   * the coarse cell list, so shrinking it can never change a result. */
  wallReach?: number;
  /** Which find_wall_collisions_from_list the ROM runs (CollisionProfile.walls).
   * Defaults to "vanilla". */
  walls?: WallModel;
  /** Frame's patch only: its edge margin (`radius - 1.0f`) in collision units —
   * 1 on a regular ROM, 1/worldScale on an extended-boundary one. */
  edgeMargin?: number;
}

/** Fine bins per axis inside one partition cell. */
const FINE = 8;
/** find_wall_collisions clamps radius to WALL_MAX_RADIUS (200). */
const WALL_REACH = 200;

/** Per-cell fine bins: FINE×FINE sparse lists per surface kind, each list
 * preserving the parent cell list's order. */
interface FineCell {
  floors: (Surface[] | null)[];
  ceilings: (Surface[] | null)[];
  walls: (Surface[] | null)[];
}

const EMPTY_LIST: Surface[] = [];

const NO_INFLATION = [0, 0] as const;
const noInflation = (): readonly [number, number] => NO_INFLATION;

/**
 * The order add_surface_to_cell leaves a list in. It inserts each surface
 * before the first entry of strictly lower priority (`vertex1[1] * sortDir`,
 * held in an s16), i.e. after every entry whose priority is >= its own — which
 * is exactly a STABLE sort by descending priority over pool order. Sorting once
 * is O(n log n) instead of the game's O(n²) insertion (a dense 12k-surface pool
 * rebuilds the oracle's partition on every stream update). Walls (sortDir 0)
 * need no sort.
 */
function sortByPriority(list: Surface[], sortDir: 1 | -1): void {
  if (list.length < 2) return;
  const prio = new Map<Surface, number>();
  for (const s of list) prio.set(s, toS16(s.vertices[0][1] * sortDir));
  list.sort((a, b) => prio.get(b)! - prio.get(a)!);
}

export class SpatialPartition {
  readonly boundary: number;
  readonly numCells: number;
  readonly cellSize: number;
  readonly select: FloorSelect;
  readonly walls: WallModel;
  /** Largest wall-query radius the fine grid serves (see wallReach). */
  readonly wallReach: number;
  /** Frame's edge margin in collision units (see PartitionOptions.edgeMargin). */
  readonly edgeMargin: number;
  private readonly cellsIndex: number; // NUM_CELLS_INDEX = numCells - 1
  private readonly staticCells: Cell[]; // flat [z * numCells + x]
  private readonly dynamicCells: Cell[];
  private readonly fineStatic: FineCell[] | null;
  private readonly fineDynamic: FineCell[] | null;

  constructor(surfaces: Surface[], opts: PartitionOptions = {}) {
    this.boundary = opts.boundary ?? deriveBoundary(surfaces);
    this.numCells = opts.numCells ?? VANILLA_NUM_CELLS;
    this.select = opts.select ?? "first";
    this.walls = opts.walls ?? "vanilla";
    this.edgeMargin = opts.edgeMargin ?? 1;
    this.wallReach = Math.min(opts.wallReach ?? WALL_REACH, WALL_REACH);
    // CELL_SIZE = LEVEL_BOUNDARY_MAX / (NUM_CELLS / 2) = 2*boundary / numCells.
    this.cellSize = (2 * this.boundary) / this.numCells;
    this.cellsIndex = this.numCells - 1;

    const n = this.numCells * this.numCells;
    this.staticCells = new Array(n);
    this.dynamicCells = new Array(n);
    for (let i = 0; i < n; i++) {
      this.staticCells[i] = { floors: [], ceilings: [], walls: [] };
      this.dynamicCells[i] = { floors: [], ceilings: [], walls: [] };
    }

    for (const surf of surfaces) this.addSurface(surf);
    for (const cells of [this.staticCells, this.dynamicCells]) {
      for (const cell of cells) {
        sortByPriority(cell.floors, 1);
        sortByPriority(cell.ceilings, -1);
        // Walls are sortDir 0: every priority ties, so pool order as appended.
      }
    }

    if (opts.accel) {
      this.fineStatic = this.buildFine(this.staticCells);
      this.fineDynamic = this.buildFine(this.dynamicCells);
    } else {
      this.fineStatic = null;
      this.fineDynamic = null;
    }
  }

  // --- Build (surface_load.c: add_surface / add_surface_to_cell) ---

  private addSurface(surf: Surface): void {
    const dynamic = (surf.flags & SURFACE_FLAG_DYNAMIC) !== 0;
    const cells = dynamic ? this.dynamicCells : this.staticCells;

    const v = surf.vertices;
    const minX = Math.min(v[0][0], v[1][0], v[2][0]);
    const maxX = Math.max(v[0][0], v[1][0], v[2][0]);
    const minZ = Math.min(v[0][2], v[1][2], v[2][2]);
    const maxZ = Math.max(v[0][2], v[1][2], v[2][2]);

    const minCellX = this.lowerCellIndex(minX);
    const maxCellX = this.upperCellIndex(maxX);
    const minCellZ = this.lowerCellIndex(minZ);
    const maxCellZ = this.upperCellIndex(maxZ);

    for (let cz = minCellZ; cz <= maxCellZ; cz++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        // add_surface_to_cell picks the list by normal.y; the order within
        // each list is settled once every surface is in (sortByPriority).
        const cell = cells[cz * this.numCells + cx];
        if (surf.kind === SurfaceKind.Floor) cell.floors.push(surf);
        else if (surf.kind === SurfaceKind.Ceiling) cell.ceilings.push(surf);
        else cell.walls.push(surf);
      }
    }
  }

  // --- Fine-grid pre-filter (accel option) ---

  private buildFine(cells: Cell[]): FineCell[] {
    const out: FineCell[] = new Array(cells.length);
    for (let cz = 0; cz < this.numCells; cz++) {
      for (let cx = 0; cx < this.numCells; cx++) {
        const idx = cz * this.numCells + cx;
        const cell = cells[idx];
        const fine: FineCell = {
          floors: new Array(FINE * FINE).fill(null),
          ceilings: new Array(FINE * FINE).fill(null),
          walls: new Array(FINE * FINE).fill(null),
        };
        this.scatter(cell.floors, fine.floors, cx, cz, noInflation);
        this.scatter(cell.ceilings, fine.ceilings, cx, cz, noInflation);
        this.scatter(cell.walls, fine.walls, cx, cz, (w) => this.wallInflation(w));
        out[idx] = fine;
      }
    }
    return out;
  }

  /**
   * How far outside its XZ bbox a wall can engage a query of radius up to
   * wallReach, per axis. The fine grid's superset guarantee rests on this.
   *
   * Vanilla: the in-plane test projects along one axis, so the point must lie
   * within the wall's extent on the OTHER axis but can sit radius/|n_axis|
   * off it along the projection axis — up to √2·radius for a 45° wall, not
   * radius. (Inflating by radius alone missed diagonal walls near bin borders:
   * a 45° wall pushed a point in the plain partition and not in the accel one.)
   * +1 on both axes because the bin is picked from the s16-truncated position
   * while the test runs on the float one.
   *
   * Frame: face pushes reach radius·|n_xz| and edge pushes the edge margin,
   * both <= radius + a hair. But its pushes accumulate, so the point MOVES
   * mid-scan: the inflation also covers one push's worth of travel, and
   * findWallCollisionsInto rescans the coarse list if a scan pushed twice.
   */
  private wallInflation(w: Surface): readonly [number, number] {
    const r = this.wallReach;
    if (this.walls === "frame") {
      const i = 2 * r + 2;
      return [i, i];
    }
    const cap = this.cellSize; // a whole cell covers every bin: always safe
    const n = w.normal;
    if (w.xProjection) {
      const ax = Math.abs(n.x);
      return [ax > 0 ? Math.min(cap, r / ax + 1) : cap, 1];
    }
    const az = Math.abs(n.z);
    return [1, az > 0 ? Math.min(cap, r / az + 1) : cap];
  }

  /** Scatter one cell list into its fine bins by (inflated) XZ bbox, keeping
   * list order within each bin. Bins clamp to the cell, so surfaces registered
   * into a clamped edge cell (geometry past the boundary) stay reachable. */
  private scatter(
    list: Surface[],
    bins: (Surface[] | null)[],
    cx: number,
    cz: number,
    inflation: (s: Surface) => readonly [number, number],
  ): void {
    const loX = cx * this.cellSize - this.boundary;
    const loZ = cz * this.cellSize - this.boundary;
    const fineSize = this.cellSize / FINE;
    const bin = (v: number, lo: number): number =>
      Math.min(FINE - 1, Math.max(0, Math.trunc((v - lo) / fineSize)));
    for (const surf of list) {
      const [ix, iz] = inflation(surf);
      const v = surf.vertices;
      const minX = Math.min(v[0][0], v[1][0], v[2][0]) - ix;
      const maxX = Math.max(v[0][0], v[1][0], v[2][0]) + ix;
      const minZ = Math.min(v[0][2], v[1][2], v[2][2]) - iz;
      const maxZ = Math.max(v[0][2], v[1][2], v[2][2]) + iz;
      const bx0 = bin(minX, loX);
      const bx1 = bin(maxX, loX);
      const bz0 = bin(minZ, loZ);
      const bz1 = bin(maxZ, loZ);
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          (bins[bz * FINE + bx] ??= []).push(surf);
        }
      }
    }
  }

  /** The candidate list for a query at (x, z): the fine bin when accel is on,
   * else the whole cell list. In-bounds queries never wrap, so the local
   * offset within the cell is well-defined. */
  private candidates(
    fine: FineCell[] | null,
    cells: Cell[],
    idx: number,
    cxi: number,
    czi: number,
    kind: keyof Cell,
    x: number,
    z: number,
  ): Surface[] {
    if (!fine) return cells[idx][kind];
    const fineSize = this.cellSize / FINE;
    const clampBin = (v: number): number =>
      Math.min(FINE - 1, Math.max(0, Math.trunc(v / fineSize)));
    const bx = clampBin(x - (cxi * this.cellSize - this.boundary));
    const bz = clampBin(z - (czi * this.cellSize - this.boundary));
    return fine[idx][kind][bz * FINE + bx] ?? EMPTY_LIST;
  }

  // --- Cell indexing (surface_load.c) ---

  /** lower_cell_index: offset by boundary (s16-wrapped, as in-game), clamp >=0,
   * divide by CELL_SIZE, pull back one cell when within 50 units of the edge. */
  private lowerCellIndex(coord: number): number {
    let c = toS16(coord + this.boundary);
    if (c < 0) c = 0;
    let index = Math.trunc(c / this.cellSize);
    if (c % this.cellSize < 50) index -= 1;
    if (index < 0) index = 0;
    return index;
  }

  /** upper_cell_index: same, but push forward one cell near the far edge and
   * clamp to NUM_CELLS_INDEX. */
  private upperCellIndex(coord: number): number {
    let c = toS16(coord + this.boundary);
    if (c < 0) c = 0;
    let index = Math.trunc(c / this.cellSize);
    if (c % this.cellSize > this.cellSize - 50) index += 1;
    if (index > this.cellsIndex) index = this.cellsIndex;
    return index;
  }

  /** The query-time cell index: `((coord + boundary) / CELL_SIZE) & NUM_CELLS_INDEX`.
   * Note this is int (not s16-wrapped) and always in range once the boundary
   * early-return has passed. */
  private queryCell(coord: number): number {
    return Math.trunc((coord + this.boundary) / this.cellSize) & this.cellsIndex;
  }

  private inBounds(x: number, z: number): boolean {
    if (x <= -this.boundary || x >= this.boundary) return false;
    if (z <= -this.boundary || z >= this.boundary) return false;
    return true;
  }

  // --- Queries (surface_collision.c: find_floor / find_ceil / find_wall_collisions) ---

  /** Scratch hit for the dynamic half of the Into queries (single-threaded). */
  private readonly dynScratch: SurfaceHit = { surface: null, height: 0 };

  /** find_floor: truncates position to s16, checks the boundary, falls through
   * an intangible static floor, then merges the static and dynamic cell
   * results (dynamic wins only if strictly higher). */
  findFloor(xPos: number, yPos: number, zPos: number): SurfaceHit {
    const out: SurfaceHit = { surface: null, height: 0 };
    this.findFloorInto(xPos, yPos, zPos, out);
    return out;
  }

  /** findFloor under an explicit selection rule, ignoring this partition's
   * configured one — lets the oracle ask both questions of one partition to
   * learn which engine the running ROM is (see detectFloorSelect). */
  findFloorWith(
    xPos: number,
    yPos: number,
    zPos: number,
    select: FloorSelect,
  ): SurfaceHit {
    const out: SurfaceHit = { surface: null, height: 0 };
    this.findFloorInto(xPos, yPos, zPos, out, select);
    return out;
  }

  /** Allocation-free findFloor: writes the result into `out`. */
  findFloorInto(
    xPos: number,
    yPos: number,
    zPos: number,
    out: SurfaceHit,
    select: FloorSelect = this.select,
  ): void {
    const x = toS16(xPos);
    const y = toS16(yPos);
    const z = toS16(zPos);
    if (!this.inBounds(x, z)) {
      out.surface = null;
      out.height = FLOOR_LOWER_LIMIT;
      return;
    }

    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    const dyn = this.dynScratch;
    findFloorFromListInto(
      this.candidates(this.fineDynamic, this.dynamicCells, idx, cxi, czi, "floors", x, z),
      x, y, z, dyn, select,
    );
    const staticList = this.candidates(
      this.fineStatic, this.staticCells, idx, cxi, czi, "floors", x, z,
    );
    findFloorFromListInto(staticList, x, y, z, out, select);
    // Mario falls through SURFACE_INTANGIBLE (gFindFloorIncludeSurfaceIntangible
    // is only ever set for room lookups): the static list is searched again
    // from `(s32)(height - 200.0f)`. When nothing is found there the game keeps
    // the intangible floor's HEIGHT with a NULL floor (the "BBH crash" quirk),
    // and that height is what the dynamic floor then has to beat.
    if (out.surface !== null && out.surface.type === SURFACE_INTANGIBLE) {
      const h = out.height;
      findFloorFromListInto(staticList, x, Math.trunc(h - 200), z, out, select);
      if (out.surface === null) out.height = h;
    }
    if (dyn.height > out.height) {
      out.surface = dyn.surface;
      out.height = dyn.height;
    }
  }

  /**
   * All STATIC floors whose XZ footprint contains (x, z), in the cell's scan
   * order, each with its plane height at (x, z). Unlike findFloor (which
   * returns the first hit below y+78), this sees the column's whole floor
   * stack — the probe uses it to find the floor that truncates a blocked
   * vertical region from above. Static-only, matching the probe world.
   */
  floorsAt(xPos: number, zPos: number): { surface: Surface; height: number }[] {
    const x = toS16(xPos);
    const z = toS16(zPos);
    if (!this.inBounds(x, z)) return [];
    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    const out: { surface: Surface; height: number }[] = [];
    for (const surf of this.candidates(
      this.fineStatic, this.staticCells, idx, cxi, czi, "floors", x, z,
    )) {
      if (surf.type === SURFACE_CAMERA_BOUNDARY) continue;
      if (surf.normal.y === 0) continue;
      if (!floorContainsXZ(surf, x, z)) continue;
      const height =
        -(x * surf.normal.x + surf.normal.z * z + surf.originOffset) /
        surf.normal.y;
      out.push({ surface: surf, height });
    }
    return out;
  }

  /**
   * Every STATIC wall in the cell covering (x, z), unfiltered. Unlike
   * findWallCollisions (which engages only walls within a push radius of a
   * point, capped at 4), this exposes the wall shell around a column at ANY
   * height — the probe uses it to tell a column inside solid geometry from one
   * in open air, where the bounding wall can sit far above Mario.
   *
   * Returns the partition's OWN list — do not mutate. Callers must skip
   * SURFACE_CAMERA_BOUNDARY themselves; handing back the live array keeps this
   * allocation-free for the probe's bulk use (bins hold ~100 walls, since the
   * fine grid inflates wall footprints by the max push reach).
   */
  wallsAt(xPos: number, zPos: number): readonly Surface[] {
    const x = toS16(xPos);
    const z = toS16(zPos);
    if (!this.inBounds(x, z)) return EMPTY_LIST;
    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    return this.candidates(
      this.fineStatic, this.staticCells, idx, cxi, czi, "walls", x, z,
    );
  }

  /** find_ceil: like findFloor, but dynamic wins only if strictly lower. */
  findCeil(xPos: number, yPos: number, zPos: number): SurfaceHit {
    const out: SurfaceHit = { surface: null, height: 0 };
    this.findCeilInto(xPos, yPos, zPos, out);
    return out;
  }

  /** Allocation-free findCeil: writes the result into `out`. */
  findCeilInto(xPos: number, yPos: number, zPos: number, out: SurfaceHit): void {
    const x = toS16(xPos);
    const y = toS16(yPos);
    const z = toS16(zPos);
    if (!this.inBounds(x, z)) {
      out.surface = null;
      out.height = CELL_HEIGHT_LIMIT;
      return;
    }

    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    const dyn = this.dynScratch;
    findCeilFromListInto(
      this.candidates(this.fineDynamic, this.dynamicCells, idx, cxi, czi, "ceilings", x, z),
      x, y, z, dyn, this.select,
    );
    findCeilFromListInto(
      this.candidates(this.fineStatic, this.staticCells, idx, cxi, czi, "ceilings", x, z),
      x, y, z, out, this.select,
    );
    if (dyn.height < out.height) {
      out.surface = dyn.surface;
      out.height = dyn.height;
    }
  }

  /** find_wall_collisions: position is truncated only for the cell lookup; the
   * in-plane test uses the float position. Scans dynamic then static walls. */
  findWallCollisions(
    xPos: number,
    yPos: number,
    zPos: number,
    offsetY: number,
    radius: number,
  ): WallCollisionData {
    const data: WallCollisionData = {
      x: xPos,
      y: yPos,
      z: zPos,
      offsetY,
      radius,
      walls: [],
      numWalls: 0,
    };
    this.findWallCollisionsInto(data);
    return data;
  }

  /** Allocation-free find_wall_collisions: `data` carries the query in and the
   * pushed position out. Callers reset walls/numWalls or reuse a scratch.
   * Dispatches to the ROM's wall routine (PartitionOptions.walls). */
  findWallCollisionsInto(data: WallCollisionData): void {
    const x = toS16(data.x);
    const z = toS16(data.z);
    if (!this.inBounds(x, z)) return;

    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    // The fine grid only guarantees a superset for radii it was inflated for;
    // anything wider must use the full cell list (see PartitionOptions.wallReach).
    const wide = Math.abs(data.radius) > this.wallReach;
    // The game picks the cell ONCE, from the original position, for both lists,
    // but the static scan starts wherever the dynamic pushes left the point —
    // possibly outside the original fine bin, so it then takes the full list.
    const dynPushes = this.scanWalls(
      wide ? null : this.fineDynamic, this.dynamicCells, idx, cxi, czi, x, z, data,
    );
    this.scanWalls(
      wide || dynPushes > 0 ? null : this.fineStatic,
      this.staticCells, idx, cxi, czi, x, z, data,
    );
  }

  /** One find_wall_collisions_from_list pass over a cell's wall list (or its
   * fine bin), returning the pushes applied. Frame's routine moves the point
   * as it goes; a fine bin only covers one push of travel, so a bin scan that
   * pushed more is discarded and redone on the full list — identical results,
   * and the (rare) corner cases pay for the full scan. */
  private scanWalls(
    fine: FineCell[] | null,
    cells: Cell[],
    idx: number,
    cxi: number,
    czi: number,
    x: number,
    z: number,
    data: WallCollisionData,
  ): number {
    const list = this.candidates(fine, cells, idx, cxi, czi, "walls", x, z);
    if (this.walls !== "frame") return findWallCollisionsFromList(list, data);
    if (fine === null) {
      return findWallCollisionsFromListFrame(list, data, this.edgeMargin);
    }
    const sx = data.x;
    const sz = data.z;
    const sn = data.numWalls;
    const pushes = findWallCollisionsFromListFrame(list, data, this.edgeMargin);
    if (pushes < 2) return pushes;
    data.x = sx;
    data.z = sz;
    data.numWalls = sn;
    data.walls.length = sn;
    return findWallCollisionsFromListFrame(cells[idx].walls, data, this.edgeMargin);
  }
}
