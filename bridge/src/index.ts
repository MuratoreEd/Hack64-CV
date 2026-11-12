// Dev bridge entry point: attach to Project64, discover SM64-US RDRAM, and
// stream collision surfaces + game state to the viewer over WebSocket. The
// serving loop is session.ts, shared with the packaged exe.
//
//   npm start            # run the WebSocket bridge
//   npm start -- --dump  # one-shot diagnostic: print what we found, then exit

import { WebSocketServer } from "ws";
import { ProcessMemory, findProject64Pid } from "./win32.js";
import {
  discoverRdram,
  dumpRegions,
  dumpDiagnostics,
  readState,
  readSurfacePool,
  type Rdram,
} from "./rdram.js";
import { LOOPBACK_HOST, verifyClient } from "./wsGuard.js";
import { startBridgeSession } from "./session.js";
import { parsePort } from "./args.js";
import { APP_VERSION } from "../../src/version.js";

const DEFAULT_PORT = 8081;

function runDump(): void {
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not found. Is it running?");
  const proc = new ProcessMemory(pid);
  try {
    const rd = discoverRdram(proc);
    if (rd == null) {
      console.error(
        "Couldn't locate SM64 (US) RDRAM. Is a US ROM loaded and a level entered?",
      );
      dumpRegions(proc);
      dumpDiagnostics(proc);
      throw new Error("RDRAM discovery failed");
    }
    console.log(
      `Attached to Project64 (pid ${pid}); RDRAM base 0x${rd.base.toString(16)}, byte order "${rd.order}".`,
    );
    printState(rd);
  } finally {
    proc.close();
  }
}

function printState(rd: Rdram): void {
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

function main(): void {
  console.log(`SM64 Invisible Wall Viewer bridge v${APP_VERSION}`);
  const args = process.argv.slice(2);
  try {
    if (args.includes("--dump")) {
      runDump();
      return;
    }
    const port = parsePort(args, DEFAULT_PORT);
    // Loopback only: this hands out the emulator's whole address space, so it
    // has no business being reachable from the network. The origin allowlist
    // covers the other half — a browser on THIS machine is also on loopback.
    const wss = new WebSocketServer({ port, host: LOOPBACK_HOST, verifyClient });
    wss.on("error", (err: NodeJS.ErrnoException) => {
      console.error(
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use - is another bridge (or the exe) running?`
          : `Server error: ${err.message}`,
      );
      process.exit(1);
    });
    wss.on("listening", () => {
      console.log(`WebSocket bridge listening on ws://${LOOPBACK_HOST}:${port}`);
      startBridgeSession(wss);
    });
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
