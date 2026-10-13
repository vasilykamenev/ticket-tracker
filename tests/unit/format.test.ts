import { describe, expect, it } from 'vitest';
import { formatDay, formatRelative, initials } from '../../src/admin/format.js';

const now = new Date('2026-10-13T12:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe('formatRelative', () => {
  it('says "just now" for the last moments', () => {
    expect(formatRelative(ago(5), now)).toBe('just now');
  });

  it('uses the largest fitting unit', () => {
    expect(formatRelative(ago(5 * 60), now)).toBe('5 minutes ago');
    expect(formatRelative(ago(3 * 3600), now)).toBe('3 hours ago');
    expect(formatRelative(ago(2 * 86_400), now)).toBe('2 days ago');
    expect(formatRelative(ago(14 * 86_400), now)).toBe('2 weeks ago');
  });

  it('writes the future too, and survives garbage', () => {
    expect(formatRelative(new Date(now.getTime() + 3 * 3600 * 1000), now)).toBe('in 3 hours');
    expect(formatRelative('not a date', now)).toBe('—');
  });
});

describe('formatDay and initials', () => {
  it('writes a day in the same form everywhere', () => {
    expect(formatDay('2026-10-13T12:00:00Z')).toBe('13 Oct 2026');
  });

  it('takes the first and the last name for initials', () => {
    expect(initials('Anna Maria Petrova')).toBe('AP');
    expect(initials('  cher ')).toBe('C');
    expect(initials('')).toBe('?');
  });
});
