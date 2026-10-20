// Identify the running ROM's collision engine from an RDRAM snapshot, without
// depending on where Mario happens to be standing.
//
// The opportunistic signal (oracle.detectFloorSelect) only speaks when the
// vanilla and patched floor-selection rules disagree over Mario's own column,
// which needs two overlapping floors — so on a fresh boot, standing on ordinary
// ground, it never returns a verdict and the profile silently stayed vanilla.
//
// This detector instead reads the game's OWN spatial partition. SM64 decides
// floor/ceiling/wall at load time in add_surface_to_cell by comparing normal.y
// against ±0.01 (vanilla) or ±0.05 (Frame's collision patch), so a surface
// whose |normal.y| lies in the disputed [0.01, 0.05) band is in a FLOOR/CEILING
// list on a vanilla ROM and in a WALL list on a patched one. Which list a node
// belongs to is recoverable without knowing where the partition array lives:
// walk the node's chain and look at its neighbours. Floor lists hold only
// upward normals, ceiling lists only downward ones, so a chain containing a
// surface with normal.y > 0.05 is a floor list and one containing < -0.05 is a
// ceiling list; a chain of nothing but shallow surfaces is a wall list.
//
//   struct SurfaceNode { struct SurfaceNode *next; struct Surface *surface; };
//     next @ +0, surface @ +4  (getting this backwards yields plausible-looking
//     garbage — gMarioStates+0x68 is a Surface* whose neighbour is also one)
//
// The snapshot must be judged against the pool IT contains, not whatever pool
// the viewer last received: at a level change the new snapshot can land while
// the old level's pool is still current, and its addresses then point at
// different surfaces in the new level — a stale pool reliably reads "vanilla"
// (old floors show up as decisive neighbours). readPoolFromRdram takes the pool
// straight out of the snapshot for exactly that reason.

import type { Surface } from "./surface";
import { SURFACE_FLAG_DYNAMIC, SURFACE_STRUCT_SIZE } from "./constants";

const KSEG0 = (a: number): boolean => a >= 0x80000000 && a < 0x80800000;

/** US gSurfacesAllocated (s32) and sSurfacePool (Surface*) — the same anchors
 * the bridge streams the pool from (bridge/src/rdram.ts). */
const US_SURFACES_ALLOCATED = 0x80361170;
const US_SURFACE_POOL = 0x8038ee9c;

/** The surface pool as it stands inside an RDRAM snapshot, or null when the
 * anchors don't describe a plausible pool (title screen, mid-load). */
export function readPoolFromRdram(
  rdram: Uint8Array,
): { bytes: Uint8Array; count: number; base: number } | null {
  const view = new DataView(rdram.buffer, rdram.byteOffset, rdram.byteLength);
  const off = (a: number): number => (a & 0x1fffffff) >>> 0;
  if (off(US_SURFACE_POOL) + 4 > rdram.length) return null;
  const count = view.getInt32(off(US_SURFACES_ALLOCATED));
  const base = view.getUint32(off(US_SURFACE_POOL)) >>> 0;
  if (count < 1 || count > 100000) return null;
  if (!KSEG0(base)) return null;
  const start = off(base);
  const end = start + count * SURFACE_STRUCT_SIZE;
  if (end > rdram.length) return null;
  return { bytes: rdram.subarray(start, end), count, base };
}

/** Longest chain we'll follow before giving up on a candidate node. Wall lists
 * in a dense cell get long; we only need to reach one decisive neighbour. */
const MAX_CHAIN = 256;

/** Surfaces whose classification differs between the two thresholds. */
const DISPUTED_LOW = 0.01;
const DISPUTED_HIGH = 0.05;
/** Beyond this, a normal is a floor/ceiling under either threshold — the
 * decisive neighbour a chain walk is looking for. */
const DECISIVE = DISPUTED_HIGH;

export interface PatchDetection {
  /** Wall-classification cutoff the ROM uses, or null if undetermined. */
  wallThreshold: number | null;
  /** Disputed-band surfaces examined. */
  examined: number;
  /** Votes for each verdict, for diagnostics. */
  wallListVotes: number;
  floorOrCeilListVotes: number;
}

/**
 * Determine the ROM's wall-classification threshold from its live partition.
 * Returns wallThreshold null when the level offers no evidence (no surfaces in
 * the disputed band, or no chain long enough to classify) — callers should keep
 * whatever they already believe rather than assuming vanilla.
 */
