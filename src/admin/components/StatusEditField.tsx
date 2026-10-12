import React, { useEffect, useState } from 'react';
import { FormGroup, Label, Loader, MessageBox, Select, Text, TextArea } from '@adminjs/design-system';
import type { EditPropertyProps } from 'adminjs';
import type { FormState } from '../../domain/tickets/ticket-queries.js';
import { recordData, toServerError } from './api.js';

type Option = { value: string; label: string };

/**
 * The Status field of the edit form. It offers the current status and the changes this person may make from it; picking
 * another status asks for what that change needs (assignee, resolution, reason), exactly as the Change status action does.
 * The choices travel with the form as `statusTarget`, `statusReason`, `statusResolution`, `statusUnresolvedReason` and
 * `statusAssignee`; the server makes the change and the other edits in one transaction and checks every rule again.
 */
const StatusEditField = ({ record, property, onChange }: EditPropertyProps) => {
  const ticketId = record?.id ?? '';
  const [state, setState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [assignee, setAssignee] = useState('');

  useEffect(() => {
    if (!ticketId) return;
    recordData<FormState>('Ticket', ticketId, 'formState')
      .then((s) => {
        setState(s);
        setTarget(s.ticket.statusCode);
        setAssignee(s.agents.some((a) => a.id === s.ticket.assigneeId) ? (s.ticket.assigneeId ?? '') : '');
      })
      .catch((e) => setLoadError(toServerError(e).message));
  }, [ticketId]);

  // A new ticket always starts as New: nothing to choose.
  if (!ticketId) return null;
  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  const current = state.ticket.statusCode;
  const options: Option[] = [{ value: current, label: state.ticket.statusName }, ...state.targets.map((t) => ({ value: t.code, label: t.name }))];
  const rule = target === current ? undefined : state.targets.find((t) => t.code === target);
  const agents: Option[] = state.agents.map((a) => ({ value: a.id, label: a.name }));
  const needsAssignee = rule?.assignee === 'activeMember';
  const error = (record?.errors?.[property.path]?.message as string | undefined) ?? null;

  const pick = (code: string) => {
    setTarget(code);
    const next = code === current ? undefined : state.targets.find((t) => t.code === code);
    onChange('statusTarget', code === current ? '' : code);
    // Inputs of another change must not travel with this one.
    if (!next?.resolution) onChange('statusResolution', '');
    if (!next?.unresolvedReason) onChange('statusUnresolvedReason', '');
    if (!next) onChange('statusReason', '');
    onChange('statusAssignee', next?.assignee === 'activeMember' && assignee && assignee !== state.ticket.assigneeId ? assignee : '');
  };

  return (
    <FormGroup error={Boolean(error)}>
      <Label>Status</Label>
      <Select value={options.find((o) => o.value === target)} options={options} isClearable={false} onChange={(o: Option) => pick(o.value)} />
      {state.targets.length === 0 && <Text variant="sm">No status changes are available to you while the ticket is {state.ticket.statusName}.</Text>}
      {error && <Text variant="sm" color="error">{error}</Text>}

      {needsAssignee && (
        <FormGroup>
          <Label required>Assignee</Label>
          <Select
            value={agents.find((o) => o.value === assignee) ?? null}
            options={agents}
            placeholder="Select an agent"
            onChange={(o: Option) => {
              setAssignee(o.value);
              onChange('statusAssignee', o.value === state.ticket.assigneeId ? '' : o.value);
            }}
          />
          <Text variant="sm">Must be an active member of the ticket's group.</Text>
        </FormGroup>
      )}

      {rule?.resolution && (
        <FormGroup>
          <Label required>Resolution</Label>
          <TextArea width="100%" onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange('statusResolution', e.target.value)} />
          <Text variant="sm">What fixed the problem. At least 10 characters.</Text>
        </FormGroup>
      )}

      {rule?.unresolvedReason && (
        <FormGroup>
          <Label required>Why it is unresolved</Label>
          <TextArea width="100%" onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange('statusUnresolvedReason', e.target.value)} />
          <Text variant="sm">At least 10 characters. Work stops without a solution.</Text>
        </FormGroup>
      )}

      {rule && (
        <FormGroup>
          <Label required={rule.reason === 'required'}>Reason</Label>
          <TextArea width="100%" onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange('statusReason', e.target.value)} />
          <Text variant="sm">{rule.reason === 'required' ? 'Required for this change.' : 'Optional. Saved in the ticket history.'}</Text>
        </FormGroup>
      )}
    </FormGroup>
  );
};

export default StatusEditField;
