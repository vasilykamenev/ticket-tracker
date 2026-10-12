import type { PropertyOptions } from 'adminjs';
import { MAX_PASSWORD_LENGTH } from '../auth/password.js';
import { COMMENT_MAX } from '../domain/comments/schemas.js';
import { DESCRIPTION_MAX, PRIORITIES } from '../domain/tickets/schemas.js';
import { OUTCOME_MAX, REASON_MAX, RESOLUTION_MIN } from '../domain/tickets/workflow.js';
import { MIN_PASSWORD_LENGTH } from '../domain/users/schemas.js';

// Single source of labels and help text for AdminJS properties. The optional AI assistant (stage 12)
// answers questions about fields from this same catalog, so wording lives in one place.
// Limits quoted in help text mirror the schemas in src/domain (requirements section 5.1).

export interface FieldDef {
  label: string;
  help?: string;
  /** What kind of value the field holds (for the assistant). */
  type?: 'text' | 'long text' | 'choice' | 'reference' | 'flag' | 'date' | 'number' | 'calculated';
  /** Must have a value when the record is saved. */
  required?: boolean;
  /** The rules a value must satisfy, in plain words (lengths, uniqueness, who may change it). */
  validation?: string;
  /** The allowed values of a choice. */
  values?: readonly string[];
}

type Catalog = Record<string, Record<string, FieldDef>>;

export const FIELD_CATALOG: Catalog = {
  Ticket: {
    number: { label: 'Number', help: 'Assigned automatically.', type: 'number', validation: 'Assigned by the system; cannot be edited.' },
    subject: { label: 'Subject', help: '5-200 characters.', type: 'text', required: true, validation: '5 to 200 characters.' },
    description: { label: 'Description', help: `Up to ${DESCRIPTION_MAX} characters.`, type: 'long text', required: true, validation: `1 to ${DESCRIPTION_MAX} characters.` },
    priority: { label: 'Priority', help: 'LOW, NORMAL, HIGH or URGENT.', type: 'choice', required: true, values: PRIORITIES, validation: 'NORMAL if not chosen.' },
    customer: { label: 'Customer', help: 'Cannot be changed after the ticket is created.', type: 'reference', required: true, validation: 'Chosen when the ticket is created; cannot be changed afterwards.' },
    group: {
      label: 'Group',
      help: 'The support group that handles the ticket. Change it with Assign.',
      type: 'reference',
      required: true,
      validation: 'An active group. An agent can only choose a group they belong to. Changed later with the Assign action.',
    },
    assignedAgent: {
      label: 'Assignee',
      help: 'An active member of the ticket group. Change it with Assign.',
      type: 'reference',
      validation: 'An active agent who belongs to the ticket group. Optional while the ticket is NEW, needed for every other status. Changed with the Assign action.',
    },
    status: { label: 'Status', help: 'Change it with Change status.', type: 'choice', validation: 'Set to NEW by the system; changed only with the Change status action, along the allowed transitions.' },
    resolution: {
      label: 'Resolution',
      help: `What fixed the problem (${RESOLUTION_MIN}-${OUTCOME_MAX} characters). Recorded when a ticket is resolved.`,
      type: 'long text',
      validation: `Required when the ticket is marked RESOLVED: ${RESOLUTION_MIN} to ${OUTCOME_MAX} characters.`,
    },
    unresolvedReason: {
      label: 'Unresolved reason',
      help: `Why work stopped without a solution (${RESOLUTION_MIN}-${OUTCOME_MAX} characters). Recorded when a ticket is marked unresolved.`,
      type: 'long text',
      validation: `Required when the ticket is marked UNRESOLVED: ${RESOLUTION_MIN} to ${OUTCOME_MAX} characters.`,
    },
    resolvedAt: { label: 'Resolved at' },
    unresolvedAt: { label: 'Marked unresolved at' },
    closedAt: { label: 'Closed at' },
    version: { label: 'Version', help: 'Increases on every change; used to detect concurrent edits.' },
    createdAt: { label: 'Created at' },
    updatedAt: { label: 'Updated at' },
    createdBy: { label: 'Created by' },
    age: { label: 'Age', help: 'Time from creation until the ticket was resolved, closed or marked unresolved (or until now).' },
    history: { label: 'History' },
    comments: {
      label: 'Comments',
      help: `Internal notes of the support team (1-${COMMENT_MAX} characters, plain text). Closed and unresolved tickets take no comments until reopened.`,
      type: 'long text',
      validation: `1 to ${COMMENT_MAX} characters, plain text. An agent edits only their own comments. The reason of a status change is given in the Change status form (up to ${REASON_MAX} characters), not as a comment.`,
    },
  },
  Customer: {
    name: { label: 'Name', help: '1-200 characters.', type: 'text', required: true, validation: '1 to 200 characters.' },
    emailNormalized: { label: 'Email', help: 'Stored in lower case; must be unique.', type: 'text', required: true, validation: 'A valid e-mail address, stored in lower case; no two customers share one.' },
    company: { label: 'Company', type: 'text', validation: 'Optional.' },
    phone: { label: 'Phone', type: 'text', validation: 'Optional.' },
    isActive: { label: 'Active', help: 'Inactive customers cannot get new tickets. Customers are never deleted.', type: 'flag', validation: 'Only an administrator can change it.' },
    createdAt: { label: 'Created at' },
    updatedAt: { label: 'Updated at' },
    tickets: { label: 'Tickets', help: 'Only tickets from your groups are shown.' },
  },
  SupportGroup: {
    code: { label: 'Code' },
    name: { label: 'Name' },
    description: { label: 'Description' },
    isActive: { label: 'Active', help: 'A group with active tickets cannot be deactivated.' },
    members: { label: 'Members', help: 'Agents who work the tickets of this group.' },
  },
  Agent: {
    displayName: { label: 'Name' },
    user: { label: 'Account', help: 'The staff account this support profile belongs to.' },
    isActive: { label: 'Active', help: 'An agent with active tickets cannot be deactivated.' },
  },
  TicketStatus: {
    code: { label: 'Code' },
    name: { label: 'Name' },
    color: { label: 'Color', help: 'A color like #3b82f6.' },
    sortOrder: { label: 'Order', help: 'Lower numbers come first.' },
    isActive: { label: 'Active', help: 'NEW and statuses that tickets still use cannot be deactivated.' },
  },
  User: {
    displayName: { label: 'Name' },
    normalizedEmail: { label: 'Email', help: 'Stored in lower case; must be unique.' },
    role: { label: 'Role', help: 'Changed with the Change role action.', type: 'choice', values: ['ADMIN', 'AGENT'], validation: 'Set when the account is created; changed only with the Change role action.' },
    isActive: { label: 'Active', help: 'Deactivating signs the person out. The last active administrator cannot be deactivated.' },
    password: {
      label: 'Password',
      help: `At least ${MIN_PASSWORD_LENGTH} characters. Changed later with the Set password action.`,
      type: 'text',
      required: true,
      validation: `${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters, stored only as a hash; changed later with the Set password action.`,
    },
    createdAt: { label: 'Created at' },
    updatedAt: { label: 'Updated at' },
  },
};

