// The probe configuration a live session runs with, in one place so the corpus
// runner cannot test a configuration the app never uses.
//
// mario.c's constants (hitbox 160, leave-ground 100, wall push offset 60 /
// radius 50) are WORLD-space, so each is divided by the world scale to reach
// collision units. The constants inside the collision routines (+80, ±78) are
// already in collision units and stay raw.

import type { ProbeOptions } from "./invisibleWalls";
import type { FloorSelect } from "../collision/profile";

export interface SessionProbeConfig {
  worldScale: number;
  select: FloorSelect;
  /** Partition boundary, derived per level (never hardcoded). */
  boundary: number;
}

export function sessionProbeOptions(c: SessionProbeConfig): ProbeOptions {
  return {
    marioHeight: 160 / c.worldScale,
    ledgeGrace: 100 / c.worldScale,
    wallOffset: 60 / c.worldScale,
    wallRadius: 50 / c.worldScale,
    boundary: c.boundary,
    select: c.select,
  };
}
