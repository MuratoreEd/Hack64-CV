import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { SpatialPartition, deriveBoundary } from "./partition";
import { VANILLA_LEVEL_BOUNDARY_MAX, SURFACE_INTANGIBLE } from "./constants";
import type { Surface } from "./surface";
import type { WallModel } from "./profile";

const floorAt = (h: number, opts = {}): Surface =>
  makeSurface([0, h, -100], [-100, h, 100], [100, h, 100], opts)!;

const wallX0 = (opts = {}): Surface =>
  makeSurface([0, 0, 100], [0, 0, -100], [0, 200, -100], opts)!;

describe("deriveBoundary", () => {
  it("defaults to vanilla for geometry that fits the vanilla box", () => {
    expect(deriveBoundary([floorAt(0)])).toBe(VANILLA_LEVEL_BOUNDARY_MAX);
  });

  it("grows to the next standard boundary for extended geometry", () => {
    const far = makeSurface([0, 0, -100], [-100, 0, 100], [10000, 0, 100], {})!;
    expect(deriveBoundary([far])).toBe(0x4000); // 16384
  });
});

describe("SpatialPartition queries", () => {
  it("returns the HIGHEST overlapping floor (cucking sort makes first = highest)", () => {
    const low = floorAt(0, { address: 0x1000 });
    const high = floorAt(200, { address: 0x2000 });
    // Pool order low-then-high; the partition should still sort high first.
    const p = new SpatialPartition([low, high]);
    const hit = p.findFloor(0, 300, 0);
    expect(hit.surface?.address).toBe(0x2000);
    expect(hit.height).toBeCloseTo(200, 5);
  });

  it("returns no floor outside the level boundary", () => {
    const p = new SpatialPartition([floorAt(0)]);
    expect(p.findFloor(9000, 100, 0).surface).toBeNull();
    expect(p.findFloor(0, 100, 9000).surface).toBeNull();
  });

  it("finds a wall in the same cell and reports it", () => {
    const p = new SpatialPartition([wallX0({ address: 0x30 })]);
    const wc = p.findWallCollisions(-30, 50, 0, 0, 50);
    expect(wc.walls.map((w) => w.address)).toContain(0x30);
  });

  it("exposes the derived boundary and cell size", () => {
    const p = new SpatialPartition([floorAt(0)]);
    expect(p.boundary).toBe(VANILLA_LEVEL_BOUNDARY_MAX);
    expect(p.cellSize).toBe(1024); // 2*8192 / 16
    expect(p.numCells).toBe(16);
  });
});

describe("cell list order (add_surface_to_cell)", () => {
  // The game's own algorithm, verbatim: insert before the first entry of
  // strictly lower priority. The partition sorts instead; they must agree.
  const insertLikeTheGame = (list: Surface[], s: Surface, sortDir: number) => {
    const p = s.vertices[0][1] * sortDir;
    let i = 0;
    while (i < list.length && !(p > list[i].vertices[0][1] * sortDir)) i++;
    list.splice(i, 0, s);
  };

  it("matches the game's insertion order, ties included", () => {
    let seed = 0xbadc0de;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const surfaces: Surface[] = [];
    for (let i = 0; i < 300; i++) {
      // Few distinct first-vertex heights, so priorities tie constantly.
      const y0 = Math.floor(rand() * 6) * 50;
      const up = rand() < 0.5;
      const s = up
        ? makeSurface([-50, y0, -50], [-50, y0 + 5, 50], [50, y0 + 3, 50], { address: i * 0x30 })
        : makeSurface([-50, y0, -50], [50, y0 + 3, 50], [-50, y0 + 5, 50], { address: i * 0x30 });
      if (s) surfaces.push(s);
    }
    const floors: Surface[] = [];
    const ceils: Surface[] = [];
    for (const s of surfaces) {
      if (s.kind === "floor") insertLikeTheGame(floors, s, 1);
      else if (s.kind === "ceiling") insertLikeTheGame(ceils, s, -1);
    }
    const p = new SpatialPartition(surfaces);
    const f = p.floorsAt(0, 0).map((h) => h.surface.address);
    expect(f).toEqual(floors.map((s) => s.address));
    expect(floors.length).toBeGreaterThan(50);
    expect(ceils.length).toBeGreaterThan(50);
    // Ceilings have no floorsAt twin: compare via "first" hits from above each
    // candidate's own height, which walks the list in order.
    const order: number[] = [];
    const remaining = new Set(ceils.map((s) => s.address));
    // With identical footprints, find_ceil "first" returns the first ceiling
    // in list order whose plane is within 78 below the query — query far below
    // so every ceiling qualifies, then remove it and repeat.
    while (remaining.size > 0) {
      const live = ceils.filter((s) => remaining.has(s.address));
      const hit = new SpatialPartition(live).findCeil(0, -10000, 0).surface!;
      order.push(hit.address);
      remaining.delete(hit.address);
    }
    expect(order).toEqual(ceils.map((s) => s.address));
  });
});

