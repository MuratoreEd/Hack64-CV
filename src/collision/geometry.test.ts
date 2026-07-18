import { describe, it, expect } from "vitest";
import { computeSurfaceGeometry, makeSurface } from "./geometry";
import { SurfaceKind } from "./surface";
import { SURFACE_FLAG_X_PROJECTION } from "./constants";
import type { Vec3s } from "./surface";

describe("computeSurfaceGeometry", () => {
  it("computes an upward normal for a floor (with -5/+5 Y buffer)", () => {
    // CCW-from-above winding on the y=0 plane -> normal points +Y.
    const g = computeSurfaceGeometry([-2000, 0, 2000], [2000, 0, 2000], [2000, 0, -2000])!;
    expect(g).not.toBeNull();
    expect(g.normal.x).toBeCloseTo(0, 5);
    expect(g.normal.y).toBeCloseTo(1, 5);
    expect(g.normal.z).toBeCloseTo(0, 5);
    expect(g.lowerY).toBe(-5); // min(0,0,0) - 5
    expect(g.upperY).toBe(5); // max(0,0,0) + 5
  });

  it("satisfies the plane equation n·v + originOffset = 0 for each vertex", () => {
    const v1: Vec3s = [100, 40, -300];
    const v2: Vec3s = [900, 40, 200];
    const v3: Vec3s = [500, 900, 50];
    const g = computeSurfaceGeometry(v1, v2, v3)!;
    for (const v of [v1, v2, v3]) {
      const d = g.normal.x * v[0] + g.normal.y * v[1] + g.normal.z * v[2] + g.originOffset;
      expect(d).toBeCloseTo(0, 3);
    }
  });

  it("returns null for a degenerate (collinear) triangle", () => {
    expect(computeSurfaceGeometry([0, 0, 0], [100, 0, 0], [200, 0, 0])).toBeNull();
  });
});

describe("makeSurface", () => {
  it("classifies a vertical surface as a wall and sets the x-projection flag", () => {
    // A wall in the x=const plane faces along X -> |nx| ~ 1 > 0.707.
    const w = makeSurface([500, 0, -1000], [500, 0, 1000], [500, 2000, 1000])!;
    expect(w.kind).toBe(SurfaceKind.Wall);
    expect(w.xProjection).toBe(true);
    expect(w.flags & SURFACE_FLAG_X_PROJECTION).toBeTruthy();
  });

  it("classifies a wall facing along Z without the x-projection flag", () => {
    const w = makeSurface([-1000, 0, 500], [1000, 0, 500], [1000, 2000, 500])!;
    expect(w.kind).toBe(SurfaceKind.Wall);
    expect(w.xProjection).toBe(false);
  });

  it("classifies a downward-facing triangle as a ceiling", () => {
    const c = makeSurface([-2000, 3000, -2000], [2000, 3000, -2000], [2000, 3000, 2000])!;
    expect(c.kind).toBe(SurfaceKind.Ceiling);
  });
});
