// Status workflow, requirements section 6. Pure functions: no database access.

export const STATUS_CODES = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'UNRESOLVED', 'CLOSED'] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

/** Display names and colors for the system statuses; names/colors are editable, codes are not. */
export const SYSTEM_STATUSES: ReadonlyArray<{ code: StatusCode; name: string; color: string; sortOrder: number }> = [
  { code: 'NEW', name: 'New', color: '#3b82f6', sortOrder: 10 },
  { code: 'IN_PROGRESS', name: 'In progress', color: '#f59e0b', sortOrder: 20 },
  { code: 'WAITING_CUSTOMER', name: 'Waiting for customer', color: '#8b5cf6', sortOrder: 30 },
  { code: 'RESOLVED', name: 'Resolved', color: '#10b981', sortOrder: 40 },
  { code: 'UNRESOLVED', name: 'Unresolved', color: '#ef4444', sortOrder: 50 },
  { code: 'CLOSED', name: 'Closed', color: '#6b7280', sortOrder: 60 },
];

export const ACTIVE_STATUSES: readonly StatusCode[] = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER'];
export const SOLVED_STATUSES: readonly StatusCode[] = ['RESOLVED', 'CLOSED'];

/** CLOSED and UNRESOLVED tickets cannot be edited, assigned or commented on until reopened. */
export function isFrozen(code: StatusCode): boolean {
  return code === 'CLOSED' || code === 'UNRESOLVED';
}

export function isStatusCode(value: string): value is StatusCode {
  return (STATUS_CODES as readonly string[]).includes(value);
}

export const RESOLUTION_MIN = 10;
export const OUTCOME_MAX = 2000;
export const REASON_MAX = 2000;

export interface TransitionRule {
  from: StatusCode;
  to: StatusCode;
  adminOnly: boolean;
  /**
   * none: assignee not checked (ADMIN may close without a valid historical assignee)
   * set: an assignee must be set
   * activeMember: an active agent who belongs to the ticket's active group
   */
  assignee: 'none' | 'set' | 'activeMember';
  reason: 'required' | 'optional';
  resolution: boolean;
  unresolvedReason: boolean;
}

const rule = (r: Partial<TransitionRule> & Pick<TransitionRule, 'from' | 'to'>): TransitionRule => ({
  adminOnly: false,
  assignee: 'set',
  reason: 'optional',
  resolution: false,
  unresolvedReason: false,
  ...r,
});

export const TRANSITIONS: readonly TransitionRule[] = [
  rule({ from: 'NEW', to: 'IN_PROGRESS', assignee: 'activeMember' }),
  rule({ from: 'IN_PROGRESS', to: 'WAITING_CUSTOMER', reason: 'required' }),
  rule({ from: 'WAITING_CUSTOMER', to: 'IN_PROGRESS', assignee: 'activeMember' }),
  rule({ from: 'IN_PROGRESS', to: 'RESOLVED', resolution: true }),
  rule({ from: 'WAITING_CUSTOMER', to: 'RESOLVED', resolution: true }),
  rule({ from: 'IN_PROGRESS', to: 'UNRESOLVED', assignee: 'activeMember', unresolvedReason: true }),
  rule({ from: 'WAITING_CUSTOMER', to: 'UNRESOLVED', assignee: 'activeMember', unresolvedReason: true }),
  rule({ from: 'UNRESOLVED', to: 'IN_PROGRESS', assignee: 'activeMember', reason: 'required' }),
  rule({ from: 'RESOLVED', to: 'CLOSED', adminOnly: true, assignee: 'none' }),
  rule({ from: 'RESOLVED', to: 'IN_PROGRESS', assignee: 'activeMember', reason: 'required' }),
  rule({ from: 'CLOSED', to: 'IN_PROGRESS', adminOnly: true, assignee: 'activeMember', reason: 'required' }),
];

export function findTransition(from: StatusCode, to: StatusCode): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Targets reachable from a status (for UI hints; the server re-checks every transition). */
export function allowedTargets(from: StatusCode, isAdmin: boolean): StatusCode[] {
  return TRANSITIONS.filter((t) => t.from === from && (isAdmin || !t.adminOnly)).map((t) => t.to);
}

export interface OutcomeFields {
  resolution: string | null;
  unresolvedReason: string | null;
  resolvedAt: Date | null;
  unresolvedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Outcome columns after a transition:
 * - RESOLVED sets resolution/resolvedAt;
 * - UNRESOLVED sets unresolvedReason/unresolvedAt and clears the resolved outcome;
 * - CLOSED keeps the confirmed resolution and sets closedAt;
 * - every other target (including reopening) clears all outcome fields.
 * Previous values stay available in TicketHistory.before.
 */
export function applyOutcome(
  current: OutcomeFields,
  to: StatusCode,
  input: { resolution?: string; unresolvedReason?: string },
  now: Date,
): OutcomeFields {
  const cleared: OutcomeFields = { resolution: null, unresolvedReason: null, resolvedAt: null, unresolvedAt: null, closedAt: null };
  switch (to) {
    case 'RESOLVED':
      return { ...cleared, resolution: input.resolution ?? null, resolvedAt: now };
    case 'UNRESOLVED':
      return { ...cleared, unresolvedReason: input.unresolvedReason ?? null, unresolvedAt: now };
    case 'CLOSED':
      // Pick the outcome columns explicitly: `current` is usually a whole Ticket row and must not leak into an update.
      return {
        resolution: current.resolution,
        unresolvedReason: current.unresolvedReason,
        resolvedAt: current.resolvedAt,
        unresolvedAt: current.unresolvedAt,
        closedAt: now,
      };
    default:
      return cleared;
  }
}
