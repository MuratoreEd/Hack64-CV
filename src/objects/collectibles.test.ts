import { describe, it, expect } from "vitest";
import {
  BHV,
  boxStarId,
  findCollectibles,
  segmentedBehavior,
} from "./collectibles";
import type { ObjectsMessage, ObjectRecord } from "../net/protocol";

// Segment 0x13 as it sat in the running hack these addresses were checked on.
const BASE = 0xf3180;
const virt = (segmented: number): number =>
  (0x80000000 + BASE + (segmented & 0xffffff)) >>> 0;
const obj = (
  slot: number,
  bhv: number,
  pos: [number, number, number],
  behParams = 0,
): ObjectRecord => [slot, virt(bhv), ...pos, behParams];
const message = (objects: ObjectRecord[], course = 15): ObjectsMessage => ({
  type: "objects",
  course,
  behaviorBase: BASE,
  objects,
});

describe("segmentedBehavior", () => {
  it("turns a behaviour pointer back into its bank-0x13 address", () => {
    expect(segmentedBehavior(virt(BHV.redCoin), BASE)).toBe(BHV.redCoin);
    expect(segmentedBehavior(0x80000000 + BASE, BASE)).toBe(0x13000000);
  });

  it("rejects pointers that aren't in the behaviour segment", () => {
    expect(segmentedBehavior(0, BASE)).toBe(0);
    expect(segmentedBehavior(0x80000000 + BASE - 4, BASE)).toBe(0); // below it
    expect(segmentedBehavior(0x13003eac, BASE)).toBe(0); // not a KSEG0 pointer
  });
});

describe("boxStarId", () => {
  it("maps the star contents ids and nothing else", () => {
    expect(boxStarId(8)).toBe(0);
    expect([10, 11, 12, 13, 14].map(boxStarId)).toEqual([1, 2, 3, 4, 5]);
    for (const other of [0, 1, 2, 3, 4, 5, 6, 7, 9, 15, 99]) {
      expect(boxStarId(other)).toBeNull();
    }
  });
});

describe("findCollectibles", () => {
  it("picks out stars of every source, in star order", () => {
    // The live sample: a placed star (5), a red-coin star (6), a secrets star
    // (2) and two star boxes (contents 12 and 11 = stars 4 and 3), among
    // boxes that hold other things.
    const found = findCollectibles(
      message([
        obj(19, BHV.exclamationBox, [-18233, -9249, -7383], 0x00020000), // vanish cap
        obj(21, BHV.exclamationBox, [-19010, -6035, -2557], 0x000c0000),
        obj(22, BHV.star, [8607, 4581, 5399], 0x04000000),
        obj(30, BHV.hiddenRedCoinStar, [-4401, 9006, 313], 0x05000000),
        obj(32, BHV.exclamationBox, [1034, 233, 25007], 0x000b0000),
        obj(33, BHV.hiddenStar, [12402, 669, -15182], 0x01000000),
        obj(51, BHV.exclamationBox, [-2295, -2386, 16556], 0x00060000), // 10 coins
      ]),
    );
    expect(found.course).toBe(15);
    expect(found.stars.map((s) => [s.starId, s.source, s.slot])).toEqual([
      [1, "secrets", 33],
      [2, "box", 32],
      [3, "box", 21],
      [4, "star", 22],
      [5, "redCoins", 30],
    ]);
    expect(found.stars[3].pos).toEqual({ x: 8607, y: 4581, z: 5399 });
    expect(found.redCoins).toEqual([]);
  });

  it("lists red coins in slot order", () => {
    const found = findCollectibles(
      message([
        obj(42, BHV.redCoin, [-7495, -3611, -17592]),
        obj(1, BHV.redCoin, [17832, -5319, -16780]),
        obj(35, BHV.redCoin, [17059, -4412, 823]),
      ]),
    );
    expect(found.redCoins.map((c) => c.slot)).toEqual([1, 35, 42]);
    expect(found.redCoins[0].pos).toEqual({ x: 17832, y: -5319, z: -16780 });
    expect(found.stars).toEqual([]);
  });

  it("counts spawned stars and the Bowser-course red coin star", () => {
    const found = findCollectibles(
      message([
        obj(3, BHV.spawnedStar, [0, 0, 0], 0x02000000),
        obj(4, BHV.spawnedStarNoLevelExit, [0, 0, 0], 0x06000000),
        obj(5, BHV.starSpawnCoordinates, [0, 0, 0], 0x00000000),
        obj(6, BHV.bowserCourseRedCoinStar, [0, 0, 0], 0x01000000),
      ]),
    );
    expect(found.stars.map((s) => [s.starId, s.source])).toEqual([
      [0, "star"],
      [1, "redCoins"],
      [2, "star"],
      [6, "star"],
    ]);
  });

  it("ignores everything else, and records it can't use", () => {
    const found = findCollectibles(
      message([
        obj(0, 0x13003f1c, [1, 2, 3]), // a secret: not a star
        obj(1, 0x13000054, [1, 2, 3]),
        [2, 0, 0, 0, 0, 0], // null behaviour
        [3, virt(BHV.star), NaN, 0, 0, 0],
        [4, virt(BHV.redCoin)] as unknown as ObjectRecord,
        null as unknown as ObjectRecord,
      ]),
    );
    expect(found).toEqual({ course: 15, stars: [], redCoins: [] });
  });
});
