import type { PropertyOptions } from 'adminjs';

// Single source of labels and help text for AdminJS properties. The optional AI assistant (stage 12)
// answers questions about fields from this same catalog, so wording lives in one place.
// Limits quoted in help text mirror the schemas in src/domain (requirements section 5.1).

export interface FieldDef {
  label: string;
  help?: string;
}

type Catalog = Record<string, Record<string, FieldDef>>;

export const FIELD_CATALOG: Catalog = {
  Ticket: {
    number: { label: 'Number', help: 'Assigned automatically.' },
    subject: { label: 'Subject', help: '5-200 characters.' },
    description: { label: 'Description', help: 'Up to 10000 characters.' },
    priority: { label: 'Priority', help: 'LOW, NORMAL, HIGH or URGENT.' },
    customer: { label: 'Customer', help: 'Cannot be changed after the ticket is created.' },
    group: { label: 'Group', help: 'The support group that handles the ticket. Change it with Assign.' },
    assignedAgent: { label: 'Assignee', help: 'An active member of the ticket group. Change it with Assign.' },
    status: { label: 'Status', help: 'Change it with Change status.' },
    resolution: { label: 'Resolution', help: 'What fixed the problem (10-2000 characters). Recorded when a ticket is resolved.' },
    unresolvedReason: { label: 'Unresolved reason', help: 'Why work stopped without a solution (10-2000 characters). Recorded when a ticket is marked unresolved.' },
    resolvedAt: { label: 'Resolved at' },
    unresolvedAt: { label: 'Marked unresolved at' },
    closedAt: { label: 'Closed at' },
    version: { label: 'Version', help: 'Increases on every change; used to detect concurrent edits.' },
    createdAt: { label: 'Created at' },
    updatedAt: { label: 'Updated at' },
    createdBy: { label: 'Created by' },
    age: { label: 'Age', help: 'Time from creation until the ticket was resolved, closed or marked unresolved (or until now).' },
    history: { label: 'History' },
    comments: { label: 'Comments', help: 'Internal notes of the support team (1-5000 characters, plain text). Closed and unresolved tickets take no comments until reopened.' },
  },
  Customer: {
    name: { label: 'Name', help: '1-200 characters.' },
    emailNormalized: { label: 'Email', help: 'Stored in lower case; must be unique.' },
    company: { label: 'Company' },
    phone: { label: 'Phone' },
    isActive: { label: 'Active', help: 'Inactive customers cannot get new tickets. Customers are never deleted.' },
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
    role: { label: 'Role', help: 'Changed with the Change role action.' },
    isActive: { label: 'Active', help: 'Deactivating signs the person out. The last active administrator cannot be deactivated.' },
    password: { label: 'Password', help: 'At least 12 characters. Changed later with the Set password action.' },
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
