import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Label, Loader, MessageBox, Text, TextArea } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';
import type { CommentsPage } from '../../domain/comments/comment-queries.js';
import { checkFile, deleteAttachment, downloadHref, formatBytes, postRecordAction, recordData, toServerError, uploadAttachment } from './api.js';

const MAX_LENGTH = 5000;
const MAX_ATTACHMENTS = 5;

/**
 * Comments inside the ticket page: a page of the thread, an "add" box and in-place editing, all without
 * leaving the ticket. Bodies are rendered as text nodes (React escapes them), never as HTML. The buttons
 * are type="button" because on the edit page this component sits inside the ticket's own form.
 */
const CommentsInline = ({ record }: BasePropertyProps) => {
  const ticketId = record?.id ?? '';
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CommentsPage | null>(null);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (pageNo: number) => {
      try {
        setData(await recordData<CommentsPage>('Ticket', ticketId, 'listComments', { page: pageNo }));
        setPage(pageNo);
      } catch (e) {
        setError(toServerError(e).message);
      }
    },
    [ticketId],
  );

  useEffect(() => {
    if (ticketId) void load(1);
  }, [ticketId, load]);

  if (!ticketId) {
    return (
      <Box mb="xl">
        <Label>Comments</Label>
        <Text>Comments are available after the ticket has been created.</Text>
      </Box>
    );
  }
  if (!data) return error ? <MessageBox variant="danger" message={error} /> : <Loader />;

  const pages = Math.max(1, Math.ceil(data.total / data.perPage));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      const message = toServerError(e).message;
      setError(message);
      // A stale version or a ticket that was just closed: show the current state next to the message.
      await load(page);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      await postRecordAction('Ticket', ticketId, 'addComment', { body: draft });
      setDraft('');
      // The new comment is the last one: jump to the page that holds it.
      const fresh = await recordData<CommentsPage>('Ticket', ticketId, 'listComments', { page: 1 });
      await load(Math.max(1, Math.ceil(fresh.total / fresh.perPage)));
    });

  /** Uploads and deletions report their own errors in the same place as comment errors. */
  const attach = (commentId: string, file: File | undefined) => {
    if (!file) return Promise.resolve();
    const problem = checkFile(file);
    if (problem) {
      setError(problem);
      return Promise.resolve();
    }
    return run(async () => {
      try {
        await uploadAttachment(commentId, file);
      } catch (e) {
        throw { response: { data: { message: e instanceof Error ? e.message : undefined } } };
      }
      await load(page);
    });
  };

  const detach = (attachmentId: string) =>
    run(async () => {
      try {
        await deleteAttachment(attachmentId);
      } catch (e) {
        throw { response: { data: { message: e instanceof Error ? e.message : undefined } } };
      }
      await load(page);
    });

  const save = (id: string, version: number) =>
    run(async () => {
      await postRecordAction('Ticket', ticketId, 'editComment', { commentId: id, version, body: editDraft });
      setEditingId(null);
      await load(page);
    });

  return (
    <Box mb="xl">
      <Label>Comments ({data.total})</Label>
      {error && <MessageBox variant="danger" message={error} mb="default" />}
      {!data.canAdd && (
        <MessageBox variant="info" message={`This ticket is ${data.statusName}. Reopen it to add or edit comments.`} mb="default" />
      )}

      {data.items.length === 0 && <Text>No comments yet.</Text>}
      {data.items.map((c) => (
        <Box key={c.id} variant="white" p="default" mb="default">
          <Box flex alignItems="center" justifyContent="space-between">
            <Text fontWeight="bold">
              {c.authorName}{' '}
              <Text as="span" variant="sm">
                {new Date(c.createdAt).toLocaleString()}
              </Text>{' '}
              {c.edited && <Badge size="sm">edited</Badge>}
            </Text>
            {c.canEdit && editingId !== c.id && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditingId(c.id);
                  setEditDraft(c.body);
                  setError(null);
                }}
              >
                Edit
              </Button>
            )}
          </Box>
          {editingId === c.id ? (
            <Box mt="default">
              <TextArea width="100%" rows={4} maxLength={MAX_LENGTH} value={editDraft} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditDraft(e.target.value)} />
              <Box mt="sm">
                <Button type="button" variant="primary" size="sm" disabled={busy || editDraft.trim() === '' || editDraft.trim() === c.body} onClick={() => void save(c.id, c.version)}>
                  Save
                </Button>
                <Button type="button" size="sm" ml="default" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </Box>
            </Box>
          ) : (
            // A text node: React escapes it, so markup in a comment is shown, never executed.
            <Box mt="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {c.body}
            </Box>
          )}

          {(c.attachments.length > 0 || c.canAttach) && (
            <Box mt="default">
              {c.attachments.map((a) => (
                <Box key={a.id} flex alignItems="center" mb="sm">
                  {/* Goes through our authorization, then to a 60-second storage URL that downloads the file. */}
                  <a href={downloadHref(a.id)} rel="noreferrer">
                    {a.name}
                  </a>
                  <Text as="span" variant="sm" ml="default">
                    {formatBytes(a.size)}
                  </Text>
                  {c.canDeleteAttachments && (
                    <Button type="button" size="sm" ml="default" disabled={busy} onClick={() => void detach(a.id)}>
                      Remove
                    </Button>
                  )}
                </Box>
              ))}
              {c.canAttach && (
                <Box>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.pdf,.txt"
                    disabled={busy}
                    aria-label={`Attach a file to the comment by ${c.authorName}`}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      void attach(c.id, e.target.files?.[0]);
                      e.target.value = ''; // allows choosing the same file again
                    }}
                  />
                  <Text as="span" variant="sm" ml="default">
                    {c.attachments.length} / {MAX_ATTACHMENTS} files, up to 10 MB each (PNG, JPEG, PDF, TXT)
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      ))}

      {pages > 1 && (
        <Box mb="default">
          <Button type="button" size="sm" disabled={busy || page <= 1} onClick={() => void load(page - 1)}>
            Earlier
          </Button>
          <Text as="span" mx="default">
            Page {data.page} of {pages}
          </Text>
          <Button type="button" size="sm" disabled={busy || page >= pages} onClick={() => void load(page + 1)}>
            Later
          </Button>
        </Box>
      )}

      {data.canAdd && (
        <Box mt="lg">
          <TextArea width="100%" rows={3} maxLength={MAX_LENGTH} placeholder="Add a comment…" value={draft} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)} />
          <Box mt="sm">
            <Button type="button" variant="primary" disabled={busy || draft.trim() === ''} onClick={() => void add()}>
              Add comment
            </Button>
            <Text as="span" variant="sm" ml="default">
              {draft.length} / {MAX_LENGTH}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default CommentsInline;
