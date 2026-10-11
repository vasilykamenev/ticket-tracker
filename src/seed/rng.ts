import { createHash } from 'node:crypto';

/** A small seeded pseudorandom generator (mulberry32): the same seed always gives the same sequence. */
export class Rng {
  private state: number;

  constructor(
    private readonly seed: number,
  ) {
    this.state = seed >>> 0;
  }

  /** An independent stream for one part of the dataset, so changing one part never reshuffles another. */
  fork(label: string): Rng {
    const h = createHash('sha1').update(`${this.seed}:${label}`).digest();
    return new Rng(h.readUInt32BE(0));
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![0];
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}
