import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { SpatialPartition } from "./partition";
import { evaluateOracle } from "./oracle";
import type { Surface } from "./surface";
import type { StateMessage } from "../net/protocol";

// Two triangles on the plane x = 0 (a wall quad split along its diagonal): same
// normal + originOffset, so they are coplanar siblings of one physical wall.
const wallA = makeSurface([0, 0, 100], [0, 0, -100], [0, 200, -100], {
  address: 0xa00,
})!;
const wallB = makeSurface([0, 0, 100], [0, 200, -100], [0, 200, 100], {
  address: 0xb00,
})!;
// A wall on a different plane (z = 0), for the not-found / stale cases.
const wallC = makeSurface([100, 0, 0], [-100, 0, 0], [-100, 200, 0], {
  address: 0xc00,
})!;

const state = (wallAddr: number): StateMessage => ({
  type: "state",
  level: 1,
  area: 1,
  pos: { x: -30, y: 50, z: 0 },
  floorAddr: 0,
  ceilAddr: 0,
  wallAddr,
  floorHeight: 0,
  ceilHeight: 0,
  surfaceCount: 0,
});

const lookup = (...s: Surface[]) =>
  new Map(s.map((x) => [x.address >>> 0, x]));

describe("evaluateOracle walls", () => {
  it("matches when the game's wall is one we detected (moving)", () => {
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0xa00), 1, { moved: true, surfaceByAddr: lookup(wallA) });
    expect(r.wall.ourAddrs).toContain(0xa00);
    expect(r.wall.ok).toBe(true);
    expect(r.wall.coplanar).toBe(false);
    expect(r.wall.stale).toBe(false);
  });

  it("matches a coplanar sibling of the game's wall (same plane, other triangle)", () => {
    // Only wallA is in the partition, so we detect A but not B; the game reports
    // B, which shares A's plane — that counts as the same physical wall.
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0xb00), 1, {
      moved: true,
      surfaceByAddr: lookup(wallA, wallB),
    });
    expect(r.wall.ourAddrs).not.toContain(0xb00);
    expect(r.wall.coplanar).toBe(true);
    expect(r.wall.ok).toBe(true);
  });

  it("passes as stale when Mario didn't move (game's wall is left over)", () => {
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0xc00), 1, {
      moved: false,
      surfaceByAddr: lookup(wallA, wallC),
    });
    expect(r.wall.stale).toBe(true);
    expect(r.wall.coplanar).toBe(false);
    expect(r.wall.ok).toBe(true);
  });

  it("fails when moving and the game's wall is neither detected nor coplanar", () => {
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0xc00), 1, {
      moved: true,
      surfaceByAddr: lookup(wallA, wallC),
    });
    expect(r.wall.ok).toBe(false);
    expect(r.wall.stale).toBe(false);
    expect(r.wall.coplanar).toBe(false);
  });

  it("passes when the game recorded no wall", () => {
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0), 1, { moved: true });
    expect(r.wall.ok).toBe(true);
  });

  it("defaults to a strict (moving) comparison when no options are given", () => {
    const p = new SpatialPartition([wallA]);
    const r = evaluateOracle(p, state(0xc00), 1);
    expect(r.wall.stale).toBe(false);
    expect(r.wall.ok).toBe(false);
  });
});

describe("evaluateOracle floor/ceil coplanar siblings", () => {
  // A floor quad at y=0 split along its diagonal: two coplanar triangles.
  const floorA = makeSurface([-200, 0, -200], [-200, 0, 200], [200, 0, 200], {
    address: 0xf0a,
  })!;
  const floorB = makeSurface([-200, 0, -200], [200, 0, 200], [200, 0, -200], {
    address: 0xf0b,
  })!;
  // A different-plane floor, for the mismatch case.
  const floorC = makeSurface([-200, 500, -200], [-200, 500, 200], [200, 500, 200], {
    address: 0xf0c,
  })!;

  const stateOn = (floorAddr: number): StateMessage => ({
    ...state(0),
    pos: { x: 10, y: 20, z: -10 }, // inside floorB's half of the quad
    floorAddr,
  });

  it("accepts the sibling triangle of the same floor plane, marked coplanar", () => {
    // Only B is loaded, so we find B; the game (pre-step position) stored A.
    const p = new SpatialPartition([floorB]);
    const r = evaluateOracle(p, stateOn(0xf0a), 1, {
      moved: true,
      surfaceByAddr: lookup(floorA, floorB),
    });
    expect(r.floor.ourAddr).toBe(0xf0b);
    expect(r.floor.coplanar).toBe(true);
    expect(r.floor.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("still fails on a genuinely different floor plane", () => {
    const p = new SpatialPartition([floorB]);
    const r = evaluateOracle(p, stateOn(0xf0c), 1, {
      moved: true,
      surfaceByAddr: lookup(floorB, floorC),
    });
    expect(r.floor.coplanar).toBe(false);
    expect(r.floor.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("does not mark an exact match as coplanar", () => {
    const p = new SpatialPartition([floorB]);
    const r = evaluateOracle(p, stateOn(0xf0b), 1, {
      moved: true,
      surfaceByAddr: lookup(floorB),
    });
    expect(r.floor.ok).toBe(true);
    expect(r.floor.coplanar).toBe(false);
  });
});
