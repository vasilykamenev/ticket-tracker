import React, { useEffect, useState } from 'react';
import { Box, Button, Label, Loader, MessageBox, Table, TableBody, TableCell, TableHead, TableRow, Text } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';
import { recordData, ticketUrl, toServerError } from './api.js';

interface CustomerTicketsPage {
  items: Array<{ id: string; number: number; subject: string; priority: string; status: string; group: string; updatedAt: string }>;
  total: number;
  page: number;
  perPage: number;
}

/** A customer's tickets, limited on the server to the signed-in user's groups. */
const CustomerTickets = ({ record }: BasePropertyProps) => {
  const customerId = record?.id ?? '';
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CustomerTicketsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) return;
    recordData<CustomerTicketsPage>('Customer', customerId, 'customerTickets', { page })
      .then(setData)
      .catch((e) => setError(toServerError(e).message));
  }, [customerId, page]);

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
            <TableCell>#</TableCell>
            <TableCell>Subject</TableCell>
            <TableCell>Group</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Priority</TableCell>
            <TableCell>Updated</TableCell>
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
              <TableCell>{t.status}</TableCell>
              <TableCell>{t.priority}</TableCell>
              <TableCell>{new Date(t.updatedAt).toLocaleString()}</TableCell>
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
