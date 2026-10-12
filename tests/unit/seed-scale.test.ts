import { describe, expect, it } from 'vitest';
import { checkDataset, type DatasetView } from '../../src/seed/checks.js';
import { MAX_TICKETS, MIN_TICKETS, SIZES, STATUS_COUNTS, generateDataset, sizesFor, statusCountsFor } from '../../src/seed/dataset.js';
import { parseTicketCount } from '../../src/seed/cli.js';
import { SeedGuardError } from '../../src/seed/config.js';

const REF = new Date('2026-10-11T06:00:00Z');

describe('dataset size', () => {
  it('2000 tickets are exactly the volumes of the requirements', () => {
    expect(sizesFor(2000)).toEqual({ admins: 2, agents: 15, groups: 5, memberships: 25, customers: 300, tickets: 2000, comments: 10000, attachments: 200 });
    expect(statusCountsFor(2000)).toEqual({ NEW: 500, IN_PROGRESS: 600, WAITING_CUSTOMER: 300, RESOLVED: 300, UNRESOLVED: 100, CLOSED: 200 });
    expect(SIZES).toEqual(sizesFor(2000));
    expect(STATUS_COUNTS).toEqual(statusCountsFor(2000));
  });

  it.each([500, 777, 2001, 20_000, 200_000, 1_000_000])('%i tickets: the statuses add up and the other volumes follow', (tickets) => {
    const sizes = sizesFor(tickets);
    expect(Object.values(statusCountsFor(tickets)).reduce((a, b) => a + b, 0)).toBe(tickets);
    expect(sizes.comments).toBe(tickets * 5);
    expect(sizes.customers).toBeGreaterThanOrEqual(170);
    expect(sizes.attachments).toBeLessThanOrEqual(500); // every file is a real object in the bucket
    expect(sizes.attachments).toBeLessThanOrEqual(sizes.comments);
  });

  it('refuses a count outside the supported range', () => {
    for (const bad of [MIN_TICKETS - 1, MAX_TICKETS + 1, 1.5, Number.NaN]) expect(() => sizesFor(bad)).toThrow(RangeError);
    expect(() => parseTicketCount('abc')).toThrow(SeedGuardError);
    expect(() => parseTicketCount('10')).toThrow(SeedGuardError);
    expect(parseTicketCount(undefined)).toBe(2000);
    expect(parseTicketCount('20_000')).toBe(20_000);
    expect(parseTicketCount('200,000')).toBe(200_000);
  });

  it.each([MIN_TICKETS, 3333])('a dataset of %i tickets has its volumes and passes every consistency check', (tickets) => {
    const data = generateDataset({ seed: 42, referenceDate: REF, tickets });
    expect(data.tickets).toHaveLength(tickets);
    expect(data.comments).toHaveLength(sizesFor(tickets).comments);
    expect(data.customers).toHaveLength(sizesFor(tickets).customers);
    expect(data.attachments).toHaveLength(sizesFor(tickets).attachments);
    expect(data.tickets.map((t) => t.number)).toEqual(Array.from({ length: tickets }, (_, i) => 1001 + i));
    expect(checkDataset(data as unknown as DatasetView, { referenceDate: REF, tickets }).problems).toEqual([]);
  });

  it('is reproducible, and the default size is unchanged by the option', () => {
    const a = generateDataset({ seed: 7, referenceDate: REF, tickets: 600 });
    const b = generateDataset({ seed: 7, referenceDate: REF, tickets: 600 });
    expect(a.tickets.map((t) => t.subject)).toEqual(b.tickets.map((t) => t.subject));
    expect(generateDataset({ seed: 42, referenceDate: REF }).tickets).toHaveLength(2000);
  });
});
