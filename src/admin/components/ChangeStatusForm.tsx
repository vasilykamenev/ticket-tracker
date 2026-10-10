import React, { useEffect, useState } from 'react';
import { Box, Button, FormGroup, H3, Label, Loader, MessageBox, Select, Text, TextArea } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import type { FormState } from '../../domain/tickets/ticket-queries.js';
import { postRecordAction, recordData, ticketUrl, toServerError, type ServerError } from './api.js';

type Option = { value: string; label: string };

const ChangeStatusForm = ({ record }: ActionProps) => {
  const ticketId = record?.id ?? '';
  const [state, setState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('');
  const [unresolvedReason, setUnresolvedReason] = useState('');
  const [assignee, setAssignee] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);

  useEffect(() => {
    if (!ticketId) return;
    recordData<FormState>('Ticket', ticketId, 'formState')
      .then((s) => {
        setState(s);
        setTarget(s.targets[0]?.code ?? '');
        setAssignee(s.agents.some((a) => a.id === s.ticket.assigneeId) ? (s.ticket.assigneeId ?? '') : '');
      })
      .catch((e) => setLoadError(toServerError(e).message));
  }, [ticketId]);

  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  const rule = state.targets.find((t) => t.code === target);
  const agents: Option[] = state.agents.map((a) => ({ value: a.id, label: a.name }));
  const targets: Option[] = state.targets.map((t) => ({ value: t.code, label: t.name }));
  const needsAssignee = rule?.assignee === 'activeMember';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rule) return;
    setSaving(true);
    setError(null);
    try {
      await postRecordAction('Ticket', ticketId, 'changeStatus', {
        version: state.ticket.version,
        targetStatus: rule.code,
        ...(reason.trim() ? { reason } : {}),
        ...(rule.resolution ? { resolution } : {}),
        ...(rule.unresolvedReason ? { unresolvedReason } : {}),
        // Only send an assignee when it differs, so a plain transition never reassigns by accident.
        ...(needsAssignee && assignee && assignee !== state.ticket.assigneeId ? { assignedAgentId: assignee } : {}),
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
        Ticket #{state.ticket.number}: {state.ticket.statusName}
      </H3>
      {state.targets.length === 0 ? (
        <MessageBox variant="info" message={`No status changes are available to you while the ticket is ${state.ticket.statusName}.`} />
      ) : (
        <>
          <FormGroup>
            <Label required>New status</Label>
            <Select value={targets.find((o) => o.value === target)} options={targets} onChange={(o: Option) => setTarget(o.value)} />
          </FormGroup>

          {needsAssignee && (
            <FormGroup>
              <Label required>Assignee</Label>
              <Select
                value={agents.find((o) => o.value === assignee) ?? null}
                options={agents}
                placeholder="Select an agent"
                onChange={(o: Option) => setAssignee(o.value)}
              />
              <Text variant="sm">Must be an active member of the ticket's group.</Text>
            </FormGroup>
          )}

          {rule?.resolution && (
            <FormGroup>
              <Label required>Resolution</Label>
              <TextArea width="100%" value={resolution} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setResolution(e.target.value)} />
              <Text variant="sm">What fixed the problem. At least 10 characters.</Text>
            </FormGroup>
          )}

          {rule?.unresolvedReason && (
            <FormGroup>
              <Label required>Why it is unresolved</Label>
              <TextArea width="100%" value={unresolvedReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setUnresolvedReason(e.target.value)} />
              <Text variant="sm">At least 10 characters. Work stops without a solution.</Text>
            </FormGroup>
          )}

          <FormGroup>
            <Label required={rule?.reason === 'required'}>Reason</Label>
            <TextArea width="100%" value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} />
            <Text variant="sm">{rule?.reason === 'required' ? 'Required for this change.' : 'Optional. Saved in the ticket history.'}</Text>
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
            <Button variant="primary" type="submit" disabled={saving || !rule}>
              {saving ? 'Saving…' : 'Change status'}
            </Button>
            <Button as="a" href={ticketUrl(ticketId)} ml="default">
              Cancel
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
};

export default ChangeStatusForm;
