import React, { useEffect, useState } from 'react';
import { Box, Button, FormGroup, H3, Label, Loader, MessageBox, Select, Text } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import type { FormState } from '../../domain/tickets/ticket-queries.js';
import { postRecordAction, recordData, ticketUrl, toServerError, type ServerError } from './api.js';

type Option = { value: string; label: string };
const UNASSIGNED = '';

const AssignForm = ({ record }: ActionProps) => {
  const ticketId = record?.id ?? '';
  const [state, setState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);

  const load = (forGroup?: string) =>
    recordData<FormState>('Ticket', ticketId, 'formState', forGroup ? { groupId: forGroup } : {})
      .then((s) => {
        setState(s);
        const group = forGroup ?? s.ticket.groupId;
        setGroupId(group);
        // Keep the current assignee only if they belong to the selected group.
        setAssignee(group === s.ticket.groupId && s.agents.some((a) => a.id === s.ticket.assigneeId) ? (s.ticket.assigneeId ?? UNASSIGNED) : UNASSIGNED);
      })
      .catch((e) => setLoadError(toServerError(e).message));

  useEffect(() => {
    if (ticketId) void load();
  }, [ticketId]);

  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  if (state.ticket.frozen) {
    return (
      <MessageBox
        variant="info"
        message={`Ticket #${state.ticket.number} is ${state.ticket.statusName}. Reopen it with Change status before assigning it.`}
      />
    );
  }

  const isNew = state.ticket.statusCode === 'NEW';
  const groups: Option[] = state.groups.map((g) => ({ value: g.id, label: g.name }));
  const agents: Option[] = [
    // Only NEW tickets may be unassigned.
    ...(isNew ? [{ value: UNASSIGNED, label: '— unassigned —' }] : []),
    ...state.agents.map((a) => ({ value: a.id, label: a.name })),
  ];
  const unchanged = groupId === state.ticket.groupId && (assignee || null) === state.ticket.assigneeId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postRecordAction('Ticket', ticketId, 'assignTicket', {
        version: state.ticket.version,
        ...(groupId !== state.ticket.groupId ? { groupId } : {}),
        assignedAgentId: assignee || null,
      });
      window.location.assign(ticketUrl(ticketId));
    } catch (e) {
      setError(toServerError(e));
      setSaving(false);
    }
  };

  return (
    <Box as="form" variant="white" onSubmit={submit}>
      <H3>
        Assign ticket #{state.ticket.number} ({state.ticket.statusName})
      </H3>
      <FormGroup>
        <Label required>Group</Label>
        <Select value={groups.find((o) => o.value === groupId)} options={groups} onChange={(o: Option) => void load(o.value)} />
      </FormGroup>
      <FormGroup>
        <Label required={!isNew}>Assignee</Label>
        <Select
          value={agents.find((o) => o.value === assignee) ?? null}
          options={agents}
          placeholder="Select an agent"
          onChange={(o: Option) => setAssignee(o.value)}
        />
        <Text variant="sm">{isNew ? 'A NEW ticket may stay unassigned.' : 'Active members of the selected group.'}</Text>
      </FormGroup>

      {error && (
        <MessageBox variant="danger" message={error.message}>
          {Object.entries(error.details).map(([field, text]) => (
            <Text key={field}>
              {field}: {text}
            </Text>
          ))}
        </MessageBox>
      )}

      <Box mt="xl">
        <Button variant="primary" type="submit" disabled={saving || unchanged}>
          {saving ? 'Saving…' : 'Assign'}
        </Button>
        <Button as="a" href={ticketUrl(ticketId)} ml="default">
          Cancel
        </Button>
      </Box>
    </Box>
  );
};

export default AssignForm;
