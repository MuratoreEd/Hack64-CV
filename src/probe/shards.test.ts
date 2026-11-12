import { describe, it, expect } from "vitest";
import { makeSurface } from "../collision/geometry";
import {
  combineShards,
  findInvisibleWalls,
  mergeSegments,
  type InvisibleWallSegment,
  type ProbeOptions,
  type ProbeResult,
} from "./invisibleWalls";
import type { Surface } from "../collision/surface";

/** A flat floor quad at height y over [x0, x1] x [z0, z1]. */
const floorQuad = (x0: number, x1: number, z0: number, z1: number, y = 0): Surface[] => [
  makeSurface([x0, y, z0], [x0, y, z1], [x1, y, z1])!,
  makeSurface([x0, y, z0], [x1, y, z1], [x1, y, z0])!,
];
/** A ceiling quad (normal.y < 0) at height y over [x0, x1] x [z0, z1]. */
const ceilQuad = (x0: number, x1: number, z0: number, z1: number, y: number): Surface[] => [
  makeSurface([x0, y, z0], [x1, y, z1], [x0, y, z1])!,
  makeSurface([x0, y, z0], [x1, y, z0], [x1, y, z1])!,
];
/** A wall quad on the plane x = px spanning z0..z1, y0..y1, facing -x. */
const wallFacingWest = (px: number, z0: number, z1: number, y0: number, y1: number): Surface[] => [
  makeSurface([px, y0, z0], [px, y0, z1], [px, y1, z1])!,
  makeSurface([px, y0, z0], [px, y1, z1], [px, y1, z0])!,
];

/** Give every surface its pool index and address, like a parsed pool. */
const pool = (surfaces: Surface[]): Surface[] =>
  surfaces.map((s, index) => ({ ...s, index, address: 0x80100000 + index * 0x30 }));

/** A scene with every kind of finding: leaked low ceilings (several, so
 * blockers differ), a cracked floor, a ledge over a roofed room. */
function busyScene(): Surface[] {
  const out: Surface[] = [];
  out.push(...floorQuad(-600, 600, -600, 600, 0));
  for (let i = 0; i < 6; i++) {
    const x = -500 + i * 180;
    out.push(...ceilQuad(x, x + 90, -400 + i * 20, 300 - i * 15, 60 + i * 12));
  }
  // A second deck with a crack in it, above the first.
  out.push(...floorQuad(-600, -3, 700, 1100, 300));
  out.push(...floorQuad(2, 600, 700, 1100, 300));
  // A ledge whose rim overhangs a roofed room.
  out.push(...floorQuad(700, 1000, -300, 300, 400));
  out.push(...floorQuad(1000, 1300, -300, 300, 0));
  out.push(...ceilQuad(1000, 1300, -300, 300, 120));
  return pool(out);
}

describe("sharded probe runs", () => {
  const scene = busyScene();

  const sharded = (count: number, opts: ProbeOptions = {}): ProbeResult => {
    const parts: ProbeResult[] = [];
    for (let index = 0; index < count; index++) {
      parts.push(findInvisibleWalls(scene, { ...opts, shard: { index, count } }));
    }
    return combineShards(parts);
  };

  it("precondition: the scene produces both kinds of finding", () => {
    const whole = findInvisibleWalls(scene);
    const kinds = new Set(whole.segments.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["exposed-ceiling", "out-of-bounds"]));
    expect(whole.segments.length).toBeGreaterThan(8);
  });

  it("reassemble into exactly the unsharded result, for any worker count", () => {
    const whole = findInvisibleWalls(scene);
    for (const count of [1, 2, 3, 5, 8, 64]) {
      const combined = sharded(count);
      // Not just the same cells: the same segments, in the same order.
      expect(combined.segments).toEqual(whole.segments);
      expect(combined.samplesProbed).toBe(whole.samplesProbed);
      expect(combined.ceilingsProbed).toBe(whole.ceilingsProbed);
      expect(combined.floorsProbed).toBe(whole.floorsProbed);
    }
  });

  it("holds under the patched engine's options too", () => {
    const opts: ProbeOptions = { walls: "frame", select: "extreme", worldScale: 4,
      marioHeight: 40, ledgeGrace: 25, wallOffset: 15, wallRadius: 12.5, edgeMargin: 0.25 };
    expect(sharded(4, opts).segments).toEqual(findInvisibleWalls(scene, opts).segments);
  });

  it("a shard returns raw segments with their source order, never merged", () => {
    const part = findInvisibleWalls(scene, { shard: { index: 0, count: 2 } });
    expect(part.segmentOrder).toHaveLength(part.segments.length);
    // Every segment in slice 0 of 2 comes from an even position in the list.
    for (const order of part.segmentOrder!) expect(order % 2).toBe(0);
    const raw = findInvisibleWalls(scene, { merge: false });
    const fromEven = raw.segments.filter((s) => s.sourceIndex % 2 === 0);
    expect(part.segments).toEqual(fromEven);
  });

  it("an unsharded run carries no shard bookkeeping", () => {
    expect(findInvisibleWalls(scene).segmentOrder).toBeUndefined();
  });
});

