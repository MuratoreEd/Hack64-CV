import { describe, it, expect } from "vitest";
import { makeSurface } from "./geometry";
import { SpatialPartition } from "./partition";
import { evaluateOracle, detectWorldScale, detectFloorSelect } from "./oracle";
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

describe("evaluateOracle wall queries mirror the game's (offset, radius) pairs", () => {
  // A wall on x = 0 facing +x that exists only from y 190 to 260: at Mario's
  // y = 50 only the air step's +150 probe (y 200) reaches it.
  const highWall = makeSurface([0, 190, 100], [0, 190, -100], [0, 260, -100], {
    address: 0xd00,
  })!;
  const at = (x: number, scale = 1): StateMessage => ({
    ...state(0),
    pos: { x: x * scale, y: 50 * scale, z: 0 },
  });

  it("includes the air step's +150 probe", () => {
    const r = evaluateOracle(new SpatialPartition([highWall]), at(30), 1);
    expect(r.wall.ourAddrs).toContain(0xd00);
  });

  it("uses the real radius (50), not 150", () => {
    // 100 away: inside the bogus (60, 150) pair the table used to have.
    expect(evaluateOracle(new SpatialPartition([wallA]), at(-100), 1).wall.ourAddrs)
      .toEqual([]);
  });

  it("scales offsets and radii with the world scale", () => {
    // At 4×, 100 world units is 25 collision units — outside the 12.5 radius,
    // inside the unscaled 50 an earlier version used.
    const p = new SpatialPartition([wallA]);
    expect(evaluateOracle(p, at(-25, 4), 4).wall.ourAddrs).toEqual([]);
    expect(evaluateOracle(p, at(-10, 4), 4).wall.ourAddrs).toContain(0xa00);
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

describe("detectWorldScale", () => {
  // A SLOPED floor in collision space: at collision (10, -10) its plane sits at
  // y = 105, so a 4x hack reports floorHeight 420 with Mario at world (40, ?, -40).
  const slope = makeSurface([-200, 0, -200], [-200, 0, 200], [200, 400, 200], {
    address: 0x5100,
  })!;
  const planeAt = (s: Surface, x: number, z: number) =>
    -(x * s.normal.x + z * s.normal.z + s.originOffset) / s.normal.y;

  const stateAt = (scale: number): StateMessage => ({
    ...state(0),
    // Collision column (10, -10) at the given scale.
    pos: { x: 10 * scale, y: 500 * scale, z: -10 * scale },
    floorAddr: 0x5100,
    floorHeight: planeAt(slope, 10, -10) * scale,
  });

  it("detects the scale from a SLOPED floor (the level-15 blind spot)", () => {
    // The old detector required |normal.y| >= 0.99 and returned null here, so a
    // hack whose Mario stands on slopes never had its scale corrected — the
    // probe then ran with a 4x-too-tall hitbox and invented ceiling collisions.
    for (const scale of [1, 2, 4, 8]) {
      expect(detectWorldScale([slope], stateAt(scale))).toBe(scale);
    }
  });

  it("returns null when the floor isn't in our pool", () => {
    expect(detectWorldScale([], stateAt(4))).toBeNull();
  });

  it("returns null rather than guessing when scales are indistinguishable", () => {
    // A flat floor whose plane is y = 0: height 0 * any scale = 0, so every
    // candidate fits and the answer would be arbitrary.
    const flat = makeSurface([-200, 0, -200], [-200, 0, 200], [200, 0, 200], {
      address: 0x5200,
    })!;
    const s: StateMessage = {
      ...state(0),
      pos: { x: 10, y: 50, z: -10 },
      floorAddr: 0x5200,
      floorHeight: 0,
    };
    expect(detectWorldScale([flat], s)).toBeNull();
  });
});

describe("detectFloorSelect", () => {
  // The live shape from this hack's level 15: two overlapping floors where the
  // one sorted FIRST (higher vertex1[1]) has the LOWER plane at the query
  // column, so vanilla first-hit-wins and a cucking-fixed engine disagree.
  //   shadower: vertex1.y = 300, plane at (0,0) = 100
  //   higher:   vertex1.y = 200, plane at (0,0) = 200 (flat)
  const shadower = makeSurface([-100, 300, -100], [-100, 100, 100], [100, 100, 100], {
    address: 0x9100,
  })!;
  const higher = makeSurface([-100, 200, -100], [-100, 200, 100], [100, 200, 100], {
    address: 0x9200,
  })!;
  const partition = () => new SpatialPartition([shadower, higher]);
  const at = (floorAddr: number): StateMessage => ({
    ...state(0),
    pos: { x: -20, y: 260, z: 20 },
    floorAddr,
  });

  it("precondition: the two rules really do disagree here", () => {
    const p = partition();
    const first = p.findFloorWith(-20, 260, 20, "first");
    const extreme = p.findFloorWith(-20, 260, 20, "extreme");
    expect(first.surface?.address).toBe(0x9100);
    expect(extreme.surface?.address).toBe(0x9200);
    expect(extreme.height).toBeGreaterThan(first.height);
  });

  it("reads 'extreme' when the game reports the highest floor", () => {
    expect(detectFloorSelect(partition(), at(0x9200), 1)).toBe("extreme");
  });

  it("reads 'first' when the game reports the first-in-sort floor", () => {
    expect(detectFloorSelect(partition(), at(0x9100), 1)).toBe("first");
  });

  it("stays silent when the rules agree, or the floor is neither", () => {
    // Single floor: nothing to learn.
    const one = new SpatialPartition([higher]);
    expect(detectFloorSelect(one, at(0x9200), 1)).toBeNull();
    // A pointer we don't recognize (dynamic surface / pool skew).
    expect(detectFloorSelect(partition(), at(0xdead), 1)).toBeNull();
  });
});
