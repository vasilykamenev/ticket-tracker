import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, DropDown, DropDownItem, DropDownMenu, DropDownTrigger, H2, Icon, Loader, MessageBox, Select, Text } from '@adminjs/design-system';
import { ApiClient, useNotice, type ActionProps, type RecordJSON } from 'adminjs';
import type { FormState } from '../../domain/tickets/ticket-queries.js';
import { formatDateTime } from '../format.js';
import { SPACE, TYPE } from '../tokens.js';
import ActivityFeed from './ActivityFeed.js';
import { adminRoot, postRecordAction, recordData, toServerError } from './api.js';
import { RelativeTime } from './RelativeTime.js';
import { StatusPill } from './StatusBadge.js';

const api = new ApiClient();
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const UNASSIGNED = '';

type Option = { value: string; label: string };

const recordUrl = (id: string, action: string) => `${adminRoot()}/resources/Ticket/records/${id}/${action}`;

/** A target the dropdown can apply on its own: nothing more to ask the person. */
const isSimple = (t: FormState['targets'][number], state: FormState) =>
  t.reason !== 'required' && !t.resolution && !t.unresolvedReason && (t.assignee === 'none' || (t.assignee === 'set' && state.ticket.assigneeId !== null));

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Box mb="default">
    <div style={{ fontSize: TYPE.label, color: '#475569', marginBottom: 2 }}>{label}</div>
    <div>{children}</div>
  </Box>
);

/**
 * The ticket page: heading, the description and the activity feed on the left; the properties on the right, each of
 * them a dropdown that saves when changed. Everything goes through the existing actions, so every change writes a
 * history entry and the server checks scope, version and workflow again. Empty fields are not shown.
 */
