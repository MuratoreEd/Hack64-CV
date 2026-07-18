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
} from "./constants";
import {
  toS16,
  findFloorFromListInto,
  findCeilFromListInto,
  findWallCollisionsFromList,
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
}

/** Fine bins per axis inside one partition cell. */
const FINE = 8;
/** find_wall_collisions clamps radius to WALL_MAX_RADIUS (200), so a wall can
 * influence points at most this far outside its XZ bbox. */
const WALL_REACH = 200;

/** Per-cell fine bins: FINE×FINE sparse lists per surface kind, each list
 * preserving the parent cell list's order. */
interface FineCell {
  floors: (Surface[] | null)[];
  ceilings: (Surface[] | null)[];
  walls: (Surface[] | null)[];
}

const EMPTY_LIST: Surface[] = [];

export class SpatialPartition {
  readonly boundary: number;
  readonly numCells: number;
  readonly cellSize: number;
  private readonly cellsIndex: number; // NUM_CELLS_INDEX = numCells - 1
  private readonly staticCells: Cell[]; // flat [z * numCells + x]
  private readonly dynamicCells: Cell[];
  private readonly fineStatic: FineCell[] | null;
  private readonly fineDynamic: FineCell[] | null;

  constructor(surfaces: Surface[], opts: PartitionOptions = {}) {
    this.boundary = opts.boundary ?? deriveBoundary(surfaces);
    this.numCells = opts.numCells ?? VANILLA_NUM_CELLS;
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

    const xs = [surf.vertices[0][0], surf.vertices[1][0], surf.vertices[2][0]];
    const zs = [surf.vertices[0][2], surf.vertices[1][2], surf.vertices[2][2]];
    const minX = Math.min(xs[0], xs[1], xs[2]);
    const maxX = Math.max(xs[0], xs[1], xs[2]);
    const minZ = Math.min(zs[0], zs[1], zs[2]);
    const maxZ = Math.max(zs[0], zs[1], zs[2]);

    const minCellX = this.lowerCellIndex(minX);
    const maxCellX = this.upperCellIndex(maxX);
    const minCellZ = this.lowerCellIndex(minZ);
    const maxCellZ = this.upperCellIndex(maxZ);

    for (let cz = minCellZ; cz <= maxCellZ; cz++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        this.addSurfaceToCell(cells[cz * this.numCells + cx], surf);
      }
    }
  }

  /** add_surface_to_cell: choose the list by normal.y, insert keeping the
   * game's sort ("surface cucking"): floors high->low by vertex1.y, ceilings
   * low->high, walls in insertion (pool) order. */
  private addSurfaceToCell(cell: Cell, surf: Surface): void {
    let list: Surface[];
    let sortDir: number;
    if (surf.kind === SurfaceKind.Floor) {
      list = cell.floors;
      sortDir = 1;
    } else if (surf.kind === SurfaceKind.Ceiling) {
      list = cell.ceilings;
      sortDir = -1;
    } else {
      list = cell.walls;
      sortDir = 0;
    }

    const surfacePriority = surf.vertices[0][1] * sortDir;
    // Insert before the first element with strictly lower priority (`>` break),
    // so equal-priority surfaces keep insertion order; sortDir 0 always appends.
    let i = 0;
    while (i < list.length) {
      const priority = list[i].vertices[0][1] * sortDir;
      if (surfacePriority > priority) break;
      i++;
    }
    list.splice(i, 0, surf);
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
        this.scatter(cell.floors, fine.floors, cx, cz, 0);
        this.scatter(cell.ceilings, fine.ceilings, cx, cz, 0);
        // Walls influence points up to WALL_REACH outside their bbox.
        this.scatter(cell.walls, fine.walls, cx, cz, WALL_REACH);
        out[idx] = fine;
      }
    }
    return out;
  }

  /** Scatter one cell list into its fine bins by (inflated) XZ bbox, keeping
   * list order within each bin. Bins clamp to the cell, so surfaces registered
   * into a clamped edge cell (geometry past the boundary) stay reachable. */
  private scatter(
    list: Surface[],
    bins: (Surface[] | null)[],
    cx: number,
    cz: number,
    inflate: number,
  ): void {
    const loX = cx * this.cellSize - this.boundary;
    const loZ = cz * this.cellSize - this.boundary;
    const fineSize = this.cellSize / FINE;
    const bin = (v: number, lo: number): number =>
      Math.min(FINE - 1, Math.max(0, Math.trunc((v - lo) / fineSize)));
    for (const surf of list) {
      const v = surf.vertices;
      const minX = Math.min(v[0][0], v[1][0], v[2][0]) - inflate;
      const maxX = Math.max(v[0][0], v[1][0], v[2][0]) + inflate;
      const minZ = Math.min(v[0][2], v[1][2], v[2][2]) - inflate;
      const maxZ = Math.max(v[0][2], v[1][2], v[2][2]) + inflate;
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

  /** find_floor: truncates position to s16, checks the boundary, then merges the
   * static and dynamic cell results (dynamic wins only if strictly higher). */
  findFloor(xPos: number, yPos: number, zPos: number): SurfaceHit {
    const out: SurfaceHit = { surface: null, height: 0 };
    this.findFloorInto(xPos, yPos, zPos, out);
    return out;
  }

  /** Allocation-free findFloor: writes the result into `out`. */
  findFloorInto(xPos: number, yPos: number, zPos: number, out: SurfaceHit): void {
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
      x, y, z, dyn,
    );
    findFloorFromListInto(
      this.candidates(this.fineStatic, this.staticCells, idx, cxi, czi, "floors", x, z),
      x, y, z, out,
    );
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
      x, y, z, dyn,
    );
    findCeilFromListInto(
      this.candidates(this.fineStatic, this.staticCells, idx, cxi, czi, "ceilings", x, z),
      x, y, z, out,
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
   * pushed position out. Callers reset walls/numWalls or reuse a scratch. */
  findWallCollisionsInto(data: WallCollisionData): void {
    const x = toS16(data.x);
    const z = toS16(data.z);
    if (!this.inBounds(x, z)) return;

    const cxi = this.queryCell(x);
    const czi = this.queryCell(z);
    const idx = czi * this.numCells + cxi;
    findWallCollisionsFromList(
      this.candidates(this.fineDynamic, this.dynamicCells, idx, cxi, czi, "walls", x, z),
      data,
    );
    findWallCollisionsFromList(
      this.candidates(this.fineStatic, this.staticCells, idx, cxi, czi, "walls", x, z),
      data,
    );
  }
}
