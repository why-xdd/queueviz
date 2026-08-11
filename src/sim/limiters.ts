/**
 * Admission control — deciding what never enters the queue at all.
 *
 * A queue with no limit does not protect anything. It absorbs overload as
 * latency until every request in it has already timed out on the client, and
 * then the server spends its capacity producing answers nobody is waiting for.
 * Shedding load early is what keeps the requests you *do* accept fast.
 */

export type LimiterName = "none" | "bounded" | "token-bucket" | "leaky-bucket";

export interface Limiter {
  readonly name: LimiterName;
  /** Advance internal state to simulation time `now`. */
  tick(now: number, queueDepth: number): void;
  /** Whether one arriving request may enter the queue. */
  admit(now: number, queueDepth: number): boolean;
  /** A 0..1 gauge of remaining allowance, for the renderer. */
  level(): number;
  reset(): void;
}

/** Accept everything. The default that turns overload into unbounded latency. */
export class NoLimiter implements Limiter {
  readonly name = "none" as const;
  tick(): void {}
  admit(): boolean {
    return true;
  }
  level(): number {
    return 1;
  }
  reset(): void {}
}

/**
 * A hard cap on queue depth — the simplest useful backpressure.
 *
 * Bounding the queue bounds the wait: with a fixed service rate, depth times
 * service time *is* the worst-case latency. Choosing a queue depth is therefore
 * choosing a latency SLO, which is a far more meaningful thing to reason about
 * than "how much memory can we spare".
 */
export class BoundedQueue implements Limiter {
  readonly name = "bounded" as const;

  constructor(private capacity: number) {}

  tick(): void {}

  admit(_now: number, queueDepth: number): boolean {
    return queueDepth < this.capacity;
  }

  level(): number {
    return 1;
  }

  reset(): void {}
}

/**
 * Token bucket: a sustained rate, plus a burst allowance.
 *
 * Tokens refill continuously and accumulate up to `capacity`. A client that has
 * been quiet can spend the whole bucket at once — which is usually what you
 * want, because real traffic is bursty and a limiter that punishes every burst
 * punishes normal behaviour.
 *
 * This is the one to reach for on an API edge.
 */
export class TokenBucket implements Limiter {
  readonly name = "token-bucket" as const;
  private tokens: number;
  private lastRefill = 0;

  constructor(
    private capacity: number,
    private refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  tick(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    // Refilled fractionally rather than in whole tokens on a timer: a timer
    // makes the allowance arrive in steps, and clients synchronise onto those
    // steps, producing exactly the thundering herd the limiter should smooth.
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
  }

  admit(now: number): boolean {
    this.tick(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  level(): number {
    return this.capacity === 0 ? 0 : this.tokens / this.capacity;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = 0;
  }
}

/**
 * Leaky bucket: a strictly constant output rate, with no burst at all.
 *
 * Where a token bucket smooths *on average* and permits spikes, a leaky bucket
 * enforces a perfectly even rate. Use it when the thing downstream genuinely
 * cannot absorb a burst — a legacy system, a hardware device, a partner API
 * with a per-second contract.
 *
 * Running both side by side is the clearest way to see the difference: same
 * average throughput, completely different shape.
 */
export class LeakyBucket implements Limiter {
  readonly name = "leaky-bucket" as const;
  private level_ = 0;
  private lastLeak = 0;

  constructor(
    private capacity: number,
    private leakPerSecond: number,
  ) {}

  tick(now: number): void {
    const elapsed = Math.max(0, now - this.lastLeak);
    this.lastLeak = now;
    this.level_ = Math.max(0, this.level_ - elapsed * this.leakPerSecond);
  }

  admit(now: number): boolean {
    this.tick(now);
    if (this.level_ + 1 <= this.capacity) {
      this.level_ += 1;
      return true;
    }
    return false;
  }

  level(): number {
    return this.capacity === 0 ? 0 : 1 - this.level_ / this.capacity;
  }

  reset(): void {
    this.level_ = 0;
    this.lastLeak = 0;
  }
}

export function createLimiter(
  name: LimiterName,
  options: { capacity: number; rate: number },
): Limiter {
  switch (name) {
    case "none":
      return new NoLimiter();
    case "bounded":
      return new BoundedQueue(options.capacity);
    case "token-bucket":
      return new TokenBucket(options.capacity, options.rate);
    case "leaky-bucket":
      return new LeakyBucket(options.capacity, options.rate);
  }
}
