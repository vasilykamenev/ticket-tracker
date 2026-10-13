import React, { useEffect, useState } from 'react';
import { Box, Button, FormGroup, H2, Label, Loader, MessageBox, Select, SelectAsync, Text, TextArea } from '@adminjs/design-system';
import { ApiClient, useNotice, type ActionProps } from 'adminjs';
import type { BulkAssignState } from '../../domain/tickets/ticket-queries.js';
import { SPACE, TYPE } from '../tokens.js';
import { adminRoot, ticketUrl, toServerError } from './api.js';
import { PriorityMarker } from './PriorityMarker.js';

const api = new ApiClient();
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const UNASSIGNED = '';
/** Same as DESCRIPTION_MAX in domain/tickets/schemas.ts (not imported: that file pulls the validation library into the browser bundle). */
const DESCRIPTION_MAX = 1000;

type Option = { value: string; label: string };
type NewFormState = BulkAssignState & { suggestedGroupId: string | null };

/** The first message AdminJS reports for a rejected form (`record.errors`). */
function firstError(data: { record?: { errors?: Record<string, { message?: string }> } }): string | null {
  const errors = Object.entries(data.record?.errors ?? {});
  const first = errors[0];
  return first ? `${first[0]}: ${first[1].message ?? 'invalid'}` : null;
}

/**
 * The new ticket form: the subject and the description on the left, the properties on the right. The priority starts
 * as NORMAL, choosing a customer suggests the group of their latest ticket, and a customer who is not in the
 * directory yet can be added without leaving the form.
 */
