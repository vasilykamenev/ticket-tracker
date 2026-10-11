// Access policies, requirements section 7. Pure functions: callers load the scope inside their transaction.
import type { Prisma } from '@prisma/client';
import { ForbiddenError } from '../domain/errors.js';

export interface Actor {
  userId: string;
  role: 'ADMIN' | 'AGENT';
  /** Agent profile id; an AGENT without one has an empty scope. */
  agentId: string | null;
}

/** Which groups' tickets an actor may touch. ADMIN: everything. AGENT: own groups only. */
export type Scope = { all: true } | { all: false; groupIds: ReadonlySet<string> };

export function scopeFor(actor: Actor, memberGroupIds: Iterable<string>): Scope {
  return actor.role === 'ADMIN' ? { all: true } : { all: false, groupIds: new Set(memberGroupIds) };
}

export function canAccessGroup(scope: Scope, groupId: string): boolean {
  return scope.all || scope.groupIds.has(groupId);
}

/**
 * Mandatory part of every ticket query (list, count, show, search, reference lookups).
 * Combine with user filters using AND so a query parameter can never widen the scope.
 */
export function ticketScopeWhere(scope: Scope): Prisma.TicketWhereInput {
  return scope.all ? {} : { groupId: { in: [...scope.groupIds] } };
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'ADMIN';
}

/** The one place that turns "ADMIN only" into an error, so every service refuses in the same way. */
export function requireAdmin(actor: Actor, message = 'Only an administrator may do this'): void {
  if (!isAdmin(actor)) throw new ForbiddenError('admin_only', message);
}
