import { describe, it, expect } from "vitest";
import type { InvisibleWallSegment } from "../probe/invisibleWalls";
import type { LabelRecord } from "./schema";
import { CORPUS_SCHEMA_VERSION } from "./schema";
import { judgeLabel, columnsNear, WALL_MATCH_RADIUS, Y_SLACK } from "./judge";

/** A segment carrying one blocked column, in COLLISION units. */
function segment(
  x: number,
  z: number,
  yLow: number,
  yHigh: number,
): InvisibleWallSegment {
  return {
    x0: x,
    z0: z,
    x1: x,
    z1: z,
    yBase: yLow,
    yLow,
    yHigh,
    kind: "exposed-ceiling",
    blockerAddr: 0x80123456,
    sourceIndex: 0,
    samples: 1,
    columns: [{ x, z, yLow, yHigh }],
  };
}

function label(over: Partial<LabelRecord> = {}): LabelRecord {
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    appVersion: "test",
    capturedAt: "2026-08-02T00:00:00.000Z",
    level: 15,
    area: 1,
    worldScale: 1,
    profile: { wallThreshold: 0.05, select: "extreme", known: true },
    marioWorldPos: { x: 1000, y: 500, z: 2000 },
    label: "wall",
    note: "test",
    ...over,
  };
}

describe("judgeLabel — wall labels", () => {
  it("passes when a column covering Mario is reported at the spot", () => {
    const j = judgeLabel([segment(1010, 2005, 480, 900)], label());
    expect(j.ok).toBe(true);
    expect(j.reason).toContain("reported 1 column");
  });

  it("fails when nothing is reported there", () => {
    const j = judgeLabel([], label());
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("MISSED");
    expect(j.reason).toContain("nothing reported");
  });

  it("fails when the only column is out of radius", () => {
    const far = WALL_MATCH_RADIUS + 20;
    const j = judgeLabel([segment(1000 + far, 2000, 480, 900)], label());
    expect(j.ok).toBe(false);
    expect(j.near).toHaveLength(0);
  });

  it("fails when a column is at the spot but far above Mario (the air-wall trap)", () => {
    // P10's real case shape: a blocked band ~2800 units above the blocker. It
    // must not vindicate a label taken on the ground.
    const j = judgeLabel([segment(1005, 2005, 3200, 4000)], label());
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("none reach y 500");
  });

  it("accepts a column within one Mario height of his feet", () => {
    const jIn = judgeLabel([segment(1000, 2000, 500 + Y_SLACK - 1, 900)], label());
    const jOut = judgeLabel([segment(1000, 2000, 500 + Y_SLACK + 1, 900)], label());
    expect(jIn.ok).toBe(true);
    expect(jOut.ok).toBe(false);
  });

  it("converts collision columns to world units by the label's scale", () => {
    // Same column, scale 4: collision (250, 500) is world (1000, 2000).
    const seg = segment(250, 500, 120, 225);
    expect(judgeLabel([seg], label({ worldScale: 4 })).ok).toBe(true);
    expect(judgeLabel([seg], label({ worldScale: 1 })).ok).toBe(false);
  });

  it("honours a per-label radius override", () => {
    const seg = segment(1000 + WALL_MATCH_RADIUS + 50, 2000, 480, 900);
    expect(judgeLabel([seg], label()).ok).toBe(false);
    expect(judgeLabel([seg], label({ radius: 200 })).ok).toBe(true);
  });
});

describe("judgeLabel — clear labels", () => {
  const clear = (over: Partial<LabelRecord> = {}) =>
    label({ label: "clear", ...over });

  it("passes when nothing is reported at the spot", () => {
    const j = judgeLabel([segment(5000, 5000, 480, 900)], clear());
    expect(j.ok).toBe(true);
  });

  it("fails when a column covering Mario is reported where he walked", () => {
    const j = judgeLabel([segment(1010, 2005, 480, 900)], clear());
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("FALSE POSITIVE");
  });

  it("tolerates a nearby column that doesn't reach his height", () => {
    const j = judgeLabel([segment(1010, 2005, 2000, 3000)], clear());
    expect(j.ok).toBe(true);
  });
});

describe("columnsNear", () => {
  it("returns hits nearest first", () => {
    const hits = columnsNear(
      [segment(1050, 2000, 400, 600), segment(1010, 2000, 400, 600)],
      { x: 1000, y: 500, z: 2000 },
      1,
      WALL_MATCH_RADIUS,
    );
    expect(hits.map((h) => Math.round(h.distance))).toEqual([10, 50]);
    expect(hits.every((h) => h.coversY)).toBe(true);
  });
});
