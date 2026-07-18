import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { SpatialPartition, deriveBoundary } from "./partition";
import { VANILLA_LEVEL_BOUNDARY_MAX } from "./constants";
import type { Surface } from "./surface";

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
});
