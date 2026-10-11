import React, { useEffect, useState } from 'react';
import { Badge, Box, Button, CheckBox, FormGroup, H3, Label, Loader, MessageBox, Select, Table, TableBody, TableCell, TableHead, TableRow, Text, TextArea } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import type { BulkFormState } from '../../domain/tickets/ticket-queries.js';
import { adminRoot, bulkAction, toServerError, type ServerError } from './api.js';

type Option = { value: string; label: string };

const listUrl = () => `${adminRoot()}/resources/Ticket`;

const BulkChangeStatusForm = ({ records }: ActionProps) => {
  const selected = (records ?? []).map((r) => r.id);
  const [state, setState] = useState<BulkFormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('');
  const [unresolvedReason, setUnresolvedReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);

  useEffect(() => {
    if (selected.length === 0) return;
    bulkAction<BulkFormState>('Ticket', 'bulkChangeStatus', selected)
      .then((s) => {
        setState(s);
        setTarget(s.targets[0]?.code ?? '');
      })
      .catch((e) => setLoadError(toServerError(e).message));
    // The selection is fixed for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(',')]);

  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  const rule = state.targets.find((t) => t.code === target);
  const targets: Option[] = state.targets.map((t) => ({ value: t.code, label: t.name }));
  const count = state.tickets.length;
  const noun = count === 1 ? 'ticket' : 'tickets';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rule) return;
    setSaving(true);
    setError(null);
    try {
      await bulkAction('Ticket', 'bulkChangeStatus', selected, {
        // The versions the operator is looking at, so a ticket edited meanwhile is refused instead of overwritten.
        items: state.tickets.map((t) => ({ id: t.id, version: t.version })),
        targetStatus: rule.code,
        ...(reason.trim() ? { reason } : {}),
        ...(rule.resolution ? { resolution } : {}),
        ...(rule.unresolvedReason ? { unresolvedReason, confirmSharedReason: confirmed } : {}),
      });
      window.location.assign(listUrl());
    } catch (e) {
      setError(toServerError(e));
      setSaving(false);
    }
  };

  return (
    <Box as="form" variant="white" onSubmit={submit}>
      <H3>
        Change status of {count} {noun}
      </H3>
      {state.unavailable > 0 && <MessageBox variant="warning" message={`${state.unavailable} selected ticket(s) are not available to you and are left out.`} />}

      <Table>
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Subject</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {state.tickets.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.number}</TableCell>
              <TableCell>{t.subject}</TableCell>
              <TableCell>
                <Badge>{t.statusName}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {state.targets.length === 0 ? (
        <Box mt="xl">
          <MessageBox variant="info" message="No single status change is available to you for all of the selected tickets. Select tickets that are in the same status." />
        </Box>
      ) : (
        <>
          <FormGroup mt="xl">
            <Label required>New status</Label>
            <Select value={targets.find((o) => o.value === target)} options={targets} onChange={(o: Option) => setTarget(o.value)} />
            <Text variant="sm">Only changes that are valid for every selected ticket are listed. If any ticket is refused, none is changed.</Text>
          </FormGroup>

          {rule?.resolution && (
            <FormGroup>
              <Label required>Resolution</Label>
              <TextArea width="100%" value={resolution} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setResolution(e.target.value)} />
              <Text variant="sm">At least 10 characters. Applied to every selected ticket.</Text>
            </FormGroup>
          )}

          {rule?.unresolvedReason && (
            <FormGroup>
              <Label required>Why they are unresolved</Label>
              <TextArea width="100%" value={unresolvedReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setUnresolvedReason(e.target.value)} />
              <Text variant="sm">At least 10 characters. The same reason is saved on every selected ticket.</Text>
              <Box mt="default" flex alignItems="center">
                <CheckBox id="confirm-shared-reason" checked={confirmed} onChange={() => setConfirmed(!confirmed)} />
                <Label htmlFor="confirm-shared-reason" ml="default" mb="0">
                  This reason is appropriate for all {count} tickets
                </Label>
              </Box>
            </FormGroup>
          )}

          <FormGroup>
            <Label required={rule?.reason === 'required'}>Reason</Label>
            <TextArea width="100%" value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} />
            <Text variant="sm">{rule?.reason === 'required' ? 'Required for this change.' : 'Optional. Saved in the history of each ticket.'}</Text>
          </FormGroup>

          {error && (
            <MessageBox variant="danger" message={error.message}>
              {Object.entries(error.details).map(([ticket, text]) => (
                <Text key={ticket}>
                  {ticket}: {text}
                </Text>
              ))}
            </MessageBox>
          )}

          <Box mt="xl">
            <Button variant="primary" type="submit" disabled={saving || !rule || (rule.unresolvedReason && !confirmed)}>
              {saving ? 'Saving…' : `Change ${count} ${noun}`}
            </Button>
            <Button as="a" href={listUrl()} ml="default">
              Cancel
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
};

export default BulkChangeStatusForm;
