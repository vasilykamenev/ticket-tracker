import React, { useEffect } from 'react';
import { Box, Loader, MessageBox } from '@adminjs/design-system';
import { useCurrentAdmin } from 'adminjs';
import { adminRoot } from './api.js';

/**
 * The menu entry "My open tickets": the ticket list with the signed-in agent as the assignee and every status but
 * CLOSED. AdminJS can only put a page in the menu, so the page sends the person on to the filtered list.
 */
const MyOpenTickets = () => {
  const [currentAdmin] = useCurrentAdmin();
  const agentId = (currentAdmin as { agentId?: string | null } | undefined)?.agentId ?? null;
  const list = `${adminRoot()}/resources/Ticket`;

  useEffect(() => {
    if (agentId) window.location.replace(`${list}?filters.assignedAgent=${encodeURIComponent(agentId)}&filters.status=__open__`);
  }, [agentId, list]);

  if (agentId) return <Loader />;
  return (
    <Box p="xl">
      <MessageBox
        variant="info"
        message="Tickets are assigned to agents, and your account has no agent profile. Administrators see every ticket in the Tickets list."
      />
    </Box>
  );
};

export default MyOpenTickets;
