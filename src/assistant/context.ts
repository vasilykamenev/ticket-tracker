import { FIELD_CATALOG } from '../admin/field-catalog.js';
import { SYSTEM_STATUSES, TRANSITIONS, type StatusCode } from '../domain/tickets/workflow.js';

// What the assistant may know about a form field (requirements section 12): the label, help text, type, required
// flag, validations and, for the status-related fields, the statuses and transitions. It is built only from the
// field catalog and the workflow table. No record, customer, password hash or secret can reach it: the catalog
// has none, and the browser supplies only the ids of a resource and a field, which are looked up here.

export type Role = 'ADMIN' | 'AGENT';

/** The screens each role can open; a person is helped only with fields of screens they can see. */
const ASKABLE: Record<string, readonly Role[]> = {
  Ticket: ['ADMIN', 'AGENT'],
  Customer: ['ADMIN', 'AGENT'],
  SupportGroup: ['ADMIN'],
  Agent: ['ADMIN'],
  TicketStatus: ['ADMIN'],
  User: ['ADMIN'],
};

const STATUS_MEANING: Record<StatusCode, string> = {
  NEW: 'Created and not yet worked on; may still have no assignee.',
  IN_PROGRESS: 'Someone is actively working on the ticket.',
  WAITING_CUSTOMER: 'Work is paused for a while, waiting for the customer to reply. It is not finished.',
  RESOLVED: 'A solution was found and is written in the resolution.',
  UNRESOLVED: 'Work stopped without a solution (for example a technical limitation or missing information). Not counted as solved.',
  CLOSED: 'Administrative closure of a ticket that was resolved.',
};

/** The fields whose answer depends on the workflow. */
const WORKFLOW_FIELDS = new Set(['status', 'resolution', 'unresolvedReason', 'comments', 'assignedAgent']);

export interface FieldContext {
  resource: string;
  field: string;
  label: string;
  help?: string;
  type?: string;
  required?: boolean;
  validation?: string;
  values?: string[];
  /** The viewer's role, so "who may do this" is answered for them. */
  viewerRole: Role;
  workflow?: {
    statuses: Array<{ code: string; name: string; meaning: string }>;
    transitions: Array<{ from: string; to: string; onlyAdministrator: boolean; reasonRequired: boolean; needs: string[] }>;
    note: string;
  };
}

export interface FieldListItem {
  id: string;
  label: string;
}

function allowed(role: Role, resource: string): boolean {
  return Object.hasOwn(ASKABLE, resource) && ASKABLE[resource]!.includes(role) && Object.hasOwn(FIELD_CATALOG, resource);
}

/** The fields a person may ask about on a screen, in the catalog's order; null if the screen is unknown or not theirs. */
export function listFields(role: Role, resource: string): FieldListItem[] | null {
  if (!allowed(role, resource)) return null;
  return Object.entries(FIELD_CATALOG[resource]!).map(([id, def]) => ({ id, label: def.label }));
}

function workflowFacts() {
  return {
    statuses: SYSTEM_STATUSES.map((s) => ({ code: s.code, name: s.name, meaning: STATUS_MEANING[s.code] })),
    transitions: TRANSITIONS.map((t) => ({
      from: t.from,
      to: t.to,
      onlyAdministrator: t.adminOnly,
      reasonRequired: t.reason === 'required',
      needs: [
        ...(t.assignee === 'none' ? [] : ['an assignee']),
        ...(t.resolution ? ['a resolution'] : []),
        ...(t.unresolvedReason ? ['an unresolved reason'] : []),
      ],
    })),
    note: 'CLOSED and UNRESOLVED tickets take no edits and no comments until they are reopened. Any transition not listed is not allowed.',
  };
}

/** The context for one field, or null if the resource or field is unknown or the role may not ask about it. */
export function buildContext(role: Role, resource: string, field: string): FieldContext | null {
  if (!allowed(role, resource)) return null;
  const fields = FIELD_CATALOG[resource]!;
  if (!Object.hasOwn(fields, field)) return null;
  const def = fields[field]!;
  return {
    resource,
    field,
    label: def.label,
    ...(def.help ? { help: def.help } : {}),
    ...(def.type ? { type: def.type } : {}),
    ...(def.required !== undefined ? { required: def.required } : {}),
    ...(def.validation ? { validation: def.validation } : {}),
    ...(def.values ? { values: [...def.values] } : {}),
    viewerRole: role,
    ...(resource === 'Ticket' && WORKFLOW_FIELDS.has(field) ? { workflow: workflowFacts() } : {}),
  };
}

/** The same facts as plain text for a person, shown when the AI cannot answer. */
export function staticHelp(ctx: FieldContext): { label: string; lines: string[] } {
  const lines: string[] = [];
  if (ctx.help) lines.push(ctx.help);
  if (ctx.type) lines.push(`Type: ${ctx.type}${ctx.required ? ', required' : ''}.`);
  if (ctx.values) lines.push(`Allowed values: ${ctx.values.join(', ')}.`);
  if (ctx.validation) lines.push(ctx.validation);
  if (lines.length === 0) lines.push('There is no help text for this field.');
  return { label: ctx.label, lines };
}
