import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { SpatialPartition, deriveBoundary } from "./partition";
import { SURFACE_FLAG_DYNAMIC } from "./constants";
import type { Surface } from "./surface";

/** A flat floor quad at height y over [x0, x1] x [z0, z1]. */
const floorQuad = (
  x0: number, x1: number, z0: number, z1: number, y = 0, flags = 0,
): Surface[] => [
  makeSurface([x0, y, z0], [x0, y, z1], [x1, y, z1], { flags })!,
  makeSurface([x0, y, z0], [x1, y, z1], [x1, y, z0], { flags })!,
];

describe("deriveBoundary", () => {
  it("ignores object surfaces when the level has geometry of its own", () => {
    // A platform carried out past 8192 must not double the level's boundary
    // (and with it every cell border) for as long as it sits there.
    const level = floorQuad(-4000, 4000, -4000, 4000);
    const farObject = floorQuad(9000, 9500, 0, 500, 0, SURFACE_FLAG_DYNAMIC);
    expect(deriveBoundary(level)).toBe(0x2000);
    expect(deriveBoundary([...level, ...farObject])).toBe(0x2000);
  });

  it("falls back to object surfaces when there is no level geometry", () => {
    const farObject = floorQuad(9000, 9500, 0, 500, 0, SURFACE_FLAG_DYNAMIC);
    expect(deriveBoundary(farObject)).toBe(0x4000);
    expect(deriveBoundary([])).toBe(0x2000);
  });

  it("never exceeds what an s16 vertex can reach", () => {
    expect(deriveBoundary(floorQuad(-32768, 32767, -100, 100))).toBe(0x8000);
  });
});

describe("cell indexing past the vanilla boundary", () => {
  it("files positive coordinates in their own cells at boundary 0x8000", () => {
    // The game's cell-index helpers add the boundary in an s16. At 0x8000 that
    // wraps EVERY non-negative coordinate negative and clamps it into cell 0 —
    // so half the level was registered where no query ever looks, and the
    // probe saw nothing but void east and south of the origin.
    const surfaces = [
      ...floorQuad(4000, 6000, 4000, 6000, 100),
      ...floorQuad(-6000, -4000, -6000, -4000, 200),
      ...floorQuad(19000, 20000, 0, 1000, 300), // forces the 0x8000 boundary
    ];
    const p = new SpatialPartition(surfaces);
    expect(p.boundary).toBe(0x8000);
    expect(p.findFloor(5000, 500, 5000).height).toBe(100);
    expect(p.findFloor(-5000, 500, -5000).height).toBe(200);
    expect(p.findFloor(19500, 500, 500).height).toBe(300);
    // The fine grid agrees.
    const accel = new SpatialPartition(surfaces, { accel: true });
    expect(accel.findFloor(5000, 500, 5000).height).toBe(100);
    expect(accel.findFloor(19500, 500, 500).height).toBe(300);
  });

  it("handles a vertex on the boundary itself at 0x4000", () => {
    const surfaces = floorQuad(15000, 16384, 0, 1000, 50);
    const p = new SpatialPartition(surfaces);
    expect(p.boundary).toBe(0x4000);
    expect(p.findFloor(16000, 500, 500).height).toBe(50);
  });

  it("keeps the game's s16 wrap at the vanilla boundary", () => {
    // Faithful quirk: with LEVEL_BOUNDARY_MAX = 0x2000 a vertex past +24575
    // wraps negative in upper_cell_index, the max cell lands BELOW the min
    // cell, and the surface is registered nowhere.
    const surfaces = floorQuad(5000, 30000, 0, 1000, 50);
    const p = new SpatialPartition(surfaces, { boundary: 0x2000 });
    expect(p.findFloor(6000, 500, 500).surface).toBeNull();
    // Without the far vertex the same floor is found.
    const sane = new SpatialPartition(floorQuad(5000, 8000, 0, 1000, 50), {
      boundary: 0x2000,
    });
    expect(sane.findFloor(6000, 500, 500).height).toBe(50);
  });
});
