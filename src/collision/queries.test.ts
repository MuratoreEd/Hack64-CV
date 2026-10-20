import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import {
  toS16,
  findFloorFromList,
  findCeilFromList,
  findWallCollisionsFromList,
  findWallCollisionsFromListFrame,
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

describe("floor/ceiling selection rule (CollisionProfile.select)", () => {
  // Cell order is the caller's (the partition sorts by vertex1[1] desc). Here
  // the LOWER floor is listed first, as happens when its first vertex outranks
  // the other's — the decomp's own "surface cucking" comment.
  const low = floorAt(100, { address: 0x1 });
  const high = floorAt(200, { address: 0x2 });

  it("'first' takes the first hit in list order, shadowing the higher floor", () => {
    const hit = findFloorFromList([low, high], 0, 300, 0, "first");
    expect(hit.surface?.address).toBe(0x1);
    expect(hit.height).toBe(100);
  });

  it("'extreme' takes the highest floor regardless of order", () => {
    for (const list of [[low, high], [high, low]]) {
      const hit = findFloorFromList(list, 0, 300, 0, "extreme");
      expect(hit.surface?.address).toBe(0x2);
      expect(hit.height).toBe(200);
    }
  });

  it("'extreme' still honors the 78-unit buffer", () => {
    // The high floor sits 100 above the query point — beyond the buffer — so
    // even "extreme" must fall back to the reachable one.
    const hit = findFloorFromList([low, high], 0, 100, 0, "extreme");
    expect(hit.surface?.address).toBe(0x1);
  });

  it("'extreme' takes the LOWEST ceiling (the mirror case)", () => {
    const lowC = ceilAt(200, { address: 0x3 });
    const highC = ceilAt(400, { address: 0x4 });
    expect(findCeilFromList([highC, lowC], 0, 50, 0, "first").surface?.address).toBe(0x4);
    expect(findCeilFromList([highC, lowC], 0, 50, 0, "extreme").surface?.address).toBe(0x3);
  });

  it("defaults to vanilla 'first' when no rule is given", () => {
    expect(findFloorFromList([low, high], 0, 300, 0).surface?.address).toBe(0x1);
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

  it("over-pushes through duplicated geometry (the Wall Overlaps quirk)", () => {
    // Both copies test the ORIGINAL position (offset 30) and both push 20.
    const d = data({ x: 30 });
    findWallCollisionsFromList([wallX0({ address: 1 }), wallX0({ address: 2 })], d);
    expect(d.x).toBeCloseTo(70, 5);
  });
});

describe("findWallCollisionsFromListFrame (Frame's patch)", () => {
  // Quad-half on the plane x=0 facing +x, spanning z ∈ [-100, 100], y ∈ [0, 200];
  // its B→C edge is vertical at z = 100.
  const frontWall = (address = 0): Surface =>
    makeSurface([0, 0, -100], [0, 200, 100], [0, 0, 100], { address })!;
  const data = (over: Partial<WallCollisionData> = {}): WallCollisionData => ({
    x: 30, y: 40, z: 0, offsetY: 60, radius: 50, walls: [], numWalls: 0, ...over,
  });

  it("precondition: the fixture faces +x", () => {
    expect(frontWall().normal.x).toBeCloseTo(1, 6);
  });

  it("pushes a point in front of the face out to the radius", () => {
    const d = data();
    expect(findWallCollisionsFromListFrame([frontWall(0x30)], d)).toBe(1);
    expect(d.x).toBeCloseTo(50, 5);
    expect(d.walls.map((w) => w.address)).toEqual([0x30]);
  });

  it("ignores the back side entirely (vanilla would shove the point through)", () => {
    const d = data({ x: -30 });
    expect(findWallCollisionsFromListFrame([frontWall()], d)).toBe(0);
    expect(d.x).toBe(-30);
    expect(d.numWalls).toBe(0);
    // Same point, vanilla: pushed forward through the plane to +50.
    const v = data({ x: -30 });
    findWallCollisionsFromList([frontWall()], v);
    expect(v.x).toBeCloseTo(50, 5);
  });

  it("accumulates pushes: duplicated geometry no longer over-pushes", () => {
    const d = data({ x: 30 });
    findWallCollisionsFromListFrame([frontWall(1), frontWall(2)], d);
    // The first copy pushes to 50; the second sees offset 50 = radius → +0.
    expect(d.x).toBeCloseTo(50, 5);
    expect(d.numWalls).toBe(2);
  });

  it("pushes radially off a vertical edge, recording only a push along the normal", () => {
    // Beside the wall's end (z > 100) at test height 100: nearest edge point is
    // (0, 100) on the vertical B→C edge. Margin = radius - 1 = 49.
    const d = data({ x: 5, z: 105 });
    expect(findWallCollisionsFromListFrame([frontWall(0x40)], d)).toBe(1);
    expect(Math.hypot(d.x - 0, d.z - 100)).toBeCloseTo(49, 4);
    expect(d.x).toBeCloseTo(34.648, 2);
    // Pushed diagonally (45° off the normal): not "touching" the wall.
    expect(d.numWalls).toBe(0);

    // Almost straight in front of the edge: the push runs along the normal.
    const e = data({ x: 5, z: 100.5 });
    findWallCollisionsFromListFrame([frontWall(0x40)], e);
    expect(Math.hypot(e.x, e.z - 100)).toBeCloseTo(49, 4);
    expect(e.walls.map((w) => w.address)).toEqual([0x40]);
  });

  it("takes the edge margin from the radius BEFORE the 200 clamp", () => {
    // Radius 250: face pushes clamp to 200, edges keep 250 - 1 = 249.
    const d = data({ x: 150, z: 250, radius: 250 });
    findWallCollisionsFromListFrame([frontWall()], d);
    expect(Math.hypot(d.x, d.z - 100)).toBeCloseTo(249, 3);
  });

  it("scales the edge margin (extended-boundary ROMs pass 1/scale)", () => {
    const d = data({ x: 1, z: 100.1, radius: 12.5 });
    findWallCollisionsFromListFrame([frontWall()], d, 0.25);
    expect(Math.hypot(d.x, d.z - 100)).toBeCloseTo(12.25, 4);
  });

  it("stays finite on integer columns around integer vertices", () => {
    // The probe tests integer columns against integer vertices — exactly the
    // inputs that sit on edges and vertices. (A point exactly on an edge is
    // caught by the face test first; the 0/0 guard in edgePush only matters
    // when rounding makes the face test miss it.)
    const walls = [frontWall(1), makeSurface([0, 0, 100], [0, 200, 100], [40, 0, 140])!];
    for (let x = -3; x <= 60; x++) {
      for (let z = 90; z <= 150; z++) {
        const d = data({ x, z, y: 40 });
        findWallCollisionsFromListFrame(walls, d);
        expect(Number.isFinite(d.x) && Number.isFinite(d.z)).toBe(true);
      }
    }
  });
});