const TicketPage = ({ record: initial, resource }: ActionProps) => {
  const sendNotice = useNotice();
  const ticketId = initial?.id ?? '';
  const [record, setRecord] = useState<RecordJSON | undefined>(initial);
  const [state, setState] = useState<FormState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [showDetails, setShowDetails] = useState(false);

  const refresh = useCallback(async () => {
    const [fresh, formState] = await Promise.all([
      api.recordAction({ resourceId: 'Ticket', recordId: ticketId, actionName: 'show', method: 'get' }),
      recordData<FormState>('Ticket', ticketId, 'formState'),
    ]);
    setRecord((fresh.data as { record: RecordJSON }).record);
    setState(formState);
    setAgents(formState.agents);
    setReloadKey((n) => n + 1);
  }, [ticketId]);

  useEffect(() => {
    if (ticketId) void refresh().catch((e) => sendNotice({ message: toServerError(e).message, type: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  if (!record) return <Loader />;
  const p = record.params;
  const populated = record.populated ?? {};
  const title = (key: string): string => String(populated[key]?.title ?? '—');
  const statusCode = String(populated.status?.params?.code ?? '');
  const frozen = state?.ticket.frozen ?? false;

  /** Runs a change, shows the outcome, and reads the ticket again. The old values stay on screen if it fails. */
  const change = async (what: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      sendNotice({ message: `${what} saved.`, type: 'success' });
    } catch (e) {
      sendNotice({ message: toServerError(e).message, type: 'error' });
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const version = state?.ticket.version ?? Number(p.version);
  const goTo = (action: string) => window.location.assign(recordUrl(ticketId, action));

  const setStatus = (code: string) => {
    const target = state?.targets.find((t) => t.code === code);
    if (!state || !target) return;
    if (!isSimple(target, state)) return goTo('changeStatus'); // needs a reason, an outcome or an assignee: the full form
    return change('Status', () => postRecordAction('Ticket', ticketId, 'changeStatus', { version, targetStatus: code }));
  };

  const setAssignee = (agentId: string) => change('Assignee', () => postRecordAction('Ticket', ticketId, 'assignTicket', { version, assignedAgentId: agentId || null }));

  const setPriority = (priority: string) => change('Priority', () => postRecordAction('Ticket', ticketId, 'setPriority', { version, priority }));

  const setGroup = async (groupId: string) => {
    if (!state || groupId === state.ticket.groupId) return;
    try {
      const target = await recordData<FormState>('Ticket', ticketId, 'formState', { groupId });
      const keeps = target.agents.some((a) => a.id === state.ticket.assigneeId);
      if (!keeps && state.ticket.statusCode !== 'NEW') return goTo('assignTicket'); // an assignee of the new group is needed
      await change('Group', () => postRecordAction('Ticket', ticketId, 'assignTicket', { version, groupId, ...(keeps ? {} : { assignedAgentId: null }) }));
    } catch (e) {
      sendNotice({ message: toServerError(e).message, type: 'error' });
    }
  };

  const statusOptions: Option[] = state
    ? [{ value: state.ticket.statusCode, label: state.ticket.statusName }, ...state.targets.map((t) => ({ value: t.code, label: t.name }))]
    : [];
  const agentOptions: Option[] = [
    ...(state?.ticket.statusCode === 'NEW' ? [{ value: UNASSIGNED, label: '— unassigned —' }] : []),
    ...agents.map((a) => ({ value: a.id, label: a.name })),
  ];
  const groupOptions: Option[] = (state?.groups ?? []).map((g) => ({ value: g.id, label: g.name }));
  const priorityOptions: Option[] = PRIORITIES.map((v) => ({ value: v, label: v }));
  const pick = (options: Option[], value: string) => options.find((o) => o.value === value) ?? null;
  const assigneeId = state?.ticket.assigneeId ?? UNASSIGNED;

  const hasText = (key: string) => typeof p[key] === 'string' && String(p[key]).trim() !== '';

  return (
    <Box p={['default', 'xl']}>
      <Box flex alignItems="center" justifyContent="space-between" flexWrap="wrap" mb="lg" style={{ gap: SPACE.md }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TYPE.small, color: '#475569' }}>
            <a href={`${adminRoot()}/resources/Ticket`}>Tickets</a> / #{String(p.number)}
          </div>
          <H2 mb="0" style={{ wordBreak: 'break-word' }}>
            #{String(p.number)} · {String(p.subject ?? '')}
          </H2>
        </div>
        <Box flex style={{ gap: SPACE.sm }}>
          <DropDown>
            <DropDownTrigger>
              <Button type="button" disabled={busy || !state}>
                Change status
                <Icon icon="ChevronDown" />
              </Button>
            </DropDownTrigger>
            <DropDownMenu>
              {(state?.targets ?? []).map((t) => (
                <DropDownItem key={t.code} onClick={() => setStatus(t.code)}>
                  {t.name}
                </DropDownItem>
              ))}
              {state && state.targets.length === 0 && <DropDownItem>No changes available</DropDownItem>}
            </DropDownMenu>
          </DropDown>
          <DropDown>
            <DropDownTrigger>
              <Button type="button" disabled={busy || !state || frozen}>
                Assign
                <Icon icon="ChevronDown" />
              </Button>
            </DropDownTrigger>
            <DropDownMenu>
              {agentOptions.map((o) => (
                <DropDownItem key={o.value || 'none'} onClick={() => void setAssignee(o.value)}>
                  {o.label}
                </DropDownItem>
              ))}
            </DropDownMenu>
          </DropDown>
          <Button as="a" href={recordUrl(ticketId, 'edit')} type="button">
            Edit
          </Button>
        </Box>
      </Box>

      {frozen && state && <MessageBox variant="info" message={`This ticket is ${state.ticket.statusName}. Reopen it with Change status to edit it.`} mb="lg" />}

      <Box flex flexWrap="wrap" style={{ gap: SPACE.xl, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <Box variant="white" mb="lg">
            <div style={{ fontSize: TYPE.label, color: '#475569', marginBottom: 4 }}>Description</div>
            <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(p.description ?? '')}</Text>
          </Box>
          {hasText('resolution') && (
            <Box variant="white" mb="lg">
              <div style={{ fontSize: TYPE.label, color: '#475569', marginBottom: 4 }}>Resolution</div>
              <Text style={{ whiteSpace: 'pre-wrap' }}>{String(p.resolution)}</Text>
            </Box>
          )}
          {hasText('unresolvedReason') && (
            <Box variant="white" mb="lg">
              <div style={{ fontSize: TYPE.label, color: '#475569', marginBottom: 4 }}>Why it is unresolved</div>
              <Text style={{ whiteSpace: 'pre-wrap' }}>{String(p.unresolvedReason)}</Text>
            </Box>
          )}
          <H2 style={{ fontSize: TYPE.h3 }}>Activity</H2>
          <ActivityFeed ticketId={ticketId} reloadKey={reloadKey} state={state} onTicketChanged={() => void refresh()} />
        </div>

        <aside style={{ flex: '0 0 320px', maxWidth: '100%' }}>
          <Box variant="white">
            <Row label="Status">
              {state ? (
                <Select value={pick(statusOptions, state.ticket.statusCode)} options={statusOptions} isDisabled={busy} onChange={(o: Option) => o.value !== state.ticket.statusCode && void setStatus(o.value)} />
              ) : (
                <StatusPill code={statusCode} label={title('status')} />
              )}
            </Row>
            <Row label="Priority">
              <Select
                value={pick(priorityOptions, String(p.priority ?? ''))}
                options={priorityOptions}
                isDisabled={busy || frozen || !state}
                onChange={(o: Option) => o.value !== p.priority && void setPriority(o.value)}
              />
            </Row>
            <Row label="Assignee">
              <Select
                value={pick(agentOptions, assigneeId)}
                options={agentOptions}
                placeholder="Unassigned"
                isDisabled={busy || frozen || !state}
                onChange={(o: Option) => o.value !== assigneeId && void setAssignee(o.value)}
              />
            </Row>
            <Row label="Group">
              <Select
                value={pick(groupOptions, state?.ticket.groupId ?? '')}
                options={groupOptions}
                isDisabled={busy || frozen || !state}
                onChange={(o: Option) => void setGroup(o.value)}
              />
            </Row>
            <Row label="Customer">
              {p.customer ? <a href={`${adminRoot()}/resources/Customer/records/${String(p.customer)}/show`}>{title('customer')}</a> : <span>—</span>}
            </Row>
            {hasText('age') && <Row label="Age">{String(p.age)}</Row>}
            {typeof p.resolvedAt === 'string' && p.resolvedAt && <Row label="Resolved"><RelativeTime value={String(p.resolvedAt)} /></Row>}
            {typeof p.unresolvedAt === 'string' && p.unresolvedAt && <Row label="Marked unresolved"><RelativeTime value={String(p.unresolvedAt)} /></Row>}
            {typeof p.closedAt === 'string' && p.closedAt && <Row label="Closed"><RelativeTime value={String(p.closedAt)} /></Row>}

            <Box mt="lg">
              <Button type="button" size="sm" onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails}>
                {showDetails ? 'Hide details' : 'Details'}
              </Button>
              {showDetails && (
                <Box mt="default">
                  <Row label="Created by">{title('createdBy')}</Row>
                  <Row label="Created">{typeof p.createdAt === 'string' ? formatDateTime(p.createdAt) : '—'}</Row>
                  <Row label="Updated">{typeof p.updatedAt === 'string' ? formatDateTime(p.updatedAt) : '—'}</Row>
                  <Row label="Version">{String(p.version ?? '—')}</Row>
                </Box>
              )}
            </Box>
          </Box>
        </aside>
      </Box>
      <span hidden>{resource?.id}</span>
    </Box>
  );
};

export default TicketPage;