const TicketNewForm = (_props: ActionProps) => {
  const sendNotice = useNotice();
  const [state, setState] = useState<NewFormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [customer, setCustomer] = useState<Option | null>(null);
  const [groupId, setGroupId] = useState('');
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [priority, setPriority] = useState('NORMAL');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const loadState = (customerId?: string) =>
    api
      .resourceAction({ resourceId: 'Ticket', actionName: 'newFormState', method: 'get', ...(customerId ? { params: { customerId } } : {}) })
      .then((r) => r.data as NewFormState);

  useEffect(() => {
    loadState()
      .then((s) => {
        setState(s);
        setGroupId(s.groups[0]?.id ?? '');
      })
      .catch((e) => setLoadError(toServerError(e).message));
  }, []);

  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  const groups: Option[] = state.groups.map((g) => ({ value: g.id, label: g.name }));
  const agents: Option[] = [{ value: UNASSIGNED, label: '— unassigned —' }, ...(state.agentsByGroup[groupId] ?? []).map((a) => ({ value: a.id, label: a.name }))];
  const priorities: Option[] = PRIORITIES.map((v) => ({ value: v, label: v }));

  const chooseCustomer = async (option: Option | null) => {
    setCustomer(option);
    if (!option) return;
    try {
      const suggestion = (await loadState(option.value)).suggestedGroupId;
      if (suggestion && suggestion !== groupId) {
        setGroupId(suggestion);
        setAssignee(UNASSIGNED);
        sendNotice({ message: `Group set to the customer's latest group. Change it if needed.`, type: 'info' });
      }
    } catch {
      // the suggestion is a convenience; the form works without it
    }
  };

  const findCustomers = async (input: string): Promise<Option[]> => {
    if (input.trim().length < 2) return [];
    const found = await api.searchRecords({ resourceId: 'Customer', query: input.trim() });
    return found.map((r) => ({ value: String(r.id), label: r.title }));
  };

  const addCustomer = async () => {
    setError(null);
    try {
      const response = await api.resourceAction({ resourceId: 'Customer', actionName: 'new', method: 'post', data: { name: newName.trim(), emailNormalized: newEmail.trim() } });
      const data = response.data as { record?: { id?: string; title?: string; errors?: Record<string, { message?: string }> } };
      const problem = firstError(data);
      if (problem || !data.record?.id) {
        setError(problem ?? 'The customer was not saved.');
        return;
      }
      setCustomer({ value: data.record.id, label: data.record.title ?? newName.trim() });
      setAdding(false);
      setNewName('');
      setNewEmail('');
    } catch (e) {
      setError(toServerError(e).message);
    }
  };

  const ready = subject.trim().length >= 5 && description.trim() !== '' && customer !== null && groupId !== '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!customer) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.resourceAction({
        resourceId: 'Ticket',
        actionName: 'new',
        method: 'post',
        data: { subject: subject.trim(), description: description.trim(), customer: customer.value, group: groupId, priority, ...(assignee ? { assignedAgent: assignee } : {}) },
      });
      const data = response.data as { record?: { id?: string; errors?: Record<string, { message?: string }> } };
      const problem = firstError(data);
      if (problem || !data.record?.id) {
        setError(problem ?? 'The ticket was not saved.');
        setSaving(false);
        return;
      }
      window.location.assign(ticketUrl(data.record.id));
    } catch (e) {
      setError(toServerError(e).message);
      setSaving(false);
    }
  };

  return (
    <Box as="form" p={['default', 'xl']} onSubmit={submit}>
      <H2>New ticket</H2>
      <Box flex flexWrap="wrap" style={{ gap: SPACE.xl, alignItems: 'flex-start' }}>
        <Box variant="white" style={{ flex: '1 1 520px', minWidth: 0 }}>
          <FormGroup>
            <Label required htmlFor="ticket-subject">
              Subject
            </Label>
            <input
              id="ticket-subject"
              value={subject}
              maxLength={200}
              autoFocus
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
              style={{ width: '100%', fontSize: TYPE.body, padding: '8px 12px', borderRadius: 4, border: '1px solid #CBD5E1' }}
            />
            <Text variant="sm">At least 5 characters.</Text>
          </FormGroup>
          <FormGroup>
            <Label required htmlFor="ticket-description">
              Description
            </Label>
            <TextArea id="ticket-description" width="100%" rows={10} maxLength={DESCRIPTION_MAX} value={description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)} />
            <Text variant="sm">
              {description.length} / {DESCRIPTION_MAX}. Plain text; line breaks are kept.
            </Text>
          </FormGroup>
        </Box>

        <Box variant="white" style={{ flex: '0 0 340px', maxWidth: '100%' }}>
          <FormGroup>
            <Label required>Customer</Label>
            <SelectAsync value={customer} loadOptions={findCustomers} placeholder="Type a name or e-mail" noOptionsMessage={() => 'Type at least 2 characters'} onChange={(o: Option | null) => void chooseCustomer(o)} />
            {!adding && (
              <Button type="button" size="sm" mt="sm" onClick={() => setAdding(true)}>
                New customer
              </Button>
            )}
            {adding && (
              <Box mt="default" p="default" style={{ border: '1px solid #E2E8F0', borderRadius: 4 }}>
                <Label htmlFor="new-customer-name">Name</Label>
                <input id="new-customer-name" value={newName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)} style={{ width: '100%', fontSize: TYPE.body, padding: '6px 10px', marginBottom: SPACE.sm }} />
                <Label htmlFor="new-customer-email">E-mail</Label>
                <input id="new-customer-email" type="email" value={newEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewEmail(e.target.value)} style={{ width: '100%', fontSize: TYPE.body, padding: '6px 10px', marginBottom: SPACE.sm }} />
                <Button type="button" size="sm" variant="primary" disabled={newName.trim() === '' || newEmail.trim() === ''} onClick={() => void addCustomer()}>
                  Add customer
                </Button>
                <Button type="button" size="sm" ml="default" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </Box>
            )}
          </FormGroup>
          <FormGroup>
            <Label required>Priority</Label>
            <Select value={priorities.find((o) => o.value === priority)} options={priorities} onChange={(o: Option) => setPriority(o.value)} />
            <Box mt="sm">
              <PriorityMarker value={priority} />
            </Box>
          </FormGroup>
          <FormGroup>
            <Label required>Group</Label>
            <Select
              value={groups.find((o) => o.value === groupId) ?? null}
              options={groups}
              onChange={(o: Option) => {
                setGroupId(o.value);
                setAssignee(UNASSIGNED);
              }}
            />
          </FormGroup>
          <FormGroup>
            <Label>Assignee</Label>
            <Select value={agents.find((o) => o.value === assignee) ?? null} options={agents} onChange={(o: Option) => setAssignee(o.value)} />
            <Text variant="sm">Active members of the group. A new ticket may stay unassigned.</Text>
          </FormGroup>
        </Box>
      </Box>

      {error && <MessageBox variant="danger" message={error} mt="lg" />}
      <Box mt="xl">
        <Button type="submit" variant="primary" disabled={saving || !ready}>
          {saving ? 'Creating…' : 'Create ticket'}
        </Button>
        <Button as="a" href={`${adminRoot()}/resources/Ticket`} ml="default">
          Cancel
        </Button>
      </Box>
    </Box>
  );
};

export default TicketNewForm;