describe("SURFACE_INTANGIBLE (find_floor falls through)", () => {
  const at = (h: number, type = 0, address = 0) =>
    makeSurface([0, h, -100], [-100, h, 100], [100, h, 100], { type, address })!;

  it("re-queries from 200 below an intangible floor", () => {
    const p = new SpatialPartition([
      at(500, SURFACE_INTANGIBLE, 0x10),
      at(250, 0, 0x20), // within (500-200)+78: found by the re-query
      at(0, 0, 0x30),
    ]);
    const hit = p.findFloor(0, 600, 0);
    expect(hit.surface?.address).toBe(0x20);
    expect(hit.height).toBeCloseTo(250, 3);
  });

  it("keeps the intangible floor's height with a NULL floor when nothing is below", () => {
    // The decomp's "BBH crash" quirk: find_floor_from_list only writes the
    // height on a hit, so a failed re-query leaves the intangible height.
    const p = new SpatialPartition([at(500, SURFACE_INTANGIBLE, 0x10)]);
    const hit = p.findFloor(0, 600, 0);
    expect(hit.surface).toBeNull();
    expect(hit.height).toBeCloseTo(500, 3);
  });

  it("a dynamic floor must beat the intangible height, not -11000", () => {
    const dyn = { ...at(400, 0, 0x40), flags: 1 }; // SURFACE_FLAG_DYNAMIC
    const p = new SpatialPartition([at(500, SURFACE_INTANGIBLE, 0x10), dyn]);
    // 400 < 500: the dynamic floor loses to the (NULL, 500) static result.
    expect(p.findFloor(0, 600, 0).surface).toBeNull();
  });
});

