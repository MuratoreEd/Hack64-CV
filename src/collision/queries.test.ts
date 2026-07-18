import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import {
  toS16,
  findFloorFromList,
  findCeilFromList,
  findWallCollisionsFromList,
  type WallCollisionData,
} from "./queries";
import { SURFACE_CAMERA_BOUNDARY, FLOOR_LOWER_LIMIT, CELL_HEIGHT_LIMIT } from "./constants";
import type { Surface } from "./surface";

// A flat +Y floor triangle at height h covering the origin in XZ. The winding
// matches the game's convention so find_floor_from_list accepts interior points.
const floorAt = (h: number, opts = {}): Surface =>
  makeSurface([0, h, -100], [-100, h, 100], [100, h, 100], opts)!;

// A flat -Y ceiling triangle at height h (floor winding reversed).
const ceilAt = (h: number, opts = {}): Surface =>
  makeSurface([0, h, -100], [100, h, 100], [-100, h, 100], opts)!;

// A vertical wall in the plane x=0 with +X normal (x-projection wall).
const wallX0 = (opts = {}): Surface =>
  makeSurface([0, 0, 100], [0, 0, -100], [0, 200, -100], opts)!;

describe("toS16", () => {
  it("truncates toward zero", () => {
    expect(toS16(100.9)).toBe(100);
    expect(toS16(-100.9)).toBe(-100);
  });
  it("wraps out-of-range values like a C s16 cast", () => {
    expect(toS16(40000)).toBe(-25536); // 40000 - 65536
    expect(toS16(65536)).toBe(0);
    expect(toS16(-1)).toBe(-1);
  });
});

describe("findFloorFromList", () => {
  it("finds a floor beneath the query point and returns its height", () => {
    const hit = findFloorFromList([floorAt(0)], 0, 100, 0);
    expect(hit.surface).not.toBeNull();
    expect(hit.height).toBeCloseTo(0, 5);
  });

  it("applies the 78-unit buffer (floor up to 78 above y still counts)", () => {
    expect(findFloorFromList([floorAt(0)], 0, -77, 0).surface).not.toBeNull();
    expect(findFloorFromList([floorAt(0)], 0, -79, 0).surface).toBeNull();
  });

  it("returns FIRST match in list order, not the highest (overlap bug)", () => {
    const low = floorAt(0, { address: 0x1000 });
    const high = floorAt(200, { address: 0x2000 });
    const hit = findFloorFromList([low, high], 0, 300, 0);
    expect(hit.surface?.address).toBe(0x1000);
  });

  it("misses when the point is outside the triangle", () => {
    const hit = findFloorFromList([floorAt(0)], 5000, 100, 5000);
    expect(hit.surface).toBeNull();
    expect(hit.height).toBe(FLOOR_LOWER_LIMIT);
  });

  it("ignores camera-boundary floors", () => {
    const cam = floorAt(0, { type: SURFACE_CAMERA_BOUNDARY });
    expect(findFloorFromList([cam], 0, 100, 0).surface).toBeNull();
  });
});

describe("findCeilFromList", () => {
  it("finds a ceiling above the query point", () => {
    const hit = findCeilFromList([ceilAt(200)], 0, 50, 0);
    expect(hit.surface).not.toBeNull();
    expect(hit.height).toBeCloseTo(200, 5);
  });

  it("applies the 78-unit buffer (ceiling up to 78 below y still counts)", () => {
    expect(findCeilFromList([ceilAt(0)], 0, 77, 0).surface).not.toBeNull();
    expect(findCeilFromList([ceilAt(0)], 0, 79, 0).surface).toBeNull();
  });

  it("returns the default limit when none found", () => {
    expect(findCeilFromList([], 0, 0, 0).height).toBe(CELL_HEIGHT_LIMIT);
  });
});

describe("findWallCollisionsFromList", () => {
  const data = (over: Partial<WallCollisionData> = {}): WallCollisionData => ({
    x: -30,
    y: 50,
    z: 0,
    offsetY: 0,
    radius: 50,
    walls: [],
    numWalls: 0,
    ...over,
  });

  it("pushes the position out to radius along the wall normal", () => {
    const d = data();
    const n = findWallCollisionsFromList([wallX0({ address: 0x30 })], d);
    expect(n).toBe(1);
    expect(d.walls.map((w) => w.address)).toEqual([0x30]);
    expect(d.x).toBeCloseTo(50, 5); // pushed from -30 to +radius on the normal side
    expect(d.z).toBeCloseTo(0, 5);
  });

  it("ignores walls beyond the radius", () => {
    const d = data({ x: -100 });
    expect(findWallCollisionsFromList([wallX0()], d)).toBe(0);
    expect(d.x).toBe(-100);
  });

  it("skips walls outside the lowerY/upperY band", () => {
    const d = data({ y: 5000 });
    expect(findWallCollisionsFromList([wallX0()], d)).toBe(0);
  });
});
