import React, { useEffect, useState } from 'react';
import { Box, H3, Loader, MessageBox, Text } from '@adminjs/design-system';
import { ApiClient, useCurrentAdmin } from 'adminjs';
import type { Dashboard as DashboardData } from '../../domain/tickets/ticket-queries.js';
import { STATUS_BAR, SPACE, TYPE } from '../tokens.js';
import { adminRoot, ticketUrl } from './api.js';
import { PriorityMarker } from './PriorityMarker.js';
import { RelativeTime } from './RelativeTime.js';
import { StatusPill } from './StatusBadge.js';

const api = new ApiClient();
const MUTED = '#475569';

interface CardProps {
  title: string;
  count: number;
  href?: string;
}

const Card = ({ title, count, href }: CardProps) => (
  <Box as={href ? 'a' : 'div'} href={href} variant="white" p="lg" mr="lg" mb="lg" flexGrow={1} style={{ minWidth: 170, textDecoration: 'none' }}>
    <Text variant="sm">{title}</Text>
    <H3 mt="sm" mb="0">
      {count}
    </H3>
  </Box>
);

/** Bars for the tickets created per day: plain SVG, with the numbers in the labels so nothing depends on color. */
const IncomingChart = ({ days }: { days: DashboardData['incoming'] }) => {
  const max = Math.max(1, ...days.map((d) => d.count));
  const width = 28;
  const height = 120;
  return (
    <svg role="img" aria-label={`Tickets created per day, last 14 days: ${days.map((d) => `${d.date} ${d.count}`).join(', ')}`} width="100%" viewBox={`0 0 ${days.length * width} ${height + 34}`} style={{ maxWidth: 560 }}>
      {days.map((d, i) => {
        const h = Math.round((d.count / max) * height);
        return (
          <g key={d.date} transform={`translate(${i * width},0)`}>
            <title>{`${d.date}: ${d.count}`}</title>
            <rect x={4} y={height - h + 14} width={width - 8} height={h} rx={2} fill="#3040d6" />
            <text x={width / 2} y={height - h + 10} fontSize={TYPE.small - 3} textAnchor="middle" fill={MUTED}>
              {d.count}
            </text>
            <text x={width / 2} y={height + 28} fontSize={TYPE.small - 3} textAnchor="middle" fill={MUTED}>
              {d.date.slice(8)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/** Open tickets per agent or group: one row each with a bar split by status in the colors of the statuses. */
const StatusLoad = ({ title, rows, href }: { title: string; rows: DashboardData['byAgent']; href: (id: string) => string }) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const legend = [...new Map(rows.flatMap((r) => r.statuses).map((s) => [s.code, s.name])).entries()];
  return (
    <Box variant="white" mb="lg" style={{ flex: '1 1 320px' }}>
      <H3>{title}</H3>
      {legend.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${SPACE.xs}px ${SPACE.md}px`, fontSize: TYPE.small, marginBottom: SPACE.md }}>
          {legend.map(([code, name]) => (
            <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: STATUS_BAR[code] ?? '#94A3B8' }} />
              {name}
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 && <Text>Nothing open.</Text>}
      {rows.map((r) => (
        <a
          key={r.id}
          href={href(r.id)}
          title={r.statuses.map((s) => `${s.name} ${s.count}`).join(' · ')}
          style={{ display: 'flex', alignItems: 'center', gap: SPACE.md, textDecoration: 'none', color: 'inherit', marginBottom: SPACE.sm, fontSize: TYPE.small }}
        >
          <span style={{ flex: '0 0 130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', width: `${(r.count / max) * 100}%`, minWidth: 8, height: 7, borderRadius: 3, overflow: 'hidden', background: '#E2E8F0' }}>
              {r.statuses.map((s) => (
                <span key={s.code} title={`${s.name}: ${s.count}`} style={{ width: `${(s.count / r.count) * 100}%`, background: STATUS_BAR[s.code] ?? '#94A3B8' }} />
              ))}
            </span>
          </span>
          <strong style={{ flex: '0 0 32px', textAlign: 'right' }}>{r.count}</strong>
        </a>
      ))}
    </Box>
  );
};

/**
 * The home page. For an agent it opens with their own queue; every counter is a link to the ticket list with the
 * same filters and the same scope, so the number on a card is the number in the list.
 */
const Dashboard = () => {
  const [currentAdmin] = useCurrentAdmin();
  const agentId = (currentAdmin as { agentId?: string | null } | undefined)?.agentId ?? null;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .getDashboard<DashboardData>()
      .then((r) => setData(r.data))
      .catch(() => setError(true));
  }, []);

  if (error) return <MessageBox variant="danger" message="Could not load the dashboard." />;
  if (!data) return <Loader />;

  const list = `${adminRoot()}/resources/Ticket`;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const today = encodeURIComponent(startOfToday.toISOString());

  return (
    <Box p="xl">
      {agentId && (
        <Box variant="white" mb="xl">
          <Box flex justifyContent="space-between" alignItems="center">
            <H3 mb="0">My queue</H3>
            <a href={`${list}?filters.assignedAgent=${agentId}&filters.status=__open__`}>All {data.mineOpen} open</a>
          </Box>
          {data.queue.length === 0 ? (
            <Text mt="default">Nothing is assigned to you right now.</Text>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: SPACE.md }}>
              <tbody>
                {data.queue.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid #E2E8F0', height: 36 }}>
                    <td style={{ whiteSpace: 'nowrap', paddingRight: SPACE.md }}>
                      <a href={ticketUrl(t.id)}>#{t.number}</a>
                    </td>
                    <td style={{ paddingRight: SPACE.md }}>{t.subject}</td>
                    <td style={{ paddingRight: SPACE.md }}>
                      <StatusPill code={t.statusCode} label={t.statusName} />
                    </td>
                    <td style={{ paddingRight: SPACE.md }}>
                      <PriorityMarker value={t.priority} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap', color: MUTED, fontSize: TYPE.small }}>
                      <RelativeTime value={t.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>
      )}

      <H3>Tickets</H3>
      <Box flex flexWrap="wrap" mt="lg">
        {data.mine && <Card title="My open tickets" count={data.mineOpen} href={`${list}?filters.assignedAgent=${data.mine.agentId}&filters.status=__open__`} />}
        {data.mine && <Card title="All my tickets" count={data.mine.count} href={`${list}?filters.assignedAgent=${data.mine.agentId}`} />}
        <Card title="Unassigned" count={data.unassigned} href={`${list}?filters.assignedAgent=__none__`} />
        <Card title="Waiting for customer" count={data.waiting.count} href={data.waiting.statusId ? `${list}?filters.status=${data.waiting.statusId}` : undefined} />
        <Card title="Unresolved" count={data.unresolved.count} href={data.unresolved.statusId ? `${list}?filters.status=${data.unresolved.statusId}` : undefined} />
        <Card title="Created today (UTC)" count={data.createdToday} href={`${list}?filters.createdAt~~from=${today}`} />
        <Card title="Closed today (UTC)" count={data.closedToday} href={`${list}?filters.closedAt~~from=${today}`} />
        <Card title="Open tickets" count={data.open} href={`${list}?filters.status=__open__`} />
        <Card title="All tickets you can see" count={data.total} href={`${list}?view=all`} />
      </Box>

      <Box variant="white" mb="lg">
        <H3>Incoming tickets, last 14 days</H3>
        <IncomingChart days={data.incoming} />
      </Box>

      <Box flex flexWrap="wrap" style={{ gap: SPACE.lg }}>
        <StatusLoad title="Open tickets by group" rows={data.byGroup} href={(id) => `${list}?filters.group=${id}&filters.status=__open__`} />
        <StatusLoad title="Open tickets by agent" rows={data.byAgent} href={(id) => `${list}?filters.assignedAgent=${id}&filters.status=__open__`} />
      </Box>
    </Box>
  );
};

export default Dashboard;
