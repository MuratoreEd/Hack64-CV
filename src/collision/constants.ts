// Ground-truth constants ported from the SM64 decompilation (n64decomp/sm64).
// Sources: include/types.h (struct Surface), src/engine/surface_load.c
// (classification + partition), include/surface_terrains.h (flag bits),
// src/engine/surface_load.h (partition macros).

/** sizeof(struct Surface) — 48 bytes. */
export const SURFACE_STRUCT_SIZE = 0x30;

/**
 * Byte offsets of each field within a `struct Surface`, as laid out in RDRAM.
 * TerrainData / Collision / Vec3Terrain are s16; normal + originOffset are f32;
 * object is a 32-bit pointer.
 */
export const SURFACE_OFFSETS = {
  type: 0x00, // s16
  force: 0x02, // s16
  flags: 0x04, // u8 (s8 in decomp, used as bitfield)
  room: 0x05, // s8
  lowerY: 0x06, // s16
  upperY: 0x08, // s16
  vertex1: 0x0a, // s16[3]
  vertex2: 0x10, // s16[3]
  vertex3: 0x16, // s16[3]
  normalX: 0x1c, // f32
  normalY: 0x20, // f32
  normalZ: 0x24, // f32
  originOffset: 0x28, // f32
  object: 0x2c, // pointer (u32)
} as const;

// Surface flag bits (surface_terrains.h).
export const SURFACE_FLAG_DYNAMIC = 1 << 0;
export const SURFACE_FLAG_NO_CAM_COLLISION = 1 << 1;
export const SURFACE_FLAG_X_PROJECTION = 1 << 3;

// Surface classification by normal.y (surface_load.c `add_surface_to_cell`):
//   normal.y >  0.01  -> floor
//   normal.y < -0.01  -> ceiling
//   otherwise         -> wall
export const FLOOR_NORMAL_Y_THRESHOLD = 0.01;
export const CEIL_NORMAL_Y_THRESHOLD = -0.01;

// For walls, the collision test projects onto the ZY plane (x-projection) when
// |normal.x| > 0.707, otherwise onto the XY plane.
export const WALL_X_PROJECTION_THRESHOLD = 0.707;

// Spatial partition geometry. VANILLA values only — ROM hacks routinely change
// LEVEL_BOUNDARY_MAX (and occasionally CELL_SIZE), so the live/derived values
// take precedence. NUM_CELLS = 2 * LEVEL_BOUNDARY_MAX / CELL_SIZE (= 16 vanilla).
export const VANILLA_LEVEL_BOUNDARY_MAX = 0x2000; // 8192
export const VANILLA_CELL_SIZE = 0x400; // 1024
// Number of cells per axis (surface_load.h). The cell lookup masks the index by
// NUM_CELLS_INDEX = NUM_CELLS - 1; upper_cell_index clamps to it.
export const VANILLA_NUM_CELLS = 16;

// Query-routine constants (surface_collision.c / surface_collision.h).
/** find_floor's default height when no floor is found (also FLOOR_LOWER_LIMIT). */
export const FLOOR_LOWER_LIMIT = -11000;
/** find_ceil's default height when no ceiling is found. */
export const CELL_HEIGHT_LIMIT = 20000;
/** Vertical tolerance for floor/ceil: `y - (height +/- -78)` — the ±78 buffer. */
export const SURFACE_Y_BUFFER = 78;
/** find_wall_collisions clamps the push radius to at most this. */
export const WALL_MAX_RADIUS = 200;
/** Surface type ignored by non-camera collision queries (skipped in find_*). */
export const SURFACE_CAMERA_BOUNDARY = 0x0072;
