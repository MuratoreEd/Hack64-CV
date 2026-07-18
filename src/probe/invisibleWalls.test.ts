import { describe, it, expect } from "vitest";
import { makeSurface } from "../collision/geometry";
import { findInvisibleWalls, mergeSegments } from "./invisibleWalls";
import type { InvisibleWallSegment } from "./invisibleWalls";
import type { Surface } from "../collision/surface";

// A segment fixture on the XZ line the fields describe, with sane defaults.
const seg = (p: Partial<InvisibleWallSegment>): InvisibleWallSegment => ({
  x0: 0, z0: 0, x1: 0, z1: 0,
  yBase: 0, yLow: 0, yHigh: 100,
  kind: "out-of-bounds",
  blockerAddr: 0,
  sourceIndex: 0,
  samples: 1,
  columns: [],
  ...p,
});

// Ground: a 400×400 floor quad at y=0 spanning x,z ∈ [-200, 200].
const ground = (): Surface[] => [
  makeSurface([-200, 0, -200], [-200, 0, 200], [200, 0, 200], { address: 0x100 })!,
  makeSurface([-200, 0, -200], [200, 0, 200], [200, 0, -200], { address: 0x130 })!,
];

// A ceiling quad at height h covering the left half (x ∈ [-200, 0]).
// Ceiling winding must give normal.y < 0 (vertices clockwise seen from above).
const leftCeiling = (h: number): Surface[] => [
  makeSurface([-200, h, -200], [0, h, 200], [-200, h, 200], { address: 0x200 })!,
  makeSurface([-200, h, -200], [0, h, -200], [0, h, 200], { address: 0x230 })!,
];

// A ceiling quad at height h covering x ∈ [-200, leak]: its edge pokes `leak`
// units past the wall plane at x = 0 (pannen's truncation-misalignment setup,
// exaggerated). Whether that band is reachable depends on the wall-push radius.
const leakyCeiling = (h: number, leak: number): Surface[] => [
  makeSurface([-200, h, -200], [leak, h, 200], [-200, h, 200], { address: 0x200 })!,
  makeSurface([-200, h, -200], [leak, h, -200], [leak, h, 200], { address: 0x230 })!,
];

// A wall quad on the plane x=0, y ∈ [0, top], capping the ceiling's edge.
// Winding gives normal +x — facing the walkable approach side (x > 0), so the
// game's one-sided wall pushes actually stop Mario before the seam.
const capWall = (top = 200): Surface[] => [
  makeSurface([0, 0, -200], [0, top, 200], [0, 0, 200], { address: 0x300 })!,
  makeSurface([0, 0, -200], [0, top, -200], [0, top, 200], { address: 0x330 })!,
];

// The same quad wound the other way — normal −x, front pointing away from the
// approach. Engaged from behind, the push shoves Mario forward THROUGH the
// plane (toward the front), so this stops nothing and caps nothing.
const backWall = (): Surface[] => [
  makeSurface([0, 0, -200], [0, 0, 200], [0, 200, 200], { address: 0x300 })!,
  makeSurface([0, 0, -200], [0, 200, 200], [0, 200, -200], { address: 0x330 })!,
];

const probe = (surfaces: Surface[], opts = {}) =>
  findInvisibleWalls(surfaces, opts);

