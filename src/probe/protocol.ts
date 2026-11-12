// What the page and a probe worker say to each other, and the worker's side of
// it as a plain function — so the pool can be tested (and driven) without a
// real Worker.
//
// Every request carries an id and every answer echoes it, so the page can tell
// the result it is waiting for from a superseded one — and a failure comes back
// as an answer too, instead of leaving the page waiting forever.

import {
  combineShards,
  findInvisibleWalls,
  type ProbeOptions,
  type ProbeResult,
} from "./invisibleWalls";
import type { Surface } from "../collision/surface";

export type ProbeRequest =
  /** March the level (or the slice `options.shard` names). */
  | { id: number; kind: "march"; surfaces: Surface[]; options: ProbeOptions }
  /** Reassemble and merge the slices of one run (see combineShards). */
  | { id: number; kind: "combine"; parts: ProbeResult[] };

export type ProbeResponse =
  | { id: number; result: ProbeResult }
  | { id: number; error: string };

export function handleProbeRequest(req: ProbeRequest): ProbeResponse {
  try {
    const result =
      req.kind === "combine"
        ? combineShards(req.parts)
        : findInvisibleWalls(req.surfaces, req.options);
    return { id: req.id, result };
  } catch (err) {
    return {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
