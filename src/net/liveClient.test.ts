import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LiveClient, type LiveHandlers } from "./liveClient";
import { parsePort } from "../../bridge/src/args";

/** Just enough of the browser's WebSocket for the client to drive. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  // Test controls.
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

interface Status {
  text: string;
  connected: boolean;
  active: boolean;
}

function setup(): { client: LiveClient; statuses: Status[]; bridge: [boolean, string][] } {
  const statuses: Status[] = [];
  const bridge: [boolean, string][] = [];
  const handlers: LiveHandlers = {
    onStatus: (text, connected, active) => statuses.push({ text, connected, active }),
    onSurfaces: () => {},
    onState: () => {},
    onRdram: () => {},
    onBridge: (attached, detail) => bridge.push([attached, detail]),
  };
  return { client: new LiveClient("ws://test", handlers), statuses, bridge };
}

const last = <T>(a: T[]): T => a[a.length - 1];

describe("LiveClient connection lifecycle", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a failed first attempt and does not retry behind the user's back", () => {
    const { client, statuses } = setup();
    client.connect();
    expect(last(statuses)).toMatchObject({ text: "connecting…", active: true });
    FakeSocket.instances[0].fail();
    expect(last(statuses).text).toMatch(/is the bridge running/);
    expect(last(statuses).active).toBe(false);
    expect(client.active).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("retries an ESTABLISHED connection that drops, until it comes back", () => {
    const { client, statuses } = setup();
    client.connect();
    FakeSocket.instances[0].open();
    expect(last(statuses)).toMatchObject({ text: "connected", connected: true });
    FakeSocket.instances[0].drop(); // the exe was closed
    expect(last(statuses).text).toMatch(/reconnecting/);
    expect(client.active).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].fail(); // still down
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].open(); // relaunched
    expect(last(statuses)).toMatchObject({ text: "connected", connected: true, active: true });
  });

  it("disconnect() stops for good — no retry, and a later drop is ignored", () => {
    const { client, statuses } = setup();
    client.connect();
    FakeSocket.instances[0].open();
    client.disconnect();
    expect(last(statuses)).toMatchObject({ text: "disconnected", connected: false, active: false });
    const count = statuses.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses).toHaveLength(count); // the socket's own close said nothing more
  });

  it("disconnect() during a retry wait cancels the retry", () => {
    const { client } = setup();
    client.connect();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].drop();
    client.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("connect() while already active opens nothing new", () => {
    const { client } = setup();
    client.connect();
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("forwards the bridge's Project64 status, and survives junk", () => {
    const { client, bridge } = setup();
    client.connect();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.onmessage?.({ data: "not json" });
    ws.onmessage?.({
      data: JSON.stringify({ type: "bridge", attached: false, detail: "Project64 is not running" }),
    });
    ws.onmessage?.({ data: JSON.stringify({ type: "bridge", attached: true, detail: "" }) });
    expect(bridge).toEqual([
      [false, "Project64 is not running"],
      [true, ""],
    ]);
  });

  it("only sends while the socket is open", () => {
    const { client } = setup();
    client.send({ type: "rdram" }); // not connected: dropped, not thrown
    client.connect();
    const ws = FakeSocket.instances[0];
    client.send({ type: "rdram" }); // still connecting
    expect(ws.sent).toHaveLength(0);
    ws.open();
    client.send({ type: "rdram" });
    expect(ws.sent).toEqual(['{"type":"rdram"}']);
  });
});

describe("parsePort (bridge --port=N)", () => {
  it("uses the fallback when the flag is absent", () => {
    expect(parsePort(["--no-open"], 8081)).toBe(8081);
  });
  it("reads a valid port", () => {
    expect(parsePort(["--no-open", "--port=8097"], 8081)).toBe(8097);
  });
  it("rejects anything that isn't a port instead of listening somewhere random", () => {
    for (const bad of ["--port=", "--port=abc", "--port=0", "--port=70000", "--port=80.5", "--port=-1"]) {
      expect(() => parsePort([bad], 8081)).toThrow(/invalid/);
    }
  });
});
