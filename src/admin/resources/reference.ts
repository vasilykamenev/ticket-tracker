import type { ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import { loadScope } from '../../domain/db.js';
import { isAdmin } from '../../policies/ticket-policy.js';
import { GuardedResource } from '../guarded-resource.js';
import { ADMIN_ONLY_READ, READ_ONLY, onlyIn } from './helpers.js';

/**
 * Read-only reference data. Editing arrives with the staff/group administration (stage 6) and will
 * go through domain services. Until then nothing here is writable, and every read is scoped.
 */

export function groupResource(prisma: PrismaClient): ResourceWithOptions {
  return {
    resource: new GuardedResource(
      { model: getModelByName('SupportGroup'), client: prisma },
      {
        // AGENT sees only own groups; ADMIN sees all.
        readScope: async (actor, db) => {
          const scope = await loadScope(db, actor);
          return scope.all ? {} : { id: { in: [...scope.groupIds] } };
        },
      },
    ),
    options: {
      navigation: { name: 'Administration', icon: 'Layers' },
      properties: { id: { isVisible: false }, name: { isTitle: true } },
      actions: READ_ONLY,
    },
  };
}

export function agentResource(prisma: PrismaClient): ResourceWithOptions {
  return {
    resource: new GuardedResource(
      { model: getModelByName('Agent'), client: prisma },
      {
        // AGENT sees colleagues who share a group (what assignment needs); ADMIN sees all.
        readScope: async (actor, db) => {
          const scope = await loadScope(db, actor);
          return scope.all ? {} : { groups: { some: { groupId: { in: [...scope.groupIds] } } } };
        },
      },
    ),
    options: {
      navigation: { name: 'Administration', icon: 'User' },
      properties: { id: { isVisible: false }, displayName: { isTitle: true }, userId: { isVisible: onlyIn('show') } },
      actions: READ_ONLY,
    },
  };
}

export function statusResource(prisma: PrismaClient): ResourceWithOptions {
  return {
    resource: new GuardedResource(
      { model: getModelByName('TicketStatus'), client: prisma },
      { readScope: async (actor) => (isAdmin(actor) ? {} : { isActive: true }) },
    ),
    options: {
      navigation: { name: 'Administration', icon: 'Tag' },
      sort: { sortBy: 'sortOrder', direction: 'asc' },
      properties: { id: { isVisible: false }, name: { isTitle: true } },
      actions: READ_ONLY,
    },
  };
}

/** Fields no actor may ever receive, regardless of which UI asks. */
const NEVER = ['passwordHash', 'sessionVersion'];
/** Fields only ADMIN may receive. AGENT gets just enough to display a name. */
const ADMIN_FIELDS = ['normalizedEmail', 'role', 'isActive', 'createdAt', 'updatedAt'];

export function userResource(prisma: PrismaClient): ResourceWithOptions {
  return {
    resource: new GuardedResource(
      { model: getModelByName('User'), client: prisma },
      {
        // AGENT may resolve names of colleagues and ticket creators within their scope (for display).
        readScope: async (actor, db) => {
          if (isAdmin(actor)) return {};
          const scope = await loadScope(db, actor);
          const groupIds = scope.all ? [] : [...scope.groupIds];
          return {
            OR: [
              { id: actor.userId },
              { agent: { groups: { some: { groupId: { in: groupIds } } } } },
              { createdTickets: { some: { groupId: { in: groupIds } } } },
            ],
          };
        },
        redact: (actor, row) => {
          const hidden = isAdmin(actor) ? NEVER : [...NEVER, ...ADMIN_FIELDS];
          return Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.includes(key)));
        },
      },
    ),
    options: {
      navigation: { name: 'Administration', icon: 'Shield' },
      properties: { id: { isVisible: false }, displayName: { isTitle: true }, passwordHash: { isVisible: false }, sessionVersion: { isVisible: false } },
      actions: ADMIN_ONLY_READ,
    },
  };
}
