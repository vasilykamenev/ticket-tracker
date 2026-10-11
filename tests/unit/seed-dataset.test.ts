import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateUpload } from '../../src/storage/file-validation.js';
import { checkDataset, type DatasetView } from '../../src/seed/checks.js';
import { SIZES, STATUS_COUNTS, generateDataset } from '../../src/seed/dataset.js';
import { seedId } from '../../src/seed/ids.js';

const REF = new Date('2026-10-11T06:00:00Z');
const data = generateDataset({ seed: 42, referenceDate: REF });
const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');

/** A deep copy that can be corrupted without touching the shared dataset. */
function copy(): DatasetView {
  return JSON.parse(JSON.stringify(data), (key, value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && /At$|^createdAt$/.test(key) ? new Date(value) : value)) as DatasetView;
}

describe('demo dataset: shape', () => {
  it('has exactly the volumes of requirements section 13', () => {
    expect(data.users.filter((u) => u.role === 'ADMIN')).toHaveLength(SIZES.admins);
    expect(data.agents).toHaveLength(SIZES.agents);
    expect(data.groups.map((g) => g.name)).toEqual(['General', 'Billing', 'Integrations', 'Platform', 'Access']);
    expect(data.memberships).toHaveLength(SIZES.memberships);
    expect(data.customers).toHaveLength(SIZES.customers);
    expect(data.tickets).toHaveLength(SIZES.tickets);
    expect(data.comments).toHaveLength(SIZES.comments);
    expect(data.attachments).toHaveLength(SIZES.attachments);
    for (const [status, count] of Object.entries(STATUS_COUNTS)) expect(data.tickets.filter((t) => t.status === status)).toHaveLength(count);
  });

  it('uses only example.test addresses and keeps every ticket inside the 90 days before the reference date', () => {
    for (const email of [...data.users.map((u) => u.email), ...data.customers.map((c) => c.email)]) expect(email).toMatch(/@example\.test$/);
    const oldest = REF.getTime() - 90 * 24 * 60 * 60 * 1000;
    for (const t of data.tickets) {
      expect(t.createdAt.getTime()).toBeGreaterThanOrEqual(oldest);
      expect(t.updatedAt.getTime()).toBeLessThanOrEqual(REF.getTime());
    }
  });

  it('uses all four priorities and all five groups', () => {
    expect(new Set(data.tickets.map((t) => t.priority))).toEqual(new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']));
    expect(new Set(data.tickets.map((t) => t.groupId)).size).toBe(5);
  });

  it('passes every consistency check (workflow chains, assignees, dates, comments, coverage)', () => {
    const result = checkDataset(data, { referenceDate: REF });
    expect(result.problems).toEqual([]);
    expect(result.stats['agents in two groups']).toBe(10);
    expect(result.stats['NEW unassigned']).toBeGreaterThan(0);
  });
});

describe('demo dataset: reproducibility', () => {
  it('is the same for the same seed and different for another one', () => {
    expect(hash(generateDataset({ seed: 42, referenceDate: REF }).tickets)).toBe(hash(data.tickets));
    expect(hash(generateDataset({ seed: 7, referenceDate: REF }).tickets)).not.toBe(hash(data.tickets));
  });

  it('gives every record an id that does not depend on the random seed', () => {
    const other = generateDataset({ seed: 7, referenceDate: REF });
    expect(other.tickets.map((t) => t.id)).toEqual(data.tickets.map((t) => t.id));
    expect(other.customers.map((c) => c.id)).toEqual(data.customers.map((c) => c.id));
    expect(other.users.map((u) => u.id)).toEqual(data.users.map((u) => u.id));
    expect(new Set(data.tickets.map((t) => t.id)).size).toBe(SIZES.tickets);
  });

  it('derives ids from the dataset name, so two datasets never share a row', () => {
    expect(seedId('takehome-demo', 'ticket', 1)).toBe(seedId('takehome-demo', 'ticket', 1));
    expect(seedId('takehome-demo', 'ticket', 1)).not.toBe(seedId('another-demo', 'ticket', 1));
    expect(seedId('takehome-demo', 'ticket', 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('demo dataset: ticket numbers', () => {
  it('numbers the default dataset 1001..3000 and leaves other datasets to the database', () => {
    expect(data.tickets.map((t) => t.number)).toEqual(Array.from({ length: SIZES.tickets }, (_, i) => 1001 + i));
    expect(generateDataset({ dataset: 'seedtest-x', seed: 42, referenceDate: REF }).tickets.every((t) => t.number === null)).toBe(true);
  });
});

describe('demo dataset: files', () => {
  it('builds safe files that pass the same validation as uploads, the same bytes every time', () => {
    for (const a of data.attachments) {
      const bytes = a.build();
      const checked = validateUpload({ originalName: a.originalName, declaredType: a.contentType, data: bytes });
      expect(checked.contentType).toBe(a.contentType);
      expect(a.build().equals(bytes)).toBe(true);
    }
    expect(new Set(data.attachments.map((a) => a.kind))).toEqual(new Set(['png', 'jpeg', 'pdf', 'txt']));
  });

  it('keeps most files within 50 KiB (the real bytes, not the target) and puts them under server-chosen keys', () => {
    const sizes = data.attachments.map((a) => a.build().length);
    expect(sizes.filter((n) => n <= 50 * 1024).length).toBeGreaterThan(SIZES.attachments * 0.8);
    expect(Math.max(...sizes)).toBeLessThan(200 * 1024);
    for (const a of data.attachments) expect(a.objectKey).toMatch(new RegExp(`^tickets/${a.ticketId}/comments/${a.commentId}/[0-9a-f-]{36}$`));
  });
});

describe('consistency checks catch corruption', () => {
  it('a transition the workflow does not allow', () => {
    const view = copy();
    const changed = view.history.find((h) => h.kind === 'STATUS_CHANGED' && h.after.status === 'IN_PROGRESS' && h.before?.status === 'NEW')!;
    changed.after = { ...changed.after, status: 'CLOSED' };
    expect(checkDataset(view).problems.join('\n')).toMatch(/not a permitted transition|does not continue/);
  });

  it('a wrong status count and an assignee outside the group', () => {
    const view = copy();
    view.tickets.find((t) => t.status === 'NEW')!.status = 'CLOSED';
    const assigned = view.tickets.find((t) => t.assignedAgentId)!;
    assigned.assignedAgentId = view.agents.find((a) => !view.memberships.some((m) => m.agentId === a.id && m.groupId === assigned.groupId))!.id;
    const text = checkDataset(view).problems.join('\n');
    expect(text).toMatch(/tickets NEW is 499/);
    expect(text).toMatch(/outside its group/);
  });

  it('a comment written while the ticket was closed, and one before the ticket existed', () => {
    const view = copy();
    const closed = view.tickets.find((t) => t.status === 'CLOSED')!;
    closed.updatedAt = new Date(closed.updatedAt.getTime() + 24 * 60 * 60 * 1000); // a day after the closing
    const inFrozen = new Date(closed.updatedAt.getTime() - 1000);
    view.comments.push({ id: 'extra-1', ticketId: closed.id, authorUserId: view.users[2]!.id, createdAt: inFrozen, updatedAt: inFrozen });
    view.comments.push({ id: 'extra-2', ticketId: closed.id, authorUserId: view.users[2]!.id, createdAt: new Date(closed.createdAt.getTime() - 1000), updatedAt: closed.createdAt });
    const text = checkDataset(view).problems.join('\n');
    expect(text).toMatch(/while the ticket was CLOSED/);
    expect(text).toMatch(/outside createdAt..updatedAt/);
  });

  it('an admin-only step done by an agent, and a lost history entry', () => {
    const view = copy();
    const closing = view.history.find((h) => h.kind === 'STATUS_CHANGED' && h.after.status === 'CLOSED')!;
    closing.actorUserId = view.users.find((u) => u.role === 'AGENT')!.id;
    const victim = view.history.findIndex((h) => h.kind === 'STATUS_CHANGED' && h.after.status === 'RESOLVED');
    view.history.splice(victim, 1);
    const text = checkDataset(view).problems.join('\n');
    expect(text).toMatch(/done by a non-admin/);
    expect(text).toMatch(/does not continue|version/);
  });

  it('a priority nobody has, a foreign address and a ticket older than the 90 days', () => {
    const view = copy();
    for (const t of view.tickets) if (t.priority === 'URGENT') t.priority = 'HIGH';
    view.users[0]!.email = 'someone@gmail.com';
    view.customers[0]!.email = 'customer@company.example';
    view.tickets[0]!.createdAt = new Date(REF.getTime() - 100 * 24 * 60 * 60 * 1000);
    const text = checkDataset(view, { referenceDate: REF }).problems.join('\n');
    expect(text).toMatch(/no ticket has priority URGENT/);
    expect(text).toMatch(/someone@gmail.com is not an example.test address/);
    expect(text).toMatch(/customer@company.example is not an example.test address/);
    expect(text).toMatch(/more than 90 days before the reference date/);
  });

  it('an inactive assignee, an attachment before its comment and a resolution without a date', () => {
    const view = copy();
    const assigned = view.tickets.find((t) => t.assignedAgentId)!;
    view.agents.find((a) => a.id === assigned.assignedAgentId)!.isActive = false;
    view.attachments[0]!.createdAt = new Date(0);
    const resolving = view.history.find((h) => h.kind === 'STATUS_CHANGED' && h.after.status === 'RESOLVED')!;
    resolving.after = { ...resolving.after, resolvedAt: null };
    const text = checkDataset(view).problems.join('\n');
    expect(text).toMatch(/inactive agent/);
    expect(text).toMatch(/attachment of ticket .* lies outside its comment/);
    expect(text).toMatch(/resolved without a resolution and date|does not continue/);
  });

  it('missing attachments', () => {
    const view = copy();
    view.attachments.pop();
    expect(checkDataset(view).problems.join('\n')).toMatch(/attachments is 199/);
  });
});
