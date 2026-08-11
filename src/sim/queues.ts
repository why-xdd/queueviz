/**
 * Queue disciplines — the rule deciding who gets served next.
 *
 * The choice is invisible in a throughput graph and enormous in a latency
 * histogram. Every discipline here moves the same number of items per second
 * when the system is not saturated; what changes is *whose* request waits, and
 * by how much. That is the thing this project exists to make visible.
 */

export interface Request {
  id: number;
  /** Simulation time at which the request arrived. */
  arrivedAt: number;
  /** How long it will occupy a worker once it starts. */
  serviceTime: number;
  /** Lower is more urgent. Only used by the priority discipline. */
  priority: number;
  /** Which tenant sent it. Only used by weighted fair queueing. */
  tenant: number;
  /** Set when the request leaves the queue for a worker. */
  startedAt?: number;
  /** Set when the worker finishes. */
  finishedAt?: number;
}

export type DisciplineName = "fifo" | "lifo" | "priority" | "wfq";

export interface Discipline {
  readonly name: DisciplineName;
  readonly size: number;
  push(request: Request): void;
  /** Remove and return the next request to serve, or undefined if empty. */
  pop(): Request | undefined;
  /** Read-only view for rendering, in the order items would be served. */
  peekAll(): Request[];
  clear(): void;
}

/**
 * First in, first out. The default, and the fair one.
 *
 * Everyone waits in proportion to how busy the system was when they arrived.
 * Under overload every request is slow, but none is starved.
 */
export class Fifo implements Discipline {
  readonly name = "fifo" as const;
  private items: Request[] = [];

  get size(): number {
    return this.items.length;
  }

  push(request: Request): void {
    this.items.push(request);
  }

  pop(): Request | undefined {
    return this.items.shift();
  }

  peekAll(): Request[] {
    return this.items;
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Last in, first out. Counter-intuitive, and occasionally correct.
 *
 * Under overload, LIFO serves the newest request — the one whose caller is most
 * likely still waiting. FIFO instead spends the server on the oldest request,
 * which has often already timed out on the client side: work delivered to
 * nobody.
 *
 * The cost is brutal and visible here: the requests at the bottom of the stack
 * may never be served at all. LIFO trades a *median* improvement for an
 * unbounded tail.
 */
export class Lifo implements Discipline {
  readonly name = "lifo" as const;
  private items: Request[] = [];

  get size(): number {
    return this.items.length;
  }

  push(request: Request): void {
    this.items.push(request);
  }

  pop(): Request | undefined {
    return this.items.pop();
  }

  peekAll(): Request[] {
    // Reversed so the rendering order matches the serving order.
    return [...this.items].reverse();
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Strict priority, on a binary heap.
 *
 * Urgent work goes first, and low-priority work starves whenever the urgent
 * stream alone can saturate the workers. That starvation is not a bug in this
 * implementation — it is the defining property of strict priority, and watching
 * the low-priority queue grow without bound is the point.
 *
 * A heap rather than a sorted array: `push` and `pop` are O(log n) instead of
 * O(n), which matters once the queue is thousands deep under overload — exactly
 * when the simulation must not stutter.
 */
export class PriorityQueue implements Discipline {
  readonly name = "priority" as const;
  private heap: Request[] = [];

  get size(): number {
    return this.heap.length;
  }

  private less(a: Request, b: Request): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority;
    // FIFO within a priority band, so equal-priority requests stay fair.
    return a.arrivedAt < b.arrivedAt;
  }

  push(request: Request): void {
    this.heap.push(request);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(this.heap[index], this.heap[parent])) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }

  pop(): Request | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.heap.length && this.less(this.heap[left], this.heap[smallest])) {
          smallest = left;
        }
        if (right < this.heap.length && this.less(this.heap[right], this.heap[smallest])) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
        index = smallest;
      }
    }

    return top;
  }

  peekAll(): Request[] {
    // A heap is not sorted, so this sorts a copy purely for display. Only ever
    // called on the render path, never inside the simulation loop.
    return [...this.heap].sort((a, b) => (this.less(a, b) ? -1 : 1));
  }

  clear(): void {
    this.heap = [];
  }
}

/**
 * Weighted fair queueing: one sub-queue per tenant, served in weighted turns.
 *
 * The problem it solves is the one every multi-tenant system eventually hits —
 * a single customer sending ten times the traffic of everyone else makes
 * *everyone's* latency ten times worse under FIFO, because they are all in the
 * same line.
 *
 * WFQ gives each tenant their own line and serves the lines in rotation. A
 * tenant flooding their own queue now only degrades themselves, which is what
 * "noisy neighbour isolation" actually means.
 */
export class WeightedFairQueue implements Discipline {
  readonly name = "wfq" as const;
  private queues: Request[][] = [];
  private credits: number[] = [];
  private cursor = 0;

  constructor(private weights: number[] = [1, 1, 1]) {
    this.reset();
  }

  private reset(): void {
    this.queues = this.weights.map(() => []);
    this.credits = this.weights.map((w) => w);
    this.cursor = 0;
  }

  get size(): number {
    return this.queues.reduce((total, queue) => total + queue.length, 0);
  }

  push(request: Request): void {
    const tenant = request.tenant % this.queues.length;
    this.queues[tenant].push(request);
  }

  pop(): Request | undefined {
    if (this.size === 0) return undefined;

    // Deficit round robin: each tenant spends credits proportional to its
    // weight before the cursor moves on. When every queue with work has run out
    // of credits, everyone is refilled — which is what stops an idle tenant
    // from banking unlimited credit and bursting later.
    for (let attempt = 0; attempt < this.queues.length * 2; attempt++) {
      const index = this.cursor % this.queues.length;
      const queue = this.queues[index];

      if (queue.length > 0 && this.credits[index] > 0) {
        this.credits[index] -= 1;
        return queue.shift();
      }

      this.cursor += 1;

      if (this.cursor % this.queues.length === 0) {
        const anyCreditLeft = this.queues.some(
          (q, i) => q.length > 0 && this.credits[i] > 0,
        );
        if (!anyCreditLeft) {
          this.weights.forEach((weight, i) => (this.credits[i] = weight));
        }
      }
    }

    // Every queue with work was out of credits and the refill above did not
    // land on it. Serve the longest queue rather than returning nothing, which
    // would stall the whole simulation.
    const fallback = this.queues
      .filter((q) => q.length > 0)
      .sort((a, b) => b.length - a.length)[0];
    return fallback?.shift();
  }

  peekAll(): Request[] {
    return this.queues.flat();
  }

  /** Per-tenant depths, for the renderer. */
  depths(): number[] {
    return this.queues.map((q) => q.length);
  }

  clear(): void {
    this.reset();
  }
}

export function createDiscipline(name: DisciplineName, tenants = 3): Discipline {
  switch (name) {
    case "fifo":
      return new Fifo();
    case "lifo":
      return new Lifo();
    case "priority":
      return new PriorityQueue();
    case "wfq":
      // Descending weights so the isolation is visible: tenant 0 is entitled to
      // three times tenant 2's share, and still cannot take more than that.
      return new WeightedFairQueue(
        Array.from({ length: tenants }, (_, i) => tenants - i),
      );
  }
}
