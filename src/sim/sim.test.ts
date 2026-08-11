import { describe, expect, it } from "vitest";

import { Simulation, defaultConfig } from "./engine";
import { LatencyWindow, RateCounter } from "./metrics";
import { BoundedQueue, LeakyBucket, TokenBucket } from "./limiters";
import { Fifo, Lifo, PriorityQueue, WeightedFairQueue, type Request } from "./queues";
import { Rng } from "./random";

function request(overrides: Partial<Request> = {}): Request {
  return {
    id: 1,
    arrivedAt: 0,
    serviceTime: 0.1,
    priority: 1,
    tenant: 0,
    ...overrides,
  };
}

/** Run a simulation for `seconds` of simulated time at a fixed step. */
function run(sim: Simulation, seconds: number, step = 1 / 60): Simulation {
  for (let t = 0; t < seconds; t += step) sim.step(step);
  return sim;
}

// -- randomness -------------------------------------------------------------

describe("Rng", () => {
  it("is reproducible from a seed", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const first = Array.from({ length: 50 }, () => a.next());
    const second = Array.from({ length: 50 }, () => b.next());
    expect(first).toEqual(second);
  });

  it("produces different streams for different seeds", () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it("stays within [0, 1)", () => {
    const rng = new Rng(99);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("draws exponential intervals with the requested mean", () => {
    const rng = new Rng(3);
    let total = 0;
    const samples = 200_000;
    for (let i = 0; i < samples; i++) total += rng.exponential(0.25);
    expect(total / samples).toBeCloseTo(0.25, 2);
  });

  it("survives a zero seed", () => {
    // A zero state makes mulberry32 degenerate, so it must be folded away.
    const rng = new Rng(0);
    const values = new Set(Array.from({ length: 20 }, () => rng.next()));
    expect(values.size).toBeGreaterThan(15);
  });
});

// -- disciplines ------------------------------------------------------------

describe("queue disciplines", () => {
  it("FIFO serves in arrival order", () => {
    const queue = new Fifo();
    [1, 2, 3].forEach((id) => queue.push(request({ id })));
    expect([queue.pop()?.id, queue.pop()?.id, queue.pop()?.id]).toEqual([1, 2, 3]);
  });

  it("LIFO serves the newest first", () => {
    const queue = new Lifo();
    [1, 2, 3].forEach((id) => queue.push(request({ id })));
    expect([queue.pop()?.id, queue.pop()?.id, queue.pop()?.id]).toEqual([3, 2, 1]);
  });

  it("LIFO's display order matches its serving order", () => {
    const queue = new Lifo();
    [1, 2, 3].forEach((id) => queue.push(request({ id })));
    expect(queue.peekAll().map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("priority serves urgent work first", () => {
    const queue = new PriorityQueue();
    queue.push(request({ id: 1, priority: 5 }));
    queue.push(request({ id: 2, priority: 0 }));
    queue.push(request({ id: 3, priority: 2 }));
    expect([queue.pop()?.id, queue.pop()?.id, queue.pop()?.id]).toEqual([2, 3, 1]);
  });

  it("priority stays FIFO within a band", () => {
    // Otherwise equal-priority requests are reordered arbitrarily by the heap,
    // and two identical requests get wildly different latencies.
    const queue = new PriorityQueue();
    queue.push(request({ id: 1, priority: 1, arrivedAt: 10 }));
    queue.push(request({ id: 2, priority: 1, arrivedAt: 5 }));
    queue.push(request({ id: 3, priority: 1, arrivedAt: 7 }));
    expect([queue.pop()?.id, queue.pop()?.id, queue.pop()?.id]).toEqual([2, 3, 1]);
  });

  it("priority keeps the heap invariant under random load", () => {
    const queue = new PriorityQueue();
    const rng = new Rng(11);
    for (let i = 0; i < 500; i++) {
      queue.push(request({ id: i, priority: Math.floor(rng.next() * 10), arrivedAt: i }));
    }

    let previous = -Infinity;
    while (queue.size > 0) {
      const next = queue.pop()!;
      expect(next.priority).toBeGreaterThanOrEqual(previous);
      previous = next.priority;
    }
  });

  it("WFQ isolates a noisy tenant", () => {
    // The property that makes WFQ worth its complexity: one tenant flooding
    // their own queue must not push everyone else's work back.
    const queue = new WeightedFairQueue([1, 1, 1]);
    for (let i = 0; i < 100; i++) queue.push(request({ id: i, tenant: 0 }));
    queue.push(request({ id: 1000, tenant: 1 }));
    queue.push(request({ id: 2000, tenant: 2 }));

    const served: number[] = [];
    for (let i = 0; i < 6; i++) served.push(queue.pop()!.tenant);

    // Both quiet tenants must be served well inside the first handful, not
    // behind all 100 of tenant 0's requests.
    expect(served).toContain(1);
    expect(served).toContain(2);
  });

  it("WFQ gives a heavier weight a larger share", () => {
    const queue = new WeightedFairQueue([3, 1]);
    for (let i = 0; i < 200; i++) {
      queue.push(request({ id: i, tenant: 0 }));
      queue.push(request({ id: i + 1000, tenant: 1 }));
    }

    const counts = [0, 0];
    for (let i = 0; i < 160; i++) counts[queue.pop()!.tenant] += 1;

    expect(counts[0]).toBeGreaterThan(counts[1]);
  });

  it("WFQ drains completely rather than stalling", () => {
    // The fallback path matters: returning undefined while work remains would
    // freeze the whole simulation.
    const queue = new WeightedFairQueue([2, 1]);
    for (let i = 0; i < 50; i++) queue.push(request({ id: i, tenant: i % 2 }));

    let drained = 0;
    while (queue.size > 0) {
      expect(queue.pop()).toBeDefined();
      drained += 1;
      expect(drained).toBeLessThanOrEqual(50);
    }
    expect(drained).toBe(50);
  });

  it("every discipline returns undefined when empty", () => {
    for (const queue of [new Fifo(), new Lifo(), new PriorityQueue(), new WeightedFairQueue()]) {
      expect(queue.pop()).toBeUndefined();
      expect(queue.size).toBe(0);
    }
  });
});

// -- limiters ---------------------------------------------------------------

describe("admission control", () => {
  it("a bounded queue rejects past its capacity", () => {
    const limiter = new BoundedQueue(10);
    expect(limiter.admit(0, 9)).toBe(true);
    expect(limiter.admit(0, 10)).toBe(false);
  });

  it("a token bucket allows a burst up to its capacity", () => {
    const bucket = new TokenBucket(10, 5);
    const admitted = Array.from({ length: 15 }, () => bucket.admit(0)).filter(Boolean);
    expect(admitted).toHaveLength(10);
  });

  it("a token bucket refills at its configured rate", () => {
    const bucket = new TokenBucket(10, 5);
    for (let i = 0; i < 10; i++) bucket.admit(0);
    expect(bucket.admit(0)).toBe(false);

    // One second later, five tokens are back.
    const refilled = Array.from({ length: 8 }, () => bucket.admit(1)).filter(Boolean);
    expect(refilled).toHaveLength(5);
  });

  it("a token bucket refills continuously, not in steps", () => {
    // Stepwise refill makes clients synchronise onto the tick and produces the
    // thundering herd the limiter is supposed to prevent.
    const bucket = new TokenBucket(10, 10);
    for (let i = 0; i < 10; i++) bucket.admit(0);
    expect(bucket.admit(0.5)).toBe(true);
  });

  it("a token bucket never banks more than its capacity", () => {
    const bucket = new TokenBucket(5, 10);
    const admitted = Array.from({ length: 20 }, () => bucket.admit(100)).filter(Boolean);
    expect(admitted).toHaveLength(5);
  });

  it("a leaky bucket refuses a burst a token bucket would allow", () => {
    // The defining difference between the two, in one assertion.
    const leaky = new LeakyBucket(3, 5);
    const token = new TokenBucket(10, 5);

    const leakyAdmitted = Array.from({ length: 10 }, () => leaky.admit(0)).filter(Boolean);
    const tokenAdmitted = Array.from({ length: 10 }, () => token.admit(0)).filter(Boolean);

    expect(leakyAdmitted.length).toBeLessThan(tokenAdmitted.length);
  });

  it("reports a level for the renderer", () => {
    const bucket = new TokenBucket(10, 1);
    expect(bucket.level()).toBeCloseTo(1);
    for (let i = 0; i < 5; i++) bucket.admit(0);
    expect(bucket.level()).toBeCloseTo(0.5);
  });
});

// -- metrics ----------------------------------------------------------------

describe("metrics", () => {
  it("computes percentiles by nearest rank", () => {
    const window = new LatencyWindow(200);
    for (let i = 1; i <= 100; i++) window.add(i);

    expect(window.percentile(50)).toBe(50);
    expect(window.percentile(99)).toBe(99);
    expect(window.max()).toBe(100);
  });

  it("keeps only the most recent samples", () => {
    // A window that grows forever stops responding to what is happening now.
    const window = new LatencyWindow(10);
    for (let i = 0; i < 100; i++) window.add(i);

    expect(window.size).toBe(10);
    expect(window.percentile(50)).toBeGreaterThanOrEqual(90);
  });

  it("returns zero before any samples", () => {
    expect(new LatencyWindow().percentile(99)).toBe(0);
  });

  it("counts a rate over the completed buckets", () => {
    const counter = new RateCounter(5);
    // Four full seconds at ten events each.
    for (let second = 0; second < 4; second++) {
      for (let i = 0; i < 10; i++) counter.record(second);
    }
    expect(counter.perSecond(4)).toBeCloseTo(10, 5);
  });

  it("excludes the in-progress second", () => {
    // Counting a partly-elapsed second while dividing by the whole window
    // under-reports by up to 1/window — a steady 20% here, which reads as a
    // system never quite keeping up when it is keeping up exactly.
    const counter = new RateCounter(5);
    for (let second = 0; second < 4; second++) {
      for (let i = 0; i < 10; i++) counter.record(second);
    }
    counter.record(4); // one event, 1 ms into the fifth second

    expect(counter.perSecond(4)).toBeCloseTo(10, 5);
  });

  it("clears buckets the clock skipped", () => {
    // Without this, a pause leaves stale counts and the rate reads high for a
    // full window afterwards.
    const counter = new RateCounter(5);
    for (let i = 0; i < 50; i++) counter.record(0);
    expect(counter.perSecond(10)).toBe(0);
  });
});

// -- the simulation ---------------------------------------------------------

describe("Simulation", () => {
  it("is reproducible for a given seed", () => {
    const a = run(new Simulation({ seed: 5 }), 20);
    const b = run(new Simulation({ seed: 5 }), 20);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it("conserves requests: arrived = dropped + completed + in flight", () => {
    // The invariant that catches almost any bookkeeping bug in the engine.
    const sim = run(new Simulation({ arrivalRate: 20, workers: 2 }), 30);
    const inFlight = sim.queue.size + sim.workers.filter((w) => w.request).length;

    expect(sim.counters.arrived).toBe(
      sim.counters.dropped + sim.counters.completed + inFlight,
    );
  });

  it("keeps up when load is below capacity", () => {
    // 4 workers at 0.25 s each is 16/s of capacity against 8/s of arrivals.
    const sim = run(
      new Simulation({ arrivalRate: 8, workers: 4, serviceTime: 0.25, serviceJitter: 0 }),
      60,
    );
    expect(sim.offeredLoad()).toBeCloseTo(0.5);
    expect(sim.queue.size).toBeLessThan(10);
    expect(sim.snapshot().throughput).toBeGreaterThan(6);
  });

  it("builds an unbounded queue when load exceeds capacity", () => {
    const sim = run(
      new Simulation({ arrivalRate: 40, workers: 2, serviceTime: 0.25, limiter: "none" }),
      40,
    );
    expect(sim.offeredLoad()).toBeGreaterThan(1);
    expect(sim.queue.size).toBeGreaterThan(100);
  });

  it("bounds latency by shedding load instead", () => {
    // The whole argument for backpressure, as a comparison.
    const unbounded = run(
      new Simulation({ arrivalRate: 40, workers: 2, serviceTime: 0.25, limiter: "none", seed: 9 }),
      40,
    );
    const bounded = run(
      new Simulation({
        arrivalRate: 40, workers: 2, serviceTime: 0.25,
        limiter: "bounded", limiterCapacity: 20, seed: 9,
      }),
      40,
    );

    expect(bounded.snapshot().p99).toBeLessThan(unbounded.snapshot().p99);
    expect(bounded.snapshot().dropRate).toBeGreaterThan(0);
    // Shedding must not cost throughput — the workers stay just as busy.
    expect(bounded.snapshot().throughput).toBeGreaterThan(
      unbounded.snapshot().throughput * 0.8,
    );
  });

  it("does not lurch forward after a background tab returns", () => {
    // requestAnimationFrame stops when hidden; an unclamped dt would advance
    // the world by minutes in a single frame.
    const sim = new Simulation();
    sim.step(600);
    expect(sim.time).toBeLessThanOrEqual(0.1);
  });

  it("admits every arrival in a frame, not just one", () => {
    // A single check per step would silently cap arrivals at the frame rate.
    const sim = new Simulation({ arrivalRate: 500, workers: 1, limiter: "none" });
    sim.step(0.1);
    expect(sim.counters.arrived).toBeGreaterThan(10);
  });

  it("keeps queued work when the discipline changes", () => {
    const sim = run(new Simulation({ arrivalRate: 40, workers: 1 }), 10);
    const before = sim.queue.size;

    sim.update({ discipline: "lifo" });

    expect(sim.queue.name).toBe("lifo");
    expect(sim.queue.size).toBe(before);
  });

  it("never discards an in-flight request when workers are removed", () => {
    const sim = run(new Simulation({ arrivalRate: 30, workers: 6 }), 10);
    const completedBefore = sim.counters.completed;

    sim.update({ workers: 1 });
    run(sim, 5);

    expect(sim.counters.completed).toBeGreaterThanOrEqual(completedBefore);
    const inFlight = sim.queue.size + sim.workers.filter((w) => w.request).length;
    expect(sim.counters.arrived).toBe(
      sim.counters.dropped + sim.counters.completed + inFlight,
    );
  });

  it("resets to a clean, identical state", () => {
    const sim = new Simulation({ seed: 3 });
    run(sim, 20);
    sim.reset();

    expect(sim.time).toBe(0);
    expect(sim.queue.size).toBe(0);
    expect(sim.counters).toEqual({ arrived: 0, admitted: 0, dropped: 0, completed: 0 });

    run(sim, 20);
    expect(sim.snapshot()).toEqual(run(new Simulation({ seed: 3 }), 20).snapshot());
  });

  it("computes offered load from workers and service time", () => {
    const sim = new Simulation({ arrivalRate: 10, workers: 2, serviceTime: 0.5 });
    // 2 workers / 0.5s = 4 per second of capacity against 10 arriving.
    expect(sim.offeredLoad()).toBeCloseTo(2.5);
  });

  it("uses sane defaults", () => {
    const sim = new Simulation();
    expect(sim.config).toEqual(defaultConfig);
    expect(sim.offeredLoad()).toBeLessThan(1);
  });
});
