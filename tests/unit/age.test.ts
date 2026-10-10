import { describe, expect, it } from 'vitest';
import { formatAge, ticketAgeMs } from '../../src/domain/tickets/age.js';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe('ticketAgeMs', () => {
  const createdAt = at('2026-10-01T08:00:00Z');
  const now = at('2026-10-04T12:00:00Z');

  it('runs to now while the ticket is active', () => {
    expect(ticketAgeMs({ createdAt }, now)).toBe(76 * HOUR);
  });

  it('stops at the end of work: closed, resolved or unresolved', () => {
    expect(ticketAgeMs({ createdAt, resolvedAt: at('2026-10-01T10:00:00Z') }, now)).toBe(2 * HOUR);
    expect(ticketAgeMs({ createdAt, unresolvedAt: at('2026-10-01T09:00:00Z') }, now)).toBe(HOUR);
    expect(ticketAgeMs({ createdAt, resolvedAt: at('2026-10-01T10:00:00Z'), closedAt: at('2026-10-02T08:00:00Z') }, now)).toBe(24 * HOUR);
  });

  it('never goes negative', () => {
    expect(ticketAgeMs({ createdAt: at('2026-10-05T00:00:00Z') }, now)).toBe(0);
  });
});

describe('formatAge', () => {
  it('shows the two most significant units', () => {
    expect(formatAge(0)).toBe('<1m');
    expect(formatAge(59_000)).toBe('<1m');
    expect(formatAge(7 * 60_000)).toBe('7m');
    expect(formatAge(5 * HOUR + 12 * 60_000)).toBe('5h 12m');
    expect(formatAge(5 * HOUR)).toBe('5h');
    expect(formatAge(76 * HOUR)).toBe('3d 4h');
    expect(formatAge(48 * HOUR)).toBe('2d');
  });
});
