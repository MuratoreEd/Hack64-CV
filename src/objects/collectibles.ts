// Picks the stars and red coins out of the game's live object list.
//
// Objects are recognised by their behaviour script, named by its segmented
// address in bank 0x13 — the way every SM64 tool identifies them, and stable
// across ROM hacks, which place vanilla behaviours rather than rewrite them.
// The addresses below are the US ones. star, exclamationBox, hiddenRedCoinStar,
// redCoin and hiddenStar were seen live in a running hack (2026-11-13) with the
// positions and parameters expected of them; the rest are from STROOP's object
// table and have not been observed here.
//
// What this can and cannot see: the object pool holds the CURRENT area's
// objects for the CURRENT act. A star in another area, or one that only exists
// in a different act, is not in RAM. A star handed out by a boss or a race is
// not an object until it is won — but the boss is, and it already carries the
// star's number (see STAR_GIVERS). A collected red coin is deleted, so the
// list is the coins still left.

import type { ObjectsMessage } from "../net/protocol";

const BHV_SEGMENT = 0x13;

export const BHV = {
  spawnedStar: 0x130007f8,
  spawnedStarNoLevelExit: 0x1300080c,
  exclamationBox: 0x13002250,
  star: 0x13003e3c,
  starSpawnCoordinates: 0x13003e64,
  hiddenRedCoinStar: 0x13003e8c,
  redCoin: 0x13003eac,
  bowserCourseRedCoinStar: 0x13003ee4,
  hiddenStar: 0x13003efc,
} as const;

/** How a star comes to be where its marker is. */
export type StarSource =
  | "star" // sitting there (or already spawned and on its way)
  | "box" // inside an exclamation box
  | "redCoins" // appears here once every red coin is collected
  | "secrets" // appears here once every secret is touched
  | "giver"; // handed out by the object here (a boss, a race, a task)

/** An object that awards a star: a boss, a race opponent, a task. The star is
 * not an object until it is won, but which star it will be is already in the
 * giver's own parameters — the game copies them onto the star it spawns
 * (spawn_star: `star->oBehParams = o->oBehParams`). The marker goes on the
 * giver: where the star then appears is a constant in that object's code.
 *
 * Addresses are STROOP's, behaviour is the decomp's. Only Big Mr. I has been
 * seen live (2026-11-13, star 1 of a hack's course 15). Left out on purpose:
 * the five huge piranha plants (one star between them), Unagi, Ukiki's cage,
 * MIPS, Toad and Bowser, whose star does not follow this rule. */
interface StarGiver {
  bhv: number;
  name: string;
  /** For behaviours shared with ordinary objects: which second parameter
   * byte makes this the star-giving one. */
  when?: (param2: number) => boolean;
}

const STAR_GIVERS: StarGiver[] = [
  { bhv: 0x13000054, name: "Big Mr. I", when: (p) => p !== 0 },
  { bhv: 0x130001f4, name: "King Bob-omb" },
  { bhv: 0x130015c0, name: "slide finish" },
  { bhv: 0x13002088, name: "mother penguin" },
  { bhv: 0x13002768, name: "Big Boo" },
  { bhv: 0x1300277c, name: "Big Boo" },
  { bhv: 0x13002790, name: "Big Boo" },
  { bhv: 0x13002bb8, name: "Whomp King" },
  { bhv: 0x13003660, name: "Big Bully" },
  { bhv: 0x13003694, name: "Big Bully" },
  { bhv: 0x13003700, name: "Chill Bully" },
  { bhv: 0x13003738, name: "water rings" },
  { bhv: 0x13003d0c, name: "snowman's head" },
  { bhv: 0x13004370, name: "manta ray rings" },
  { bhv: 0x13004470, name: "treasure chests" },
  { bhv: 0x13004494, name: "treasure chests" },
  { bhv: 0x13004580, name: "Koopa the Quick", when: (p) => p === 2 || p === 3 },
  { bhv: 0x13004898, name: "Wiggler" },
  { bhv: 0x130052b4, name: "Eyerok" },
  { bhv: 0x13005310, name: "Klepto", when: (p) => p !== 0 },
  { bhv: 0x13005380, name: "racing penguin" },
];
const GIVER_BY_BHV = new Map(STAR_GIVERS.map((g) => [g.bhv, g]));

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface StarObject {
  slot: number;
  /** World units. */
  pos: Vec3;
  /** 0-based star index within the course (the save-file bit): 0..5 are the
   * six acts, 6 is the 100-coin star. */
  starId: number;
  source: StarSource;
  /** For source "giver": what hands the star out ("King Bob-omb"). */
  giver?: string;
}

