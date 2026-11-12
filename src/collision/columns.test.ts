import { describe, it, expect } from "vitest";
import {
  collisionColumn,
  columnSpan,
  toS16,
  worldToCollision,
} from "./queries";
import { makeSurface } from "./geometry";
import { detectWorldScale } from "./oracle";
import type { StateMessage } from "../net/protocol";

describe("collisionColumn (how the engine files a fractional position)", () => {
  it("is plain truncation at scale 1", () => {
    for (const c of [0, 0.9, -0.9, 100.37, -100.37, -50.5, 50.5]) {
      expect(collisionColumn(c, 1)).toBe(Math.trunc(c) + 0); // + 0: no -0
    }
  });

  it("leaves integer columns alone at every scale", () => {
    for (const scale of [1, 2, 4, 8]) {
      for (const c of [-8000, -51, -1, 0, 1, 51, 8000]) {
        expect(collisionColumn(c, scale)).toBe(c);
      }
    }
  });

  it("truncates the WORLD position, then floor-divides (negative side of a 4x hack)", () => {
    // Collision -50.5 is world -202: (s16) -202, >> 2 = -51. Truncating the
    // collision value itself says -50 — the neighbouring column.
    expect(collisionColumn(-50.5, 4)).toBe(-51);
    expect(Math.trunc(-50.5)).toBe(-50);
    // ...but not every fraction moves: world -400.4 truncates to -400 = -100.
    expect(collisionColumn(-100.1, 4)).toBe(-100);
    // Positive coordinates agree with truncation.
    expect(collisionColumn(50.5, 4)).toBe(50);
  });

  it("agrees with the oracle's world conversion", () => {
    for (const scale of [1, 2, 4, 8]) {
      for (let w = -3000; w <= 3000; w += 7.3) {
        expect(collisionColumn(w / scale, scale)).toBe(worldToCollision(w, scale));
      }
    }
  });

  it("worldToCollision wraps like the game's s16 cast", () => {
    expect(worldToCollision(40000, 1)).toBe(toS16(40000));
    expect(worldToCollision(-7, 4)).toBe(-2); // floor, not trunc
  });
});

describe("columnSpan (where a column physically is)", () => {
  it("matches truncation toward zero at scale 1", () => {
    expect(columnSpan(5, 1)).toEqual([5, 6]);
    expect(columnSpan(-5, 1)).toEqual([-6, -5]);
    expect(columnSpan(0, 1)).toEqual([-1, 1]); // (-1, 1) all truncate to 0
  });

  it("is the inverse of collisionColumn", () => {
    for (const scale of [1, 2, 4, 8]) {
      for (let c = -40; c <= 40; c++) {
        const [lo, hi] = columnSpan(c, scale);
        expect(hi).toBeGreaterThan(lo);
        // Strictly inside the span lands in the column...
        for (const t of [0.01, 0.25, 0.5, 0.75, 0.99]) {
          expect(collisionColumn(lo + (hi - lo) * t, scale)).toBe(c);
        }
        // ...and just outside it does not.
        expect(collisionColumn(lo - 0.01, scale)).not.toBe(c);
        expect(collisionColumn(hi + 0.01, scale)).not.toBe(c);
      }
    }
  });

  it("tiles the axis: neighbouring spans meet exactly", () => {
    for (const scale of [1, 4]) {
      for (let c = -20; c < 20; c++) {
        expect(columnSpan(c, scale)[1]).toBe(columnSpan(c + 1, scale)[0]);
      }
    }
  });
});

describe("detectWorldScale on flat ground at y = 0 (footprint tie-break)", () => {
  // Seen live: level 24's ground is a y = 0 plane, where 0 x any scale is 0,
  // so height alone never decided the scale and a fresh session probed at 1x.
  const flat = makeSurface([1000, 0, -1500], [1000, 0, -500], [2000, 0, -500], {
    address: 0x5300,
  })!;
  const at = (x: number, z: number): StateMessage => ({
    type: "state",
    level: 24,
    area: 1,
    pos: { x, y: 1011, z },
    floorAddr: 0x5300,
    ceilAddr: 0,
    wallAddr: 0,
    floorHeight: 0,
    ceilHeight: 20000,
    surfaceCount: 1,
  });

  it("picks the one scale whose column is inside the reported floor", () => {
    // Collision column (1250, -1000) is inside the triangle; Mario's world
    // position on a 4x hack is 4x that.
    expect(detectWorldScale([flat], at(5000, -4000))).toBe(4);
    expect(detectWorldScale([flat], at(1250, -1000))).toBe(1);
    expect(detectWorldScale([flat], at(2500, -2000))).toBe(2);
  });

  it("stays silent when no candidate column is inside (pointer/position skew)", () => {
    expect(detectWorldScale([flat], at(100, 100))).toBeNull();
  });

  it("stays silent when several candidates are inside the floor", () => {
    // A triangle around the origin contains the column at every scale.
    const origin = makeSurface([-500, 0, -500], [-500, 0, 2000], [2000, 0, -500], {
      address: 0x5300,
    })!;
    expect(detectWorldScale([origin], at(40, 40))).toBeNull();
  });

  it("does not let a near-tie in height pick the wrong scale", () => {
    // A barely tilted floor through the origin: every scale reproduces the
    // height to a fraction of a unit, the true one only marginally better.
    // The old rule took the smallest error however slim the lead.
    const tilted = makeSurface([1000, 1, -1500], [1000, 1, -500], [2000, 2, -500], {
      address: 0x5300,
    })!;
    const s = at(5001, -4000);
    const cx = Math.floor(5001 / 4);
    const h = -(cx * tilted.normal.x + -1000 * tilted.normal.z + tilted.originOffset) /
      tilted.normal.y;
    s.floorHeight = h * 4;
    expect(detectWorldScale([tilted], s)).toBe(4); // by footprint, not by luck
  });

  it("accepts a lookup map instead of scanning the pool", () => {
    const byAddr = new Map([[0x5300, flat]]);
    expect(detectWorldScale([], at(5000, -4000), byAddr)).toBe(4);
  });
});
