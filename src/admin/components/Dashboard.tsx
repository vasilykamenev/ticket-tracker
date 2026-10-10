import React, { useEffect, useState } from 'react';
import { Box, H3, Loader, MessageBox, Text } from '@adminjs/design-system';
import { ApiClient } from 'adminjs';
import type { Dashboard as DashboardData } from '../../domain/tickets/ticket-queries.js';
import { adminRoot } from './api.js';

const api = new ApiClient();

interface CardProps {
  title: string;
  count: number;
  href?: string;
}

const Card = ({ title, count, href }: CardProps) => (
  <Box as={href ? 'a' : 'div'} href={href} variant="white" p="xl" mr="lg" mb="lg" flexGrow={1} style={{ minWidth: 190, textDecoration: 'none' }}>
    <Text variant="sm">{title}</Text>
    <H3 mt="sm" mb="0">
      {count}
    </H3>
  </Box>
);

/** Saved-filter shortcuts. Counts are computed with the same scope as the ticket list they link to. */
const Dashboard = () => {
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
  return (
    <Box p="xl">
      <H3>Tickets</H3>
      <Box flex flexWrap="wrap" mt="lg">
        {data.mine && <Card title="My tickets" count={data.mine.count} href={`${list}?filters.assignedAgent=${data.mine.agentId}`} />}
        <Card title="Unassigned" count={data.unassigned} href={`${list}?filters.assignedAgent=__none__`} />
        <Card
          title="Waiting for customer"
          count={data.waiting.count}
          href={data.waiting.statusId ? `${list}?filters.status=${data.waiting.statusId}` : undefined}
        />
        <Card
          title="Unresolved"
          count={data.unresolved.count}
          href={data.unresolved.statusId ? `${list}?filters.status=${data.unresolved.statusId}` : undefined}
        />
        <Card title="All tickets you can see" count={data.total} href={list} />
      </Box>
    </Box>
  );
};

export default Dashboard;
