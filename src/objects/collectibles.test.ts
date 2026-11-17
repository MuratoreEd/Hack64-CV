import { describe, it, expect } from "vitest";
import {
  BHV,
  INTERACT_STAR_OR_KEY,
  absentStars,
  boxStarId,
  classifyStar,
  findCollectibles,
  placedStars,
  segmentedBehavior,
  starIndex,
} from "./collectibles";
import type { ScriptObject } from "./levelScript";
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
  act: 1,
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
    expect(found.secrets).toEqual([]);
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

  it("lists secrets in slot order, apart from the star they unlock", () => {
    const found = findCollectibles(
      message([
        obj(33, BHV.hiddenStar, [12402, 669, -15182], 0x01000000),
        obj(9, BHV.secret, [5, 6, 7]),
        obj(0, BHV.secret, [-12591, -2041, -10715]),
      ]),
    );
    expect(found.secrets).toEqual([
      { slot: 0, pos: { x: -12591, y: -2041, z: -10715 } },
      { slot: 9, pos: { x: 5, y: 6, z: 7 } },
    ]);
    expect(found.stars.map((s) => s.source)).toEqual(["secrets"]);
    expect(found.redCoins).toEqual([]);
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

  it("lists a boss's star at the boss, numbered from the boss's parameters", () => {
    // Live: two Mr. I in one level, only the big one (second byte 1) holds a
    // star — star 1, the one that was missing from the list.
    const found = findCollectibles(
      message([
        obj(31, 0x13000054, [-974, -9249, -4074], 0x00000000),
        obj(39, 0x13000054, [15277, -7028, -1767], 0x00010000),
        obj(40, 0x130001f4, [0, 0, 0], 0x02000000), // King Bob-omb, star 3
      ]),
    );
    expect(found.stars).toEqual([
      { slot: 39, pos: { x: 15277, y: -7028, z: -1767 }, starId: 0, source: "giver", giver: "Big Mr. I" },
      { slot: 40, pos: { x: 0, y: 0, z: 0 }, starId: 2, source: "giver", giver: "King Bob-omb" },
    ]);
  });

  it("tells Koopa the Quick from an ordinary Koopa", () => {
    const koopa = (param2: number): ObjectRecord =>
      obj(param2, 0x13004580, [0, 0, 0], 0x01000000 | (param2 << 16));
    const found = findCollectibles(message([0, 1, 2, 3, 4].map(koopa)));
    expect(found.stars.map((s) => [s.slot, s.giver])).toEqual([
      [2, "Koopa the Quick"],
      [3, "Koopa the Quick"],
    ]);
  });

  it("flags troll stars: a star numbered past 7, and a drawn star that isn't one", () => {
    // Live, 2026-11-17: four bhvStar with star index 8 ("star 9"), drawn
    // (flags 0x21); three fire bars (bhv 0x13001108) with the star model as a
    // placeholder, never drawn (0x20, GRAPH_RENDER_ACTIVE off) — not stars of
    // any kind; the red-coin star's transparent marker (another model) and a
    // real box.
    const STAR_MODEL = 0x80100b9c;
    const msg: ObjectsMessage = {
      ...message([
        [103, virt(BHV.star), -17907, 1201, 500, 0x08000000, STAR_MODEL, INTERACT_STAR_OR_KEY, 0x21],
        [42, virt(0x13001108), -11065, 5678, -18435, 0, STAR_MODEL, 0, 0x20],
        [115, virt(0x1300556c), -1409, -1840, -12793, 0, 0x80100c00, 0, 0x21],
        [88, virt(BHV.exclamationBox), -10527, 11632, 265, 0x000a0000, 0x8015fa78, 0x200, 0x20],
        // A hack's own star behaviour: star model, star pickup — a real star,
        // drawn or not.
        [7, virt(0x13009000), 1, 2, 3, 0x02000000, STAR_MODEL, INTERACT_STAR_OR_KEY, 0x20],
        // The game masks the number with 0x1F: 0x21 is star 2, not star 34.
        [8, virt(BHV.star), 4, 5, 6, 0x21000000, STAR_MODEL, INTERACT_STAR_OR_KEY, 0x21],
        // Drawn as a star, not a pickup: a lookalike. Hidden: nothing.
        [9, virt(0x13001108), 7, 8, 9, 0, STAR_MODEL, 0x08, 0x21],
        [10, virt(0x13001108), 7, 8, 9, 0, STAR_MODEL, 0, 0x31], // cur_obj_hide
        [11, virt(0x13001108), 7, 8, 9, 0, STAR_MODEL, 0], // older bridge: no flags
      ]),
      starModel: STAR_MODEL,
    };
    expect(findCollectibles(msg).stars.map((s) => [s.slot, s.starId, s.fake])).toEqual([
      [8, 1, undefined],
      [88, 1, undefined],
      [7, 2, undefined],
      [9, 0, "lookalike"],
      [103, 8, "badId"],
    ]);
    // A bridge that sends no model knows no lookalikes; the number rule holds.
    const old = findCollectibles({ ...msg, starModel: undefined });
    expect(old.stars.map((s) => [s.slot, s.fake])).toEqual([
      [8, undefined],
      [88, undefined],
      [103, "badId"],
    ]);
    expect(starIndex(0xe7000000)).toBe(7);
    expect(classifyStar(BHV.star, 0x06000000)?.fake).toBeUndefined(); // 100-coin bit
    expect(classifyStar(BHV.star, 0x07000000)?.fake).toBe("badId");
    expect(classifyStar(0x130001f4, 0x09000000)?.fake).toBe("badId"); // a boss too
  });

  it("ignores everything else, and records it can't use", () => {
    const found = findCollectibles(
      message([
        obj(1, 0x13000054, [1, 2, 3]),
        [2, 0, 0, 0, 0, 0], // null behaviour
        [3, virt(BHV.star), NaN, 0, 0, 0],
        [4, virt(BHV.redCoin)] as unknown as ObjectRecord,
        null as unknown as ObjectRecord,
      ]),
    );
    expect(found).toEqual({ course: 15, stars: [], redCoins: [], secrets: [] });
  });
});

