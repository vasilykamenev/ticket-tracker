import { describe, expect, it } from 'vitest';
import {
  assignTicketSchema,
  changeStatusSchema,
  DESCRIPTION_MAX,
  createTicketSchema,
  parseInput,
  updateTicketSchema,
} from '../../src/domain/tickets/schemas.js';
import {
  STATUS_CODES,
  TRANSITIONS,
  allowedTargets,
  applyOutcome,
  findTransition,
  isFrozen,
} from '../../src/domain/tickets/workflow.js';
import { ValidationError } from '../../src/domain/errors.js';
import { canAccessGroup, scopeFor, ticketScopeWhere } from '../../src/policies/ticket-policy.js';

const pair = (a: string, b: string) => `${a}->${b}`;

describe('transition matrix (requirements section 6)', () => {
  const allowed = new Set([
    'NEW->IN_PROGRESS',
    'IN_PROGRESS->WAITING_CUSTOMER',
    'WAITING_CUSTOMER->IN_PROGRESS',
    'IN_PROGRESS->RESOLVED',
    'WAITING_CUSTOMER->RESOLVED',
    'IN_PROGRESS->UNRESOLVED',
    'WAITING_CUSTOMER->UNRESOLVED',
    'UNRESOLVED->IN_PROGRESS',
    'RESOLVED->CLOSED',
    'RESOLVED->IN_PROGRESS',
    'CLOSED->IN_PROGRESS',
  ]);

  it('allows exactly the listed transitions and rejects every other pair', () => {
    for (const from of STATUS_CODES) {
      for (const to of STATUS_CODES) {
        expect(findTransition(from, to) !== undefined, pair(from, to)).toBe(allowed.has(pair(from, to)));
      }
    }
    expect(TRANSITIONS).toHaveLength(allowed.size);
  });

  it('never moves UNRESOLVED straight to RESOLVED or CLOSED', () => {
    expect(allowedTargets('UNRESOLVED', true)).toEqual(['IN_PROGRESS']);
  });

  it('makes closing and reopening a closed ticket ADMIN-only', () => {
    expect(allowedTargets('RESOLVED', false)).toEqual(['IN_PROGRESS']);
    expect(allowedTargets('RESOLVED', true).sort()).toEqual(['CLOSED', 'IN_PROGRESS']);
    expect(allowedTargets('CLOSED', false)).toEqual([]);
    expect(allowedTargets('CLOSED', true)).toEqual(['IN_PROGRESS']);
  });

  it('requires a reason when waiting or reopening, and outcome text for RESOLVED/UNRESOLVED', () => {
    expect(findTransition('IN_PROGRESS', 'WAITING_CUSTOMER')?.reason).toBe('required');
    for (const from of ['UNRESOLVED', 'RESOLVED', 'CLOSED'] as const) {
      expect(findTransition(from, 'IN_PROGRESS')?.reason, from).toBe('required');
    }
    expect(findTransition('IN_PROGRESS', 'RESOLVED')?.resolution).toBe(true);
    expect(findTransition('WAITING_CUSTOMER', 'UNRESOLVED')?.unresolvedReason).toBe(true);
    expect(findTransition('RESOLVED', 'CLOSED')?.assignee).toBe('none');
  });

  it('freezes only CLOSED and UNRESOLVED', () => {
    expect(STATUS_CODES.filter(isFrozen)).toEqual(['UNRESOLVED', 'CLOSED']);
  });
});

describe('applyOutcome', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const empty = { resolution: null, unresolvedReason: null, resolvedAt: null, unresolvedAt: null, closedAt: null };

  it('RESOLVED sets resolution and resolvedAt', () => {
    expect(applyOutcome(empty, 'RESOLVED', { resolution: 'Restarted the sync job' }, now)).toEqual({
      ...empty,
      resolution: 'Restarted the sync job',
      resolvedAt: now,
    });
  });

  it('UNRESOLVED clears the resolved outcome', () => {
    const resolved = { ...empty, resolution: 'x'.repeat(10), resolvedAt: now };
    expect(applyOutcome(resolved, 'UNRESOLVED', { unresolvedReason: 'Vendor limitation, no fix' }, now)).toEqual({
      ...empty,
      unresolvedReason: 'Vendor limitation, no fix',
      unresolvedAt: now,
    });
  });

  it('CLOSED keeps the confirmed resolution', () => {
    const resolved = { ...empty, resolution: 'Restarted the sync job', resolvedAt: now };
    const closedAt = new Date('2026-10-11T08:00:00Z');
    expect(applyOutcome(resolved, 'CLOSED', {}, closedAt)).toEqual({ ...resolved, closedAt });
  });

  it('returns only outcome columns even when given a whole ticket row', () => {
    const row = { ...empty, id: 'x', version: 3, subject: 's', resolution: 'Restarted the sync job', resolvedAt: now };
    for (const to of ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'UNRESOLVED', 'CLOSED'] as const) {
      expect(Object.keys(applyOutcome(row, to, { resolution: 'Restarted the sync job', unresolvedReason: 'Vendor limitation' }, now)).sort(), to).toEqual(
        ['closedAt', 'resolution', 'resolvedAt', 'unresolvedAt', 'unresolvedReason'],
      );
    }
  });

  it('reopening clears every outcome field', () => {
    const closed = { resolution: 'Restarted the sync job', unresolvedReason: null, resolvedAt: now, unresolvedAt: null, closedAt: now };
    expect(applyOutcome(closed, 'IN_PROGRESS', {}, now)).toEqual(empty);
    expect(applyOutcome({ ...empty, unresolvedReason: 'Vendor limitation', unresolvedAt: now }, 'IN_PROGRESS', {}, now)).toEqual(empty);
  });
});

