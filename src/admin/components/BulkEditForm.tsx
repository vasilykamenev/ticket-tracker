import React, { useEffect, useState } from 'react';
import { Badge, Box, Button, FormGroup, H3, Label, Loader, MessageBox, Select, Table, TableBody, TableCell, TableHead, TableRow, Text } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import type { BulkAssignState } from '../../domain/tickets/ticket-queries.js';
import type { BulkChanged } from '../../domain/tickets/ticket-service.js';
import { adminRoot, bulkAction, toServerError, type ServerError } from './api.js';
import { PriorityMarker } from './PriorityMarker.js';

type Option = { value: string; label: string };
const UNASSIGNED = '';
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export type BulkEditMode = 'assign' | 'group' | 'priority';

const TITLES: Record<BulkEditMode, string> = { assign: 'Assign', group: 'Change group of', priority: 'Change priority of' };
const ACTIONS: Record<BulkEditMode, string> = { assign: 'bulkAssign', group: 'bulkChangeGroup', priority: 'bulkChangePriority' };

const listUrl = () => `${adminRoot()}/resources/Ticket`;

/**
 * The form of the bulk assign, change-group and change-priority actions. The selection is fixed for the page; the
 * versions the operator sees travel back, so a ticket edited meanwhile is refused instead of overwritten. If any
 * ticket is refused, none is changed, and every refusal is named.
 */
const BulkEditForm = ({ records, mode }: ActionProps & { mode: BulkEditMode }) => {
  const selected = (records ?? []).map((r) => r.id);
  const action = ACTIONS[mode];
  const [state, setState] = useState<BulkAssignState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [priority, setPriority] = useState('NORMAL');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [done, setDone] = useState<BulkChanged[] | null>(null);

  useEffect(() => {
    if (selected.length === 0) return;
    bulkAction<BulkAssignState>('Ticket', action, selected)
      .then((s) => {
        setState(s);
        setGroupId(s.sharedGroupId ?? s.groups[0]?.id ?? '');
      })
      .catch((e) => setLoadError(toServerError(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(',')]);

  if (loadError) return <MessageBox variant="danger" message={loadError} />;
  if (!state) return <Loader />;

  if (done) {
    return (
      <Box variant="white">
        <MessageBox variant="success" message={`${done.length} ${done.length === 1 ? 'ticket' : 'tickets'} changed: ${done.map((t) => `#${t.number}`).join(', ')}`} />
        <Box mt="xl">
          <Button as="a" href={listUrl()} variant="primary">
            Back to the list
          </Button>
        </Box>
      </Box>
    );
  }

  const count = state.tickets.length;
  const noun = count === 1 ? 'ticket' : 'tickets';
  const groups: Option[] = state.groups.map((g) => ({ value: g.id, label: g.name }));
  const members = state.agentsByGroup[groupId] ?? [];
  const agents: Option[] = [{ value: UNASSIGNED, label: '— unassigned —' }, ...members.map((a) => ({ value: a.id, label: a.name }))];
  const frozen = state.tickets.filter((t) => t.frozen).length;
  const priorities: Option[] = PRIORITIES.map((v) => ({ value: v, label: v }));
  // Assigning needs someone to assign to; a group change may leave the ticket unassigned (only NEW tickets may stay so).
  const incomplete = mode === 'assign' ? assignee === UNASSIGNED : mode === 'group' ? groupId === '' : false;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const items = state.tickets.map((t) => ({ id: t.id, version: t.version }));
    try {
      const payload =
        mode === 'priority'
          ? { items, priority }
          : mode === 'assign'
            ? { items, groupId, assignedAgentId: assignee }
            : { items, groupId, assignedAgentId: assignee || null };
      const result = await bulkAction<{ changed: BulkChanged[] }>('Ticket', action, selected, payload);
      setDone(result.changed);
    } catch (e) {
      setError(toServerError(e));
      setSaving(false);
    }
  };

  return (
    <Box as="form" variant="white" onSubmit={submit}>
      <H3>
        {TITLES[mode]} {count} {noun}
      </H3>
      {state.unavailable > 0 && <MessageBox variant="warning" message={`${state.unavailable} selected ticket(s) are not available to you and are left out.`} />}
      {frozen > 0 && mode !== 'group' && (
        <MessageBox variant="info" message={`${frozen} selected ${frozen === 1 ? 'ticket is' : 'tickets are'} CLOSED or UNRESOLVED and cannot be changed here; reopen them first. Nothing is changed while they are selected.`} />
      )}

      <Table>
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Subject</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Group</TableCell>
            <TableCell>Assignee</TableCell>
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
              <TableCell>{t.groupName}</TableCell>
              <TableCell>{t.assigneeName ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {mode === 'priority' ? (
        <FormGroup mt="xl">
          <Label required>New priority</Label>
          <Select value={priorities.find((o) => o.value === priority)} options={priorities} onChange={(o: Option) => setPriority(o.value)} />
          <Box mt="sm">
            <PriorityMarker value={priority} />
          </Box>
        </FormGroup>
      ) : (
        <>
          <FormGroup mt="xl">
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
            <Label required={mode === 'assign'}>Assignee</Label>
            <Select value={agents.find((o) => o.value === assignee) ?? null} options={agents} placeholder="Select an agent" onChange={(o: Option) => setAssignee(o.value)} />
            <Text variant="sm">Active members of the selected group. Only NEW tickets may stay unassigned.</Text>
          </FormGroup>
        </>
      )}
      <Text variant="sm">If any ticket is refused, none is changed. Each ticket gets its own history entry.</Text>

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
        <Button variant="primary" type="submit" disabled={saving || incomplete || count === 0}>
          {saving ? 'Saving…' : `Change ${count} ${noun}`}
        </Button>
        <Button as="a" href={listUrl()} ml="default">
          Cancel
        </Button>
      </Box>
    </Box>
  );
};

export default BulkEditForm;
