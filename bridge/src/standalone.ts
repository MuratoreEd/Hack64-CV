// Standalone (packaged .exe) entry point: one process that
//   1. serves the BUILT viewer (dist/, embedded in the exe) over HTTP,
//   2. runs the WebSocket bridge on the SAME port,
//   3. waits for Project64 instead of crashing when it isn't up yet, and
//      re-attaches automatically when the emulator is closed and reopened,
//   4. opens the viewer in the default browser (unless --no-open),
//   5. if another instance is already serving, just opens the browser.
//
// Dev never uses this file (start.cmd runs index.ts + Vite); it exists for
// `npm run build:exe`, which bundles it with esbuild and packs it with pkg.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { ProcessMemory, findProject64Pid } from "./win32.js";
import {
  discoverRdram,
  readState,
  readSurfacePool,
  readRdramSnapshot,
  type Rdram,
} from "./rdram.js";
import type {
  ServerMessage,
  SurfacesMessage,
  ClientMessage,
} from "../../src/net/protocol.js";

const VERSION = "1.0.0";
const DEFAULT_PORT = 8081;
const STATE_INTERVAL_MS = 100;
const ATTACH_RETRY_MS = 2000;
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

// --- Project64 attachment (lazy, retried, self-healing) ---

let attached: { proc: ProcessMemory; rd: Rdram } | null = null;
let nextAttachTry = 0;
let lastWaitLog = 0;
let lastPool: Buffer | null = null;

/** Try to attach to a running Project64. Throttled: RDRAM discovery scans the
 * whole process, so failed attempts only happen every ATTACH_RETRY_MS. */
function ensureAttached(): boolean {
  if (attached) return true;
  const now = Date.now();
  if (now < nextAttachTry) return false;
  nextAttachTry = now + ATTACH_RETRY_MS;
  try {
    const pid = findProject64Pid();
    if (pid == null) throw new Error("Project64 is not running");
    const proc = new ProcessMemory(pid);
    const rd = discoverRdram(proc);
    if (rd == null) {
      proc.close();
      throw new Error("SM64 (US) not found in RAM - load the ROM and enter a level");
    }
    attached = { proc, rd };
    lastPool = null; // force a fresh surface send to every viewer
    console.log(
      `Attached to Project64 (pid ${pid}); RDRAM base 0x${rd.base.toString(16)}, byte order "${rd.order}".`,
    );
    return true;
  } catch (err) {
    if (now - lastWaitLog > 10000) {
      console.log(`Waiting for Project64... (${(err as Error).message})`);
      lastWaitLog = now;
    }
    return false;
  }
}

function detach(reason: string): void {
  if (!attached) return;
  console.log(`Lost Project64 (${reason}) - waiting for it to come back.`);
  try {
    attached.proc.close();
  } catch {
    // handle already gone
  }
  attached = null;
}

// --- Bridge messages (same wire protocol as the dev bridge) ---

function buildSurfacesMessage(rd: Rdram): SurfacesMessage {
  const pool = readSurfacePool(rd);
  return {
    type: "surfaces",
    count: pool.count,
    poolBase: pool.poolBase,
    base64: pool.bytes.toString("base64"),
  };
}

const send = (ws: WebSocket, msg: ServerMessage): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

// --- HTTP static serving of the embedded viewer ---

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0];
  if (url === HEALTH_PATH) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(HEALTH_BODY);
    return;
  }
  // Normalize and refuse anything that escapes the dist directory.
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.normalize(path.join(distDir, rel));
  if (!file.startsWith(distDir)) {
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
  });
  res.end(body);
}

// --- Startup ---

function openBrowser(url: string): void {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** Is another instance of us already serving on this port? */
async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}${HEALTH_PATH}`, {
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
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice(7), 10) : DEFAULT_PORT;
  const url = `http://localhost:${port}`;

  console.log(`SM64 Invisible Wall Viewer v${VERSION}`);
  console.log("----------------------------------------");

  if (await alreadyRunning(port)) {
    console.log(`Already running at ${url} - opening your browser.`);
    if (!noOpen) openBrowser(url);
    return;
  }

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("viewer connected");
    if (attached) {
      try {
        send(ws, buildSurfacesMessage(attached.rd));
        send(ws, { type: "state", ...readState(attached.rd) });
      } catch (err) {
        detach((err as Error).message);
      }
    }
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (!attached) return; // viewer will get data once PJ64 is back
      try {
        if (msg.type === "refresh") send(ws, buildSurfacesMessage(attached.rd));
        if (msg.type === "rdram") {
          const snap = readRdramSnapshot(attached.rd);
          send(ws, {
            type: "rdram",
            size: snap.length,
            base64: snap.toString("base64"),
          });
        }
      } catch (err) {
        detach((err as Error).message);
      }
    });
    ws.on("close", () => console.log("viewer disconnected"));
  });

  // Poll loop: attach when possible, stream state, resend the pool when its
  // bytes change (dynamic surfaces rewrite in place), self-heal on read errors.
  setInterval(() => {
    if (!ensureAttached() || !attached) return;
    let surfacesMsg: SurfacesMessage;
    let stateMsg: ServerMessage;
    try {
      surfacesMsg = buildSurfacesMessage(attached.rd);
      stateMsg = { type: "state", ...readState(attached.rd) };
    } catch (err) {
      detach((err as Error).message);
      return;
    }
    const poolBytes = Buffer.from(surfacesMsg.base64, "base64");
    const changed = lastPool === null || !lastPool.equals(poolBytes);
    lastPool = poolBytes;
    for (const ws of wss.clients) {
      if (changed) send(ws, surfacesMsg);
      send(ws, stateMsg);
    }
  }, STATE_INTERVAL_MS);

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

  server.listen(port, () => {
    console.log(`Viewer running at ${url}`);
    console.log("Start Project64 with a US SM64 ROM and enter a level,");
    console.log('then click "Connect to Project64" in the browser.');
    console.log("");
    console.log("Keep this window open while you use the viewer.");
    if (!noOpen) openBrowser(url);
  });
}

void main();
