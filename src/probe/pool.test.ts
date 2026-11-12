import { describe, it, expect } from "vitest";
import { makeSurface } from "../collision/geometry";
import type { Surface } from "../collision/surface";
import { findInvisibleWalls, type ProbeResult } from "./invisibleWalls";
import { ProbePool, type WorkerLike } from "./pool";
import { handleProbeRequest, type ProbeRequest, type ProbeResponse } from "./protocol";

const floorQuad = (x0: number, x1: number, z0: number, z1: number, y = 0): Surface[] => [
  makeSurface([x0, y, z0], [x0, y, z1], [x1, y, z1])!,
  makeSurface([x0, y, z0], [x1, y, z1], [x1, y, z0])!,
];
const ceilQuad = (x0: number, x1: number, z0: number, z1: number, y: number): Surface[] => [
  makeSurface([x0, y, z0], [x1, y, z1], [x0, y, z1])!,
  makeSurface([x0, y, z0], [x1, y, z0], [x1, y, z1])!,
];
const scene: Surface[] = [
  ...floorQuad(-300, 300, -300, 300),
  ...ceilQuad(-300, 0, -300, 300, 100),
  ...ceilQuad(100, 200, -100, 100, 120),
].map((s, index) => ({ ...s, index, address: 0x80200000 + index * 0x30 }));

/** A worker that answers on a later tick, like the real thing, running the
 * same handler the real worker runs. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: ProbeResponse }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  terminated = false;
  requests: ProbeRequest[] = [];
  /** Hold answers back until release() (to test cancelling mid-run). */
  static held = false;
  private pending: (() => void)[] = [];

  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: ProbeRequest): void {
    this.requests.push(message);
    // structuredClone, as postMessage does: the pool must not rely on shared
    // object identity across the boundary.
    const answer = () => {
      if (this.terminated) return;
      const response = structuredClone(handleProbeRequest(structuredClone(message)));
      this.onmessage?.({ data: response });
    };
    if (FakeWorker.held) this.pending.push(answer);
    else setTimeout(answer, 0);
  }
  release(): void {
    const run = this.pending;
    this.pending = [];
    for (const f of run) f();
  }
  terminate(): void {
    this.terminated = true;
  }
}

const reset = (): void => {
  FakeWorker.all = [];
  FakeWorker.held = false;
};

const runPool = (size: number): Promise<{ result: ProbeResult; pool: ProbePool }> =>
  new Promise((resolve, reject) => {
    const pool = new ProbePool(() => new FakeWorker(), size);
    pool.run(scene, {}, (result) => resolve({ result, pool }), reject);
  });

describe("ProbePool", () => {
  it("returns what a single unsharded run returns, across several workers", async () => {
    reset();
    const whole = findInvisibleWalls(scene);
    expect(whole.segments.length).toBeGreaterThan(0);
    for (const size of [1, 2, 4]) {
      reset();
      const { result, pool } = await runPool(size);
      expect(result.segments).toEqual(whole.segments);
      expect(result.samplesProbed).toBe(whole.samplesProbed);
      expect(result.workers).toBe(size);
      expect(result.segmentOrder).toBeUndefined();
      expect(pool.busy).toBe(false);
      expect(FakeWorker.all).toHaveLength(size);
    }
  });

  it("runs one worker unsharded, with no combine round trip", async () => {
    reset();
    await runPool(1);
    const [w] = FakeWorker.all;
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0].kind).toBe("march");
    expect((w.requests[0] as { options: { shard?: unknown } }).options.shard).toBeUndefined();
  });

  it("never uses more workers than there are surfaces", async () => {
    reset();
    const { result } = await runPool(64);
    expect(result.workers).toBe(scene.length);
  });

  it("reuses its workers for the next run", async () => {
    reset();
    const pool = new ProbePool(() => new FakeWorker(), 3);
    const once = () =>
      new Promise<ProbeResult>((resolve, reject) => pool.run(scene, {}, resolve, reject));
    const a = await once();
    const b = await once();
    expect(b.segments).toEqual(a.segments);
    expect(FakeWorker.all).toHaveLength(3);
  });

  it("a newer run cancels the one in flight: only the newer one reports", async () => {
    reset();
    FakeWorker.held = true;
    const pool = new ProbePool(() => new FakeWorker(), 2);
    let firstDone = 0;
    pool.run(scene, {}, () => firstDone++, () => firstDone++);
    const firstWorkers = [...FakeWorker.all];
    FakeWorker.held = false;
    const second = new Promise<ProbeResult>((resolve, reject) =>
      pool.run(scene, {}, resolve, reject),
    );
    // The first run's workers were terminated, not left to finish.
    expect(firstWorkers.every((w) => w.terminated)).toBe(true);
    for (const w of firstWorkers) w.release(); // answers nobody is waiting for
    const result = await second;
    expect(result.segments).toEqual(findInvisibleWalls(scene).segments);
    expect(firstDone).toBe(0);
  });

  it("cancel() drops the run: no callback, pool idle", async () => {
    reset();
    FakeWorker.held = true;
    const pool = new ProbePool(() => new FakeWorker(), 2);
    let calls = 0;
    pool.run(scene, {}, () => calls++, () => calls++);
    expect(pool.busy).toBe(true);
    pool.cancel();
    expect(pool.busy).toBe(false);
    for (const w of FakeWorker.all) w.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(0);
  });

  it("reports a probe that throws, once, and recovers for the next run", async () => {
    reset();
    const pool = new ProbePool(() => new FakeWorker(), 2);
    const bad = [{ ...scene[0], vertices: null }] as unknown as Surface[];
    const message = await new Promise<string>((resolve) =>
      pool.run([...bad, ...scene], {}, () => resolve("unexpectedly fine"), resolve),
    );
    expect(message).not.toBe("unexpectedly fine");
    expect(pool.busy).toBe(false);
    const again = await new Promise<ProbeResult>((resolve, reject) =>
      pool.run(scene, {}, resolve, reject),
    );
    expect(again.segments).toEqual(findInvisibleWalls(scene).segments);
  });

  it("reports a worker that dies (its module failing to load)", async () => {
    reset();
    FakeWorker.held = true;
    const pool = new ProbePool(() => new FakeWorker(), 2);
    const message = new Promise<string>((resolve) =>
      pool.run(scene, {}, () => resolve("unexpectedly fine"), resolve),
    );
    FakeWorker.all[0].onerror?.({ message: "boom" });
    expect(await message).toBe("boom");
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    expect(pool.busy).toBe(false);
  });

  it("measures the whole run on its own clock", async () => {
    reset();
    let now = 1000;
    const pool = new ProbePool(() => new FakeWorker(), 2, () => now);
    const result = await new Promise<ProbeResult>((resolve, reject) => {
      pool.run(scene, {}, resolve, reject);
      now = 4500;
    });
    expect(result.elapsedMs).toBe(3500);
  });
});
