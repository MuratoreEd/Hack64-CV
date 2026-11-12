// Runs the probe across several workers at once.
//
// Marching is embarrassingly parallel: what the probe reports for one surface's
// edges depends on the level's geometry, never on what it found for another
// surface. So each worker builds the same partition, marches every N-th surface
// (ProbeOptions.shard) and returns its raw segments; one worker then puts the
// slices back in order and merges them (combineShards). The result is the one a
// single worker would have produced — only sooner. A dense level that took a
// single worker ~40 s is the reason this exists.
//
// One run at a time: starting a run (or cancel()) terminates the workers of the
// run in flight, because a probe that is mid-march cannot be interrupted any
// other way and its answer is worthless once the inputs changed.

import type { Surface } from "../collision/surface";
import type { ProbeOptions, ProbeResult } from "./invisibleWalls";
import type { ProbeRequest, ProbeResponse } from "./protocol";

/** The slice of the Worker interface the pool uses (tests supply a fake). */
export interface WorkerLike {
  postMessage(message: ProbeRequest): void;
  terminate(): void;
  // Loosely typed on purpose: a real Worker's handlers take full DOM events,
  // and the pool only ever reads `data` / `message` off them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((e: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((e: any) => void) | null;
}

/** Workers to split a probe across: every core but one (the page stays
 * responsive), at most 8 — each holds its own copy of the level's partition,
 * and the march stops scaling well before that anyway. */
export function defaultPoolSize(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(8, cores - 1));
}

interface Job {
  id: number;
  shards: number;
  parts: ProbeResult[];
  combining: boolean;
  startedAt: number;
  onDone: (result: ProbeResult) => void;
  onError: (message: string) => void;
}

const defaultClock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export class ProbePool {
  private workers: WorkerLike[] = [];
  private seq = 0;
  private job: Job | null = null;

  constructor(
    private readonly spawn: () => WorkerLike,
    readonly size: number = defaultPoolSize(),
    private readonly clock: () => number = defaultClock,
  ) {}

  /** Whether a run is in flight. */
  get busy(): boolean {
    return this.job !== null;
  }

  /**
   * Probe `surfaces`, cancelling any run in flight. Exactly one of the
   * callbacks fires, once, unless the run is cancelled first (then neither).
   * `elapsedMs` of the result is the wall time of the whole run.
   */
  run(
    surfaces: Surface[],
    options: ProbeOptions,
    onDone: (result: ProbeResult) => void,
    onError: (message: string) => void,
  ): void {
    this.cancel();
    // More slices than surfaces would only be empty workers.
    const shards = Math.max(1, Math.min(this.size, surfaces.length));
    const job: Job = {
      id: ++this.seq,
      shards,
      parts: [],
      combining: false,
      startedAt: this.clock(),
      onDone,
      onError,
    };
    this.job = job;
    try {
      while (this.workers.length < shards) this.workers.push(this.attach());
      for (let i = 0; i < shards; i++) {
        this.workers[i].postMessage({
          id: job.id,
          kind: "march",
          surfaces,
          // A single worker runs the plain, unsharded probe: nothing to combine.
          options:
            shards === 1
              ? options
              : { ...options, shard: { index: i, count: shards } },
        });
      }
    } catch (err) {
      this.fail(job, err instanceof Error ? err.message : String(err));
    }
  }

  /** Abandon the run in flight (if any). Its callbacks never fire. */
  cancel(): void {
    if (!this.job) return;
    this.job = null;
    this.dropWorkers();
  }

  private attach(): WorkerLike {
    const w = this.spawn();
    w.onmessage = (e: { data: ProbeResponse }) => this.onMessage(e.data);
    // The worker itself failed (its module didn't load, it ran out of memory):
    // whatever run it was part of cannot finish.
    w.onerror = (e: { message?: string }) => {
      if (this.job) this.fail(this.job, e.message || "probe worker failed");
      else this.dropWorkers();
    };
    return w;
  }

  private dropWorkers(): void {
    for (const w of this.workers) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
    this.workers = [];
  }

  private fail(job: Job, message: string): void {
    if (this.job !== job) return;
    this.job = null;
    // Workers of a failed run are in an unknown state (some still marching).
    this.dropWorkers();
    job.onError(message);
  }

  private onMessage(data: ProbeResponse): void {
    const job = this.job;
    if (!job || data.id !== job.id) return; // superseded
    if ("error" in data) {
      this.fail(job, data.error);
      return;
    }
    if (job.shards > 1 && !job.combining) {
      job.parts.push(data.result);
      if (job.parts.length < job.shards) return;
      // Every slice is in: merge them off the main thread too (it is quadratic
      // in the worst case, and the page is rendering).
      job.combining = true;
      try {
        this.workers[0].postMessage({
          id: job.id,
          kind: "combine",
          parts: job.parts,
        });
      } catch (err) {
        this.fail(job, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    this.job = null;
    job.onDone({
      ...data.result,
      elapsedMs: this.clock() - job.startedAt,
      workers: job.shards,
    });
  }
}
