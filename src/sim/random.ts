/**
 * Seeded randomness.
 *
 * `Math.random()` cannot be seeded, which would make every run of this
 * simulation unreproducible — you could never show someone the interesting
 * thing you just saw, and a failing test could never be re-run. Everything
 * stochastic here draws from a seeded generator instead.
 */

/**
 * mulberry32: a small, fast PRNG with a full 2^32 period.
 *
 * Not cryptographic, and does not need to be. What it needs is to be
 * deterministic from a seed and to have no visible short-range structure, which
 * a naive `sin(seed++)` hash does not.
 */
export class Rng {
  private state: number;

  constructor(seed = 1) {
    // A zero state would make mulberry32 degenerate, so fold it away.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  between(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * An exponentially distributed interval with the given mean.
   *
   * This is what makes arrivals look like real traffic rather than a metronome.
   * Under a Poisson process, gaps between events are exponential — so requests
   * clump. Those clumps are the entire reason queues form at average loads well
   * below capacity, and a simulation with evenly-spaced arrivals hides the only
   * phenomenon worth showing.
   */
  exponential(mean: number): number {
    // 1 - next() keeps the argument in (0, 1], so log() never sees zero.
    return -Math.log(1 - this.next()) * mean;
  }

  /** Reset to a known seed, so a run can be repeated exactly. */
  reseed(seed: number): void {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
}
