// Web Worker wrapper for the invisible-wall probe: floor+ceiling edge marching
// over a full level takes a noticeable chunk of a second, so it runs off the
// main thread. Surfaces are plain objects and survive structured clone; the
// probe builds its own static-only partition internally.

/// <reference lib="webworker" />

import { findInvisibleWalls, type ProbeOptions } from "./invisibleWalls";
import type { Surface } from "../collision/surface";

export interface ProbeRequest {
  surfaces: Surface[];
  options: ProbeOptions;
}

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  const { surfaces, options } = e.data;
  self.postMessage(findInvisibleWalls(surfaces, options));
};
