import React, { useEffect, useState } from 'react';
import { Box } from '@adminjs/design-system';
import { ApiClient, List, useCurrentAdmin, type ActionProps } from 'adminjs';
import type { Dashboard } from '../../domain/tickets/ticket-queries.js';
import { SPACE, TYPE } from '../tokens.js';
import { adminRoot } from './api.js';

const api = new ApiClient();

interface Tab {
  key: string;
  label: string;
  /** The filters that make the tab; the tab is active when the address carries exactly these filters. */
  filters: Record<string, string>;
  /** Set on the tab that shows every ticket, so an address without filters can mean "the default view". */
  view?: string;
  count?: number;
  /** Shown but not clickable, with the reason as its tooltip. */
  disabledReason?: string;
}

const FILTER_PREFIX = 'filters.';

/** The filters of the address, without the search ones. */
function activeFilters(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(search).forEach((value, key) => {
    if (key.startsWith(FILTER_PREFIX) && key !== 'filters.number' && key !== 'filters.subject') out[key.slice(FILTER_PREFIX.length)] = value;
  });
  return out;
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
};

/**
 * The ticket list with queue tabs above the table (the search is in the top bar). A tab only sets filters in the address, so a
 * view can be shared as a link. The table is AdminJS's own. The counts come from the dashboard query, which uses
 * the same scope as the list.
 */
const TicketList = (props: ActionProps) => {
  const [currentAdmin] = useCurrentAdmin();
  const agentId = (currentAdmin as { agentId?: string | null } | undefined)?.agentId ?? null;
  // The address is read and written directly: the same full-page links the dashboard uses.
  const location = window.location;
  const [stats, setStats] = useState<Dashboard | null>(null);

  useEffect(() => {
    api
      .getDashboard<Dashboard>()
      .then((r) => setStats(r.data))
      .catch(() => setStats(null)); // the tabs work without counts
  }, []);

  const tabs: Tab[] = [
    { key: 'open', label: 'Open', filters: { status: '__open__' }, count: stats?.open },
    agentId
      ? { key: 'mine', label: 'My open', filters: { assignedAgent: agentId, status: '__open__' }, count: stats?.mineOpen }
      : { key: 'mine', label: 'My open', filters: { assignedAgent: '__none__', status: '__open__' }, disabledReason: 'Your account has no agent profile, so no tickets are assigned to you.' },
    { key: 'unassigned', label: 'Unassigned', filters: { assignedAgent: '__none__' }, count: stats?.unassigned },
    ...(stats?.waiting.statusId ? [{ key: 'waiting', label: 'Waiting for customer', filters: { status: stats.waiting.statusId }, count: stats.waiting.count }] : []),
    { key: 'all', label: 'All', filters: {}, view: 'all', count: stats?.total },
  ];
  const current = activeFilters(location.search);
  const view = new URLSearchParams(location.search).get('view');

  // The list opened without any filter shows the open tickets; "All" is asked for explicitly (view=all).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const hasFilter = [...q.keys()].some((k) => k.startsWith(FILTER_PREFIX));
    if (hasFilter || q.get('view') === 'all') return;
    q.set(`${FILTER_PREFIX}status`, '__open__');
    window.location.replace(`${adminRoot()}/resources/Ticket?${q.toString()}`);
  }, []);

  const go = (query: URLSearchParams) => {
    const qs = query.toString();
    window.location.assign(`${adminRoot()}/resources/Ticket${qs ? `?${qs}` : ''}`);
  };

  const open = (filters: Record<string, string>, tabView?: string) => {
    const query = new URLSearchParams();
    if (tabView) query.set('view', tabView);
    for (const [k, v] of Object.entries(filters)) query.set(`${FILTER_PREFIX}${k}`, v);
    go(query);
  };

  return (
    <>
      <Box flex flexWrap="wrap" alignItems="center" mb="lg" style={{ gap: SPACE.md }}>
        <div role="tablist" aria-label="Ticket queues" style={{ display: 'flex', flexWrap: 'wrap', gap: SPACE.xs }}>
          {tabs.map((tab) => {
            const active = same(tab.filters, current) && (tab.view ?? null) === (Object.keys(current).length === 0 ? view : null);
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={Boolean(tab.disabledReason)}
                title={tab.disabledReason}
                onClick={() => open(tab.filters, tab.view)}
                style={{
                  cursor: tab.disabledReason ? 'not-allowed' : 'pointer',
                  opacity: tab.disabledReason ? 0.55 : 1,
                  fontSize: TYPE.body,
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: `1px solid ${active ? '#3040d6' : '#CBD5E1'}`,
                  background: active ? '#3040d6' : '#FFFFFF',
                  color: active ? '#FFFFFF' : '#1E293B',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {tab.label}
                {tab.count !== undefined ? <span style={{ marginLeft: 6, opacity: 0.85 }}>{tab.count}</span> : null}
              </button>
            );
          })}
        </div>
      </Box>
      <List {...props} />
    </>
  );
};

export default TicketList;
