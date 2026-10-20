import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { detectWallThreshold, readPoolFromRdram } from "./patchDetect";
import { detectPatchSignatures } from "./patchSignatures";
import { SURFACE_FLAG_DYNAMIC } from "./constants";
import { encodeSurfacePool } from "./surfaceEncode";
import { parseSurfacePool } from "./surface";
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

  it("a node at the END of its list proves nothing", () => {
    // Nothing follows it to look at. On a vanilla ROM a disputed floor that
    // sorts last in its cell would otherwise count as a wall-list vote — two of
    // those used to be enough to call a vanilla ROM patched.
    const rdram = image([
      [A_SHALLOW, A_DISPUTED],
      [A_SHALLOW, A_DISPUTED],
    ]);
    const r = detectWallThreshold(rdram, [disputed, steepFloor, shallow]);
    expect(r.wallThreshold).toBeNull();
    expect(r.wallListVotes).toBe(0);
  });

  it("finds nodes BELOW the surface pool (vanilla's allocation order)", () => {
    // alloc_surface_pools allocates the node pool first and main_pool_alloc
    // grows upward, so on vanilla every node sits under the surfaces. An old
    // "nodes live above the pool" filter made vanilla undetectable.
    const hi = (a: number) => a + 0x300000; // surfaces above the nodes (0x80300000)
    const s = (a: number, ny: number) => surf(hi(a), ny);
    const rdram = image([[hi(A_DISPUTED), hi(A_STEEP_FLOOR)]]);
    const r = detectWallThreshold(rdram, [s(A_DISPUTED, 0.03), s(A_STEEP_FLOOR, 0.8)]);
    expect(r.wallThreshold).toBe(0.01);
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

describe("readPoolFromRdram", () => {
  it("reads the pool the snapshot itself holds", () => {
    const pool = [surf(0, 0.8), surf(0, -0.8)].map((s, i) => ({ ...s, index: i }));
    const bytes = new Uint8Array(encodeSurfacePool(pool));
    const rdram = new Uint8Array(RDRAM);
    const view = new DataView(rdram.buffer);
    const base = 0x80250000;
    rdram.set(bytes, base & 0x1fffffff);
    view.setInt32(0x361170, pool.length); // gSurfacesAllocated
    view.setUint32(0x38ee9c, base); // sSurfacePool
    const got = readPoolFromRdram(rdram)!;
    expect(got.count).toBe(2);
    expect(got.base).toBe(base);
    const parsed = parseSurfacePool(
      got.bytes.slice().buffer as ArrayBuffer, got.count, { baseAddress: got.base },
    );
    expect(parsed.map((s) => s.normal.y)).toEqual([
      expect.closeTo(0.8, 5), expect.closeTo(-0.8, 5),
    ]);
  });

  it("returns null for anchors that don't describe a pool", () => {
    const rdram = new Uint8Array(RDRAM);
    expect(readPoolFromRdram(rdram)).toBeNull(); // count 0
    new DataView(rdram.buffer).setInt32(0x361170, 5);
    expect(readPoolFromRdram(rdram)).toBeNull(); // pool pointer 0
    expect(readPoolFromRdram(new Uint8Array(16))).toBeNull();
  });
});

describe("detectPatchSignatures (the patcher's own edits, read from RAM)", () => {
  // RAM addresses of the patcher's ROM offsets (engine segment ROM 0xF5580 →
  // RAM 0x80378800): the two JALs, the band-aid JAL, the threshold doubles.
  const JAL1 = 0x380f98;
  const JAL2 = 0x380fe8;
  const BAND_AID = 0x38100c;
  const THRESH = 0x38bbb0;
  const jal = (target: number) => (0x0c000000 | ((target & 0x0fffffff) >>> 2)) >>> 0;
  const PROLOGUE = [
    0x27bdff20, 0xafbf0054, 0xafb30050, 0xafb2004c, 0xafb10048, 0xafb00044,
    0xf7be0038, 0xf7bc0030, 0xf7ba0028, 0xf7b80020, 0xf7b60018, 0xf7b40010,
    0xc4aa0010,
  ];
  const ram = (opts: { frame?: boolean; bandAid?: boolean; threshold?: number }) => {
    const rdram = new Uint8Array(0x420000);
    const v = new DataView(rdram.buffer);
    const routine = opts.frame ? 0x80401000 : 0x80380690;
    v.setUint32(JAL1, jal(routine));
    v.setUint32(JAL2, jal(routine));
    if (opts.frame) PROLOGUE.forEach((w, i) => v.setUint32(0x401000 + i * 4, w));
    if (opts.bandAid) v.setUint32(BAND_AID, jal(0x80380690));
    if (opts.threshold !== undefined) {
      v.setFloat64(THRESH, opts.threshold);
      v.setFloat64(THRESH + 8, -opts.threshold);
    }
    return rdram;
  };

  it("recognises vanilla", () => {
    expect(detectPatchSignatures(ram({ threshold: 0.01 }))).toEqual({
      walls: "vanilla", wallThreshold: 0.01,
    });
  });

  it("recognises Frame's patch, ignoring its extended-boundary band-aid call", () => {
    // The band-aid JAL targets the OLD routine; counting it would read "mixed".
    expect(detectPatchSignatures(ram({ frame: true, bandAid: true, threshold: 0.05 }))).toEqual({
      walls: "frame", wallThreshold: 0.05,
    });
  });

  it("says nothing it can't back up", () => {
    // A JAL into expansion RAM that isn't the patch's routine: some other patch.
    const r = ram({ threshold: 0.02 });
    const v = new DataView(r.buffer);
    v.setUint32(JAL1, jal(0x80401000));
    v.setUint32(JAL2, jal(0x80401000));
    expect(detectPatchSignatures(r)).toEqual({ walls: null, wallThreshold: null });
    expect(detectPatchSignatures(new Uint8Array(0x100))).toEqual({
      walls: null, wallThreshold: null,
    });
  });
});
