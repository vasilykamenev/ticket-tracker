import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Box, Button, DropDown, DropDownItem, DropDownMenu, DropDownTrigger, Icon, Loader, MessageBox, Text, TextArea } from '@adminjs/design-system';
import type { CommentItem } from '../../domain/comments/comment-queries.js';
import type { FormState, HistoryItem } from '../../domain/tickets/ticket-queries.js';
import { REASON_MAX, RESOLUTION_MIN } from '../../domain/tickets/workflow.js';
import { ALLOWED_EXTENSIONS, FILE_LIMIT_LABEL, MAX_ATTACHMENTS_PER_COMMENT } from '../../storage/limits.js';
import { formatDateTime, formatRelative, initials } from '../format.js';
import { SPACE, TYPE } from '../tokens.js';
import { checkFile, deleteAttachment, downloadHref, formatBytes, postRecordAction, postRecordActionForData, recordData, toServerError, uploadAttachment } from './api.js';

const MAX_LENGTH = 5000;
const PAGE = 15;

type Entry = { type: 'comment'; at: string; comment: CommentItem } | { type: 'event'; at: string; event: HistoryItem };

interface TimelineData {
  entries: Entry[];
  canAdd: boolean;
  statusName: string;
}

const KIND_LABELS: Record<string, string> = { CREATED: 'Created', UPDATED: 'Edited', ASSIGNED: 'Assigned', STATUS_CHANGED: 'Status changed' };

const GREY = '#475569';

/** "Status changed: New → In progress" in a single line. */
function eventText(event: HistoryItem): string {
  const label = KIND_LABELS[event.kind] ?? event.kind;
  if (event.kind === 'CREATED') return `${label} by ${event.actor}`;
  const changes = event.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ');
  return `${label}${changes ? ` (${changes})` : ''} by ${event.actor}`;
}

const Avatar = ({ name }: { name: string }) => (
  <span
    aria-hidden
    style={{ flex: '0 0 auto', width: 32, height: 32, borderRadius: '50%', background: '#E0E7FF', color: '#3730A3', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE.small, fontWeight: 700 }}
  >
    {initials(name)}
  </span>
);

const When = ({ at }: { at: string }) => (
  <time dateTime={at} title={formatDateTime(at)} style={{ fontSize: TYPE.small, color: GREY }}>
    {formatRelative(at)}
  </time>
);

/** Statuses a reply can set in one step, with the text of the reply standing in for the reason or the outcome. */
function replyTargets(state: FormState | null, body: string) {
  if (!state) return [];
  const text = body.trim();
  return state.targets.filter((t) => {
    if (t.assignee !== 'none' && !state.ticket.assigneeId) return false;
    if (t.assignee === 'activeMember') return false; // reopening needs an explicit assignee: use the header menu
    if ((t.resolution || t.unresolvedReason) && text.length < RESOLUTION_MIN) return false;
    return true;
  });
}

interface FeedProps {
  ticketId: string;
  /** Bumped by the page after any change, so the feed reloads. */
  reloadKey: number;
  state: FormState | null;
  /** The page re-reads the ticket (version, status) after the reply changed it. */
  onTicketChanged: () => void;
}

/**
 * One chronological feed of comments and history events, with the reply editor pinned under it. Bodies are rendered
 * as text nodes (React escapes them), never as HTML. Internal notes need a flag on the comment that the data model
 * does not have, so every comment here is visible to the whole team.
 */
