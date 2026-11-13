// The bridge itself: attach to Project64, stream its collision surfaces and
// game state to every connected viewer, answer their requests. Shared by the
// dev bridge (index.ts) and the packaged exe (standalone.ts) — they differ only
// in how the WebSocket server comes to exist, and two copies of this loop had
// already drifted (only the exe waited for Project64 and re-attached).
//
//   - Lazy, retried, self-healing attachment: the bridge can start before the
//     emulator and outlives it being closed and reopened.
//   - Viewers are told whether Project64 is attached (BridgeMessage), so
//     "connected" never silently means "connected to nothing".
//   - The pool is resent whenever its BYTES change, not just level/area/count:
//     dynamic surfaces are rewritten in place every frame, and the oracle needs
//     a pool coherent with the state it is validated against.

import { WebSocket, type WebSocketServer } from "ws";
import { ProcessMemory, findProject64Pid } from "./win32.js";
import {
  discoverRdram,
  readState,
  readSurfacePool,
  readObjects,
  readRdramSnapshot,
  type Rdram,
  type SurfacePool,
} from "./rdram.js";
import type {
  BridgeMessage,
  ClientMessage,
  ServerMessage,
  SurfacesMessage,
} from "../../src/net/protocol.js";

const STATE_INTERVAL_MS = 100;
const ATTACH_RETRY_MS = 2000;
const WAIT_LOG_MS = 10000;
/** A viewer with this much unsent data queued is not keeping up (a tab the
 * browser has frozen, say). Piling a fresh ~1 MB pool behind it ten times a
 * second only grows the queue without bound — skip, and catch it up later. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function surfacesMessage(pool: SurfacePool): SurfacesMessage {
  return {
    type: "surfaces",
    count: pool.count,
    poolBase: pool.poolBase,
    base64: pool.bytes.toString("base64"),
  };
}

/** Run the bridge on an existing WebSocket server. Returns a stop function. */
export function startBridgeSession(wss: WebSocketServer): () => void {
  let attached: { proc: ProcessMemory; rd: Rdram } | null = null;
  let nextAttachTry = 0;
  let lastWaitLog = 0;
  let waitingFor = "looking for Project64";
  // The last good surface pool: what change detection compares against, and
  // what a viewer connecting mid-load (when the live pool isn't readable)
  // receives. Serialized at most once per change.
  let lastPool: SurfacePool | null = null;
  let lastPoolJson: string | null = null;
  // Viewers that were skipped when the pool last changed.
  const behind = new WeakSet<WebSocket>();
  // The object list as last broadcast (serialized), and the viewers that
  // missed it. Compared as text: it is small, and "changed" is all we ask.
  let lastObjectsJson: string | null = null;
  const behindObjects = new WeakSet<WebSocket>();
  const objectsJson = (rd: Rdram): string =>
    JSON.stringify({ type: "objects", ...readObjects(rd) });

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const bridgeMessage = (): BridgeMessage => ({
    type: "bridge",
    attached: attached !== null,
    detail: attached ? "" : waitingFor,
  });
  const broadcastStatus = (): void => {
    const json = JSON.stringify(bridgeMessage());
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  };
  const poolJson = (): string | null => {
    if (!lastPool) return null;
    lastPoolJson ??= JSON.stringify(surfacesMessage(lastPool));
    return lastPoolJson;
  };
  const setPool = (pool: SurfacePool): void => {
    lastPool = pool;
    lastPoolJson = null;
  };
  /** The pool for ONE viewer, right now (on connect, or on "refresh"): the
   * live one, else the last good one while a level is loading. Deliberately
   * leaves lastPool alone — that is what the broadcast tick diffs against, and
   * the other viewers haven't been sent this read. */
  const currentPoolJson = (rd: Rdram): string | null => {
    const fresh = readSurfacePool(rd);
    if (!fresh) return poolJson();
    if (lastPool && lastPool.bytes.equals(fresh.bytes)) return poolJson();
    return JSON.stringify(surfacesMessage(fresh));
  };

  /** Try to attach to a running Project64. Throttled: RDRAM discovery scans
   * the whole process (~0.15 s), so attempts happen every ATTACH_RETRY_MS. */
  function ensureAttached(): boolean {
    if (attached) return true;
    const now = Date.now();
    if (now < nextAttachTry) return false;
    nextAttachTry = now + ATTACH_RETRY_MS;
    try {
      const pid = findProject64Pid();
      if (pid == null) throw new Error("Project64 is not running");
      const proc = new ProcessMemory(pid);
      let rd: Rdram | null;
      try {
        rd = discoverRdram(proc);
      } catch (err) {
        proc.close();
        throw err;
      }
      if (rd == null) {
        proc.close();
        throw new Error("load a US SM64 ROM and enter a level");
      }
      attached = { proc, rd };
      lastPool = null; // force a fresh surface send to every viewer
      lastPoolJson = null;
      lastObjectsJson = null;
      console.log(
        `Attached to Project64 (pid ${pid}); RDRAM base 0x${rd.base.toString(16)}, byte order "${rd.order}".`,
      );
      broadcastStatus();
      return true;
    } catch (err) {
      const reason = (err as Error).message;
      if (reason !== waitingFor) {
        waitingFor = reason;
        broadcastStatus();
        lastWaitLog = 0; // a new reason is worth a line straight away
      }
      if (now - lastWaitLog > WAIT_LOG_MS) {
        console.log(`Waiting for Project64... (${reason})`);
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
    waitingFor = "Project64 was closed";
    broadcastStatus();
  }

  wss.on("connection", (ws) => {
    console.log("viewer connected");
    // A socket error (the tab was killed mid-send) is an 'error' EVENT; with
    // no listener Node turns it into an uncaught exception and the whole
    // bridge dies.
    ws.on("error", (err) => console.warn("viewer socket error:", err.message));
    send(ws, bridgeMessage());
    if (attached) {
      try {
        const json = currentPoolJson(attached.rd);
        if (json) ws.send(json);
        send(ws, { type: "state", ...readState(attached.rd) });
        ws.send(objectsJson(attached.rd));
      } catch (err) {
        detach((err as Error).message);
      }
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
      if (!msg || typeof msg !== "object") return;
      if (!attached) return; // the viewer gets data once Project64 is back
      try {
        if (msg.type === "refresh") {
          const json = currentPoolJson(attached.rd);
          if (json && ws.readyState === WebSocket.OPEN) ws.send(json);
        } else if (msg.type === "rdram") {
          const snap = readRdramSnapshot(attached.rd);
          send(ws, {
            type: "rdram",
            size: snap.length,
            base64: snap.toString("base64"),
          });
        }
      } catch (err) {
        // A failed READ means the emulator (or its RDRAM mapping) is gone.
        detach((err as Error).message);
      }
    });
    ws.on("close", () => console.log("viewer disconnected"));
  });

  const timer = setInterval(() => {
    if (!ensureAttached() || !attached) return;
    let pool: SurfacePool | null;
    let stateJson: string;
    let objJson: string;
    try {
      pool = readSurfacePool(attached.rd);
      stateJson = JSON.stringify({ type: "state", ...readState(attached.rd) });
      objJson = objectsJson(attached.rd);
    } catch (err) {
      // An unreadable pool mid-load is not an error (readSurfacePool says
      // null); a failed read is.
      detach((err as Error).message);
      return;
    }
    // No valid pool (mid-load): keep the viewers on the last good one.
    const changed =
      pool !== null && (lastPool === null || !lastPool.bytes.equals(pool.bytes));
    if (changed && pool) setPool(pool);
    const objectsChanged = objJson !== lastObjectsJson;
    lastObjectsJson = objJson;
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const congested = ws.bufferedAmount > MAX_BUFFERED_BYTES;
      if (changed || behind.has(ws)) {
        const json = congested ? null : poolJson();
        if (json) {
          ws.send(json);
          behind.delete(ws);
        } else {
          behind.add(ws);
        }
      }
      if (!congested) ws.send(stateJson);
      if (objectsChanged || behindObjects.has(ws)) {
        if (congested) behindObjects.add(ws);
        else {
          ws.send(objJson);
          behindObjects.delete(ws);
        }
      }
    }
  }, STATE_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    if (attached) {
      try {
        attached.proc.close();
      } catch {
        // handle already gone
      }
      attached = null;
    }
  };
}