export interface RedCoinObject {
  slot: number;
  pos: Vec3;
}

export interface Collectibles {
  course: number;
  stars: StarObject[];
  redCoins: RedCoinObject[];
}

/** Object.behavior (a KSEG0 pointer) → the behaviour's segmented address, or
 * 0 when it doesn't point into the behaviour segment. */
export function segmentedBehavior(behavior: number, behaviorBase: number): number {
  const offset = (behavior & 0x1fffffff) - behaviorBase;
  if (behavior >>> 24 < 0x80 || offset < 0 || offset > 0xffffff) return 0;
  return ((BHV_SEGMENT << 24) | offset) >>> 0;
}

/** Which star an exclamation box holds, from its contents id (the second
 * behaviour-parameter byte, sExclamationBoxContents): 8 is star 1, 10..14 are
 * stars 2..6. Everything else is caps, coins, shells and 1-ups. */
export function boxStarId(contents: number): number | null {
  if (contents === 8) return 0;
  if (contents >= 10 && contents <= 14) return contents - 9;
  return null;
}

const STAR_SOURCE = new Map<number, StarSource>([
  [BHV.star, "star"],
  [BHV.starSpawnCoordinates, "star"],
  [BHV.spawnedStar, "star"],
  [BHV.spawnedStarNoLevelExit, "star"],
  [BHV.hiddenRedCoinStar, "redCoins"],
  [BHV.bowserCourseRedCoinStar, "redCoins"],
  [BHV.hiddenStar, "secrets"],
]);

/** Stars (by star index, then slot) and red coins (by slot) among the live
 * objects. Slot order is the order the level placed them in, so a coin keeps
 * its number while others are collected around it... until the level reloads. */
export function findCollectibles(msg: ObjectsMessage): Collectibles {
  const stars: StarObject[] = [];
  const redCoins: RedCoinObject[] = [];
  for (const rec of msg.objects) {
    if (!Array.isArray(rec) || rec.length < 6) continue;
    const [slot, behavior, x, y, z, behParams] = rec;
    if (![x, y, z].every(Number.isFinite)) continue;
    const bhv = segmentedBehavior(behavior >>> 0, msg.behaviorBase);
    const pos = { x, y, z };
    if (bhv === BHV.redCoin) {
      redCoins.push({ slot, pos });
      continue;
    }
    if (bhv === BHV.exclamationBox) {
      const starId = boxStarId((behParams >>> 16) & 0xff);
      if (starId !== null) stars.push({ slot, pos, starId, source: "box" });
      continue;
    }
    const starId = behParams >>> 24;
    const source = STAR_SOURCE.get(bhv);
    if (source) {
      stars.push({ slot, pos, starId, source });
      continue;
    }
    const giver = GIVER_BY_BHV.get(bhv);
    if (giver && (giver.when?.((behParams >>> 16) & 0xff) ?? true)) {
      stars.push({ slot, pos, starId, source: "giver", giver: giver.name });
    }
  }
  stars.sort((a, b) => a.starId - b.starId || a.slot - b.slot);
  redCoins.sort((a, b) => a.slot - b.slot);
  return { course: msg.course, stars, redCoins };
}
