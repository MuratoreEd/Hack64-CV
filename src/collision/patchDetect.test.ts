import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { detectWallThreshold } from "./patchDetect";
import { SURFACE_FLAG_DYNAMIC } from "./constants";
import type { Surface } from "./surface";

// A fake RDRAM image containing SurfaceNode chains, so the detector can be
// exercised against both engines without a live game.
//   struct SurfaceNode { next @+0; surface @+4; }
const RDRAM = 0x400000;
/** Node region — above the surface-pool addresses, as in the real pool. */
const NODES = 0x80300000;

// Surface-pool addresses. These must be KSEG0: the detector uses the pool's low
// address to reject stray Surface* fields elsewhere in RAM.
const A_DISPUTED = 0x80100000; // |ny| in [0.01, 0.05): classification differs
const A_DISPUTED_CEIL = 0x80100400; // same band, downward-facing
const A_STEEP_FLOOR = 0x80100100; // a floor under either threshold
const A_STEEP_CEIL = 0x80100200; // a ceiling under either threshold
const A_SHALLOW = 0x80100300; // |ny| < 0.01: a wall under either threshold

/** A surface at a pool address with an exact normal.y (the only geometry the
 * detector reads, alongside flags and address). */
function surf(address: number, normalY: number, dynamic = false): Surface {
  const s = makeSurface([-100, 0, -100], [-100, 0, 100], [100, 0, 100], {
    address,
  })!;
  return {
    ...s,
    normal: { x: 0, y: normalY, z: Math.sqrt(Math.max(0, 1 - normalY ** 2)) },
    flags: dynamic ? s.flags | SURFACE_FLAG_DYNAMIC : s.flags,
  };
}

/** Lay out chains in a fresh image. Each chain is a list of surface addresses;
 * nodes are emitted in order and linked, terminating with next = 0. */
function image(chains: number[][]): Uint8Array {
  const bytes = new Uint8Array(RDRAM);
  const view = new DataView(bytes.buffer);
  const off = (addr: number) => addr & 0x1fffffff;
  let cursor = NODES;
  for (const chain of chains) {
    const nodeAddrs = chain.map((_, i) => cursor + i * 8);
    cursor += chain.length * 8 + 8; // gap between chains
    chain.forEach((surfAddr, i) => {
      const node = nodeAddrs[i];
      view.setUint32(off(node), i + 1 < nodeAddrs.length ? nodeAddrs[i + 1] : 0);
      view.setUint32(off(node) + 4, surfAddr);
    });
  }
  return bytes;
}

const disputed = surf(A_DISPUTED, 0.03);
const disputedCeil = surf(A_DISPUTED_CEIL, -0.03);
const steepFloor = surf(A_STEEP_FLOOR, 0.8);
const steepCeil = surf(A_STEEP_CEIL, -0.8);
const shallow = surf(A_SHALLOW, 0.005);

describe("detectWallThreshold", () => {
  it("reads ±0.05 (patched) when the disputed surface sits in a wall list", () => {
    // A chain of nothing but shallow surfaces is a wall list, so this ROM put a
    // 0.03 surface among the walls: the patched threshold. Two votes, since a
    // single inconclusive walk is deliberately not enough.
    const rdram = image([
      [A_SHALLOW, A_DISPUTED, A_SHALLOW],
      [A_DISPUTED, A_SHALLOW],
    ]);
    const r = detectWallThreshold(rdram, [disputed, steepFloor, shallow]);
    expect(r.wallThreshold).toBe(0.05);
    expect(r.wallListVotes).toBeGreaterThanOrEqual(2);
    expect(r.floorOrCeilListVotes).toBe(0);
  });

  it("reads ±0.01 (vanilla) when it sits in a floor list", () => {
    // A steep floor in the same chain proves the chain is a floor list.
    const rdram = image([[A_DISPUTED, A_STEEP_FLOOR]]);
    const r = detectWallThreshold(rdram, [disputed, steepFloor, shallow]);
    expect(r.wallThreshold).toBe(0.01);
    expect(r.floorOrCeilListVotes).toBeGreaterThan(0);
  });

  it("reads ±0.01 from a CEILING list too", () => {
    const rdram = image([[A_DISPUTED_CEIL, A_STEEP_CEIL]]);
    const r = detectWallThreshold(rdram, [disputedCeil, steepCeil, shallow]);
    expect(r.wallThreshold).toBe(0.01);
  });

  it("a single decisive neighbour outvotes several wall-list walks", () => {
    // An inconclusive walk is indistinguishable from a wall list, so one hard
    // floor-list sighting must win — otherwise long wall lists mask vanilla.
    const rdram = image([
      [A_DISPUTED, A_SHALLOW],
      [A_DISPUTED, A_SHALLOW],
      [A_DISPUTED, A_STEEP_FLOOR],
    ]);
    expect(
      detectWallThreshold(rdram, [disputed, steepFloor, shallow]).wallThreshold,
    ).toBe(0.01);
  });

  it("returns null when the level offers no evidence", () => {
    // No disputed-band surfaces at all: callers must keep their current belief
    // rather than defaulting to vanilla.
    const rdram = image([[A_STEEP_FLOOR, A_SHALLOW]]);
    expect(detectWallThreshold(rdram, [steepFloor, shallow]).wallThreshold).toBeNull();
    // Disputed surface present, but no node chain references it.
    expect(detectWallThreshold(image([]), [disputed, shallow]).wallThreshold).toBeNull();
    // Empty inputs.
    expect(detectWallThreshold(new Uint8Array(0), [disputed]).wallThreshold).toBeNull();
  });

  it("discards a chain whose neighbour isn't a pool surface", () => {
    // Guards against a stray Surface* elsewhere in RAM (gMarioStates+0x68 holds
    // one whose neighbour is also one) being mistaken for a partition node.
    const rdram = image([[A_DISPUTED, A_STEEP_FLOOR]]);
    // The pool we pass omits the neighbour, so the walk hits an unknown surface
    // and the chain proves nothing.
    const r = detectWallThreshold(rdram, [disputed, shallow]);
    expect(r.wallThreshold).toBeNull();
    expect(r.examined).toBe(0);
  });

  it("skips dynamic surfaces, whose nodes are rebuilt every frame", () => {
    const rdram = image([
      [A_SHALLOW, A_DISPUTED, A_SHALLOW],
      [A_DISPUTED, A_SHALLOW],
    ]);
    const dyn = surf(A_DISPUTED, 0.03, true);
    expect(
      detectWallThreshold(rdram, [dyn, steepFloor, shallow]).wallThreshold,
    ).toBeNull();
  });
});
