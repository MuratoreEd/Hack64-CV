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
import { actsInclude, type ScriptObject } from "./levelScript";

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
  secret: 0x13003f1c, // bhvHiddenStarTrigger; seen live
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

/** Model id of the star (gLoadedGraphNodes index) — what a level script's
 * OBJECT command names, and what a fake star wears. */
export const MODEL_STAR = 0x7a;
/** oInteractType bit of a star or key pickup (INTERACT_STAR_OR_KEY). */
export const INTERACT_STAR_OR_KEY = 0x1000;
/** The highest star index a save file keeps: a course has seven star bits
 * (save_file_set_star_flags; the eighth is a cannon flag), and the star
 * counters read only those. */
export const LAST_STAR_INDEX = 6;

/** Why something listed with the stars is not a real one. Troll stars:
 * - "badId": a genuine star object, but its number is past the seven a course
 *   has, so collecting it plays the whole star cutscene and saves nothing.
 * - "lookalike": an object wearing the star model that isn't a star pickup
 *   at all (decoration, or something that hurts). */
export type FakeStar = "badId" | "lookalike";

/** The star index a star object saves to: interact_star_or_key reads
 * `(oBehParams >> 24) & 0x1F`. */
export const starIndex = (behParams: number): number => (behParams >>> 24) & 0x1f;

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
  /** Set when it is not a real star (a troll star). */
  fake?: FakeStar;
}

/** A red coin or a secret: nothing to say about it but where it is. */
export interface PointObject {
  slot: number;
  pos: Vec3;
}