describe('input schemas', () => {
  const ids = {
    customerId: '11111111-1111-4111-8111-111111111111',
    groupId: '22222222-2222-4222-8222-222222222222',
  };

  it('enforces the documented length limits', () => {
    const ok = { subject: 'Valid subject', description: 'd', ...ids };
    expect(parseInput(createTicketSchema, ok).priority).toBe('NORMAL');
    expect(() => parseInput(createTicketSchema, { ...ok, subject: 'abcd' })).toThrow(ValidationError);
    expect(() => parseInput(createTicketSchema, { ...ok, subject: 'x'.repeat(201) })).toThrow(ValidationError);
    expect(() => parseInput(createTicketSchema, { ...ok, description: ' ' })).toThrow(ValidationError);
    expect(parseInput(createTicketSchema, { ...ok, description: 'x'.repeat(DESCRIPTION_MAX) }).description).toHaveLength(1000); // the limit itself is allowed
    expect(() => parseInput(createTicketSchema, { ...ok, description: 'x'.repeat(DESCRIPTION_MAX + 1) })).toThrow(ValidationError);
    expect(() => parseInput(updateTicketSchema, { description: 'x'.repeat(DESCRIPTION_MAX + 1) })).toThrow(ValidationError);
  });

  it('rejects unknown or forbidden fields instead of passing them through', () => {
    const base = { subject: 'Valid subject', description: 'd', ...ids };
    expect(() => parseInput(createTicketSchema, { ...base, statusId: ids.groupId })).toThrow(ValidationError);
    expect(() => parseInput(createTicketSchema, { ...base, version: 5 })).toThrow(ValidationError);
    expect(() => parseInput(updateTicketSchema, { groupId: ids.groupId })).toThrow(ValidationError);
    expect(() => parseInput(updateTicketSchema, {})).toThrow(ValidationError);
    expect(() => parseInput(assignTicketSchema, {})).toThrow(ValidationError);
    expect(() => parseInput(changeStatusSchema, { targetStatus: 'CLOSED', closedAt: '2020-01-01' })).toThrow(ValidationError);
  });

  it('requires outcome text of at least 10 characters', () => {
    expect(() => parseInput(changeStatusSchema, { targetStatus: 'RESOLVED', resolution: 'too short' })).toThrow(ValidationError);
    expect(parseInput(changeStatusSchema, { targetStatus: 'RESOLVED', resolution: 'long enough!' }).resolution).toBe('long enough!');
    expect(() => parseInput(changeStatusSchema, { targetStatus: 'NOPE' })).toThrow(ValidationError);
  });
});

describe('scope policy', () => {
  const admin = { userId: 'u1', role: 'ADMIN' as const, agentId: null };
  const agent = { userId: 'u2', role: 'AGENT' as const, agentId: 'a1' };

  it('gives ADMIN every group and an empty filter', () => {
    const scope = scopeFor(admin, []);
    expect(canAccessGroup(scope, 'any')).toBe(true);
    expect(ticketScopeWhere(scope)).toEqual({});
  });

  it('limits AGENT to member groups, and a user filter can only narrow it', () => {
    const scope = scopeFor(agent, ['g1', 'g2']);
    expect(canAccessGroup(scope, 'g1')).toBe(true);
    expect(canAccessGroup(scope, 'g3')).toBe(false);
    expect(ticketScopeWhere(scope)).toEqual({ groupId: { in: ['g1', 'g2'] } });
  });

  it('gives an AGENT with no memberships an empty scope', () => {
    expect(ticketScopeWhere(scopeFor(agent, []))).toEqual({ groupId: { in: [] } });
  });
});
