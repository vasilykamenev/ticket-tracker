import React, { useState } from 'react';
import { Box, Button, FormGroup, H3, Input, Label, MessageBox, Text } from '@adminjs/design-system';
import type { ActionProps } from 'adminjs';
import { adminRoot, postRecordAction, toServerError, type ServerError } from './api.js';

const MIN_LENGTH = 12;

/** Sets a new password for a staff account and signs that person out everywhere. */
const SetPasswordForm = ({ record }: ActionProps) => {
  const userId = record?.id ?? '';
  const name = String(record?.params?.displayName ?? 'this user');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const back = `${adminRoot()}/resources/User/records/${userId}/show`;

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postRecordAction('User', userId, 'setPassword', { password });
      window.location.assign(back);
    } catch (e) {
      setError(toServerError(e));
      setSaving(false);
    }
  };

  return (
    <Box as="form" variant="white" onSubmit={submit} autoComplete="off">
      <H3>Set a new password for {name}</H3>
      <FormGroup>
        <Label required>New password</Label>
        <Input type="password" width="100%" autoComplete="new-password" value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
        <Text variant="sm">At least {MIN_LENGTH} characters. A long passphrase is better than a complicated one.</Text>
        {tooShort && <Text variant="sm">Too short: {password.length} of {MIN_LENGTH} characters.</Text>}
      </FormGroup>
      <FormGroup>
        <Label required>Repeat the password</Label>
        <Input type="password" width="100%" autoComplete="new-password" value={confirm} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)} />
        {mismatch && <Text variant="sm">The passwords do not match.</Text>}
      </FormGroup>
      <Text variant="sm">The person is signed out everywhere and must sign in with the new password.</Text>

      {error && <MessageBox variant="danger" message={error.message} />}

      <Box mt="xl">
        <Button variant="primary" type="submit" disabled={saving || password.length < MIN_LENGTH || password !== confirm}>
          {saving ? 'Saving…' : 'Set password'}
        </Button>
        <Button as="a" href={back} ml="default">
          Cancel
        </Button>
      </Box>
    </Box>
  );
};

export default SetPasswordForm;
