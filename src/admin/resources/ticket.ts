import type { ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import { loadScope } from '../../domain/db.js';
import { ValidationError } from '../../domain/errors.js';
import { formatAge, ticketAgeMs } from '../../domain/tickets/age.js';
import type { TicketQueries } from '../../domain/tickets/ticket-queries.js';
import type { TicketService } from '../../domain/tickets/ticket-service.js';
import { ticketScopeWhere } from '../../policies/ticket-policy.js';
import { Components } from '../component-loader.js';
import { labelled } from '../field-catalog.js';
import { GuardedResource, actorFromContext } from '../guarded-resource.js';
import { NO_ACTIONS, onlyIn } from './helpers.js';
import { dataAction, formAction, pick, query, recordId } from './record-actions.js';

/** Form fields that the ordinary edit form must never change; changing them is rejected, not ignored. */
const PROTECTED_FIELDS: Record<string, string> = {
  customer: 'customerId',
  group: 'groupId',
  assignedAgent: 'assignedAgentId',
  status: 'statusId',
  createdBy: 'createdByUserId',
  number: 'number',
  resolution: 'resolution',
  unresolvedReason: 'unresolvedReason',
};

const blank = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

export function ticketResource(prisma: PrismaClient, tickets: TicketService, queries: TicketQueries): ResourceWithOptions {
  const resource = new GuardedResource(
    { model: getModelByName('Ticket'), client: prisma },
    {
      readScope: async (actor, db) => ticketScopeWhere(await loadScope(db, actor)),
      errorFields: { customerId: 'customer', groupId: 'group', assignedAgentId: 'assignedAgent' },
      fallbackErrorField: 'version',
      computed: (row) => ({ age: formatAge(ticketAgeMs(row as { createdAt: Date; closedAt: Date | null; resolvedAt: Date | null; unresolvedAt: Date | null }, new Date())) }),
      create: (actor, p) =>
        tickets.create(actor, {
          subject: p.subject,
          description: p.description,
          customerId: p.customer,
          groupId: p.group,
          priority: blank(p.priority) ?? undefined,
          assignedAgentId: blank(p.assignedAgent),
        }),
      update: async (actor, id, p) => {
        const current = await tickets.get(actor, id); // 404 when out of scope
        const details: Record<string, string> = {};
        for (const [field, column] of Object.entries(PROTECTED_FIELDS)) {
          if (field in p && blank(p[field]) !== blank((current as unknown as Record<string, unknown>)[column])) {
            details[field] = 'cannot be changed in this form; use the dedicated action';
          }
        }
        if (Object.keys(details).length > 0) throw new ValidationError('validation', 'Invalid input', details);
        return tickets.update(actor, id, Number(p.version), pick(p, ['subject', 'description', 'priority']));
      },
    },
  );

  return {
    resource,
    options: {
      navigation: { name: 'Support', icon: 'Inbox' },
      sort: { sortBy: 'updatedAt', direction: 'desc' },
      listProperties: ['number', 'subject', 'customer', 'group', 'assignedAgent', 'status', 'priority', 'updatedAt'],
      filterProperties: ['number', 'subject', 'status', 'group', 'assignedAgent', 'priority', 'customer', 'createdAt', 'updatedAt'],
      showProperties: [
        'number', 'subject', 'description', 'priority', 'status', 'customer', 'group', 'assignedAgent', 'age',
        'resolution', 'unresolvedReason', 'resolvedAt', 'unresolvedAt', 'closedAt', 'createdBy', 'createdAt', 'updatedAt', 'version', 'history',
      ],
      properties: labelled('Ticket', {
        id: { isVisible: false },
        number: { isVisible: onlyIn('list', 'filter', 'show') },
        subject: { isTitle: true, isVisible: onlyIn('list', 'filter', 'show', 'edit') },
        description: { type: 'textarea', isVisible: onlyIn('show', 'edit') },
        priority: { isVisible: onlyIn('list', 'filter', 'show', 'edit') },
        // "edit" covers both the new and the edit form; on an existing ticket these render read-only.
        customer: { isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'The customer cannot be changed after creation.' } },
        group: { isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        assignedAgent: { isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        status: { isVisible: onlyIn('list', 'filter', 'show') },
        resolution: { type: 'textarea', isVisible: onlyIn('show') },
        unresolvedReason: { type: 'textarea', isVisible: onlyIn('show') },
        resolvedAt: { isVisible: onlyIn('show') },
        unresolvedAt: { isVisible: onlyIn('show') },
        closedAt: { isVisible: onlyIn('show') },
        // Not shown in forms, but it travels with the record params and is sent back on save, which is
        // how concurrent edits are detected (optimistic locking).
        version: { isVisible: onlyIn('show') },
        createdAt: { isVisible: onlyIn('filter', 'show') },
        updatedAt: { isVisible: onlyIn('list', 'filter', 'show') },
        createdBy: { isVisible: onlyIn('show') },
        // Virtual: derived on read, never stored.
        age: { type: 'string', isVisible: onlyIn('show') },
        history: { type: 'mixed', isVisible: onlyIn('show'), components: { show: Components.TicketHistory } },
      }),
      actions: {
        ...NO_ACTIONS,
        changeStatus: {
          ...formAction(Components.ChangeStatusForm, (context, request, p) =>
            tickets.changeStatus(
              actorFromContext(context),
              recordId(request),
              Number(p.version),
              pick(p, ['targetStatus', 'reason', 'resolution', 'unresolvedReason', 'groupId', 'assignedAgentId']),
            ),
          ),
          icon: 'Shuffle',
        },
        assignTicket: {
          ...formAction(Components.AssignForm, (context, request, p) =>
            tickets.assign(actorFromContext(context), recordId(request), Number(p.version), pick(p, ['groupId', 'assignedAgentId'])),
          ),
          icon: 'UserPlus',
        },
        formState: dataAction((context, request) => queries.formState(actorFromContext(context), recordId(request), query(request, 'groupId'))),
        history: dataAction((context, request) => queries.history(actorFromContext(context), recordId(request), Number(query(request, 'page') ?? 1))),
      },
    },
  };
}
