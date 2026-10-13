import React, { useEffect, useState } from 'react';
import { Box, Button, Icon, Label, Loader, MessageBox, Table, TableBody, TableCell, TableHead, TableRow, Text } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';
import { PriorityPill } from './PriorityBadge.js';
import { StatusPill } from './StatusBadge.js';
import { recordData, ticketUrl, toServerError } from './api.js';
import { RelativeTime } from './RelativeTime.js';

interface CustomerTicketsPage {
  items: Array<{ id: string; number: number; subject: string; priority: string; status: string; statusCode: string; group: string; updatedAt: string }>;
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS = [
  { key: 'number', label: '#' },
  { key: 'subject', label: 'Subject' },
  { key: 'group', label: 'Group' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'updatedAt', label: 'Updated' },
] as const;

/** A customer's tickets, limited on the server to the signed-in user's groups. */
const CustomerTickets = ({ record }: BasePropertyProps) => {
  const customerId = record?.id ?? '';
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ by: string; direction: 'asc' | 'desc' }>({ by: 'updatedAt', direction: 'desc' });
  const [data, setData] = useState<CustomerTicketsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) return;
    recordData<CustomerTicketsPage>('Customer', customerId, 'customerTickets', { page, sortBy: sort.by, direction: sort.direction })
      .then(setData)
      .catch((e) => setError(toServerError(e).message));
  }, [customerId, page, sort]);

  if (error) return <MessageBox variant="danger" message={error} />;
  if (!data) return <Loader />;
  if (data.total === 0) {
    return (
      <Box mb="xl">
        <Label>Tickets</Label>
        <Text>No tickets from your groups.</Text>
      </Box>
    );
  }

  const pages = Math.max(1, Math.ceil(data.total / data.perPage));
  return (
    <Box mb="xl">
      <Label>Tickets ({data.total})</Label>
      <Table>
        <TableHead>
          <TableRow>
            {COLUMNS.map((col) => (
              <TableCell key={col.key} aria-sort={sort.by === col.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                <button
                  type="button"
                  onClick={() => {
                    setPage(1);
                    setSort((s) => ({ by: col.key, direction: s.by === col.key && s.direction === 'asc' ? 'desc' : 'asc' }));
                  }}
                  style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  {col.label}
                  {sort.by === col.key && <Icon icon={sort.direction === 'asc' ? 'ChevronUp' : 'ChevronDown'} size={14} />}
                </button>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {data.items.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.number}</TableCell>
              <TableCell>
                <a href={ticketUrl(t.id)}>{t.subject}</a>
              </TableCell>
              <TableCell>{t.group}</TableCell>
              <TableCell>
                <StatusPill code={t.statusCode} label={t.status} />
              </TableCell>
              <TableCell>
                <PriorityPill value={t.priority} />
              </TableCell>
              <TableCell><RelativeTime value={t.updatedAt} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pages > 1 && (
        <Box mt="default">
          <Button type="button" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Text as="span" mx="default">
            Page {data.page} of {pages}
          </Text>
          <Button type="button" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default CustomerTickets;
