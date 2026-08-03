// Handshake guard shared by both bridge servers (dev bridge in index.ts,
// packaged exe in standalone.ts). One copy so a fix can't land on one server
// and miss the other.

import type { IncomingMessage } from "node:http";
import { isAllowedOrigin } from "../../src/net/origin.js";

/** Both servers bind here — the bridge reads another process's memory and
 * must never be reachable from the network. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * `ws` verifyClient in its two-argument (async) form, so we can answer a
 * rejected handshake with 403 instead of the default 401.
 *
 * Loopback binding alone does NOT protect this endpoint: WebSockets are not
 * subject to the same-origin policy, so any web page open in the user's
 * browser could otherwise connect to ws://localhost:8081 and pull the full
 * RDRAM snapshot. See src/net/origin.ts for the policy itself.
 */
export function verifyClient(
  info: { origin?: string; secure: boolean; req: IncomingMessage },
  cb: (ok: boolean, code?: number, message?: string) => void,
): void {
  const origin = info.origin ?? info.req.headers.origin;
  if (isAllowedOrigin(origin)) {
    cb(true);
    return;
  }
  console.warn(`refused WebSocket handshake from origin ${origin}`);
  cb(false, 403, "Forbidden");
}