const ActivityFeed = ({ ticketId, reloadKey, state, onTicketChanged }: FeedProps) => {
  const [data, setData] = useState<TimelineData | null>(null);
  const [visible, setVisible] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await recordData<TimelineData>('Ticket', ticketId, 'timeline'));
    } catch (e) {
      setError(toServerError(e).message);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (!data) return error ? <MessageBox variant="danger" message={error} /> : <Loader />;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error && !('response' in e) ? e.message : toServerError(e).message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const next = [...files];
    for (const file of Array.from(picked)) {
      const problem = checkFile(file);
      if (problem) {
        setError(`${file.name}: ${problem}`);
        continue;
      }
      if (next.length >= MAX_ATTACHMENTS_PER_COMMENT) {
        setError(`At most ${MAX_ATTACHMENTS_PER_COMMENT} files per reply.`);
        break;
      }
      next.push(file);
    }
    setFiles(next);
  };

  /** Posts the reply, uploads its files, and optionally moves the ticket to a status in the same step. */
  const send = (target?: FormState['targets'][number]) =>
    run(async () => {
      const text = draft.trim();
      const result = await postReply(ticketId, text);
      for (const file of files) await uploadAttachment(result, file);
      if (target && state) {
        const change: Record<string, unknown> = { version: state.ticket.version, targetStatus: target.code };
        if (target.reason === 'required') change.reason = text.slice(0, REASON_MAX);
        else if (text) change.reason = text.slice(0, REASON_MAX);
        if (target.resolution) change.resolution = text;
        if (target.unresolvedReason) change.unresolvedReason = text;
        try {
          await postRecordAction('Ticket', ticketId, 'changeStatus', change);
        } catch (e) {
          setDraft('');
          setFiles([]);
          await load();
          throw new Error(`The reply was posted, but the status was not changed: ${toServerError(e).message}`);
        }
        onTicketChanged();
      }
      setDraft('');
      setFiles([]);
      await load();
    });

  const saveEdit = (id: string, version: number) =>
    run(async () => {
      await postRecordAction('Ticket', ticketId, 'editComment', { commentId: id, version, body: editDraft });
      setEditingId(null);
      await load();
    });

  const detach = (attachmentId: string) =>
    run(async () => {
      await deleteAttachment(attachmentId);
      await load();
    });

  const shown = data.entries.slice(Math.max(0, data.entries.length - visible));
  const hidden = data.entries.length - shown.length;
  const targets = replyTargets(state, draft);

  return (
    <Box>
      {error && <MessageBox variant="danger" message={error} mb="default" />}

      {hidden > 0 && (
        <Box mb="default">
          <Button type="button" size="sm" onClick={() => setVisible(visible + PAGE)}>
            Show earlier ({hidden})
          </Button>
        </Box>
      )}

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: SPACE.md }}>
        {shown.map((entry) =>
          entry.type === 'event' ? (
            <li key={`e-${entry.event.id}`} style={{ fontSize: TYPE.small, color: GREY, background: '#F8FAFC', borderRadius: 4, padding: '4px 10px' }}>
              {eventText(entry.event)} · <When at={entry.at} />
              {entry.event.reason ? <span> · “{entry.event.reason}”</span> : null}
            </li>
          ) : (
            <li key={`c-${entry.comment.id}`} style={{ display: 'flex', gap: SPACE.md }}>
              <Avatar name={entry.comment.authorName} />
              <div style={{ flex: 1, minWidth: 0, background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, padding: `${SPACE.sm}px ${SPACE.md}px` }}>
                <Box flex alignItems="center" justifyContent="space-between">
                  <Text fontWeight="bold">
                    {entry.comment.authorName} <When at={entry.at} /> {entry.comment.edited && <Badge size="sm">edited</Badge>}
                  </Text>
                  {entry.comment.canEdit && editingId !== entry.comment.id && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(entry.comment.id);
                        setEditDraft(entry.comment.body);
                        setError(null);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </Box>
                {editingId === entry.comment.id ? (
                  <Box mt="default">
                    <TextArea width="100%" rows={4} maxLength={MAX_LENGTH} value={editDraft} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditDraft(e.target.value)} />
                    <Box mt="sm">
                      <Button type="button" variant="primary" size="sm" disabled={busy || editDraft.trim() === '' || editDraft.trim() === entry.comment.body} onClick={() => void saveEdit(entry.comment.id, entry.comment.version)}>
                        Save
                      </Button>
                      <Button type="button" size="sm" ml="default" disabled={busy} onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </Box>
                  </Box>
                ) : (
                  <Box mt="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {entry.comment.body}
                  </Box>
                )}
                {entry.comment.attachments.length > 0 && (
                  <Box mt="default">
                    {entry.comment.attachments.map((a) => (
                      <Box key={a.id} flex alignItems="center" mb="sm" style={{ gap: SPACE.sm }}>
                        <Icon icon="Paperclip" size={14} />
                        {/* Goes through our authorization, then to a 60-second storage URL that downloads the file. */}
                        <a href={downloadHref(a.id)} rel="noreferrer">
                          {a.name}
                        </a>
                        <span style={{ fontSize: TYPE.small, color: GREY }}>{formatBytes(a.size)}</span>
                        {entry.comment.canDeleteAttachments && (
                          <Button type="button" size="sm" disabled={busy} onClick={() => void detach(a.id)}>
                            Remove
                          </Button>
                        )}
                      </Box>
                    ))}
                  </Box>
                )}
              </div>
            </li>
          ),
        )}
      </ol>
      {data.entries.length === 0 && <Text>No activity yet.</Text>}

      <Box mt="xl">
        {!data.canAdd ? (
          <MessageBox variant="info" message={`This ticket is ${data.statusName}. Reopen it to add or edit comments.`} />
        ) : (
          <Box
            as="form"
            variant="white"
            p="default"
            aria-label="Reply to the customer"
            onSubmit={(event: React.FormEvent) => {
              event.preventDefault();
              if (!busy && draft.trim() !== '') void send();
            }}
          >
            <TextArea width="100%" rows={4} maxLength={MAX_LENGTH} placeholder="Write a reply…" value={draft} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)} />
            {files.length > 0 && (
              <Box mt="sm">
                {files.map((file, at) => (
                  <Box key={`${file.name}-${at}`} flex alignItems="center" mb="sm" style={{ gap: SPACE.sm }}>
                    <Icon icon="Paperclip" size={14} />
                    <span>{file.name}</span>
                    <span style={{ fontSize: TYPE.small, color: GREY }}>{formatBytes(file.size)}</span>
                    <Button type="button" size="sm" disabled={busy} onClick={() => setFiles(files.filter((_, i) => i !== at))}>
                      Remove
                    </Button>
                  </Box>
                ))}
              </Box>
            )}
            <Box flex alignItems="center" mt="sm" style={{ gap: SPACE.sm, flexWrap: 'wrap' }}>
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
                aria-label="Attach files to the reply"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button type="button" size="sm" disabled={busy || files.length >= MAX_ATTACHMENTS_PER_COMMENT} onClick={() => fileInput.current?.click()}>
                <Icon icon="Paperclip" />
                Attach
              </Button>
              <span style={{ fontSize: TYPE.small, color: GREY }}>
                {files.length} / {MAX_ATTACHMENTS_PER_COMMENT} files, up to {FILE_LIMIT_LABEL} each (PNG, JPEG, PDF, TXT)
              </span>
              <span style={{ marginLeft: 'auto', fontSize: TYPE.small, color: GREY }}>
                {draft.length} / {MAX_LENGTH}
              </span>
              <Button type="submit" variant="primary" disabled={busy || draft.trim() === ''}>
                {busy ? 'Sending…' : 'Send'}
              </Button>
              {targets.length > 0 && (
                <DropDown>
                  <DropDownTrigger>
                    <Button type="button" disabled={busy || draft.trim() === ''}>
                      Send and set status
                      <Icon icon="ChevronDown" />
                    </Button>
                  </DropDownTrigger>
                  <DropDownMenu>
                    {targets.map((t) => (
                      <DropDownItem key={t.code} onClick={() => void send(t)}>
                        Send and set {t.name}
                      </DropDownItem>
                    ))}
                  </DropDownMenu>
                </DropDown>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/** Posts the comment and returns its id, which the files are attached to. */
async function postReply(ticketId: string, body: string): Promise<string> {
  const response = await postRecordActionForData<{ commentId?: string }>('Ticket', ticketId, 'addComment', { body });
  if (!response.commentId) throw new Error('The reply was not saved.');
  return response.commentId;
}

export default ActivityFeed;
