import React, { useState } from 'react';
import { Box, Button, FormGroup, H3, Label, MessageBox, Select, Text } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import { adminRoot, postRecordAction, toServerError, type ServerError } from './api.js';

type Option = { value: string; label: string };
const ROLES: Option[] = [
  { value: 'AGENT', label: 'Agent: works tickets of their groups' },
  { value: 'ADMIN', label: 'Administrator: manages staff, groups and all tickets' },
];

const ChangeRoleForm = ({ record }: ActionProps) => {
  const userId = record?.id ?? '';
  const current = String(record?.params?.role ?? '');
  const name = String(record?.params?.displayName ?? 'this user');
  const [role, setRole] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const back = `${adminRoot()}/resources/User/records/${userId}/show`;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postRecordAction('User', userId, 'changeRole', { role });
      window.location.assign(back);
    } catch (e) {
      setError(toServerError(e));
      setSaving(false);
    }
  };

  return (
    <Box as="form" variant="white" onSubmit={submit}>
      <H3>Change the role of {name}</H3>
      <FormGroup>
        <Label required>Role</Label>
        <Select value={ROLES.find((o) => o.value === role)} options={ROLES} onChange={(o: Option) => setRole(o.value)} />
        <Text variant="sm">The person is signed out everywhere and has to sign in again. You cannot change your own role.</Text>
      </FormGroup>

      {error && <MessageBox variant="danger" message={error.message} />}

      <Box mt="xl">
        <Button variant="primary" type="submit" disabled={saving || role === current}>
          {saving ? 'Saving…' : 'Change role'}
        </Button>
        <Button as="a" href={back} ml="default">
          Cancel
        </Button>
      </Box>
    </Box>
  );
};

export default ChangeRoleForm;
