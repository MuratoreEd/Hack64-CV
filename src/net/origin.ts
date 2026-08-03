// WebSocket handshake origin policy, shared by both bridge servers (dev
// bridge and packaged exe). Kept dependency-free so Node can import it.
//
// Why this exists: WebSockets are exempt from the same-origin policy, so
// without an Origin check ANY page the user happens to have open can connect
// to the bridge and ask for `{type:"rdram"}` — the emulator's full 8 MB RAM.
// Binding to 127.0.0.1 does not help: the browser making the request is on
// the same machine.

/** Hosts we consider "this machine". */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "[::1]" || h === "::1") return true;
  // 127.0.0.0/8 is entirely loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Should a WebSocket handshake carrying this `Origin` header be accepted?
 *
 * - No Origin at all → accept. Non-browser tooling (our own scripts, wscat)
 *   sends no Origin, and anything that omits it is not a web page acting on
 *   an unwitting user's behalf.
 * - A loopback origin on ANY port → accept. Dev serves the viewer on 5173
 *   against the bridge on 8081; the exe serves it on 8081 itself.
 * - Everything else, including the literal "null" that file:// pages and
 *   sandboxed iframes send → reject.
 */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (origin == null || origin === "") return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null", garbage, or a bare host — not a usable origin
  }
  return isLoopbackHost(url.hostname);
}
