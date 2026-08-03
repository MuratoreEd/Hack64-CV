import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { parseSurfacePool } from "./surface";
import { encodeSurfacePool } from "./surfaceEncode";
import { SURFACE_STRUCT_SIZE } from "./constants";

const scene = () =>
  [
    makeSurface([-200, 0, -200], [-200, 0, 200], [200, 0, 200], { address: 0 })!,
    makeSurface([-200, 100, -200], [0, 100, 200], [-200, 100, 200], {
      address: 0,
      type: 0x0e,
      room: 2,
      force: -3,
    })!,
    makeSurface([0, 0, -200], [0, 200, 200], [0, 0, 200], { address: 0 })!,
  ].map((s, index) => ({ ...s, index }));

describe("encodeSurfacePool", () => {
  it("writes 0x30 bytes per surface", () => {
    expect(encodeSurfacePool(scene()).byteLength).toBe(3 * SURFACE_STRUCT_SIZE);
  });

  it("round-trips through the parser", () => {
    const base = 0x8038ee9c;
    const original = scene();
    const parsed = parseSurfacePool(encodeSurfacePool(original), original.length, {
      baseAddress: base,
    });

    expect(parsed).toHaveLength(original.length);
    parsed.forEach((p, i) => {
      const s = original[i];
      expect(p.address).toBe(base + i * SURFACE_STRUCT_SIZE);
      expect(p.type).toBe(s.type);
      expect(p.force).toBe(s.force);
      expect(p.flags).toBe(s.flags);
      expect(p.room).toBe(s.room);
      expect(p.lowerY).toBe(s.lowerY);
      expect(p.upperY).toBe(s.upperY);
      expect(p.vertices).toEqual(s.vertices);
      expect(p.normal.x).toBeCloseTo(s.normal.x, 6);
      expect(p.normal.y).toBeCloseTo(s.normal.y, 6);
      expect(p.normal.z).toBeCloseTo(s.normal.z, 6);
      expect(p.originOffset).toBeCloseTo(s.originOffset, 3);
      expect(p.object).toBe(s.object);
      // Derived, not stored — must come out the same anyway.
      expect(p.kind).toBe(s.kind);
      expect(p.xProjection).toBe(s.xProjection);
    });
  });

  it("survives the float32 narrowing that the game's own pool imposes", () => {
    // Normals are f32 in RAM; a fixture built from f64 math must still parse to
    // a plane the queries agree with, or corpus replays would drift.
    const [floor] = scene();
    const [parsed] = parseSurfacePool(encodeSurfacePool([floor]), 1);
    expect(Math.hypot(parsed.normal.x, parsed.normal.y, parsed.normal.z)).toBeCloseTo(1, 5);
  });
});
