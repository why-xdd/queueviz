/**
 * The simulation itself.
 *
 * Fixed-timestep, not event-driven. A discrete-event simulation would be faster
 * and is the right choice when you only want the final numbers — but this one
 * is watched, and a fixed step means every frame advances the world by the same
 * amount, so the animation reads as motion rather than teleportation.
 */

import { LatencyWindow, RateCounter, History, type Snapshot } from "./metrics";
import { createDiscipline, type Discipline, type DisciplineName, type Request } from "./queues";
import { createLimiter, type Limiter, type LimiterName } from "./limiters";
import { Rng } from "./random";

export interface Config {
  arrivalRate: number;
  serviceTime: number;
  serviceJitter: number;
  workers: number;
  discipline: DisciplineName;
  limiter: LimiterName;
  limiterCapacity: number;
  limiterRate: number;
  tenants: number;
  seed: number;
}

export const defaultConfig: Config = {
  arrivalRate: 12,
  serviceTime: 0.25,
  serviceJitter: 0.5,
  workers: 4,
  discipline: "fifo",
  limiter: "none",
  limiterCapacity: 40,
  limiterRate: 10,
  tenants: 3,
  seed: 42,
};

export interface Worker {
  request: Request | null;
  /** Simulation time at which the current request completes. */
  freeAt: number;
}

/** Maximum simulated seconds per step, so a background tab cannot fast-forward. */
const MAX_STEP = 0.1;

export class Simulation {
  config: Config;
  time = 0;
  queue: Discipline;
  limiter: Limiter;
  workers: Worker[] = [];

  private rng: Rng;
  private nextArrivalAt = 0;
  private nextId = 1;
  private busyTime = 0;

  readonly latency = new LatencyWindow(2048);
  readonly arrivals = new RateCounter(5);
  readonly completions = new RateCounter(5);
  readonly drops = new RateCounter(5);
  readonly depthHistory = new History(240);
  readonly p99History = new History(240);

  counters = { arrived: 0, admitted: 0, dropped: 0, completed: 0 };

  /** Requests that just finished, for the renderer to animate out. */
  justCompleted: Request[] = [];

  constructor(config: Partial<Config> = {}) {
    this.config = { ...defaultConfig, ...config };
    this.rng = new Rng(this.config.seed);
    this.queue = createDiscipline(this.config.discipline, this.config.tenants);
    this.limiter = createLimiter(this.config.limiter, {
      capacity: this.config.limiterCapacity,
      rate: this.config.limiterRate,
    });
    this.setWorkerCount(this.config.workers);
    this.nextArrivalAt = this.rng.exponential(1 / this.config.arrivalRate);
  }

  private setWorkerCount(count: number): void {
    while (this.workers.length < count) {
      this.workers.push({ request: null, freeAt: 0 });
    }
    // Trailing workers are dropped only when idle, so an in-flight request is
    // never silently discarded — that would corrupt the completion count.
    while (this.workers.length > count) {
      const index = this.workers.findIndex((w) => w.request === null);
      if (index === -1) break;
      this.workers.splice(index, 1);
    }
  }

  /**
   * Apply a configuration change to a running simulation.
   *
   * Structural changes rebuild the affected component and preserve everything
   * else, so switching discipline mid-overload shows the transition rather than
   * resetting the world — which is the most instructive moment in the whole
   * tool.
   */
  update(patch: Partial<Config>): void {
    const previous = this.config;
    this.config = { ...previous, ...patch };

    if (patch.discipline && patch.discipline !== previous.discipline) {
      const pending = this.queue.peekAll().slice();
      this.queue = createDiscipline(patch.discipline, this.config.tenants);
      for (const request of pending) this.queue.push(request);
    }

    if (
      patch.limiter !== undefined ||
      patch.limiterCapacity !== undefined ||
      patch.limiterRate !== undefined
    ) {
      this.limiter = createLimiter(this.config.limiter, {
        capacity: this.config.limiterCapacity,
        rate: this.config.limiterRate,
      });
    }

    if (patch.workers !== undefined) this.setWorkerCount(patch.workers);
    if (patch.seed !== undefined) this.rng.reseed(patch.seed);
  }

