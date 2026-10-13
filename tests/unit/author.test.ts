import { describe, expect, it } from 'vitest';
import { AUTHOR_EMAIL, AUTHOR_NAME, copyrightYears } from '../../src/author.js';

describe('copyright line', () => {
  it('names the author and a mailbox', () => {
    expect(AUTHOR_NAME).toBe('Vasily Kamenev');
    expect(AUTHOR_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it('writes one year at first and a range later', () => {
    expect(copyrightYears(new Date('2026-10-13'))).toBe('2026');
    expect(copyrightYears(new Date('2028-01-02'))).toBe('2026–2028');
  });
});
