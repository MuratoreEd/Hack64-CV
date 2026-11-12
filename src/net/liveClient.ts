// Browser-side WebSocket client for the Project64 bridge. Parses the streamed
// surface pool with the collision core and forwards state to the viewer.

import type { ServerMessage, StateMessage, ClientMessage } from "./protocol";
import { parseSurfacePool } from "../collision/surface";
import type { Surface } from "../collision/surface";

export interface LiveHandlers {
  /** `connected`: the socket is open. `active`: the client is connected,
   * connecting or retrying — i.e. the user's next click means "stop". */
  onStatus(text: string, connected: boolean, active: boolean): void;
  onSurfaces(surfaces: Surface[]): void;
  onState(state: StateMessage): void;
  /** Full RDRAM snapshot (canonical big-endian), for the textured view. */
  onRdram(bytes: Uint8Array): void;
  /** Whether the bridge currently has Project64 (and if not, why). */
  onBridge?(attached: boolean, detail: string): void;
}

/** How long after losing an established connection before trying again. */
const RETRY_MS = 2000;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  // The user asked for a connection and hasn't cancelled it: a connection that
  // drops is retried for as long as this holds.
  private wantOpen = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // Wall-classification cutoff for parsing (CollisionProfile.wallThreshold).
  // Detected live, so the last pool is retained: when the verdict changes the
  // pool must be re-classified rather than waiting for the next stream.
  private wallThreshold: number | undefined;
  private lastPool: { buffer: ArrayBuffer; count: number; base: number } | null =
    null;

  constructor(
    private url: string,
    private handlers: LiveHandlers,
  ) {}

  /** The raw pool exactly as the bridge delivered it (canonical big-endian),
   * for ground-truth capture: the corpus stores bytes, not parsed surfaces, so
   * a replay can re-classify them under any collision profile. */
  get rawPool(): { buffer: ArrayBuffer; count: number; base: number } | null {
    return this.lastPool;
  }

  /** Connected, connecting, or waiting to retry. */
  get active(): boolean {
    return this.wantOpen;
  }

  /** Re-classify the current pool under a new wall threshold. No-op when the
   * threshold is unchanged or no pool has arrived yet. */
  setWallThreshold(threshold: number): void {
    if (threshold === this.wallThreshold) return;
    this.wallThreshold = threshold;
    const p = this.lastPool;
    if (!p) return;
    this.handlers.onSurfaces(
      parseSurfacePool(p.buffer, p.count, {
        baseAddress: p.base,
        wallThreshold: threshold,
      }),
    );
  }

  connect(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.open(false);
  }

  /** Close the connection (or stop retrying) and stay closed. */
  disconnect(): void {
    this.wantOpen = false;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.handlers.onStatus("disconnected", false, false);
  }

  private open(isRetry: boolean): void {
    if (this.ws) return;
    if (!isRetry) this.handlers.onStatus("connecting…", false, true);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.handlers.onStatus("connected", true, true);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // disconnect() already reported it
      this.ws = null;
      if (opened || isRetry) {
        // An established connection went away — the exe was closed or is being
        // rebuilt. Keep trying, so starting it again brings the viewer back
        // without a click.
        this.handlers.onStatus("bridge lost — reconnecting…", false, true);
        this.retry = setTimeout(() => {
          this.retry = null;
          if (this.wantOpen) this.open(true);
        }, RETRY_MS);
      } else {
        // The very first attempt failed: that is an answer to the user's
        // click, not something to retry behind their back.
        this.wantOpen = false;
        this.handlers.onStatus("error — is the bridge running?", false, false);
      }
    };
    // A failed connection fires error THEN close; close reports it.
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data as string);
    };
  }

  private onMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return; // not ours
    }
    if (msg.type === "surfaces") {
      const buffer = base64ToArrayBuffer(msg.base64);
      this.lastPool = { buffer, count: msg.count, base: msg.poolBase };
      const surfaces = parseSurfacePool(buffer, msg.count, {
        baseAddress: msg.poolBase,
        wallThreshold: this.wallThreshold,
      });
      this.handlers.onSurfaces(surfaces);
    } else if (msg.type === "state") {
      this.handlers.onState(msg);
    } else if (msg.type === "rdram") {
      this.handlers.onRdram(new Uint8Array(base64ToArrayBuffer(msg.base64)));
    } else if (msg.type === "bridge") {
      this.handlers.onBridge?.(msg.attached, msg.detail);
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
