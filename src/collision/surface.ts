// Parsing and classification of SM64 collision surfaces read from emulator RAM.
// A faithful reimplementation of how the game interprets `struct Surface`.

import {
  SURFACE_STRUCT_SIZE,
  SURFACE_OFFSETS,
  SURFACE_FLAG_X_PROJECTION,
  FLOOR_NORMAL_Y_THRESHOLD,
  CEIL_NORMAL_Y_THRESHOLD,
} from "./constants";

export type Vec3s = [number, number, number];
export interface Vec3f {
  x: number;
  y: number;
  z: number;
}

export enum SurfaceKind {
  Floor = "floor",
  Ceiling = "ceiling",
  Wall = "wall",
}

export interface Surface {
  /** Index within the surface pool. */
  index: number;
  /** RDRAM address of this struct (0 for synthetic surfaces). Used to match the
   * game's floor/ceil/wall pointers when validating against the live oracle. */
  address: number;
  type: number;
  force: number;
  flags: number;
  room: number;
  lowerY: number;
  upperY: number;
  vertices: [Vec3s, Vec3s, Vec3s];
  normal: Vec3f;
  originOffset: number;
  /** Owning object pointer (0 if this is static level geometry). */
  object: number;
  kind: SurfaceKind;
  /** For walls: whether the collision test uses the x-projection (|nx| > 0.707). */
  xProjection: boolean;
}

/** Classify a surface as floor/ceiling/wall from its normal's Y component,
 * matching `add_surface_to_cell` in surface_load.c. */
export function classifyKind(normalY: number): SurfaceKind {
  if (normalY > FLOOR_NORMAL_Y_THRESHOLD) return SurfaceKind.Floor;
  if (normalY < CEIL_NORMAL_Y_THRESHOLD) return SurfaceKind.Ceiling;
  return SurfaceKind.Wall;
}

// N64 RDRAM is big-endian. The bridge canonicalizes emulator memory to
// big-endian byte order, so the parser reads big-endian by default.
const DEFAULT_LITTLE_ENDIAN = false;

export interface ParseOptions {
  /** Byte order of the buffer. Defaults to big-endian (canonical N64). */
  littleEndian?: boolean;
  /** RDRAM address of the first surface, so each surface's `address` is exact. */
  baseAddress?: number;
}

function readVec3s(view: DataView, off: number, littleEndian: boolean): Vec3s {
  return [
    view.getInt16(off, littleEndian),
    view.getInt16(off + 2, littleEndian),
    view.getInt16(off + 4, littleEndian),
  ];
}

/** Parse a single `struct Surface` at `byteOffset` within `view`. */
export function parseSurface(
  view: DataView,
  byteOffset: number,
  index: number,
  opts: ParseOptions = {},
): Surface {
  const le = opts.littleEndian ?? DEFAULT_LITTLE_ENDIAN;
  const o = SURFACE_OFFSETS;

  const normal: Vec3f = {
    x: view.getFloat32(byteOffset + o.normalX, le),
    y: view.getFloat32(byteOffset + o.normalY, le),
    z: view.getFloat32(byteOffset + o.normalZ, le),
  };
  const flags = view.getUint8(byteOffset + o.flags);

  return {
    index,
    address: (opts.baseAddress ?? 0) + index * SURFACE_STRUCT_SIZE,
    type: view.getInt16(byteOffset + o.type, le),
    force: view.getInt16(byteOffset + o.force, le),
    flags,
    room: view.getInt8(byteOffset + o.room),
    lowerY: view.getInt16(byteOffset + o.lowerY, le),
    upperY: view.getInt16(byteOffset + o.upperY, le),
    vertices: [
      readVec3s(view, byteOffset + o.vertex1, le),
      readVec3s(view, byteOffset + o.vertex2, le),
      readVec3s(view, byteOffset + o.vertex3, le),
    ],
    normal,
    originOffset: view.getFloat32(byteOffset + o.originOffset, le),
    object: view.getUint32(byteOffset + o.object, le) >>> 0,
    kind: classifyKind(normal.y),
    xProjection: (flags & SURFACE_FLAG_X_PROJECTION) !== 0,
  };
}

/** Parse `count` contiguous surfaces from a raw surface-pool buffer. */
export function parseSurfacePool(
  buffer: ArrayBuffer,
  count: number,
  opts: ParseOptions = {},
): Surface[] {
  const view = new DataView(buffer);
  const needed = count * SURFACE_STRUCT_SIZE;
  if (buffer.byteLength < needed) {
    throw new Error(
      `surface pool buffer too small: have ${buffer.byteLength} bytes, ` +
        `need ${needed} for ${count} surfaces`,
    );
  }
  const surfaces: Surface[] = new Array(count);
  for (let i = 0; i < count; i++) {
    surfaces[i] = parseSurface(view, i * SURFACE_STRUCT_SIZE, i, opts);
  }
  return surfaces;
}

export interface LevelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * Derive the world extent from surface vertices. Used to size the spatial
 * partition when a hack's LEVEL_BOUNDARY_MAX is unknown, and to bound the probe
 * grid. Returns an empty (inverted) bounds when there are no surfaces.
 */
export function deriveLevelBounds(surfaces: Surface[]): LevelBounds {
  const b: LevelBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const s of surfaces) {
    for (const v of s.vertices) {
      if (v[0] < b.minX) b.minX = v[0];
      if (v[0] > b.maxX) b.maxX = v[0];
      if (v[1] < b.minY) b.minY = v[1];
      if (v[1] > b.maxY) b.maxY = v[1];
      if (v[2] < b.minZ) b.minZ = v[2];
      if (v[2] > b.maxZ) b.maxZ = v[2];
    }
  }
  return b;
}