export interface Collectibles {
  course: number;
  stars: StarObject[];
  redCoins: PointObject[];
  /** The invisible triggers a "secrets" star counts (touched ones are gone). */
  secrets: PointObject[];
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

/** What star an object with this behaviour and these parameters stands for,
 * if any. The same rule for a live object and for one the level script only
 * places: both carry the segmented behaviour and the raw oBehParams. */
export function classifyStar(
  bhv: number,
  behParams: number,
): { starId: number; source: StarSource; giver?: string; fake?: FakeStar } | null {
  const param2 = (behParams >>> 16) & 0xff;
  if (bhv === BHV.exclamationBox) {
    // The box spawns its star from a fixed table: always a valid number.
    const starId = boxStarId(param2);
    return starId === null ? null : { starId, source: "box" };
  }
  const starId = starIndex(behParams);
  const fake = starId > LAST_STAR_INDEX ? { fake: "badId" as const } : {};
  const source = STAR_SOURCE.get(bhv);
  if (source) return { starId, source, ...fake };
  const giver = GIVER_BY_BHV.get(bhv);
  if (giver && (giver.when?.(param2) ?? true)) {
    return { starId, source: "giver", giver: giver.name, ...fake };
  }
  return null;
}

/** An object no behaviour rule calls a star but that wears the star model:
 * what touching it does decides. A star pickup under a hack's own behaviour
 * is a real star; anything else is a lookalike. `interact` undefined (not
 * known: a placement that hasn't loaded) counts as a lookalike. */
function starModelObject(
  behParams: number,
  interact: number | undefined,
): { starId: number; source: StarSource; giver?: string; fake?: FakeStar } {
  const starId = starIndex(behParams);
  if (interact !== undefined && (interact & INTERACT_STAR_OR_KEY) !== 0) {
    return starId > LAST_STAR_INDEX ? { starId, source: "star", fake: "badId" } : { starId, source: "star" };
  }
  return { starId, source: "star", fake: "lookalike" };
}

/** Stars (by star index, then slot), red coins and secrets (by slot) among
 * the live objects. Slot order is the order the level placed them in, so a
 * coin keeps its number while others are collected around it... until the
 * level reloads. */
export function findCollectibles(msg: ObjectsMessage): Collectibles {
  const stars: StarObject[] = [];
  const redCoins: PointObject[] = [];
  const secrets: PointObject[] = [];
  for (const rec of msg.objects) {
    if (!Array.isArray(rec) || rec.length < 6) continue;
    const [slot, behavior, x, y, z, behParams, model, interact] = rec;
    if (![x, y, z].every(Number.isFinite)) continue;
    const bhv = segmentedBehavior(behavior >>> 0, msg.behaviorBase);
    const pos = { x, y, z };
    if (bhv === BHV.redCoin) redCoins.push({ slot, pos });
    else if (bhv === BHV.secret) secrets.push({ slot, pos });
    else {
      const star =
        classifyStar(bhv, behParams) ??
        (msg.starModel && model === msg.starModel ? starModelObject(behParams, interact) : null);
      if (star) stars.push({ slot, pos, ...star });
    }
  }
  // Real stars by number, the fakes after them.
  stars.sort((a, b) => +!!a.fake - +!!b.fake || a.starId - b.starId || a.slot - b.slot);
  redCoins.sort((a, b) => a.slot - b.slot);
  secrets.sort((a, b) => a.slot - b.slot);
  return { course: msg.course, stars, redCoins, secrets };
}

// --- Stars the level places but the game has not loaded -----------------------

/** A star as the level script places it (levelScript.ts): which area it is
 * in and which acts it exists in, on top of what a live star says. */
export interface PlacedStar {
  area: number;
  /** Act mask, as in ScriptObject. */
  acts: number;
  pos: Vec3;
  starId: number;
  source: StarSource;
  giver?: string;
  fake?: FakeStar;
}

/** Why a placed star is not among the live objects. */
export type AbsentReason =
  | "area" // it is in another area of the level
  | "act" // it only exists in other acts
  | "gone"; // it was loaded for this visit and no longer exists

export interface AbsentStar extends PlacedStar {
  reason: AbsentReason;
}

/** The stars among a level's placements. The same star placed more than once
 * on one spot (a copy per act) is one entry with the act masks combined. */
export function placedStars(objects: ScriptObject[]): PlacedStar[] {
  const byKey = new Map<string, PlacedStar>();
  for (const o of objects) {
    // A placement says what model, not what touching it does: a star-model
    // object that no rule recognises is listed as a lookalike until it loads.
    const star =
      classifyStar(o.behavior, o.behParams) ??
      (o.model === MODEL_STAR ? starModelObject(o.behParams, undefined) : null);
    if (!star) continue;
    const key = [o.area, o.pos.x, o.pos.y, o.pos.z, star.starId, star.source, star.giver, star.fake].join("|");
    const seen = byKey.get(key);
    // 0x1F is "every act", not five bits to add to.
    if (seen) seen.acts = seen.acts === 0x1f || o.acts === 0x1f ? 0x1f : seen.acts | o.acts;
    else byKey.set(key, { area: o.area, acts: o.acts, pos: o.pos, ...star });
  }
  return [...byKey.values()].sort(
    (a, b) => +!!a.fake - +!!b.fake || a.starId - b.starId || a.area - b.area,
  );
}

/** The placed stars that are not in the live list, each with the reason.
 * A star that should be loaded here and now (this area, this act) counts as
 * present when ANY real live star has its number: the box has been opened and
 * the star is in the air, the boss is beaten and the star has spawned. Fakes
 * share numbers (or have none that matters) and stay put, so one counts as
 * present when any live star stands on its spot — which also settles a
 * placement guessed a lookalike that turned out, loaded, to be a real star. */
export function absentStars(
  placed: PlacedStar[],
  live: StarObject[],
  area: number,
  act: number,
): AbsentStar[] {
  const liveIds = new Set(live.filter((s) => !s.fake).map((s) => s.starId));
  const near = (a: Vec3, b: Vec3): boolean =>
    Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.z - b.z) <= 2;
  const present = (p: PlacedStar): boolean =>
    p.fake ? live.some((s) => near(s.pos, p.pos)) : liveIds.has(p.starId);
  const out: AbsentStar[] = [];
  for (const p of placed) {
    if (p.area !== area) out.push({ ...p, reason: "area" });
    else if (!actsInclude(p.acts, act)) out.push({ ...p, reason: "act" });
    else if (!present(p)) out.push({ ...p, reason: "gone" });
  }
  return out;
}
