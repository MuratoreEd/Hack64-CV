// Web Worker wrapper for the invisible-wall probe: floor+ceiling edge marching
// over a full level takes seconds, so it runs off the main thread — split
// across several of these by ProbePool. Surfaces are plain objects and survive
// structured clone; the probe builds its own static-only partition internally.
// The request handling itself lives in protocol.ts.

/// <reference lib="webworker" />

import { handleProbeRequest, type ProbeRequest } from "./protocol";

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  self.postMessage(handleProbeRequest(e.data));
};