describe("fine-grid accel", () => {
  // Deterministic PRNG so failures reproduce.
  const rng = (seed: number) => (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  it("returns results identical to the plain partition under fuzz", () => {
    const rand = rng(0xc0ffee);
    const surfaces: Surface[] = [];
    // A pile of random triangles: mixed floors/walls/ceilings, varied sizes,
    // some crossing cell borders, some poking past the boundary.
    for (let i = 0; i < 400; i++) {
      const cx = (rand() * 2 - 1) * 9000;
      const cz = (rand() * 2 - 1) * 9000;
      const cy = (rand() * 2 - 1) * 2000;
      const size = 20 + rand() * 900;
      const v = (): [number, number, number] => [
        Math.round(cx + (rand() * 2 - 1) * size),
        Math.round(cy + (rand() * 2 - 1) * size),
        Math.round(cz + (rand() * 2 - 1) * size),
      ];
      const s = makeSurface(v(), v(), v(), { address: 0x1000 + i * 0x30 });
      if (s) surfaces.push(s);
    }
    const plain = new SpatialPartition(surfaces);
    const accel = new SpatialPartition(surfaces, { accel: true });

    for (let i = 0; i < 4000; i++) {
      const x = (rand() * 2 - 1) * 8500;
      const y = (rand() * 2 - 1) * 3000;
      const z = (rand() * 2 - 1) * 8500;

      const f0 = plain.findFloor(x, y, z);
      const f1 = accel.findFloor(x, y, z);
      expect(f1.height).toBe(f0.height);
      expect(f1.surface?.address).toBe(f0.surface?.address);

      const c0 = plain.findCeil(x, y, z);
      const c1 = accel.findCeil(x, y, z);
      expect(c1.height).toBe(c0.height);
      expect(c1.surface?.address).toBe(c0.surface?.address);

      const r = rand() * 200;
      const w0 = plain.findWallCollisions(x, y, z, 30, r);
      const w1 = accel.findWallCollisions(x, y, z, 30, r);
      expect(w1.x).toBe(w0.x);
      expect(w1.z).toBe(w0.z);
      expect(w1.numWalls).toBe(w0.numWalls);
      expect(w1.walls.map((s) => s.address)).toEqual(
        w0.walls.map((s) => s.address),
      );

      const l0 = plain.floorsAt(x, z).map((f) => f.surface.address);
      const l1 = accel.floorsAt(x, z).map((f) => f.surface.address);
      expect(l1).toEqual(l0);
    }
  });

  // The random-triangle fuzz above is nearly silent on walls: random vertices
  // almost never land within ±0.01 of vertical (4 walls in 400 surfaces). This
  // one builds nothing BUT walls, at every orientation, and aims its queries at
  // them — it catches the 45° case a radius-only inflation missed.
  const wallField = (seed: number, count: number) => {
    const rand = rng(seed);
    const walls: Surface[] = [];
    for (let i = 0; i < count; i++) {
      const x0 = Math.round((rand() * 2 - 1) * 3000);
      const z0 = Math.round((rand() * 2 - 1) * 3000);
      const y0 = Math.round((rand() * 2 - 1) * 500);
      const theta = rand() * Math.PI * 2;
      const len = 20 + rand() * 400;
      const h = 30 + rand() * 300;
      const b: [number, number, number] = [
        Math.round(x0 + Math.cos(theta) * len), y0, Math.round(z0 + Math.sin(theta) * len),
      ];
      const c: [number, number, number] = [x0, Math.round(y0 + h), z0];
      const a: [number, number, number] = [x0, y0, z0];
      const s = rand() < 0.5
        ? makeSurface(a, b, c, { address: 0x8000 + i * 0x30 })
        : makeSurface(a, c, b, { address: 0x8000 + i * 0x30 });
      if (s && s.kind === "wall") walls.push(s);
    }
    return { walls, rand };
  };

  for (const model of ["vanilla", "frame"] as WallModel[]) {
    it(`${model} walls: the fine grid matches plain on a wall-heavy fuzz`, () => {
      const { walls, rand } = wallField(model === "vanilla" ? 0x3a11 : 0x3a12, 600);
      expect(walls.length).toBeGreaterThan(500);
      for (const reach of [12.5, 50]) {
        const plain = new SpatialPartition(walls, { walls: model, edgeMargin: 0.25 });
        const accel = new SpatialPartition(walls, {
          walls: model, edgeMargin: 0.25, accel: true, wallReach: reach,
        });
        let engaged = 0;
        for (let i = 0; i < 20000; i++) {
          // Aim at a wall, mostly just past one of its ENDS: that is where an
          // axis-projected test reaches furthest outside the bbox (√2·radius
          // for a 45° wall), and so where an under-inflated bin goes wrong.
          const w = walls[Math.floor(rand() * walls.length)];
          const [a, b] = w.vertices;
          const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
          const near = ((rand() * 2 - 1) * reach * 1.5) / len; // either side of an end
          const u = rand();
          const t = u < 0.4 ? near : u < 0.8 ? 1 + near : rand();
          // Step off the wall along its normal, or along a bare axis — the
          // vanilla test's reach is longest along its PROJECTION axis.
          const off = (rand() * 2 - 1) * reach * 1.6;
          const k = rand();
          const ox = k < 0.4 ? w.normal.x * off : k < 0.7 ? off : 0;
          const oz = k < 0.4 ? w.normal.z * off : k < 0.7 ? 0 : off;
          const x = a[0] + (b[0] - a[0]) * t + ox;
          const z = a[2] + (b[2] - a[2]) * t + oz;
          const y = Math.min(a[1], b[1]) + rand() * 200 - 60;
          // Mostly near the max radius: below ~0.71·reach even a radius-only
          // inflation is wide enough, so small radii prove little.
          const r = reach * (rand() < 0.7 ? 0.9 + 0.1 * rand() : rand());
          const w0 = plain.findWallCollisions(x, y, z, 60, r);
          const w1 = accel.findWallCollisions(x, y, z, 60, r);
          if (w0.x !== x || w0.z !== z) engaged++;
          expect(w1.x).toBe(w0.x);
          expect(w1.z).toBe(w0.z);
          expect(w1.walls.map((s) => s.address)).toEqual(w0.walls.map((s) => s.address));
        }
        expect(engaged).toBeGreaterThan(500); // the fuzz actually pushes
      }
    });
  }

  it("frame walls: chained pushes in a dense cluster still match plain", () => {
    // Frame's pushes accumulate, so the point travels mid-scan — possibly out
    // of the bin it started in. A tight cluster of walls straddling fine-bin
    // borders (x = 0 and x = ±128 are borders) makes pushes chain.
    const rand = rng(0xc1057e);
    const walls: Surface[] = [];
    for (let i = 0; i < 400; i++) {
      const x0 = Math.round((rand() * 2 - 1) * 160);
      const z0 = Math.round((rand() * 2 - 1) * 160);
      const theta = rand() * Math.PI * 2;
      const len = 8 + rand() * 40;
      const a: [number, number, number] = [x0, 0, z0];
      const b: [number, number, number] = [
        Math.round(x0 + Math.cos(theta) * len), 0, Math.round(z0 + Math.sin(theta) * len),
      ];
      const c: [number, number, number] = [x0, 200, z0];
      const s = rand() < 0.5
        ? makeSurface(a, b, c, { address: 0x20000 + i * 0x30 })
        : makeSurface(a, c, b, { address: 0x20000 + i * 0x30 });
      if (s && s.kind === "wall") walls.push(s);
    }
    const plain = new SpatialPartition(walls, { walls: "frame", edgeMargin: 0.25 });
    const accel = new SpatialPartition(walls, {
      walls: "frame", edgeMargin: 0.25, accel: true, wallReach: 12.5,
    });
    let chained = 0;
    for (let i = 0; i < 20000; i++) {
      const x = (rand() * 2 - 1) * 170;
      const z = (rand() * 2 - 1) * 170;
      const w0 = plain.findWallCollisions(x, 20, z, 30, 12.5);
      const w1 = accel.findWallCollisions(x, 20, z, 30, 12.5);
      if (w0.numWalls >= 2) chained++;
      expect(w1.x).toBe(w0.x);
      expect(w1.z).toBe(w0.z);
      expect(w1.walls.map((s) => s.address)).toEqual(w0.walls.map((s) => s.address));
    }
    expect(chained).toBeGreaterThan(1000);
  });

  it("frame walls: a push chain that leaves the starting bin falls back to the full list", () => {
    // A staircase of +x-facing walls 10 apart. Frame re-tests every wall from
    // the pushed position, so a point at x=127 walks 125→135→…→165, crossing
    // the fine-bin border at x=128 — walls past it aren't in the start bin.
    const stair = [125, 135, 145, 155, 165].map((c, i) =>
      makeSurface([c, 0, -100], [c, 200, 100], [c, 0, 100], { address: 0x30000 + i * 0x30 })!,
    );
    const plain = new SpatialPartition(stair, { walls: "frame" });
    const accel = new SpatialPartition(stair, { walls: "frame", accel: true, wallReach: 12.5 });
    const a = plain.findWallCollisions(127, 0, 0, 60, 12.5);
    const b = accel.findWallCollisions(127, 0, 0, 60, 12.5);
    expect(a.x).toBeCloseTo(177.5, 6); // every step pushes to 12.5 in front
    expect(b.x).toBe(a.x);
    expect(b.walls.map((s) => s.address)).toEqual(a.walls.map((s) => s.address));
  });

  it("regression: a 45° wall past its bbox + radius still pushes in the fine grid", () => {
    // Wall on x + z = 112 (normal ±(√½, 0, √½), x-projected). A point 16 units
    // past its max-x in front of it engages at radius 12.5 — √2·12.5 = 17.7 of
    // reach along x — and a fine-bin border (x = 128) sits in between.
    const w = makeSurface([112, 0, 0], [12, 0, 100], [112, 200, 0], { address: 0x40 })!;
    const w2 = makeSurface([12, 0, 100], [12, 200, 100], [112, 200, 0], { address: 0x70 })!;
    const plain = new SpatialPartition([w, w2]);
    const accel = new SpatialPartition([w, w2], { accel: true, wallReach: 12.5 });
    const a = plain.findWallCollisions(128, 0, 0.5, 60, 12.5);
    const b = accel.findWallCollisions(128, 0, 0.5, 60, 12.5);
    expect(a.numWalls).toBe(1);
    expect(b.x).toBe(a.x);
    expect(b.numWalls).toBe(1);
  });

  it("a reduced wallReach matches plain for radii within it, and falls back beyond", () => {
    // The probe shrinks wall inflation to its own push radius, which is what
    // makes wall bins small enough to be fast. That is only sound if queries
    // within the reach are unchanged and wider ones bypass the fine grid.
    const rand = rng(0x5eed);
    const surfaces: Surface[] = [];
    for (let i = 0; i < 400; i++) {
      const cx = (rand() * 2 - 1) * 9000;
      const cz = (rand() * 2 - 1) * 9000;
      const cy = (rand() * 2 - 1) * 2000;
      const size = 20 + rand() * 900;
      const v = (): [number, number, number] => [
        Math.round(cx + (rand() * 2 - 1) * size),
        Math.round(cy + (rand() * 2 - 1) * size),
        Math.round(cz + (rand() * 2 - 1) * size),
      ];
      const s = makeSurface(v(), v(), v(), { address: 0x1000 + i * 0x30 });
      if (s) surfaces.push(s);
    }
    const plain = new SpatialPartition(surfaces);
    const REACH = 12.5; // the probe's radius on a 4× hack
    const tight = new SpatialPartition(surfaces, { accel: true, wallReach: REACH });
    expect(tight.wallReach).toBe(REACH);

    for (let i = 0; i < 4000; i++) {
      const x = (rand() * 2 - 1) * 8500;
      const y = (rand() * 2 - 1) * 3000;
      const z = (rand() * 2 - 1) * 8500;
      // Mix radii on both sides of the reach: within it the fine grid is used,
      // beyond it the query must fall back to the full cell list.
      const r = i % 2 === 0 ? rand() * REACH : REACH + rand() * 190;
      const w0 = plain.findWallCollisions(x, y, z, 30, r);
      const w1 = tight.findWallCollisions(x, y, z, 30, r);
      expect(w1.x).toBe(w0.x);
      expect(w1.z).toBe(w0.z);
      expect(w1.numWalls).toBe(w0.numWalls);
      expect(w1.walls.map((s) => s.address)).toEqual(
        w0.walls.map((s) => s.address),
      );
    }
  });
});