describe("mergeSegments at scale", () => {
  const seg = (p: Partial<InvisibleWallSegment>): InvisibleWallSegment => ({
    x0: 0, z0: 0, x1: 0, z1: 0, yBase: 0, yLow: 0, yHigh: 100,
    kind: "out-of-bounds", blockerAddr: 0, sourceIndex: 0, samples: 1,
    columns: [], ...p,
  });

  it("reaches a fixpoint when a later segment bridges two earlier ones", () => {
    // A and B are 50 apart on one line and cannot fuse; C, listed last, spans
    // the gap. A absorbs C, and the grown A must then go back for B.
    const a = seg({ z0: 0, z1: 100 });
    const b = seg({ z0: 150, z1: 250 });
    const c = seg({ z0: 99, z1: 151 });
    for (const order of [[a, b, c], [c, a, b], [b, c, a], [b, a, c]]) {
      const out = mergeSegments(order);
      expect(out).toHaveLength(1);
      expect(Math.min(out[0].z0, out[0].z1)).toBeCloseTo(0, 6);
      expect(Math.max(out[0].z0, out[0].z1)).toBeCloseTo(250, 6);
      expect(out[0].samples).toBe(3);
    }
  });

  it("chains a run delivered in scrambled order", () => {
    const pieces = Array.from({ length: 40 }, (_, i) => seg({ z0: i * 10, z1: i * 10 + 9 }));
    // Deterministic scramble.
    const scrambled = pieces.map((p, i) => ({ p, k: (i * 17) % 40 }))
      .sort((x, y) => x.k - y.k).map((x) => x.p);
    const out = mergeSegments(scrambled);
    expect(out).toHaveLength(1);
    expect(out[0].samples).toBe(40);
  });

  it("stays fast on thousands of segments in one group", () => {
    // Every out-of-bounds segment shares a group. The old merge restarted from
    // the first pair after every fusion: 3000 of these took ~15 s.
    const k = 3000;
    const far = Array.from({ length: k }, (_, i) =>
      seg({
        x0: (i % 60) * 40, x1: (i % 60) * 40 + 10,
        z0: Math.floor(i / 60) * 40, z1: Math.floor(i / 60) * 40,
        columns: [{ x: (i % 60) * 40, z: Math.floor(i / 60) * 40, yLow: 0, yHigh: 100 }],
      }),
    );
    const dupes = far.slice(0, k / 2).map((s) => ({ ...s, columns: [...s.columns] }));
    const t0 = performance.now();
    const out = mergeSegments([...far, ...dupes]);
    const ms = performance.now() - t0;
    expect(out).toHaveLength(k); // every duplicate folded into its twin
    expect(ms).toBeLessThan(2000);
  });
});

describe("worldScale: a pushed step target is filed in the engine's column", () => {
  // Scale-4 lengths throughout; only `worldScale` differs between the runs.
  const lengths: ProbeOptions = {
    marioHeight: 40, ledgeGrace: 25, wallOffset: 15, wallRadius: 12.5,
    airPass: false,
  };
  // Two floor pieces with a one-column crack between them (column x = -51 is
  // on neither), and a wall at x = -38 whose (60, 50)/4 push leaves a step
  // target at exactly x = -50.5.
  const scene = pool([
    ...floorQuad(-200, -52, -100, 100),
    ...floorQuad(-50, 100, -100, 100),
    ...wallFacingWest(-38, -100, 100, -10, 100),
  ]);

  it("precondition: the wall faces the crack", () => {
    const wall = scene[scene.length - 1];
    expect(wall.kind).toBe("wall");
    expect(wall.normal.x).toBeCloseTo(-1, 6);
  });

  const blockedXs = (worldScale: number): Set<number> => {
    const res = findInvisibleWalls(scene, { ...lengths, worldScale });
    return new Set(res.segments.flatMap((s) => s.columns.map((c) => c.x)));
  };

  it("truncates toward zero on a 1x ROM: -50.5 is column -50, which has floor", () => {
    const xs = blockedXs(1);
    expect(xs.has(-51)).toBe(true); // the crack itself
    expect(xs.has(-50)).toBe(false);
  });

  it("floors on a 4x ROM: -50.5 is column -51 — the crack — so -50 is blocked too", () => {
    // World -202 -> (s16) -202 -> >> 2 = -51. Stepping to column -50 from the
    // east gets pushed onto the crack: a blocked step the 1x rule misses.
    const xs = blockedXs(4);
    expect(xs.has(-51)).toBe(true);
    expect(xs.has(-50)).toBe(true);
  });
});