/** Labels of the custom record actions, by resource. */
export const ACTION_LABELS: Record<string, Record<string, string>> = {
  Ticket: { changeStatus: 'Change status', assignTicket: 'Assign' },
  User: { changeRole: 'Change role', setPassword: 'Set password' },
};

/** Help text for the properties of one resource, ready to merge into AdminJS property options. */
export function labelled(resource: string, properties: Record<string, PropertyOptions>): Record<string, PropertyOptions> {
  const defs = FIELD_CATALOG[resource] ?? {};
  const result: Record<string, PropertyOptions> = {};
  for (const [name, options] of Object.entries(properties)) {
    const help = defs[name]?.help;
    // Explicit options win over the catalog.
    result[name] = help ? { description: help, ...options } : options;
  }
  return result;
}

/**
 * AdminJS takes property labels from translations (`resources.<Resource>.properties.<field>`), not from
 * property options, so the catalog also produces that structure.
 */
export function catalogTranslations(): { resources: Record<string, { properties: Record<string, string>; actions?: Record<string, string> }> } {
  const resources: Record<string, { properties: Record<string, string>; actions?: Record<string, string> }> = {};
  for (const [resource, fields] of Object.entries(FIELD_CATALOG)) {
    resources[resource] = {
      properties: Object.fromEntries(Object.entries(fields).map(([name, def]) => [name, def.label])),
      ...(ACTION_LABELS[resource] ? { actions: ACTION_LABELS[resource] } : {}),
    };
  }
  return { resources };
}
