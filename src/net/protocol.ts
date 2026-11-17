// Wire protocol shared by the bridge (Node) and the viewer (browser).
// Kept dependency-free so the bridge can `import type` it (erased at runtime).

export const BRIDGE_DEFAULT_PORT = 8081;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Full collision snapshot: the raw surface pool bytes (canonical big-endian),
 * base64-encoded. Sent on connect and whenever the level/area/count changes. */
export interface SurfacesMessage {
  type: "surfaces";
  /** Number of surfaces (gSurfacesAllocated). */
  count: number;
  /** KSEG0 address of the surface pool base (so surface addresses match the
   * game's floor/ceil/wall pointers). */
  poolBase: number;
  /** base64 of count * 0x30 canonical big-endian surface bytes. */
  base64: string;
}

/** Per-frame game state, including the oracle pointers for validating our
 * reimplemented collision queries against the game's own results. */
export interface StateMessage {
  type: "state";
  level: number;
  area: number;
  pos: Vec3;
  /** KSEG0 addresses of the surfaces the game currently has Mario on/against
   * (0 if none). Compared against our findFloor/findCeil/findWall in P2. */
  floorAddr: number;
  ceilAddr: number;
  wallAddr: number;
  floorHeight: number;
  ceilHeight: number;
  surfaceCount: number;
}

/** Full RDRAM snapshot (canonical big-endian), used to parse the level's
 * VISUAL geometry (graph nodes + Fast3D display lists + textures) for the
 * textured view. Large (~8 MB → ~11 MB base64), so only sent on request. */
export interface RdramMessage {
  type: "rdram";
  /** Snapshot length in bytes (4 or 8 MB). */
  size: number;
  base64: string;
}

/** Whether the bridge currently has Project64. Sent on connect and whenever it
 * changes: the packaged exe serves the viewer before the emulator is running
 * (and after it closes), and otherwise a viewer that connected then would see
 * "connected" and no data, with nothing to say why. */
export interface BridgeMessage {
  type: "bridge";
  attached: boolean;
  /** When not attached: what the bridge is waiting for, in plain words. */
  detail: string;
}

/** One live object slot: `[slot, behavior, x, y, z, behParams, model,
 * interact, gfxFlags]`. `behavior` is the KSEG0 address of the object's
 * behaviour script (Object.behavior), the position is in world units,
 * `behParams` is the raw u32 (oBehParams). `model` is the graph node attached
 * to it (header.gfx.sharedChild, KSEG0; 0 = none), `gfxFlags` whether that is
 * drawn at all (header.gfx.node.flags, GRAPH_RENDER_*), `interact` its
 * oInteractType — what it looks like and what touching it does, to tell a
 * fake star from a real one. The last three are missing from older bridges. */
export type ObjectRecord = [
  number, number, number, number, number, number, number?, number?, number?,
];

/** The active objects in gObjectPool. The bridge stays ignorant of what any of
 * them are: the viewer picks out stars and red coins by behaviour script
 * (src/objects/collectibles.ts). Sent on connect and whenever it changes. */
export interface ObjectsMessage {
  type: "objects";
  /** gCurrCourseNum — which course's star names apply. */
  course: number;
  /** gCurrActNum (1-6; 0 outside the main courses) — which of the level's
   * act-specific objects the game loaded. */
  act: number;
  /** sSegmentTable[0x13]: physical offset of the behaviour-script segment, to
   * turn `behavior` back into the segmented address a behaviour is known by. */
  behaviorBase: number;
  /** gLoadedGraphNodes[MODEL_STAR]: the graph node a star is drawn with, to
   * recognise an object that only looks like one. 0 when unknown. */
  starModel?: number;
  objects: ObjectRecord[];
}

/** Bytes of the cartridge ROM, read out of the emulator's memory (answer to
 * a RomRequestMessage). The level's object placements can live only there. */
export interface RomMessage {
  type: "rom";
  offset: number;
  length: number;
  /** base64 of `length` bytes; empty when the bridge can't provide them (no
   * ROM image found in the emulator, or the range is outside it). */
  base64: string;
}

export type ServerMessage =
  | SurfacesMessage
  | StateMessage
  | RdramMessage
  | BridgeMessage
  | ObjectsMessage
  | RomMessage;

export interface RefreshMessage {
  type: "refresh";
}

/** Ask the bridge for a full RDRAM snapshot (RdramMessage). */
export interface RdramRequestMessage {
  type: "rdram";
}

/** Ask the bridge for a range of the ROM (RomMessage). */
export interface RomRequestMessage {
  type: "rom";
  offset: number;
  length: number;
}

export type ClientMessage =
  | RefreshMessage
  | RdramRequestMessage
  | RomRequestMessage;
