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
// not an object until it spawns. A collected red coin is deleted, so the list
// is the coins still left.

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
  | "secrets"; // appears here once every secret is touched

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
    const source = STAR_SOURCE.get(bhv);
    if (source) stars.push({ slot, pos, starId: behParams >>> 24, source });
  }
  stars.sort((a, b) => a.starId - b.starId || a.slot - b.slot);
  redCoins.sort((a, b) => a.slot - b.slot);
  return { course: msg.course, stars, redCoins };
}
