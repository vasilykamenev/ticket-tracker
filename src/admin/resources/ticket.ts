import type { ActionContext, ActionRequest, ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import { loadScope } from '../../domain/db.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { formatAge, ticketAgeMs } from '../../domain/tickets/age.js';
import type { CommentQueries } from '../../domain/comments/comment-queries.js';
import type { CommentService } from '../../domain/comments/comment-service.js';
import type { TicketQueries } from '../../domain/tickets/ticket-queries.js';
import type { TicketService } from '../../domain/tickets/ticket-service.js';
import { ticketScopeWhere } from '../../policies/ticket-policy.js';
import { Components } from '../component-loader.js';
import { labelled } from '../field-catalog.js';
import { GuardedResource, actorFromContext } from '../guarded-resource.js';
import { NO_ACTIONS, longText, onlyIn } from './helpers.js';
import { dataAction, formAction, mutationAction, pick, query, recordId } from './record-actions.js';

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

export function ticketResource(
  prisma: PrismaClient,
  tickets: TicketService,
  queries: TicketQueries,
  comments: CommentService,
  commentQueries: CommentQueries,
): ResourceWithOptions {
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
      // The edit form's order (subject, customer, group, assignee, description) under the header line, where the number
      // carries the status and the priority (TicketHeader). What the form does not have follows, and the comments
      // (their list and the box for a new one) come last, as they do in the form before Save.
      showProperties: [
        'number', 'subject', 'customer', 'group', 'assignedAgent', 'description',
        'age', 'resolution', 'unresolvedReason', 'resolvedAt', 'unresolvedAt', 'closedAt', 'createdBy', 'createdAt', 'updatedAt', 'version', 'history', 'comments',
      ],
      properties: labelled('Ticket', {
        id: { isVisible: false },
        // On the page the number also draws the status and the priority at the right of its line (TicketHeader).
        number: { isVisible: onlyIn('list', 'filter', 'show'), components: { show: Components.TicketHeader } },
        // `position` fixes the order of the edit form: subject, priority, customer, group, assignee, description,
        // then the comments (their list and the box for a new one), and the Save button after them.
        subject: { isTitle: true, position: 1, isVisible: onlyIn('list', 'filter', 'show', 'edit') },
        description: { type: 'textarea', position: 6, isVisible: onlyIn('show', 'edit'), ...longText() },
        priority: { position: 2, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { list: Components.PriorityBadge, show: Components.PriorityBadge } },
        // "edit" covers both the new and the edit form; on an existing ticket these render read-only.
        customer: { position: 3, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'The customer cannot be changed after creation.' } },
        group: { position: 4, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        assignedAgent: { position: 5, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        status: { isVisible: onlyIn('list', 'filter', 'show'), components: { list: Components.StatusBadge, show: Components.StatusBadge } },
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
        // Virtual: comments live inside the ticket page. "edit" covers the new form too, where the component
        // explains that comments become available once the ticket exists.
        comments: { type: 'mixed', position: 100, isVisible: onlyIn('show', 'edit'), components: { show: Components.CommentsInline, edit: Components.CommentsInline } },
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
        // Selection comes from the list (recordIds in the query); the form sends id/version pairs back and the
        // service re-checks scope, version and the workflow for every ticket, all in one transaction.
        bulkChangeStatus: {
          actionType: 'bulk' as const,
          icon: 'Shuffle',
          component: Components.BulkChangeStatusForm,
          showInDrawer: false,
          handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
            const actor = actorFromContext(context);
            if (request.method === 'get') {
              const records = context.records ?? [];
              if (records.length === 0) throw new NotFoundError('ticket');
              // The ids as selected, not as AdminJS loaded them, so ids that are out of scope are counted as unavailable.
              const ids = (query(request, 'recordIds') ?? '').split(',').filter(Boolean);
              // AdminJS needs the records themselves to open the page; the form reads the rest of this response itself.
              return { records: records.map((r) => r.toJSON(context.currentAdmin)), ...(await queries.bulkFormState(actor, ids)) };
            }
            const result = await tickets.bulkChangeStatus(actor, request.payload);
            return { records: [], ok: true, ...result };
          },
        },
        assignTicket: {
          ...formAction(Components.AssignForm, (context, request, p) =>
            tickets.assign(actorFromContext(context), recordId(request), Number(p.version), pick(p, ['groupId', 'assignedAgentId'])),
          ),
          icon: 'UserPlus',
        },
        formState: dataAction((context, request) => queries.formState(actorFromContext(context), recordId(request), query(request, 'groupId'))),
        // The ticket id is the record being viewed and the author is the session user; neither comes from the payload.
        listComments: dataAction((context, request) => commentQueries.list(actorFromContext(context), recordId(request), Number(query(request, 'page') ?? 1))),
        addComment: mutationAction((context, request, p) => comments.add(actorFromContext(context), recordId(request), pick(p, ['body']))),
        editComment: mutationAction((context, request, p) =>
          comments.edit(actorFromContext(context), String(p.commentId), Number(p.version), pick(p, ['body']), recordId(request)),
        ),
        history: dataAction((context, request) => queries.history(actorFromContext(context), recordId(request), Number(query(request, 'page') ?? 1))),
      },
    },
  };
}
