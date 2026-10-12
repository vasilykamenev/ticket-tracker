import React from 'react';
import { Box, ValueGroup } from '@adminjs/design-system';
import { useTranslation, type ShowPropertyProps } from 'adminjs';
import { PriorityPill } from './PriorityBadge.js';
import { StatusPill } from './StatusBadge.js';

/**
 * The top line of the Ticket page: the number on the left, and at the right the status and the priority, each under
 * its name. Rendered in place of the number (a show component), because AdminJS stacks every property in its own block.
 */
const TicketHeader = ({ record, property, resource }: ShowPropertyProps) => {
  const status = record.populated?.status;
  const priority = record.params?.priority as string | undefined;
  // The labels go through the same translation as the other fields, so they read "Status", not "status".
  const { translateProperty } = useTranslation();
  const label = (path: string, fallback: string) => translateProperty(resource?.properties?.[path]?.label ?? fallback, resource?.id);
  return (
    <Box flex flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="flex-start" style={{ gap: '1rem 4rem' }}>
      <ValueGroup label={translateProperty(property.label, resource?.id)}>{String(record.params?.[property.path] ?? '—')}</ValueGroup>
      <Box flex flexDirection="row" flexWrap="wrap" style={{ gap: '1rem 4rem', paddingRight: '2rem' }}>
        <ValueGroup label={label('status', 'Status')}>
          {status ? <StatusPill code={String(status.params?.code ?? '')} label={status.title ?? String(status.id)} /> : <span>—</span>}
        </ValueGroup>
        <ValueGroup label={label('priority', 'Priority')}>{priority ? <PriorityPill value={priority} /> : <span>—</span>}</ValueGroup>
      </Box>
    </Box>
  );
};

export default TicketHeader;
