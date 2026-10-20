// Bridge entry point: attach to Project64, discover SM64-US RDRAM, and stream
// collision surfaces + game state to the viewer over WebSocket.
//
//   npm start            # run the WebSocket bridge
//   npm start -- --dump  # one-shot diagnostic: print what we found, then exit

import { WebSocketServer, WebSocket } from "ws";
import { ProcessMemory, findProject64Pid } from "./win32.js";
import {
  discoverRdram,
  dumpRegions,
  dumpDiagnostics,
  readState,
  readSurfacePool,
  readRdramSnapshot,
  type Rdram,
  type SurfacePool,
} from "./rdram.js";
import type {
  ServerMessage,
  StateMessage,
  SurfacesMessage,
  ClientMessage,
} from "../../src/net/protocol.js";
import { LOOPBACK_HOST, verifyClient } from "./wsGuard.js";
import { APP_VERSION } from "../../src/version.js";

const DEFAULT_PORT = 8081;
const STATE_INTERVAL_MS = 100;

function attach(): { proc: ProcessMemory; rd: Rdram } {
  const pid = findProject64Pid();
  if (pid == null) {
    throw new Error("Project64 not found. Is it running?");
  }
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (rd == null) {
    console.error(
      "Couldn't locate SM64 (US) RDRAM. Is a US ROM loaded and a level entered?",
    );
    dumpRegions(proc);
    dumpDiagnostics(proc);
    proc.close();
    throw new Error("RDRAM discovery failed");
  }
  console.log(
    `Attached to Project64 (pid ${pid}); RDRAM base 0x${rd.base.toString(16)}, byte order "${rd.order}".`,
  );
  return { proc, rd };
}

function surfacesMessage(pool: SurfacePool): SurfacesMessage {
  return {
    type: "surfaces",
    count: pool.count,
    poolBase: pool.poolBase,
    base64: pool.bytes.toString("base64"),
  };
}

function buildStateMessage(state: ReturnType<typeof readState>): StateMessage {
  return { type: "state", ...state };
}

function runDump(rd: Rdram): void {
  const state = readState(rd);
  const pool = readSurfacePool(rd);
  console.log("--- SM64 live state ---");
  console.log(`level ${state.level}, area ${state.area}`);
  console.log(
    `mario pos (${state.pos.x.toFixed(1)}, ${state.pos.y.toFixed(1)}, ${state.pos.z.toFixed(1)})`,
  );
  console.log(
    `floorHeight ${state.floorHeight.toFixed(1)} (surf 0x${state.floorAddr.toString(16)}), ` +
      `ceilHeight ${state.ceilHeight.toFixed(1)} (surf 0x${state.ceilAddr.toString(16)}), ` +
      `wall 0x${state.wallAddr.toString(16)}`,
  );
  if (!pool) {
    console.log("surfaces: no valid pool (mid level load, or not in a level)");
    return;
  }
  console.log(
    `surfaces: ${pool.count} @ pool base 0x${pool.poolBase.toString(16)} (${pool.bytes.length} bytes)`,
  );
  // Sanity: the floor pointer should fall inside the surface pool.
  if (state.floorAddr) {
    const idx = (state.floorAddr - pool.poolBase) / 0x30;
    console.log(
      `mario's floor is pool index ${idx}${Number.isInteger(idx) && idx >= 0 && idx < pool.count ? " (valid)" : " (!! outside pool)"}`,
    );
  }
}

function serve(proc: ProcessMemory, rd: Rdram, port: number): void {
  // Loopback only: this hands out the emulator's whole address space, so it
  // has no business being reachable from the network. The origin allowlist
  // covers the other half — a browser on THIS machine is also on loopback.
  const wss = new WebSocketServer({ port, host: LOOPBACK_HOST, verifyClient });
  console.log(`WebSocket bridge listening on ws://${LOOPBACK_HOST}:${port}`);

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // The last good pool: sent to each viewer on connect and on "refresh", and
  // what change detection compares against.
  let lastPool: SurfacePool | null = null;

  wss.on("connection", (ws) => {
    console.log("viewer connected");
    try {
      const pool = readSurfacePool(rd) ?? lastPool;
      if (pool) send(ws, surfacesMessage(pool));
      send(ws, buildStateMessage(readState(rd)));
    } catch (err) {
      console.error("initial read failed:", (err as Error).message);
    }
    ws.on("message", (data) => {
      // A malformed message must not take the bridge down: an exception out
      // of this listener is an uncaught exception for the whole process.
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      try {
        if (msg.type === "refresh") {
          const pool = readSurfacePool(rd) ?? lastPool;
          if (pool) send(ws, surfacesMessage(pool));
        }
        if (msg.type === "rdram") {
          const snap = readRdramSnapshot(rd);
          send(ws, {
            type: "rdram",
            size: snap.length,
            base64: snap.toString("base64"),
          });
        }
      } catch (err) {
        console.error(`${msg.type} request failed:`, (err as Error).message);
      }
    });
    ws.on("close", () => console.log("viewer disconnected"));
  });

  // Poll game state; resend the full surface pool whenever its BYTES change
  // (not just level/area/count — dynamic surfaces are rewritten in place every
  // frame, so content can change while the count stays identical, and the
  // oracle needs a pool snapshot coherent with the state it validates against).
  setInterval(() => {
    let state: ReturnType<typeof readState>;
    let pool: SurfacePool | null;
    try {
      state = readState(rd);
      pool = readSurfacePool(rd);
    } catch (err) {
      console.error("read failed (emulator closed?):", (err as Error).message);
      return;
    }
    // No valid pool (mid-load): keep the viewers on the last good one.
    const changed = pool !== null && (lastPool === null || !lastPool.bytes.equals(pool.bytes));
    if (changed) lastPool = pool;
    const surfacesMsg = changed && pool ? JSON.stringify(surfacesMessage(pool)) : null;
    const stateMsg = JSON.stringify(buildStateMessage(state));
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (surfacesMsg) ws.send(surfacesMsg);
      ws.send(stateMsg);
    }
  }, STATE_INTERVAL_MS);
}

function main(): void {
  console.log(`SM64 Invisible Wall Viewer bridge v${APP_VERSION}`);
  const args = process.argv.slice(2);
  const dump = args.includes("--dump");
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice(7), 10) : DEFAULT_PORT;

  let attached;
  try {
    attached = attach();
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
  const { proc, rd } = attached;

  if (dump) {
    runDump(rd);
    proc.close();
    return;
  }
  serve(proc, rd, port);
}

main();