  reset(): void {
    this.time = 0;
    this.nextId = 1;
    this.busyTime = 0;
    this.counters = { arrived: 0, admitted: 0, dropped: 0, completed: 0 };
    this.justCompleted = [];

    this.rng.reseed(this.config.seed);
    this.queue.clear();
    this.limiter.reset();
    this.workers.forEach((worker) => {
      worker.request = null;
      worker.freeAt = 0;
    });

    this.latency.clear();
    this.arrivals.clear();
    this.completions.clear();
    this.drops.clear();
    this.depthHistory.clear();
    this.p99History.clear();

    this.nextArrivalAt = this.rng.exponential(1 / this.config.arrivalRate);
  }

  /** Advance by `dt` simulated seconds. */
  step(dt: number): void {
    // Clamped because requestAnimationFrame stops in a background tab: on
    // return, dt would be the whole elapsed wall time and the simulation would
    // lurch forward by minutes in one frame.
    const delta = Math.min(Math.max(dt, 0), MAX_STEP);
    const target = this.time + delta;

    this.justCompleted = [];
    this.limiter.tick(this.time, this.queue.size);

    this.admitArrivals(target);
    this.completeWork(target);
    this.dispatch(target);

    this.time = target;
    this.busyTime += this.workers.filter((w) => w.request !== null).length * delta;

    this.depthHistory.push(this.queue.size);
    this.p99History.push(this.latency.percentile(99));
  }

  private admitArrivals(target: number): void {
    // A while loop, not a single check: at high arrival rates more than one
    // request can arrive inside one frame, and dropping the extras would
    // silently cap the arrival rate at the frame rate.
    while (this.nextArrivalAt <= target) {
      const at = this.nextArrivalAt;
      this.counters.arrived += 1;
      this.arrivals.record(at);

      if (this.limiter.admit(at, this.queue.size)) {
        this.queue.push({
          id: this.nextId++,
          arrivedAt: at,
          serviceTime: this.sampleServiceTime(),
          priority: this.rng.next() < 0.2 ? 0 : 1,
          tenant: Math.floor(this.rng.next() * this.config.tenants),
        });
        this.counters.admitted += 1;
      } else {
        this.counters.dropped += 1;
        this.drops.record(at);
      }

      this.nextArrivalAt = at + this.rng.exponential(1 / this.config.arrivalRate);
    }
  }

  private sampleServiceTime(): number {
    const { serviceTime, serviceJitter } = this.config;
    if (serviceJitter <= 0) return serviceTime;
    // Log-normal-ish spread around the mean: service times have a long right
    // tail in reality, and a symmetric distribution would understate the tail
    // latency that dominates p99.
    return Math.max(0.01, serviceTime * Math.exp(this.rng.between(-1, 1) * serviceJitter));
  }

  private completeWork(target: number): void {
    for (const worker of this.workers) {
      if (worker.request && worker.freeAt <= target) {
        const request = worker.request;
        request.finishedAt = worker.freeAt;

        this.latency.add(request.finishedAt - request.arrivedAt);
        this.completions.record(worker.freeAt);
        this.counters.completed += 1;
        this.justCompleted.push(request);

        worker.request = null;
      }
    }
  }

  private dispatch(target: number): void {
    for (const worker of this.workers) {
      if (worker.request !== null) continue;

      const request = this.queue.pop();
      if (!request) break;

      request.startedAt = Math.max(target, request.arrivedAt);
      worker.request = request;
      worker.freeAt = request.startedAt + request.serviceTime;
    }
  }

  /**
   * Offered load: arrival rate divided by service capacity.
   *
   * The single most useful number in queueing theory. Below 1 the queue is
   * stable; at 1 it grows without bound even though nothing is "overloaded" in
   * any obvious sense; above 1 it grows linearly forever. Latency starts
   * climbing steeply from about 0.7, which is why capacity planning to 100%
   * utilisation always ends badly.
   */
  offeredLoad(): number {
    const capacity = this.workers.length / this.config.serviceTime;
    return capacity === 0 ? Infinity : this.config.arrivalRate / capacity;
  }

  snapshot(): Snapshot {
    const busyNow = this.workers.filter((w) => w.request !== null).length;
    return {
      ...this.counters,
      throughput: this.completions.perSecond(this.time),
      dropRate:
        this.counters.arrived === 0 ? 0 : this.counters.dropped / this.counters.arrived,
      utilisation: this.workers.length === 0 ? 0 : busyNow / this.workers.length,
      queueDepth: this.queue.size,
      p50: this.latency.percentile(50),
      p95: this.latency.percentile(95),
      p99: this.latency.percentile(99),
      max: this.latency.max(),
    };
  }
}