describe("findInvisibleWalls: exposed ceilings (ceiling-edge march)", () => {
  it("flags the exposed edge of a low ceiling with no capping wall", () => {
    const surfaces = [...ground(), ...leftCeiling(100)]; // gap 100 < 160 → blocked
    const segments = probe(surfaces).segments.filter(
      (s) => s.kind === "exposed-ceiling",
    );
    expect(segments.length).toBeGreaterThan(0);
    // Anomalies must sit on the ceiling's exposed boundary x = 0, not the
    // outer edges (no walkable outside) or the interior diagonal (both blocked).
    for (const s of segments) {
      expect(Math.abs(s.x0)).toBeLessThanOrEqual(2);
      expect(Math.abs(s.x1)).toBeLessThanOrEqual(2);
      expect(s.yBase).toBeCloseTo(0, 3);
      // Mario (160) doesn't fit under the ceiling (100), so the pocket below
      // it is blocked too: the region reaches the floor, and with no floor
      // above the column it runs past all geometry to the sky cap.
      expect(s.yLow).toBeCloseTo(0, 3);
      expect(s.yHigh).toBeGreaterThan(100);
      expect([0x200, 0x230]).toContain(s.blockerAddr);
    }
    // Together the segments should span most of the z range of the edge.
    const zSpan = segments.reduce((acc, s) => acc + Math.abs(s.z1 - s.z0), 0);
    expect(zSpan).toBeGreaterThan(300);
  });

  it("records the unique blocked integer columns, for unit-cell rendering", () => {
    // The viewer draws one unit-footprint box per column, so columns must be
    // the deduplicated set of INTEGER cells the step was blocked at — both
    // triangles marching the shared rim contribute each cell exactly once.
    const surfaces = [...ground(), ...leftCeiling(100)];
    const segments = probe(surfaces).segments.filter(
      (s) => s.kind === "exposed-ceiling",
    );
    for (const s of segments) {
      expect(s.columns.length).toBeGreaterThan(0);
      expect(s.columns.length).toBeLessThanOrEqual(s.samples);
      const seen = new Set<string>();
      for (const c of s.columns) {
        expect(Number.isInteger(c.x)).toBe(true);
        expect(Number.isInteger(c.z)).toBe(true);
        const key = `${c.x},${c.z}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        // Blocked cells sit at most 2 units past the marched line (the probe
        // tries perpendicular offsets 0..2), plus 0.5 for integer rounding.
        expect(Math.abs(c.x)).toBeLessThanOrEqual(2);
        expect(c.z).toBeGreaterThanOrEqual(Math.min(s.z0, s.z1) - 2.5);
        expect(c.z).toBeLessThanOrEqual(Math.max(s.z0, s.z1) + 2.5);
        expect(c.yLow).toBeCloseTo(s.yLow, 3);
        expect(c.yHigh).toBeCloseTo(s.yHigh, 3);
      }
    }
  });

  it("stays silent when a wall caps the seam (expected barrier)", () => {
    const surfaces = [...ground(), ...leftCeiling(100), ...capWall()];
    expect(probe(surfaces).segments).toEqual([]);
  });

  it("stays silent when a sub-height wall guards the seam (bridge rail)", () => {
    // A wall only 100 tall facing the approach: too short to cover Mario's
    // hitbox, but the game's floor+30/+60 pushes engage it, so walking Mario
    // is stopped by real wall collision — an expected barrier, not an anomaly
    // (verified live: bridge side rails ~106 above the deck were flagged when
    // height was required).
    const surfaces = [...ground(), ...leftCeiling(100), ...capWall(100)];
    expect(probe(surfaces).segments).toEqual([]);
  });

  it("ignores a back-facing wall on the seam (pass-through side)", () => {
    // Full-height wall whose front points AWAY from the approach: engaged
    // from behind, the push ejects Mario forward through the plane instead of
    // stopping him — the seam's exposed ceiling must still be reported
    // (verified live: a cliff-face sliver fronting the drop hid the rim's
    // floor crack from the probe).
    const surfaces = [...ground(), ...leftCeiling(100), ...backWall()];
    const segments = probe(surfaces).segments;
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.kind).toBe("exposed-ceiling");
      expect([0x200, 0x230]).toContain(s.blockerAddr);
    }
  });

  it("stays silent when the leak is shallower than the wall-push radius", () => {
    // Ceiling pokes 10 past its capping wall. The game resolves wall pushes
    // BEFORE the ceiling check (offset 60, radius 50): a step target inside
    // the band is pushed back to 50 from the plane — outside the leak — so no
    // step ever takes the ceiling verdict. No invisible wall exists.
    const surfaces = [...ground(), ...leakyCeiling(100, 10), ...capWall()];
    expect(probe(surfaces).segments).toEqual([]);
  });

  it("flags the reachable band when the leak outruns the push radius", () => {
    // Leak 60 > radius 50: between the push distance and the ceiling edge
    // there is standable ground where the step is ceiling-blocked — a real
    // invisible wall along the edge.
    const surfaces = [...ground(), ...leakyCeiling(100, 60), ...capWall()];
    const segments = probe(surfaces).segments;
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.kind).toBe("exposed-ceiling");
      expect(Math.abs(s.x0 - 60)).toBeLessThanOrEqual(2);
      expect(Math.abs(s.x1 - 60)).toBeLessThanOrEqual(2);
      expect([0x200, 0x230]).toContain(s.blockerAddr);
    }
  });

  it("stays silent when the ceiling clears Mario's height", () => {
    const surfaces = [...ground(), ...leftCeiling(300)]; // gap 300 > 160
    expect(probe(surfaces).segments).toEqual([]);
  });

  it("respects a scaled marioHeight (4× world-scale hack)", () => {
    // In a 4× hack the same ceiling at collision height 100 is 400 world units
    // up — far above Mario's 160-world hitbox (40 collision units).
    const surfaces = [...ground(), ...leftCeiling(100)];
    expect(probe(surfaces, { marioHeight: 40, ledgeGrace: 25 }).segments)
      .toEqual([]);
    // …while a genuinely low ceiling (30 < 40) still fires.
    const low = [...ground(), ...leftCeiling(30)];
    const hits = probe(low, { marioHeight: 40, ledgeGrace: 25 }).segments;
    expect(hits.length).toBeGreaterThan(0);
  });

  it("skips dynamic and camera-only surfaces", () => {
    const dyn = leftCeiling(100).map((s) => ({ ...s, flags: s.flags | 1 }));
    expect(probe([...ground(), ...dyn]).segments).toEqual([]);
    const cam = leftCeiling(100).map((s) => ({ ...s, type: 0x0072 }));
    expect(probe([...ground(), ...cam]).segments).toEqual([]);
  });
});

describe("findInvisibleWalls: ledges above roofed rooms (floor-edge march)", () => {
  // A ledge: upper floor at y=500 over x ∈ [-200, 0], lower floor at y=0 over
  // x ∈ [0, 400], and a ceiling at y=100 roofing the lower area. Walking off
  // the upper ledge is rejected by the leave-ground branch (ceiling below
  // Mario), even though nothing visible blocks the rim — the same
  // exposed-ceiling metric as the grounded case, reached from above.
  const upperFloor = (): Surface[] => [
    makeSurface([-200, 500, -200], [-200, 500, 200], [0, 500, 200], { address: 0x400 })!,
    makeSurface([-200, 500, -200], [0, 500, 200], [0, 500, -200], { address: 0x430 })!,
  ];
  const lowerFloor = (): Surface[] => [
    makeSurface([0, 0, -200], [0, 0, 200], [400, 0, 200], { address: 0x500 })!,
    makeSurface([0, 0, -200], [400, 0, 200], [400, 0, -200], { address: 0x530 })!,
  ];
  const lowerRoof = (): Surface[] => [
    makeSurface([0, 100, -200], [400, 100, 200], [0, 100, 200], { address: 0x600 })!,
    makeSurface([0, 100, -200], [400, 100, -200], [400, 100, 200], { address: 0x630 })!,
  ];

  it("flags the rim of a ledge above a roofed room", () => {
    const surfaces = [...upperFloor(), ...lowerFloor(), ...lowerRoof()];
    const segments = probe(surfaces).segments.filter(
      (s) => s.kind === "exposed-ceiling",
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      // On the upper floor's drop-off edge at x = 0, standing at 500, blocked
      // by the roof at 100. The room below is only 100 tall (< 160), so the
      // blocked region reaches its floor and — with no floor above the roof
      // at that column — runs past the 500 ledge to the sky cap.
      expect(Math.abs(s.x0)).toBeLessThanOrEqual(2);
      expect(s.yBase).toBeCloseTo(500, 3);
      expect(s.yLow).toBeCloseTo(0, 3);
      expect(s.yHigh).toBeGreaterThan(500);
      expect([0x600, 0x630]).toContain(s.blockerAddr);
    }
  });

  it("stays silent when the drop is open (no roof)", () => {
    const surfaces = [...upperFloor(), ...lowerFloor()];
    expect(probe(surfaces).segments).toEqual([]);
  });

  it("stays silent when the roof clears Mario approaching on the LOWER floor", () => {
    // Same scene but the roof is high enough (200 > 160) that the lower floor
    // is walkable — and the upper rim must still be flagged.
    const roofHigh: Surface[] = [
      makeSurface([0, 200, -200], [400, 200, 200], [0, 200, 200], { address: 0x700 })!,
      makeSurface([0, 200, -200], [400, 200, -200], [400, 200, 200], { address: 0x730 })!,
    ];
    const segments = probe([...upperFloor(), ...lowerFloor(), ...roofHigh]).segments;
    // Rim still blocked (roof at 200 is below the 500 ledge → branch 2), and
    // since Mario FITS in the room (200 > 160) the blocked region starts at
    // the roof, not the room floor.
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.kind).toBe("exposed-ceiling");
      expect(s.yLow).toBeCloseTo(200, 3);
      expect(s.yHigh).toBeGreaterThan(500);
    }
  });
});

describe("findInvisibleWalls: out of bounds (floor cracks)", () => {
  it("flags a narrow floor crack but not the level boundary", () => {
    // Two floor slabs at y=0 with a 4-unit gap between them (x ∈ [0, 4]) —
    // a truncation-style crack Mario's step cannot cross (floor NULL).
    const slabA: Surface[] = [
      makeSurface([-200, 0, -200], [-200, 0, 200], [0, 0, 200], { address: 0x800 })!,
      makeSurface([-200, 0, -200], [0, 0, 200], [0, 0, -200], { address: 0x830 })!,
    ];
    const slabB: Surface[] = [
      makeSurface([4, 0, -200], [4, 0, 200], [200, 0, 200], { address: 0x900 })!,
      makeSurface([4, 0, -200], [200, 0, 200], [200, 0, -200], { address: 0x930 })!,
    ];
    const segments = probe([...slabA, ...slabB]).segments;
    expect(segments.length).toBeGreaterThan(0);
    // EVERY segment must be out-of-bounds on the crack edges (x = 0 or x = 4).
    // Nothing may fire along the outer rim (x = ±200 / z = ±200): a void with
    // no floor further out is the level boundary, which players read as
    // intentional. (Crack segments legitimately extend to the corners, so we
    // assert on x, which cleanly separates crack from rim.)
    for (const s of segments) {
      expect(s.kind).toBe("out-of-bounds");
      expect(s.blockerAddr).toBe(0);
      // The crack column has nothing above it: region runs from the walk
      // floor past all geometry (maxY = 0 here) to the sky cap.
      expect(s.yLow).toBeCloseTo(0, 3);
      expect(s.yHigh).toBeGreaterThan(0);
      for (const x of [s.x0, s.x1]) {
        expect(x).toBeGreaterThanOrEqual(-2);
        expect(x).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe("mergeSegments", () => {
  it("collapses two identical segments and sums their samples", () => {
    const a = seg({ z0: -200, z1: 200, samples: 3, sourceIndex: 1 });
    const b = seg({ z0: -200, z1: 200, samples: 4, sourceIndex: 2 });
    const out = mergeSegments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].samples).toBe(7);
    expect(out[0].z0).toBeCloseTo(-200, 6);
    expect(out[0].z1).toBeCloseTo(200, 6);
  });

  it("merges a duplicate wound in the opposite direction", () => {
    const a = seg({ z0: -200, z1: 0 });
    const b = seg({ z0: 0, z1: -200 }); // same edge, reversed
    expect(mergeSegments([a, b])).toHaveLength(1);
  });

  it("fuses collinear segments that touch, spanning both", () => {
    const a = seg({ z0: -200, z1: 0 });
    const b = seg({ z0: 2, z1: 200 }); // 2-unit gap < tol → one run
    const out = mergeSegments([a, b]);
    expect(out).toHaveLength(1);
    expect(Math.min(out[0].z0, out[0].z1)).toBeCloseTo(-200, 6);
    expect(Math.max(out[0].z0, out[0].z1)).toBeCloseTo(200, 6);
  });

  it("keeps collinear segments separated by a real gap", () => {
    const a = seg({ z0: -200, z1: -100 });
    const b = seg({ z0: 100, z1: 200 }); // 200-unit walkable gap between them
    expect(mergeSegments([a, b])).toHaveLength(2);
  });

  it("keeps parallel segments on different lines apart", () => {
    const a = seg({ x0: 0, z0: -200, x1: 0, z1: 200 });
    const b = seg({ x0: 4, z0: -200, x1: 4, z1: 200 }); // 4 units over
    expect(mergeSegments([a, b])).toHaveLength(2);
  });

  it("never fuses across kinds or blockers", () => {
    const line = { z0: -200, z1: 200 } as const;
    const diffKind = [
      seg({ ...line, kind: "out-of-bounds", blockerAddr: 0 }),
      seg({ ...line, kind: "exposed-ceiling", blockerAddr: 0x10 }),
    ];
    expect(mergeSegments(diffKind)).toHaveLength(2);
    const diffBlocker = [
      seg({ ...line, kind: "exposed-ceiling", blockerAddr: 0x10 }),
      seg({ ...line, kind: "exposed-ceiling", blockerAddr: 0x20 }),
    ];
    expect(mergeSegments(diffBlocker)).toHaveLength(2);
  });

  it("unions the blocked intervals when fusing", () => {
    const a = seg({
      z1: 200, kind: "exposed-ceiling", blockerAddr: 0x10,
      yBase: 10, yLow: 100, yHigh: 300,
    });
    const b = seg({
      z1: 200, kind: "exposed-ceiling", blockerAddr: 0x10,
      yBase: 0, yLow: 50, yHigh: 250,
    });
    const out = mergeSegments([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].yBase).toBe(0);
    expect(out[0].yLow).toBe(50);
    expect(out[0].yHigh).toBe(300);
  });
});

describe("findInvisibleWalls: full-region vertical extents", () => {
  // An upper floor over the same left-half footprint as the leaked ceiling.
  const upperDeck = (h: number): Surface[] => [
    makeSurface([-200, h, -200], [-200, h, 200], [0, h, 200], { address: 0xa00 })!,
    makeSurface([-200, h, -200], [0, h, 200], [0, h, -200], { address: 0xa30 })!,
  ];

  it("truncates the region at the first floor above the column", () => {
    // Classic sliver (ground + leaked ceiling at 100) plus a floor at 400 over
    // the same columns: from above it, find_floor resolves to that floor, so
    // the blocked region must stop there instead of running to the sky.
    const surfaces = [...ground(), ...leftCeiling(100), ...upperDeck(400)];
    const segments = probe(surfaces).segments.filter(
      (s) => s.kind === "exposed-ceiling",
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.yLow).toBeCloseTo(0, 3);
      expect(s.yHigh).toBeCloseTo(400, 3);
    }
  });

  it("emits two stacked regions for two ceilings in one column", () => {
    // Two-story wall column: ground everywhere; story-1 ceiling at 100 and
    // story-2 floor at 400 over the left half; a roof at 450 over the left
    // half; and an outdoor deck at 400 on the right half so a walkable
    // approach exists at the upper level. The column just left of x=0 has two
    // disjoint blocked ranges — [0, 400] under/above the story-1 ceiling, and
    // [400, sky] above the roof — each owned by its own blocking ceiling, so
    // they must arrive as separate segments and never fuse into one tall quad.
    const roof: Surface[] = [
      makeSurface([-200, 450, -200], [0, 450, 200], [-200, 450, 200], { address: 0xd00 })!,
      makeSurface([-200, 450, -200], [0, 450, -200], [0, 450, 200], { address: 0xd30 })!,
    ];
    const deck: Surface[] = [
      makeSurface([0, 400, -200], [0, 400, 200], [200, 400, 200], { address: 0xe00 })!,
      makeSurface([0, 400, -200], [200, 400, 200], [200, 400, -200], { address: 0xe30 })!,
    ];
    const surfaces = [
      ...ground(),
      ...leftCeiling(100),
      ...upperDeck(400),
      ...roof,
      ...deck,
    ];
    const segments = probe(surfaces).segments.filter(
      (s) => s.kind === "exposed-ceiling",
    );
    const lower = segments.filter((s) => [0x200, 0x230].includes(s.blockerAddr));
    const upper = segments.filter((s) => [0xd00, 0xd30].includes(s.blockerAddr));
    expect(lower.length).toBeGreaterThan(0);
    expect(upper.length).toBeGreaterThan(0);
    for (const s of lower) {
      expect(s.yLow).toBeCloseTo(0, 3);
      expect(s.yHigh).toBeCloseTo(400, 3);
    }
    for (const s of upper) {
      // Roof 450 within 160 of the story-2 floor 400 → pocket blocked too.
      expect(s.yLow).toBeCloseTo(400, 3);
      expect(s.yHigh).toBeGreaterThan(450); // open to the sky cap
    }
  });
});
