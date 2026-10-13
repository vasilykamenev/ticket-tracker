import React, { useEffect, useState } from 'react';
import { Box, Button, Label, Loader, MessageBox, Table, TableBody, TableCell, TableHead, TableRow, Text } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';
import type { HistoryItem, Page } from '../../domain/tickets/ticket-queries.js';
import { recordData, toServerError } from './api.js';
import { RelativeTime } from './RelativeTime.js';

const KIND_LABELS: Record<string, string> = {
  CREATED: 'Created',
  UPDATED: 'Edited',
  ASSIGNED: 'Assigned',
  STATUS_CHANGED: 'Status changed',
};

/** Read-only, newest first. Rendered as a virtual property on the Ticket show page. */
const TicketHistory = ({ record }: BasePropertyProps) => {
  const ticketId = record?.id ?? '';
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<HistoryItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticketId) return;
    recordData<Page<HistoryItem>>('Ticket', ticketId, 'history', { page })
      .then(setData)
      .catch((e) => setError(toServerError(e).message));
  }, [ticketId, page]);

  if (error) return <MessageBox variant="danger" message={error} />;
  if (!data) return <Loader />;

  const pages = Math.max(1, Math.ceil(data.total / data.perPage));
  return (
    <Box mb="xl">
      <Label>History</Label>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Who</TableCell>
            <TableCell>What</TableCell>
            <TableCell>Reason</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell><RelativeTime value={item.createdAt} /></TableCell>
              <TableCell>{item.actor}</TableCell>
              <TableCell>
                <Text fontWeight="bold">{KIND_LABELS[item.kind] ?? item.kind}</Text>
                {item.changes.map((c) => (
                  <Text key={c.field} variant="sm">
                    {c.field}: {c.from ?? '—'} → {c.to ?? '—'}
                  </Text>
                ))}
              </TableCell>
              <TableCell>{item.reason ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pages > 1 && (
        <Box mt="default">
          <Button type="button" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Newer
          </Button>
          <Text as="span" mx="default">
            Page {data.page} of {pages}
          </Text>
          <Button type="button" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Older
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default TicketHistory;
