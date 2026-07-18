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

export type ServerMessage = SurfacesMessage | StateMessage | RdramMessage;

export interface RefreshMessage {
  type: "refresh";
}

/** Ask the bridge for a full RDRAM snapshot (RdramMessage). */
export interface RdramRequestMessage {
  type: "rdram";
}

export type ClientMessage = RefreshMessage | RdramRequestMessage;
