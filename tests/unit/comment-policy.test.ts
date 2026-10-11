import { describe, expect, it } from 'vitest';
import { canAddComment, canEditComment } from '../../src/policies/comment-policy.js';
import { STATUS_CODES } from '../../src/domain/tickets/workflow.js';

const admin = { userId: 'admin-1', role: 'ADMIN' as const, agentId: null };
const agent = { userId: 'agent-1', role: 'AGENT' as const, agentId: 'a1' };

describe('canAddComment', () => {
  it('allows every status except CLOSED and UNRESOLVED', () => {
    const allowed = STATUS_CODES.filter(canAddComment);
    expect(allowed).toEqual(['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED']);
  });

  it('fails closed on a status it does not know', () => {
    expect(canAddComment('SOMETHING_ELSE')).toBe(false);
    expect(canAddComment('')).toBe(false);
  });
});

describe('canEditComment', () => {
  it('lets ADMIN edit anyone\'s comment and an AGENT only their own', () => {
    expect(canEditComment(admin, 'agent-1', 'IN_PROGRESS')).toBe(true);
    expect(canEditComment(agent, 'agent-1', 'IN_PROGRESS')).toBe(true);
    expect(canEditComment(agent, 'admin-1', 'IN_PROGRESS')).toBe(false);
    expect(canEditComment(agent, 'agent-2', 'NEW')).toBe(false);
  });

  it('keeps RESOLVED editable according to the role rules', () => {
    expect(canEditComment(agent, 'agent-1', 'RESOLVED')).toBe(true);
    expect(canEditComment(agent, 'someone-else', 'RESOLVED')).toBe(false);
  });

  it('allows nobody to edit on CLOSED or UNRESOLVED tickets, whatever the role', () => {
    for (const status of ['CLOSED', 'UNRESOLVED']) {
      expect(canEditComment(admin, 'agent-1', status), `admin ${status}`).toBe(false);
      expect(canEditComment(agent, 'agent-1', status), `author ${status}`).toBe(false);
    }
  });
});
