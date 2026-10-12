import type { ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import { loadScope } from '../../domain/db.js';
import { ValidationError } from '../../domain/errors.js';
import type { GroupQueries } from '../../domain/groups/group-queries.js';
import type { GroupService } from '../../domain/groups/group-service.js';
import type { StatusService } from '../../domain/statuses/status-service.js';
import type { AgentService } from '../../domain/users/agent-service.js';
import type { UserService } from '../../domain/users/user-service.js';
import { isAdmin } from '../../policies/ticket-policy.js';
import { Components } from '../component-loader.js';
import { labelled } from '../field-catalog.js';
import { GuardedResource, actorFromContext } from '../guarded-resource.js';
import { ADMIN_MANAGED, ADMIN_WRITE, NO_DELETE, adminOnly, longText, onlyIn, toggle } from './helpers.js';
import { dataAction, formAction, mutationAction, recordId } from './record-actions.js';

/**
 * Staff, groups and statuses. Reads are scoped by the resource; every write goes through a domain
 * service, which re-checks that the caller is an ADMIN. The forms only expose what may be edited.
 */

const blank = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Form fields that must not change in the generic edit form; a change is rejected, not ignored. */
function assertUnchanged(params: Record<string, unknown>, current: Record<string, unknown>, fields: Record<string, string>, hint: string): void {
  const details: Record<string, string> = {};
  for (const [field, column] of Object.entries(fields)) {
    if (field in params && blank(params[field]) !== blank(current[column])) details[field] = hint;
  }
  if (Object.keys(details).length > 0) throw new ValidationError('validation', 'Invalid input', details);
}

const without = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

/** Shown read-only on an existing record (code, owner account, role). */
const readonlyOnEdit = (hint?: string) => ({ components: { edit: Components.ModeField }, custom: { mode: 'readonlyOnEdit', hint } });
const createOnly = () => ({ components: { edit: Components.ModeField }, custom: { mode: 'createOnly' } });
const editOnly = () => ({ components: { edit: Components.ModeField }, custom: { mode: 'editOnly' } });

export function groupResource(prisma: PrismaClient, groups: GroupService, groupQueries: GroupQueries): ResourceWithOptions {
  const resource = new GuardedResource(
    { model: getModelByName('SupportGroup'), client: prisma },
    {
      // AGENT sees only own groups; ADMIN sees all.
      readScope: async (actor, db) => {
        const scope = await loadScope(db, actor);
        return scope.all ? {} : { id: { in: [...scope.groupIds] } };
      },
      fallbackErrorField: 'name',
      create: (actor, p) => groups.create(actor, { code: p.code, name: p.name, description: p.description }),
      update: async (actor, id, p) => {
        const current = await prisma.supportGroup.findUnique({ where: { id } });
        if (current) assertUnchanged(p, current, { code: 'code' }, 'the code never changes');
        return groups.update(actor, id, without({ name: p.name, description: p.description, isActive: p.isActive }));
      },
    },
  );
  return {
    resource,
    options: {
      navigation: { name: 'Administration', icon: 'Layers' },
      listProperties: ['code', 'name', 'isActive'],
      showProperties: ['code', 'name', 'description', 'isActive', 'members'],
      properties: labelled('SupportGroup', {
        id: { isVisible: false },
        code: { isVisible: onlyIn('list', 'show', 'edit'), ...readonlyOnEdit('The code is fixed once the group exists.') },
        name: { isTitle: true },
        description: { type: 'textarea', isVisible: onlyIn('show', 'edit'), ...longText() },
        // Activity is edited, not set at creation: new groups start active.
        isActive: { isVisible: onlyIn('list', 'show', 'edit'), ...toggle({ editOnly: true }) },
        members: { type: 'mixed', isVisible: onlyIn('show'), components: { show: Components.GroupMembers } },
      }),
      actions: {
        ...ADMIN_WRITE,
        // Everyone in the group may read the member list; only ADMIN sees the controls.
        members: dataAction((context, request) => groupQueries.members(actorFromContext(context), recordId(request))),
        addMember: { ...mutationAction((context, request, p) => groups.addMember(actorFromContext(context), String(p.agentId), recordId(request))), isAccessible: adminOnly },
        removeMember: { ...mutationAction((context, request, p) => groups.removeMember(actorFromContext(context), String(p.agentId), recordId(request))), isAccessible: adminOnly },
      },
    },
  };
}

export function agentResource(prisma: PrismaClient, agents: AgentService): ResourceWithOptions {
  const resource = new GuardedResource(
    { model: getModelByName('Agent'), client: prisma },
    {
      // AGENT sees colleagues who share a group (what assignment needs); ADMIN sees all.
      readScope: async (actor, db) => {
        const scope = await loadScope(db, actor);
        return scope.all ? {} : { groups: { some: { groupId: { in: [...scope.groupIds] } } } };
      },
      errorFields: { userId: 'user' },
      fallbackErrorField: 'displayName',
      create: (actor, p) => agents.createProfile(actor, { userId: p.user, displayName: blank(p.displayName) ?? undefined }),
      update: async (actor, id, p) => {
        const current = await prisma.agent.findUnique({ where: { id } });
        if (current) assertUnchanged(p, current, { user: 'userId' }, 'the account of a support profile cannot change');
        return agents.update(actor, id, without({ displayName: p.displayName, isActive: p.isActive }));
      },
    },
  );
  return {
    resource,
    options: {
      navigation: { name: 'Administration', icon: 'User' },
      listProperties: ['displayName', 'user', 'isActive'],
      properties: labelled('Agent', {
        id: { isVisible: false },
        displayName: { isTitle: true },
        user: { isVisible: onlyIn('list', 'show', 'edit'), ...readonlyOnEdit('The account cannot be changed.') },
        isActive: { isVisible: onlyIn('list', 'show', 'edit'), ...toggle({ editOnly: true }) },
      }),
      actions: ADMIN_WRITE,
    },
  };
}

export function statusResource(prisma: PrismaClient, statuses: StatusService): ResourceWithOptions {
  const resource = new GuardedResource(
    { model: getModelByName('TicketStatus'), client: prisma },
    {
      readScope: async (actor) => (isAdmin(actor) ? {} : { isActive: true }),
      fallbackErrorField: 'name',
      // No create: a new status needs a migration and workflow changes.
      update: async (actor, id, p) => {
        const current = await prisma.ticketStatus.findUnique({ where: { id } });
        if (current) assertUnchanged(p, current, { code: 'code' }, 'the code is fixed by the workflow');
        return statuses.update(actor, id, without({ name: p.name, color: p.color, sortOrder: p.sortOrder === undefined ? undefined : Number(p.sortOrder), isActive: p.isActive }));
      },
    },
  );
  return {
    resource,
    options: {
      navigation: { name: 'Administration', icon: 'Tag' },
      sort: { sortBy: 'sortOrder', direction: 'asc' },
      listProperties: ['code', 'name', 'color', 'sortOrder', 'isActive'],
      properties: labelled('TicketStatus', {
        id: { isVisible: false },
        code: { isVisible: onlyIn('list', 'show', 'edit'), ...readonlyOnEdit('The code is fixed by the workflow.') },
        name: { isTitle: true },
        isActive: toggle(),
      }),
      actions: { ...NO_DELETE, new: { isAccessible: () => false }, edit: { isAccessible: adminOnly } },
    },
  };
}

/** Fields no actor may ever receive, regardless of which UI asks. */
const NEVER = ['passwordHash', 'sessionVersion'];
/** Fields only ADMIN may receive. AGENT gets just enough to display a name. */
const ADMIN_FIELDS = ['normalizedEmail', 'role', 'isActive', 'createdAt', 'updatedAt'];

export function userResource(prisma: PrismaClient, users: UserService): ResourceWithOptions {
  const resource = new GuardedResource(
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
      errorFields: { email: 'normalizedEmail' },
      fallbackErrorField: 'displayName',
      create: (actor, p) => users.create(actor, { email: p.normalizedEmail, displayName: p.displayName, role: p.role, password: p.password }),
      update: async (actor, id, p) => {
        const current = await users.get(actor, id); // ADMIN only
        // Role and password have their own actions; they never travel through the profile form.
        const details: Record<string, string> = {};
        if ('role' in p && blank(p.role) !== current.role) details.role = 'use the Change role action';
        if (blank(p.password) !== null) details.password = 'use the Set password action';
        if (Object.keys(details).length > 0) throw new ValidationError('validation', 'Invalid input', details);
        return users.update(actor, id, without({ displayName: p.displayName, email: p.normalizedEmail, isActive: p.isActive }));
      },
    },
  );
  return {
    resource,
    options: {
      navigation: { name: 'Administration', icon: 'Shield' },
      listProperties: ['displayName', 'normalizedEmail', 'role', 'isActive'],
      filterProperties: ['displayName', 'normalizedEmail', 'role', 'isActive'],
      showProperties: ['displayName', 'normalizedEmail', 'role', 'isActive', 'createdAt', 'updatedAt'],
      properties: labelled('User', {
        id: { isVisible: false },
        // `position` fixes the form order: email, name, role, password, active.
        normalizedEmail: { position: 1, isVisible: onlyIn('list', 'filter', 'show', 'edit') },
        displayName: { isTitle: true, position: 2 },
        role: { position: 3, isVisible: onlyIn('list', 'filter', 'show', 'edit'), ...readonlyOnEdit('Use the Change role action.') },
        // Virtual: only for creating an account. Changing a password is its own action.
        password: { position: 4, type: 'password', isVisible: onlyIn('edit'), ...createOnly() },
        isActive: { position: 5, isVisible: onlyIn('list', 'filter', 'show', 'edit'), ...toggle({ editOnly: true }) },
        createdAt: { isVisible: onlyIn('show') },
        updatedAt: { isVisible: onlyIn('show') },
        passwordHash: { isVisible: false },
        sessionVersion: { isVisible: false },
      }),
      actions: {
        ...ADMIN_MANAGED,
        changeRole: {
          ...formAction(Components.ChangeRoleForm, (context, request, p) => users.changeRole(actorFromContext(context), recordId(request), p.role)),
          icon: 'Key',
          isAccessible: adminOnly,
        },
        setPassword: {
          ...formAction(Components.SetPasswordForm, (context, request, p) => users.setPassword(actorFromContext(context), recordId(request), p.password)),
          icon: 'Lock',
          isAccessible: adminOnly,
        },
      },
    },
  };
}

