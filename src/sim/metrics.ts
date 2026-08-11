/**
 * Metrics over a sliding window.
 *
 * A running average since startup is useless for watching a system change: ten
 * minutes of healthy traffic drowns the thirty seconds where everything broke.
 * Everything here describes only the recent past.
 */

export interface Snapshot {
  arrived: number;
  admitted: number;
  dropped: number;
  completed: number;
  throughput: number;
  dropRate: number;
  utilisation: number;
  queueDepth: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * A ring buffer of recent latency samples.
 *
 * Fixed capacity rather than a growing array: the simulation runs indefinitely,
 * and an unbounded sample set would leak memory and make percentiles
 * progressively less responsive to what is happening now.
 */
export class LatencyWindow {
  private samples: Float64Array;
  private index = 0;
  private filled = 0;

  /**
   * The sorted view, rebuilt only after new samples arrive.
   *
   * Percentiles are read several times per frame — the renderer wants them, the
   * stat strip wants them, the history sparkline wants them — and every read
   * used to sort the whole window again. Sorting identical data ten times per
   * frame is work nobody asked for; the samples cannot change between reads
   * inside one frame.
   */
  private sorted: number[] | null = null;

  constructor(capacity = 2048) {
    this.samples = new Float64Array(capacity);
  }

  add(value: number): void {
    this.samples[this.index] = value;
    this.index = (this.index + 1) % this.samples.length;
    this.filled = Math.min(this.filled + 1, this.samples.length);
    this.sorted = null;
  }

  private view(): number[] {
    if (this.sorted === null) {
      this.sorted = Array.from(this.samples.slice(0, this.filled)).sort((a, b) => a - b);
    }
    return this.sorted;
  }

  get size(): number {
    return this.filled;
  }

  /**
   * The requested percentile, using nearest-rank on a sorted copy.
   *
   * Sorting up to 2048 numbers a few times a second is nothing, and it gives an
   * exact answer. Approximations like t-digest exist for the case where samples
   * arrive faster than they can be sorted — not this one.
   */
  percentile(p: number): number {
    if (this.filled === 0) return 0;

    const sorted = this.view();
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
  }

  max(): number {
    if (this.filled === 0) return 0;
    const sorted = this.view();
    return sorted[sorted.length - 1];
  }

  clear(): void {
    this.index = 0;
    this.filled = 0;
    this.samples.fill(0);
    this.sorted = null;
  }
}

/** Counts events per second over a rolling window of one-second buckets. */
export class RateCounter {
  private buckets: number[];
  private currentSecond = 0;

  constructor(private windowSeconds = 5) {
    this.buckets = new Array(windowSeconds).fill(0);
  }

  record(now: number, count = 1): void {
    const second = Math.floor(now);

    if (second !== this.currentSecond) {
      // Zero every bucket the clock skipped. Without this, a pause leaves stale
      // counts in place and the rate reads high for a full window afterwards.
      const skipped = Math.min(second - this.currentSecond, this.windowSeconds);
      for (let i = 1; i <= skipped; i++) {
        this.buckets[(this.currentSecond + i) % this.windowSeconds] = 0;
      }
      this.currentSecond = second;
    }

    this.buckets[second % this.windowSeconds] += count;
  }

  /**
   * Events per second over the *completed* buckets.
   *
   * The current second is deliberately excluded. It is only partly elapsed, so
   * counting it while still dividing by the full window under-reports the rate
   * by up to `1 / windowSeconds` — a systematic 20% error at a five-second
   * window, which reads as the system never quite keeping up even when it is.
   */
  perSecond(now: number): number {
    this.record(now, 0);

    const completed = this.windowSeconds - 1;
    if (completed <= 0 || this.currentSecond === 0) return 0;

    let total = 0;
    for (let age = 1; age <= completed; age++) {
      const second = this.currentSecond - age;
      if (second < 0) continue;
      total += this.buckets[second % this.windowSeconds];
    }

    return total / completed;
  }

  clear(): void {
    this.buckets.fill(0);
    this.currentSecond = 0;
  }
}

/** A short history of a scalar, for sparklines. */
export class History {
  private values: number[] = [];

  constructor(private capacity = 240) {}

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  all(): readonly number[] {
    return this.values;
  }

  peak(): number {
    return this.values.length ? Math.max(...this.values) : 0;
  }

  clear(): void {
    this.values = [];
  }
}
