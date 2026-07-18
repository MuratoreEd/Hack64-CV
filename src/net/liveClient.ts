// Browser-side WebSocket client for the Project64 bridge. Parses the streamed
// surface pool with the collision core and forwards state to the viewer.

import type { ServerMessage, StateMessage, ClientMessage } from "./protocol";
import { parseSurfacePool } from "../collision/surface";
import type { Surface } from "../collision/surface";

export interface LiveHandlers {
  onStatus(text: string, connected: boolean): void;
  onSurfaces(surfaces: Surface[]): void;
  onState(state: StateMessage): void;
  /** Full RDRAM snapshot (canonical big-endian), for the textured view. */
  onRdram(bytes: Uint8Array): void;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class LiveClient {
  private ws: WebSocket | null = null;

  constructor(
    private url: string,
    private handlers: LiveHandlers,
  ) {}

  connect(): void {
    if (this.ws) return;
    this.handlers.onStatus("connecting…", false);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.handlers.onStatus("connected", true);
    ws.onclose = () => {
      this.handlers.onStatus("disconnected", false);
      this.ws = null;
    };
    ws.onerror = () =>
      this.handlers.onStatus("error — is the bridge running?", false);
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
  }

  private onMessage(data: string): void {
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === "surfaces") {
      const buffer = base64ToArrayBuffer(msg.base64);
      const surfaces = parseSurfacePool(buffer, msg.count, {
        baseAddress: msg.poolBase,
      });
      this.handlers.onSurfaces(surfaces);
    } else if (msg.type === "state") {
      this.handlers.onState(msg);
    } else if (msg.type === "rdram") {
      this.handlers.onRdram(new Uint8Array(base64ToArrayBuffer(msg.base64)));
    }
  }

  send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  disconnect(): void {
    this.ws?.close();
  }
}
