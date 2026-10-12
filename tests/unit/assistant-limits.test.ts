import { describe, expect, it } from 'vitest';
import { AssistantLimiter } from '../../src/assistant/limits.js';

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

describe('assistant limits', () => {
  it('lets one user ask 10 questions in a minute and refuses the 11th, then lets them ask again as the minute slides', () => {
    let now = T0;
    const limiter = new AssistantLimiter(10, 1000, () => now);
    for (let i = 0; i < 10; i++) {
      expect(limiter.take('u1'), `question ${i + 1}`).toEqual({ ok: true });
      now += 1000; // one a second
    }
    const refused = limiter.take('u1');
    expect(refused).toMatchObject({ ok: false, reason: 'rate' });
    // The first question was 10 s ago, so it leaves the window in 50 s.
    expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBe(50);
    now += 50_000;
    expect(limiter.take('u1')).toEqual({ ok: true });
  });

  it('counts each user separately', () => {
    const limiter = new AssistantLimiter(2, 1000, () => T0);
    expect(limiter.take('a').ok && limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  it('stops everyone at the daily budget and starts again on the next UTC day', () => {
    let now = T0;
    const limiter = new AssistantLimiter(100, 3, () => now);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('b').ok).toBe(true);
    expect(limiter.take('c').ok).toBe(true);
    const refused = limiter.take('d');
    expect(refused).toMatchObject({ ok: false, reason: 'budget' });
    expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBe(14 * 3600); // until 00:00 UTC
    now = Date.UTC(2026, 9, 13, 0, 0, 1);
    expect(limiter.take('d').ok).toBe(true);
  });

  it('does not count a refused question against the budget', () => {
    const limiter = new AssistantLimiter(1, 2, () => T0);
    expect(limiter.take('a').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(limiter.take('a')).toMatchObject({ ok: false, reason: 'rate' });
    expect(limiter.take('b').ok).toBe(true); // the second and last of the budget
    expect(limiter.take('c')).toMatchObject({ ok: false, reason: 'budget' });
  });
});