describe("placedStars / absentStars", () => {
  const placed = (
    area: number,
    acts: number,
    bhv: number,
    behParams: number,
    pos: [number, number, number] = [0, 0, 0],
  ): ScriptObject => ({
    area,
    acts,
    model: 0x01, // not the star model: that has a meaning of its own

    pos: { x: pos[0], y: pos[1], z: pos[2] },
    behParams,
    behavior: bhv,
  });

  it("classifies script placements by the same rules as live objects", () => {
    const stars = placedStars([
      placed(1, 0x1f, 0x13000054, 0x00010000, [15277, -7028, -1767]), // Big Mr. I
      placed(1, 0x1f, 0x13000054, 0x00000000), // an ordinary Mr. I
      placed(1, 0x1f, BHV.redCoin, 0),
      placed(2, 0x04, BHV.exclamationBox, 0x000c0000, [5, 6, 7]),
      placed(2, 0x1f, BHV.exclamationBox, 0x00060000), // ten coins
    ]);
    expect(stars).toEqual([
      { area: 1, acts: 0x1f, pos: { x: 15277, y: -7028, z: -1767 }, starId: 0, source: "giver", giver: "Big Mr. I" },
      { area: 2, acts: 0x04, pos: { x: 5, y: 6, z: 7 }, starId: 3, source: "box" },
    ]);
  });

  it("merges one star placed once per act into a single entry", () => {
    const stars = placedStars([
      placed(1, 0x01, BHV.star, 0x02000000, [1, 2, 3]),
      placed(1, 0x04, BHV.star, 0x02000000, [1, 2, 3]),
      placed(1, 0x02, BHV.star, 0x02000000, [9, 9, 9]), // somewhere else
    ]);
    expect(stars.map((s) => [s.acts, s.pos.x])).toEqual([[0x05, 1], [0x02, 9]]);
    const every = placedStars([
      placed(1, 0x01, BHV.star, 0, [1, 2, 3]),
      placed(1, 0x1f, BHV.star, 0, [1, 2, 3]),
    ]);
    expect(every.map((s) => s.acts)).toEqual([0x1f]);
  });

  it("says why each placed star is not loaded", () => {
    const stars = placedStars([
      placed(1, 0x1f, BHV.star, 0x00000000), // star 1: here, live
      placed(1, 0x1f, BHV.exclamationBox, 0x000a0000), // star 2: here, opened, in the air
      placed(1, 0x1f, 0x130001f4, 0x02000000), // star 3: King Bob-omb, beaten and collected
      placed(1, 0x05, BHV.star, 0x03000000), // star 4: acts 1 and 3 only
      placed(2, 0x1f, BHV.hiddenRedCoinStar, 0x04000000), // star 5: other area
      placed(2, 0x02, BHV.star, 0x00000000), // star 1 again, in the other area
    ]);
    const live = findCollectibles(
      message([
        obj(3, BHV.star, [0, 0, 0], 0x00000000),
        obj(4, BHV.spawnedStar, [0, 50, 0], 0x01000000),
      ]),
    ).stars;
    const absent = absentStars(stars, live, 1, 2);
    expect(absent.map((s) => [s.starId, s.area, s.reason])).toEqual([
      [0, 2, "area"],
      [2, 1, "gone"],
      [3, 1, "act"],
      [4, 2, "area"],
    ]);
    // In act 3 the act-limited star is simply loaded-or-gone like any other.
    expect(absentStars(stars, live, 1, 3).find((s) => s.starId === 3)?.reason).toBe("gone");
    // From the other area, everything in area 1 is elsewhere.
    expect(absentStars(stars, [], 2, 2).map((s) => s.reason)).toEqual([
      "area", "gone", "area", "area", "area", "gone",
    ]);
  });

  it("places troll stars last, and matches them to live ones by spot", () => {
    // The fire bars' placements: the star model (0x7A) on a non-star. The
    // model alone proves nothing (a placeholder), so they aren't listed.
    const fireBar = (pos: [number, number, number], area = 1): ScriptObject => ({
      ...placed(area, 0x1f, 0x13001108, 0, pos),
      model: 0x7a,
    });
    const stars = placedStars([
      placed(1, 0x1f, BHV.star, 0x08000000, [-17907, 1201, 500]), // ID 9
      placed(1, 0x1f, BHV.star, 0x08000000, [-16600, 1201, 2196]), // ID 9 again
      fireBar([-11065, 5678, -18435]),
      fireBar([9, 9, 9], 2),
      placed(1, 0x1f, BHV.star, 0x00000000, [0, 0, 0]),
    ]);
    expect(stars.map((s) => [s.starId, s.fake ?? null])).toEqual([
      [0, null],
      [8, "badId"],
      [8, "badId"],
    ]);
    // Live: the real star and one of the two ID-9 stars (the other was
    // touched): fakes are matched by spot, not by their shared number.
    const live = findCollectibles(
      message([
        [1, virt(BHV.star), 0, 0, 0, 0],
        [2, virt(BHV.star), -17907, 1201, 500, 0x08000000],
      ]),
    ).stars;
    expect(absentStars(stars, live, 1, 1).map((s) => [s.pos.x, s.fake, s.reason])).toEqual([
      [-16600, "badId", "gone"],
    ]);
  });
});
