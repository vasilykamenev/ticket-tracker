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
import { NO_ACTIONS, longText, onlyIn, twoColumn } from './helpers.js';
import { dataAction, formAction, mutationAction, pick, query, recordId } from './record-actions.js';
import type { Actor } from '../../policies/ticket-policy.js';

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
const optional = (key: string, v: unknown): Record<string, string> => (blank(v) === null ? {} : { [key]: String(v) });

/** Problems of a status change, as the workflow names them, and how the edit form's status field calls them. */
const STATUS_PROBLEMS: Record<string, string> = {
  targetStatus: 'Status',
  reason: 'Reason',
  resolution: 'Resolution',
  unresolvedReason: 'Why it is unresolved',
  assignedAgentId: 'Assignee',
};

/**
 * A bulk action with its own React form. GET answers with the selected records (AdminJS needs them to open the page)
 * and the form's data; POST runs the change through the service, which re-checks scope, version and rules per ticket.
 */
const bulkForm = (
  component: string,
  icon: string,
  state: (actor: Actor, ids: string[]) => Promise<object>,
  run: (actor: Actor, payload: unknown) => Promise<object>,
) => ({
  actionType: 'bulk' as const,
  icon,
  component,
  showInDrawer: false,
  handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
    const actor = actorFromContext(context);
    if (request.method === 'get') {
      const records = context.records ?? [];
      if (records.length === 0) throw new NotFoundError('ticket');
      // The ids as selected, not as AdminJS loaded them, so ids that are out of scope are counted as unavailable.
      const ids = (query(request, 'recordIds') ?? '').split(',').filter(Boolean);
      return { records: records.map((r) => r.toJSON(context.currentAdmin)), ...(await state(actor, ids)) };
    }
    return { records: [], ok: true, ...(await run(actor, request.payload)) };
  },
});

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
        const target = blank(p.statusTarget);
        const fields = pick(p, ['subject', 'description', 'priority']);
        if (target === null || target === current.status.code) return tickets.update(actor, id, Number(p.version), fields);
        const change = {
          targetStatus: target,
          ...optional('reason', p.statusReason),
          ...optional('resolution', p.statusResolution),
          ...optional('unresolvedReason', p.statusUnresolvedReason),
          ...optional('assignedAgentId', p.statusAssignee),
        };
        try {
          return await tickets.updateWithStatus(actor, id, Number(p.version), fields, change);
        } catch (err) {
          // The status field of the form shows every problem of the change in one place.
          if (err instanceof ValidationError && err.details && Object.keys(err.details).some((k) => k in STATUS_PROBLEMS)) {
            const rest = Object.entries(err.details).filter(([k]) => !(k in STATUS_PROBLEMS));
            const text = Object.entries(err.details)
              .filter(([k]) => k in STATUS_PROBLEMS)
              .map(([k, v]) => `${STATUS_PROBLEMS[k]}: ${v}`)
              .join('; ');
            throw new ValidationError(err.code, err.message, { ...Object.fromEntries(rest), status: text });
          }
          throw err;
        }
      },
    },
  );

  return {
    resource,
    options: {
      navigation: { name: 'Support', icon: 'Inbox' },
      sort: { sortBy: 'updatedAt', direction: 'desc' },
      listProperties: ['number', 'subject', 'customer', 'group', 'assignedAgent', 'status', 'priority', 'age', 'updatedAt'],
      filterProperties: ['number', 'subject', 'status', 'group', 'assignedAgent', 'priority', 'customer', 'createdAt', 'updatedAt', 'closedAt'],
      // The edit form's order (subject, customer, group, assignee, description) under the header line, where the number
      // carries the status and the priority (TicketHeader). What the form does not have follows, then the comments
      // (their list and the box for a new one), and the history comes last, after the Add comment button.
      showProperties: [
        'number', 'subject', 'customer', 'group', 'assignedAgent', 'description',
        'age', 'resolution', 'unresolvedReason', 'resolvedAt', 'unresolvedAt', 'closedAt', 'createdBy', 'createdAt', 'updatedAt', 'version', 'comments', 'history',
      ],
      properties: labelled('Ticket', {
        id: { isVisible: false },
        // On the page the number also draws the status and the priority at the right of its line (TicketHeader).
        number: { isVisible: onlyIn('list', 'filter', 'show'), components: { list: Components.TicketNumberCell, show: Components.TicketHeader } },
        // `position` fixes the order of the edit form: subject, priority, customer, group, assignee, description,
        // then the comments (their list and the box for a new one), and the Save button after them.
        subject: { isTitle: true, position: 1, isVisible: onlyIn('list', 'filter', 'show', 'edit') },
        description: { type: 'textarea', position: 6, isVisible: onlyIn('show', 'edit'), ...longText() },
        priority: { position: 2, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { list: Components.PriorityBadge, show: Components.PriorityBadge } },
        // "edit" covers both the new and the edit form; on an existing ticket these render read-only.
        customer: { position: 3, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'The customer cannot be changed after creation.' } },
        group: { position: 4, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        assignedAgent: { position: 5, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { edit: Components.ModeField }, custom: { hint: 'Change this with the Assign action.' } },
        // In the edit form the status is changeable: StatusEditField offers the allowed changes and what each needs.
        status: { position: 2.5, isVisible: onlyIn('list', 'filter', 'show', 'edit'), components: { list: Components.StatusBadge, show: Components.StatusBadge, edit: Components.StatusEditField } },
        resolution: { type: 'textarea', isVisible: onlyIn('show') },
        unresolvedReason: { type: 'textarea', isVisible: onlyIn('show') },
        resolvedAt: { isVisible: onlyIn('show') },
        unresolvedAt: { isVisible: onlyIn('show') },
        closedAt: { isVisible: onlyIn('filter', 'show') },
        // Not shown in forms, but it travels with the record params and is sent back on save, which is
        // how concurrent edits are detected (optimistic locking).
        version: { isVisible: onlyIn('show') },
        createdAt: { isVisible: onlyIn('filter', 'show') },
        updatedAt: { isVisible: onlyIn('list', 'filter', 'show'), components: { list: Components.RelativeTime, show: Components.RelativeTime } },
        createdBy: { isVisible: onlyIn('show') },
        // Virtual: derived on read, never stored.
        age: { type: 'string', isVisible: onlyIn('list', 'show') },
        history: { type: 'mixed', isVisible: onlyIn('show'), components: { show: Components.TicketHistory } },
        // Virtual: comments live inside the ticket page. "edit" covers the new form too, where the component
        // explains that comments become available once the ticket exists.
        comments: { type: 'mixed', position: 100, isVisible: onlyIn('show', 'edit'), components: { show: Components.CommentsInline, edit: Components.CommentsInline } },
      }),
      actions: {
        ...NO_ACTIONS,
        // Queue tabs and search above AdminJS's own table.
        list: { component: Components.TicketList },
        // The edit form has the layout of the new ticket form: the text left, the properties right.
        edit: { layout: twoColumn(['subject', 'description', 'comments'], ['priority', 'status', 'customer', 'group', 'assignedAgent']) },
        // The new ticket form: new ticket page with groups, their members and the group suggested for a customer.
        new: { component: Components.TicketNewForm },
        newFormState: {
          actionType: 'resource' as const,
          isVisible: false,
          component: false as const,
          handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
            const actor = actorFromContext(context);
            const customerId = query(request, 'customerId');
            return { ...(await queries.bulkAssignState(actor, [])), suggestedGroupId: customerId ? await queries.suggestGroup(actor, customerId) : null };
          },
        },
        // The two-column ticket page draws its own heading and buttons, so AdminJS's header is switched off.
        show: { component: Components.TicketPage, hideActionHeader: true },
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
        bulkAssign: bulkForm(Components.BulkAssignForm, 'UserPlus', (actor, ids) => queries.bulkAssignState(actor, ids), (actor, payload) => tickets.bulkAssign(actor, payload)),
        bulkChangeGroup: bulkForm(Components.BulkGroupForm, 'Users', (actor, ids) => queries.bulkAssignState(actor, ids), (actor, payload) => tickets.bulkAssign(actor, payload)),
        bulkChangePriority: bulkForm(Components.BulkPriorityForm, 'Flag', (actor, ids) => queries.bulkAssignState(actor, ids), (actor, payload) => tickets.bulkSetPriority(actor, payload)),
        assignTicket: {
          ...formAction(Components.AssignForm, (context, request, p) =>
            tickets.assign(actorFromContext(context), recordId(request), Number(p.version), pick(p, ['groupId', 'assignedAgentId'])),
          ),
          icon: 'UserPlus',
        },
        formState: dataAction((context, request) => queries.formState(actorFromContext(context), recordId(request), query(request, 'groupId'))),
        // The ticket id is the record being viewed and the author is the session user; neither comes from the payload.
        listComments: dataAction((context, request) => commentQueries.list(actorFromContext(context), recordId(request), Number(query(request, 'page') ?? 1))),
        // The new comment's id comes back so the editor can attach files to it.
        addComment: mutationAction(async (context, request, p) => ({
          reply: { commentId: (await comments.add(actorFromContext(context), recordId(request), pick(p, ['body']))).id },
        })),
        editComment: mutationAction(async (context, request, p) => {
          await comments.edit(actorFromContext(context), String(p.commentId), Number(p.version), pick(p, ['body']), recordId(request));
        }),
        // Priority is the one ticket field that is edited in place on the ticket page.
        setPriority: mutationAction(async (context, request, p) => {
          await tickets.update(actorFromContext(context), recordId(request), Number(p.version), pick(p, ['priority']));
        }),
        // Comments and history in one chronological feed.
        timeline: dataAction(async (context, request) => {
          const actor = actorFromContext(context);
          const id = recordId(request);
          const [thread, events] = await Promise.all([commentQueries.listAll(actor, id), queries.historyAll(actor, id)]);
          const entries = [
            ...thread.items.map((c) => ({ type: 'comment' as const, at: c.createdAt, comment: c })),
            ...events.map((e) => ({ type: 'event' as const, at: e.createdAt, event: e })),
          ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
          return { entries, canAdd: thread.canAdd, statusName: thread.statusName };
        }),
        history: dataAction((context, request) => queries.history(actorFromContext(context), recordId(request), Number(query(request, 'page') ?? 1))),
      },
    },
  };
}
