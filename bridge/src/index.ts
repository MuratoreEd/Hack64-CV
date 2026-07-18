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
} from "./rdram.js";
import type {
  ServerMessage,
  StateMessage,
  SurfacesMessage,
  ClientMessage,
} from "../../src/net/protocol.js";

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

function buildSurfacesMessage(rd: Rdram): SurfacesMessage {
  const pool = readSurfacePool(rd);
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
  const wss = new WebSocketServer({ port });
  console.log(`WebSocket bridge listening on ws://localhost:${port}`);

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws) => {
    console.log("viewer connected");
    try {
      send(ws, buildSurfacesMessage(rd));
      send(ws, buildStateMessage(readState(rd)));
    } catch (err) {
      console.error("initial read failed:", (err as Error).message);
    }
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      if (msg.type === "refresh") send(ws, buildSurfacesMessage(rd));
      if (msg.type === "rdram") {
        try {
          const snap = readRdramSnapshot(rd);
          send(ws, {
            type: "rdram",
            size: snap.length,
            base64: snap.toString("base64"),
          });
        } catch (err) {
          console.error("rdram snapshot failed:", (err as Error).message);
        }
      }
    });
    ws.on("close", () => console.log("viewer disconnected"));
  });

  // Poll game state; resend the full surface pool whenever its BYTES change
  // (not just level/area/count — dynamic surfaces are rewritten in place every
  // frame, so content can change while the count stays identical, and the
  // oracle needs a pool snapshot coherent with the state it validates against).
  let lastPool: Buffer | null = null;
  setInterval(() => {
    let state: ReturnType<typeof readState>;
    let surfacesMsg: SurfacesMessage;
    try {
      state = readState(rd);
      surfacesMsg = buildSurfacesMessage(rd);
    } catch (err) {
      console.error("read failed (emulator closed?):", (err as Error).message);
      return;
    }
    const poolBytes = Buffer.from(surfacesMsg.base64, "base64");
    const changed = lastPool === null || !lastPool.equals(poolBytes);
    lastPool = poolBytes;

    const stateMsg = buildStateMessage(state);
    for (const ws of wss.clients) {
      if (changed) send(ws, surfacesMsg);
      send(ws, stateMsg);
    }
  }, STATE_INTERVAL_MS);
}

function main(): void {
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
