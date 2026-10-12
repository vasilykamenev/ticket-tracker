import { describe, expect, it } from 'vitest';
import { FIELD_CATALOG } from '../../src/admin/field-catalog.js';
import { buildContext, listFields, staticHelp } from '../../src/assistant/context.js';
import { TRANSITIONS } from '../../src/domain/tickets/workflow.js';

describe('assistant context', () => {
  it('describes a field from the catalog: label, help, type, required, validation and values', () => {
    const ctx = buildContext('AGENT', 'Ticket', 'priority')!;
    expect(ctx).toMatchObject({ resource: 'Ticket', field: 'priority', label: 'Priority', type: 'choice', required: true, values: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], viewerRole: 'AGENT' });
    expect(ctx.help).toMatch(/LOW, NORMAL, HIGH or URGENT/);
    expect(buildContext('AGENT', 'Ticket', 'subject')).toMatchObject({ type: 'text', required: true, validation: '5 to 200 characters.' });
  });

  it('adds the statuses and transitions to the status-related fields, with the meaning of the three that are easily confused', () => {
    for (const field of ['status', 'resolution', 'unresolvedReason', 'comments', 'assignedAgent']) {
      const wf = buildContext('ADMIN', 'Ticket', field)!.workflow!;
      expect(wf.statuses.map((s) => s.code)).toEqual(['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'UNRESOLVED', 'CLOSED']);
      expect(wf.transitions).toHaveLength(TRANSITIONS.length);
    }
    const wf = buildContext('ADMIN', 'Ticket', 'status')!.workflow!;
    const meaning = (code: string) => wf.statuses.find((s) => s.code === code)!.meaning;
    expect(meaning('WAITING_CUSTOMER')).toMatch(/waiting for the customer/i);
    expect(meaning('RESOLVED')).toMatch(/solution was found/i);
    expect(meaning('UNRESOLVED')).toMatch(/without a solution/i);
    expect(meaning('UNRESOLVED')).toMatch(/not counted as solved/i);
    expect(wf.transitions.find((t) => t.from === 'RESOLVED' && t.to === 'CLOSED')).toMatchObject({ onlyAdministrator: true });
    expect(wf.transitions.find((t) => t.from === 'IN_PROGRESS' && t.to === 'UNRESOLVED')!.needs).toContain('an unresolved reason');
    // Fields that do not depend on the workflow do not carry it.
    expect(buildContext('ADMIN', 'Ticket', 'subject')!.workflow).toBeUndefined();
    expect(buildContext('ADMIN', 'Customer', 'name')!.workflow).toBeUndefined();
  });

  it('lets an agent ask only about the screens they can open, an administrator about all', () => {
    expect(listFields('AGENT', 'Ticket')!.length).toBeGreaterThan(5);
    expect(listFields('AGENT', 'Customer')).not.toBeNull();
    for (const resource of ['User', 'SupportGroup', 'Agent', 'TicketStatus']) {
      expect(listFields('AGENT', resource), resource).toBeNull();
      expect(buildContext('AGENT', resource, Object.keys(FIELD_CATALOG[resource]!)[0]!), resource).toBeNull();
      expect(listFields('ADMIN', resource), resource).not.toBeNull();
    }
  });

  it('knows nothing it was not given: unknown screens and fields, and names that exist on every object, give nothing', () => {
    for (const bad of ['', 'Nope', 'constructor', '__proto__', 'toString']) {
      expect(listFields('ADMIN', bad), bad).toBeNull();
      expect(buildContext('ADMIN', bad, 'subject'), bad).toBeNull();
      expect(buildContext('ADMIN', 'Ticket', bad), bad).toBeNull();
    }
  });

  it('carries only catalog facts: no record data, no secret, whatever the field', () => {
    const allowedKeys = new Set(['resource', 'field', 'label', 'help', 'type', 'required', 'validation', 'values', 'viewerRole', 'workflow']);
    for (const [resource, fields] of Object.entries(FIELD_CATALOG)) {
      for (const field of Object.keys(fields)) {
        const ctx = buildContext('ADMIN', resource, field)!;
        expect(Object.keys(ctx).every((k) => allowedKeys.has(k)), `${resource}.${field}`).toBe(true);
        expect(JSON.stringify(ctx), `${resource}.${field}`).not.toMatch(/passwordHash|sessionVersion|ANTHROPIC|secret|argon2/i);
      }
    }
  });

  it('gives a person the same facts as plain text when the AI cannot answer', () => {
    const help = staticHelp(buildContext('ADMIN', 'Ticket', 'priority')!);
    expect(help.label).toBe('Priority');
    expect(help.lines.join(' ')).toMatch(/Type: choice, required/);
    expect(help.lines.join(' ')).toMatch(/Allowed values: LOW, NORMAL, HIGH, URGENT/);
    expect(staticHelp(buildContext('ADMIN', 'Customer', 'createdAt')!).lines).toEqual(['There is no help text for this field.']);
  });
});