export function detectWallThreshold(
  rdram: Uint8Array,
  surfaces: Surface[],
): PatchDetection {
  const none: PatchDetection = {
    wallThreshold: null,
    examined: 0,
    wallListVotes: 0,
    floorOrCeilListVotes: 0,
  };
  if (rdram.length < 0x1000 || surfaces.length === 0) return none;

  const view = new DataView(rdram.buffer, rdram.byteOffset, rdram.byteLength);
  const u32 = (addr: number): number => {
    const off = (addr & 0x1fffffff) >>> 0;
    return off + 4 <= rdram.length ? view.getUint32(off) >>> 0 : 0;
  };

  // normal.y by surface address, and the surface array's extent. Nodes are
  // never INSIDE the surface array, but they can sit on either side of it:
  // vanilla allocates the node pool first (alloc_surface_pools, MEMORY_POOL_LEFT
  // grows upward), so its nodes are BELOW the surfaces, while this hack keeps
  // them above. Stray Surface* pairs elsewhere in RAM (gMarioStates+0x60..0x68)
  // are rejected by the chain walk: their "next" isn't a pool node.
  const normalY = new Map<number, number>();
  let poolLow = Infinity;
  let poolHigh = -Infinity;
  for (const s of surfaces) {
    const a = s.address >>> 0;
    normalY.set(a, s.normal.y);
    if (a < poolLow) poolLow = a;
    if (a > poolHigh) poolHigh = a;
  }
  poolHigh += SURFACE_STRUCT_SIZE;

  // Static surfaces only: dynamic (object) collision is rebuilt every frame, so
  // its nodes may not match the snapshot.
  const disputed = new Set<number>();
  for (const s of surfaces) {
    if ((s.flags & SURFACE_FLAG_DYNAMIC) !== 0) continue;
    const m = Math.abs(s.normal.y);
    if (m >= DISPUTED_LOW && m < DISPUTED_HIGH) disputed.add(s.address >>> 0);
  }
  if (disputed.size === 0) return none;

  // One pass: collect candidate nodes holding a disputed surface.
  const candidates: number[] = [];
  for (let off = 0; off + 8 <= rdram.length; off += 4) {
    const addr = 0x80000000 + off;
    if (addr >= poolLow && addr < poolHigh) continue; // inside a Surface struct
    if (!disputed.has(view.getUint32(off + 4) >>> 0)) continue;
    const next = view.getUint32(off) >>> 0;
    if (next !== 0 && !KSEG0(next)) continue;
    candidates.push(addr);
  }

  let wallListVotes = 0;
  let floorOrCeilListVotes = 0;
  const examined = new Set<number>();

  for (const node of candidates) {
    const self = u32(node + 4) >>> 0;
    let decisive = false;
    let valid = true;
    let walked = 0;
    let n = u32(node) >>> 0;
    for (let step = 0; step < MAX_CHAIN && n !== 0; step++) {
      if (!KSEG0(n)) {
        valid = false;
        break;
      }
      const ny = normalY.get(u32(n + 4) >>> 0);
      if (ny === undefined) {
        valid = false; // not a real node chain
        break;
      }
      walked++;
      if (Math.abs(ny) > DECISIVE) {
        decisive = true;
        break;
      }
      n = u32(n) >>> 0;
    }
    // A chain that ran into non-pool data proves nothing — and neither does a
    // node at the END of its list (nothing after it to look at): on a vanilla
    // ROM a disputed floor that sorts last in its cell would otherwise vote
    // "wall list".
    if (!valid || walked === 0) continue;
    examined.add(self);
    if (decisive) floorOrCeilListVotes++;
    else wallListVotes++;
  }

  if (examined.size === 0) return none;
  // A single decisive neighbour is proof the ROM kept the disputed surface in a
  // floor/ceiling list, i.e. vanilla thresholds. Wall-list votes are only
  // conclusive in bulk, since "no decisive neighbour found" is also what a
  // truncated walk looks like.
  const wallThreshold =
    floorOrCeilListVotes > 0
      ? DISPUTED_LOW
      : wallListVotes >= 2
        ? DISPUTED_HIGH
        : null;
  return {
    wallThreshold,
    examined: examined.size,
    wallListVotes,
    floorOrCeilListVotes,
  };
}
