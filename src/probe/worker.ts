// Web Worker wrapper for the invisible-wall probe: floor+ceiling edge marching
// over a full level takes seconds, so it runs off the main thread. Surfaces are
// plain objects and survive structured clone; the probe builds its own
// static-only partition internally.
//
// Every request carries an id and every answer echoes it, so the page can tell
// the result it is waiting for from a superseded one — and a failure comes back
// as an answer too, instead of leaving the page waiting forever.

/// <reference lib="webworker" />

import { findInvisibleWalls, type ProbeOptions, type ProbeResult } from "./invisibleWalls";
import type { Surface } from "../collision/surface";

export interface ProbeRequest {
  id: number;
  surfaces: Surface[];
  options: ProbeOptions;
}

export type ProbeResponse =
  | { id: number; result: ProbeResult }
  | { id: number; error: string };

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  const { id, surfaces, options } = e.data;
  let response: ProbeResponse;
  try {
    response = { id, result: findInvisibleWalls(surfaces, options) };
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
