// Deciding whether the probe's output agrees with a human label.
//
// Everything here works in WORLD units — the units the HUD shows and the user
// reasons in — and converts the probe's collision-space columns on the way in.

import type { InvisibleWallSegment } from "../probe/invisibleWalls";
import type { LabelRecord } from "./schema";

/**
 * How far from Mario a reported column may sit and still count as "the wall he
 * reported" (WORLD units).
 *
 * The game holds Mario 50 units off a wall plane (the perform_*_step push
 * radius), so the blocked cell he is stopped against is already tens of units
 * ahead of where he parks. 100 covers that plus imprecise parking, without
 * reaching into the next structure.
 */
export const WALL_MATCH_RADIUS = 100;

/**
 * How close a reported column may come to a spot the user says is walkable
 * (WORLD units) before it contradicts them.
 *
 * 50 = the same push radius: within it, the tool is claiming Mario could not be
 * standing where he demonstrably was. Beyond it, a blocked cell can honestly
 * belong to a real wall he was standing next to.
 */
export const CLEAR_MATCH_RADIUS = 50;

/**
 * Vertical slack when asking whether a blocked interval covers Mario (WORLD
 * units). One Mario height: the step target the probe blocked is at the target
 * column's floor, which can legitimately sit a step above or below his feet.
 * Without a vertical test at all, an air wall 2800 units overhead would
 * "confirm" a ground label.
 */
export const Y_SLACK = 160;

export interface ColumnHit {
  /** World-space column centre and blocked interval. */
  x: number;
  z: number;
  yLow: number;
  yHigh: number;
  distance: number;
  kind: string;
  blockerAddr: number;
  /** Whether the blocked interval reaches Mario's own height. */
  coversY: boolean;
}

export interface Judgement {
  ok: boolean;
  /** Plain-words explanation, shown when a corpus label fails. */
  reason: string;
  /** Columns inside the radius, nearest first (capped). */
  near: ColumnHit[];
}

/** Columns reported near a world position, nearest first. */
export function columnsNear(
  segments: readonly InvisibleWallSegment[],
  at: { x: number; y: number; z: number },
  worldScale: number,
  radius: number,
): ColumnHit[] {
  const hits: ColumnHit[] = [];
  for (const seg of segments) {
    for (const c of seg.columns) {
      const wx = c.x * worldScale;
      const wz = c.z * worldScale;
      const distance = Math.hypot(wx - at.x, wz - at.z);
      if (distance > radius) continue;
      const yLow = c.yLow * worldScale;
      const yHigh = c.yHigh * worldScale;
      hits.push({
        x: wx,
        z: wz,
        yLow,
        yHigh,
        distance,
        kind: seg.kind,
        blockerAddr: seg.blockerAddr,
        coversY: at.y >= yLow - Y_SLACK && at.y <= yHigh + Y_SLACK,
      });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

const describe = (h: ColumnHit): string =>
  `(${h.x.toFixed(0)}, ${h.z.toFixed(0)}) ${h.distance.toFixed(0)}u away, ` +
  `y ${h.yLow.toFixed(0)}→${h.yHigh.toFixed(0)}, ${h.kind}`;

/**
 * Does the probe's output agree with what the user said about this spot?
 *
 * "wall"  — at least one reported column within WALL_MATCH_RADIUS whose blocked
 *           interval reaches Mario's height.
 * "clear" — no such column within CLEAR_MATCH_RADIUS.
 */
export function judgeLabel(
  segments: readonly InvisibleWallSegment[],
  label: LabelRecord,
): Judgement {
  const wanted = label.label === "wall";
  const radius =
    label.radius ?? (wanted ? WALL_MATCH_RADIUS : CLEAR_MATCH_RADIUS);
  const near = columnsNear(
    segments,
    label.marioWorldPos,
    label.worldScale,
    radius,
  );
  const covering = near.filter((h) => h.coversY);

  if (wanted) {
    if (covering.length > 0) {
      return {
        ok: true,
        reason: `reported ${covering.length} column(s) here, nearest ${describe(covering[0])}`,
        near,
      };
    }
    const why =
      near.length === 0
        ? `nothing reported within ${radius}u`
        : `${near.length} column(s) within ${radius}u but none reach y ${label.marioWorldPos.y.toFixed(0)} ` +
          `(nearest ${describe(near[0])})`;
    return { ok: false, reason: `MISSED: ${why}`, near };
  }

  if (covering.length === 0) {
    return {
      ok: true,
      reason:
        near.length === 0
          ? `nothing reported within ${radius}u`
          : `${near.length} column(s) within ${radius}u, none at Mario's height`,
      near,
    };
  }
  return {
    ok: false,
    reason:
      `FALSE POSITIVE: ${covering.length} column(s) reported at a spot labelled clear, ` +
      `nearest ${describe(covering[0])}`,
    near,
  };
}
