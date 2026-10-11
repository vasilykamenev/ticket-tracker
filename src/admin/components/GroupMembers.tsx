import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Label, Loader, MessageBox, Select, Table, TableBody, TableCell, TableHead, TableRow, Text } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';
import type { GroupMembersView } from '../../domain/groups/group-queries.js';
import { postRecordAction, recordData, toServerError } from './api.js';

type Option = { value: string; label: string };

/** Members of a group, shown on the group page. ADMIN can add and remove; an AGENT only reads. */
const GroupMembers = ({ record }: BasePropertyProps) => {
  const groupId = record?.id ?? '';
  const [view, setView] = useState<GroupMembersView | null>(null);
  const [candidate, setCandidate] = useState<Option | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!groupId) return Promise.resolve();
    return recordData<GroupMembersView>('SupportGroup', groupId, 'members')
      .then((v) => {
        setView(v);
        setCandidate(null);
      })
      .catch((e) => setError(toServerError(e).message));
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (action: 'addMember' | 'removeMember', agentId: string) => {
    setBusy(true);
    setError(null);
    try {
      await postRecordAction('SupportGroup', groupId, action, { agentId });
      await load();
    } catch (e) {
      setError(toServerError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return error ? <MessageBox variant="danger" message={error} /> : <Loader />;

  const options: Option[] = view.candidates.map((c) => ({ value: c.id, label: c.name }));
  return (
    <Box mb="xl">
      <Label>Members ({view.members.length})</Label>
      {error && <MessageBox variant="danger" message={error} mb="default" />}
      {view.members.length === 0 ? (
        <Text>No members yet.</Text>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              {view.canEdit && <TableCell />}
            </TableRow>
          </TableHead>
          <TableBody>
            {view.members.map((m) => (
              <TableRow key={m.agentId}>
                <TableCell>{m.name}</TableCell>
                <TableCell>{m.isActive ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}</TableCell>
                {view.canEdit && (
                  <TableCell>
                    <Button type="button" size="sm" disabled={busy} onClick={() => void change('removeMember', m.agentId)}>
                      Remove
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.canEdit && view.groupActive && (
        <Box flex mt="lg" alignItems="center">
          <Box flexGrow={1} mr="default">
            <Select value={candidate} options={options} placeholder="Add an agent…" onChange={(o: Option) => setCandidate(o)} />
          </Box>
          <Button type="button" variant="primary" disabled={busy || !candidate} onClick={() => candidate && void change('addMember', candidate.value)}>
            Add
          </Button>
        </Box>
      )}
      {view.canEdit && !view.groupActive && <Text variant="sm">The group is inactive, so members cannot be added.</Text>}
    </Box>
  );
};

export default GroupMembers;
