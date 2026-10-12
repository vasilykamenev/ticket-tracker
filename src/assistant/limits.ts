export type LimitDecision = { ok: true } | { ok: false; reason: 'rate' | 'budget'; retryAfterSeconds: number };

const MINUTE_MS = 60_000;

/**
 * Per-user rate limit (a sliding minute) and a daily budget of requests for the whole application (UTC day).
 * Counted in memory, like the login limits: right for one replica, and a restart starts the day again at zero.
 * A request counts when it is let through, whether or not the provider then answers, so a failing provider cannot
 * be used to spend more than the budget.
 */
export class AssistantLimiter {
  private readonly hits = new Map<string, number[]>();
  private day = '';
  private used = 0;

  constructor(
    private readonly perMinute: number,
    private readonly dailyBudget: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(userId: string): LimitDecision {
    const at = this.now();
    const today = new Date(at).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }

    const recent = (this.hits.get(userId) ?? []).filter((t) => at - t < MINUTE_MS);
    if (recent.length >= this.perMinute) {
      this.hits.set(userId, recent);
      return { ok: false, reason: 'rate', retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - at) / 1000)) };
    }
    if (this.used >= this.dailyBudget) {
      const tomorrow = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1);
      return { ok: false, reason: 'budget', retryAfterSeconds: Math.max(1, Math.ceil((tomorrow - at) / 1000)) };
    }

    recent.push(at);
    this.hits.set(userId, recent);
    this.used++;
    if (this.hits.size > 1000) this.forgetIdle(at);
    return { ok: true };
  }

  private forgetIdle(at: number): void {
    for (const [user, times] of this.hits) if (times.every((t) => at - t >= MINUTE_MS)) this.hits.delete(user);
  }
}
