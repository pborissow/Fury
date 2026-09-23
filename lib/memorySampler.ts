import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { furyLogsDir } from './furyHome';
import type { MemorySample } from './memoryReport';

/**
 * Periodic memory telemetry.
 *
 * A single snapshot can't distinguish "big" from "growing", and the failure
 * being chased takes days to reach the heap limit. This appends a compact
 * sample every interval so the RATE and the SHAPE of growth are recoverable
 * after the fact — including from a run that ended in an OOM, since samples are
 * on disk rather than only in memory.
 *
 * Constraints it holds itself to, being a memory diagnostic:
 *  - The in-memory ring is capped (MAX_RING) — telemetry must not leak.
 *  - Writes are serialized behind one rolling promise. An unqueued
 *    fire-and-forget appendFile per sample is itself an unbounded backlog if
 *    the disk stalls, which is the exact pattern being hunted.
 *  - The interval is unref'd so it never keeps the process alive.
 */

const SAMPLE_INTERVAL_MS = 60_000;
/** ~8h at one sample/min. Enough to show a trend without holding much. */
const MAX_RING = 500;

class MemorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ring: MemorySample[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private collect: (() => MemorySample) | null = null;
  private writeErrors = 0;
  startedAt = 0;

  /** Idempotent. The first caller supplies the collector. */
  start(collect: () => MemorySample, intervalMs = SAMPLE_INTERVAL_MS): void {
    this.collect = collect;
    if (this.timer) return;
    this.startedAt = Date.now();

    // Take one immediately so there is always a baseline to diff against, even
    // if the process dies before the first interval elapses.
    this.sampleNow();

    this.timer = setInterval(() => this.sampleNow(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Take a sample now, ring-buffer it, and queue it for disk. */
  sampleNow(): MemorySample | null {
    if (!this.collect) return null;
    let s: MemorySample;
    try {
      s = this.collect();
    } catch {
      return null; // a probe blew up; never let telemetry take the server down
    }

    this.ring.push(s);
    if (this.ring.length > MAX_RING) this.ring.splice(0, this.ring.length - MAX_RING);

    const line = JSON.stringify(s) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const dir = furyLogsDir();
        await mkdir(dir, { recursive: true });
        const d = new Date(s.t);
        const pad = (n: number) => String(n).padStart(2, '0');
        const file = `memory-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
        await appendFile(join(dir, file), line, 'utf-8');
      } catch {
        this.writeErrors++;
      }
    });

    return s;
  }

  samples(): MemorySample[] {
    return this.ring;
  }

  stats() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      samplesHeld: this.ring.length,
      intervalMs: SAMPLE_INTERVAL_MS,
      writeErrors: this.writeErrors,
      logDir: (() => { try { return furyLogsDir(); } catch { return null; } })(),
    };
  }
}

// Survive Next.js HMR: one sampler per process, not one per module evaluation.
const globalKey = '__fury_memory_sampler__';
export const memorySampler: MemorySampler =
  (globalThis as any)[globalKey] ??
  ((globalThis as any)[globalKey] = new MemorySampler());

/**
 * Growth between the oldest and newest retained samples, with a per-hour rate
 * and a naive projection to the heap limit. The projection is a straight-line
 * extrapolation, not a model — it answers "is this on track to die today or in
 * a month", nothing finer.
 */
export function summarizeGrowth(samples: MemorySample[]) {
  if (samples.length < 2) return { enoughData: false as const, samples: samples.length };

  const first = samples[0];
  const last = samples[samples.length - 1];
  const hours = (last.t - first.t) / 3_600_000;
  if (hours <= 0) return { enoughData: false as const, samples: samples.length };

  const rate = (a: number, b: number) => Math.round(((b - a) / hours) * 10) / 10;

  const countersDelta: Record<string, number> = {};
  for (const k of new Set([...Object.keys(first.counters), ...Object.keys(last.counters)])) {
    const d = (last.counters[k] ?? 0) - (first.counters[k] ?? 0);
    if (d !== 0) countersDelta[k] = d;
  }

  const spacesRate: Record<string, number> = {};
  for (const k of new Set([...Object.keys(first.spacesMb), ...Object.keys(last.spacesMb)])) {
    const r = rate(first.spacesMb[k] ?? 0, last.spacesMb[k] ?? 0);
    if (r !== 0) spacesRate[k] = r;
  }

  const heapRate = rate(first.heapUsedMb, last.heapUsedMb);
  const headroom = last.heapLimitMb - last.heapUsedMb;

  return {
    enoughData: true as const,
    samples: samples.length,
    windowHours: Math.round(hours * 100) / 100,
    heapUsedMb: { from: first.heapUsedMb, to: last.heapUsedMb, perHour: heapRate },
    rssMb: { from: first.rssMb, to: last.rssMb, perHour: rate(first.rssMb, last.rssMb) },
    /** Hours until heapUsed meets heapLimit at the observed rate. */
    hoursToHeapLimit: heapRate > 0 ? Math.round((headroom / heapRate) * 10) / 10 : null,
    /** MB/hour per V8 space — the discriminator between an object-graph leak
     *  (old_space) and big-string churn/fragmentation (large_object_space). */
    spacesMbPerHour: spacesRate,
    /** Which retention counters moved, and by how much, over the window. */
    countersDelta,
  };
}
