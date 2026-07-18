import { describe, it, expect } from "vitest";
import {
  parseSurface,
  parseSurfacePool,
  classifyKind,
  deriveLevelBounds,
  SurfaceKind,
} from "./surface";
import {
  SURFACE_STRUCT_SIZE,
  SURFACE_OFFSETS,
  SURFACE_FLAG_X_PROJECTION,
  SURFACE_FLAG_DYNAMIC,
} from "./constants";

interface SurfaceSpec {
  type?: number;
  force?: number;
  flags?: number;
  room?: number;
  lowerY?: number;
  upperY?: number;
  v1?: [number, number, number];
  v2?: [number, number, number];
  v3?: [number, number, number];
  normal?: { x: number; y: number; z: number };
  originOffset?: number;
  object?: number;
}

// Encode a surface spec into 0x30 bytes at `off`, big-endian (canonical N64).
function encodeSurface(spec: SurfaceSpec, view: DataView, off = 0, le = false) {
  const o = SURFACE_OFFSETS;
  view.setInt16(off + o.type, spec.type ?? 0, le);
  view.setInt16(off + o.force, spec.force ?? 0, le);
  view.setUint8(off + o.flags, spec.flags ?? 0);
  view.setInt8(off + o.room, spec.room ?? 0);
  view.setInt16(off + o.lowerY, spec.lowerY ?? 0, le);
  view.setInt16(off + o.upperY, spec.upperY ?? 0, le);
  const writeVec = (base: number, v: [number, number, number]) => {
    view.setInt16(base, v[0], le);
    view.setInt16(base + 2, v[1], le);
    view.setInt16(base + 4, v[2], le);
  };
  writeVec(off + o.vertex1, spec.v1 ?? [0, 0, 0]);
  writeVec(off + o.vertex2, spec.v2 ?? [0, 0, 0]);
  writeVec(off + o.vertex3, spec.v3 ?? [0, 0, 0]);
  view.setFloat32(off + o.normalX, spec.normal?.x ?? 0, le);
  view.setFloat32(off + o.normalY, spec.normal?.y ?? 1, le);
  view.setFloat32(off + o.normalZ, spec.normal?.z ?? 0, le);
  view.setFloat32(off + o.originOffset, spec.originOffset ?? 0, le);
  view.setUint32(off + o.object, spec.object ?? 0, le);
}

function bufferFor(specs: SurfaceSpec[], le = false): ArrayBuffer {
  const buf = new ArrayBuffer(specs.length * SURFACE_STRUCT_SIZE);
  const view = new DataView(buf);
  specs.forEach((s, i) => encodeSurface(s, view, i * SURFACE_STRUCT_SIZE, le));
  return buf;
}

describe("classifyKind", () => {
  it("classifies clear floors, ceilings, and walls", () => {
    expect(classifyKind(1)).toBe(SurfaceKind.Floor);
    expect(classifyKind(-1)).toBe(SurfaceKind.Ceiling);
    expect(classifyKind(0)).toBe(SurfaceKind.Wall);
  });

  it("uses strict > 0.01 / < -0.01 thresholds (boundary is a wall)", () => {
    // Exactly at the threshold is NOT past it -> wall.
    expect(classifyKind(0.01)).toBe(SurfaceKind.Wall);
    expect(classifyKind(-0.01)).toBe(SurfaceKind.Wall);
    // Just past the threshold flips the classification.
    expect(classifyKind(0.0100001)).toBe(SurfaceKind.Floor);
    expect(classifyKind(-0.0100001)).toBe(SurfaceKind.Ceiling);
  });
});

describe("parseSurface", () => {
  it("round-trips all fields from big-endian bytes", () => {
    const buf = bufferFor([
      {
        type: 1234,
        force: -5,
        flags: SURFACE_FLAG_DYNAMIC,
        room: 3,
        lowerY: -100,
        upperY: 250,
        v1: [10, -20, 30],
        v2: [-4000, 0, 4000],
        v3: [1, 2, 3],
        normal: { x: 0.25, y: 0.75, z: -0.5 },
        originOffset: 42.5,
        object: 0x80361160,
      },
    ]);
    const s = parseSurface(new DataView(buf), 0, 0, { baseAddress: 0x8038be00 });

    expect(s.type).toBe(1234);
    expect(s.force).toBe(-5);
    expect(s.flags).toBe(SURFACE_FLAG_DYNAMIC);
    expect(s.room).toBe(3);
    expect(s.lowerY).toBe(-100);
    expect(s.upperY).toBe(250);
    expect(s.vertices[0]).toEqual([10, -20, 30]);
    expect(s.vertices[1]).toEqual([-4000, 0, 4000]);
    expect(s.vertices[2]).toEqual([1, 2, 3]);
    expect(s.normal.x).toBeCloseTo(0.25, 6);
    expect(s.normal.y).toBeCloseTo(0.75, 6);
    expect(s.normal.z).toBeCloseTo(-0.5, 6);
    expect(s.originOffset).toBeCloseTo(42.5, 4);
    expect(s.object >>> 0).toBe(0x80361160);
    expect(s.kind).toBe(SurfaceKind.Floor); // ny = 0.75
    expect(s.address).toBe(0x8038be00);
  });

  it("detects the wall x-projection flag", () => {
    const buf = bufferFor([
      { flags: SURFACE_FLAG_X_PROJECTION, normal: { x: 1, y: 0, z: 0 } },
    ]);
    const s = parseSurface(new DataView(buf), 0, 0);
    expect(s.kind).toBe(SurfaceKind.Wall);
    expect(s.xProjection).toBe(true);
  });
});

describe("parseSurfacePool", () => {
  it("parses multiple surfaces and assigns exact addresses", () => {
    const base = 0x8038be00;
    const buf = bufferFor([
      { normal: { x: 0, y: 1, z: 0 } }, // floor
      { normal: { x: 0, y: -1, z: 0 } }, // ceiling
      { normal: { x: 0, y: 0, z: 1 } }, // wall
    ]);
    const surfaces = parseSurfacePool(buf, 3, { baseAddress: base });

    expect(surfaces).toHaveLength(3);
    expect(surfaces.map((s) => s.kind)).toEqual([
      SurfaceKind.Floor,
      SurfaceKind.Ceiling,
      SurfaceKind.Wall,
    ]);
    expect(surfaces[0].address).toBe(base);
    expect(surfaces[1].address).toBe(base + SURFACE_STRUCT_SIZE);
    expect(surfaces[2].address).toBe(base + 2 * SURFACE_STRUCT_SIZE);
  });

  it("throws when the buffer is too small for the surface count", () => {
    const buf = bufferFor([{}]); // room for 1
    expect(() => parseSurfacePool(buf, 2)).toThrow(/too small/);
  });
});

describe("deriveLevelBounds", () => {
  it("computes the world AABB across all surface vertices", () => {
    const buf = bufferFor([
      { v1: [-8000, -500, 100], v2: [200, 900, -3000], v3: [0, 0, 0] },
      { v1: [9000, 10, 5000], v2: [-1, -1, -1], v3: [50, -900, 50] },
    ]);
    const surfaces = parseSurfacePool(buf, 2);
    const b = deriveLevelBounds(surfaces);

    expect(b.minX).toBe(-8000);
    expect(b.maxX).toBe(9000);
    expect(b.minY).toBe(-900);
    expect(b.maxY).toBe(900);
    expect(b.minZ).toBe(-3000);
    expect(b.maxZ).toBe(5000);
  });
});
