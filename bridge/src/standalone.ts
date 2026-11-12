// Standalone (packaged .exe) entry point: one process that
//   1. serves the BUILT viewer (dist/, embedded in the exe) over HTTP,
//   2. runs the WebSocket bridge on the SAME port (session.ts — which waits
//      for Project64 instead of crashing when it isn't up yet, and re-attaches
//      automatically when the emulator is closed and reopened),
//   3. opens the viewer in the default browser (unless --no-open),
//   4. if another instance is already serving, just opens the browser.
//
// Dev never uses this file (start.cmd runs index.ts + Vite); it exists for
// `npm run build:exe`, which bundles it with esbuild and packs it with pkg.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { LOOPBACK_HOST, verifyClient } from "./wsGuard.js";
import { startBridgeSession } from "./session.js";
import { parsePort } from "./args.js";
import { APP_VERSION as VERSION } from "../../src/version.js";

const DEFAULT_PORT = 8081;
const HEALTH_PATH = "/iwv-health";
const HEALTH_BODY = `sm64-iwv ${VERSION}`;

// Inside the pkg snapshot, __dirname points at the embedded app directory; the
// viewer build is staged next to this bundle as ./dist by scripts/buildExe.mjs.
const distDir = path.join(__dirname, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// --- HTTP static serving of the embedded viewer ---

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0];
  if (url === HEALTH_PATH) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(HEALTH_BODY);
    return;
  }
  // Normalize and refuse anything that escapes the dist directory. (A bare
  // prefix test would also admit a sibling such as "dist-old/".)
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.normalize(path.join(distDir, rel));
  const inside = path.relative(distDir, file);
  const escapes = inside === ".." || inside.startsWith(`..${path.sep}`);
  if (inside === "" || escapes || path.isAbsolute(inside)) {
    res.writeHead(403).end();
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    // The exe is rebuilt constantly and its asset names only change when their
    // content does — but index.html keeps its name, and a cached copy would
    // go on loading the previous build's script.
    "cache-control": "no-cache",
  });
  res.end(body);
}

// --- Startup ---

function openBrowser(url: string): void {
  // Quoted verbatim: `start` takes the first quoted argument as a window title
  // (hence the empty ""), and the URL itself is quoted so a query string can
  // never be split or misread by cmd.
  spawn("cmd", ["/c", `start "" "${url}"`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
}

/** Is another instance of us already serving on this port? Asked of the
 * address we actually bind (not "localhost", which may resolve to ::1 first
 * and cost the full timeout before falling back). */
async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(1500),
    });
    return (await res.text()).startsWith("sm64-iwv");
  } catch {
    return false;
  }
}

/** Keep the console window alive so a double-clicking user can read the error. */
function hang(message: string): Promise<never> {
  console.log("");
  console.log(message);
  console.log("Close this window when you're done.");
  return new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noOpen = args.includes("--no-open");

  console.log(`SM64 Invisible Wall Viewer v${VERSION}`);
  console.log("----------------------------------------");

  let port: number;
  try {
    port = parsePort(args, DEFAULT_PORT);
  } catch (err) {
    await hang((err as Error).message);
    return;
  }
  const url = `http://localhost:${port}`;

  if (await alreadyRunning(port)) {
    console.log(`Already running at ${url} - opening your browser.`);
    if (!noOpen) openBrowser(url);
    return;
  }

  const server = http.createServer(serveStatic);
  // Origin allowlist: WebSockets ignore the same-origin policy, so without it
  // any page open in the user's browser could pull the emulator's RAM.
  const wss = new WebSocketServer({ server, verifyClient });
  // The http server's errors are re-emitted here; they're handled below.
  wss.on("error", () => {});

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      void hang(
        `Port ${port} is taken by another program. Close it and relaunch, ` +
          `or run this exe with --port=8082`,
      );
    } else {
      void hang(`Server error: ${err.message}`);
    }
  });

  // Loopback only — the viewer and the emulator are both on this machine, and
  // the bridge hands out the emulator's entire address space.
  server.listen(port, LOOPBACK_HOST, () => {
    console.log(`Viewer running at ${url}`);
    console.log("Start Project64 with a US SM64 ROM and enter a level,");
    console.log('then click "Connect to Project64" in the browser.');
    console.log("");
    console.log("Keep this window open while you use the viewer.");
    startBridgeSession(wss);
    if (!noOpen) openBrowser(url);
  });
}

// A double-clicked console window closes the instant the process dies, taking
// the reason with it: say what happened and stay open instead.
process.on("uncaughtException", (err) => {
  void hang(`Unexpected error: ${err.stack ?? err.message}`);
});

void main();
