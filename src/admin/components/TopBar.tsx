import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@adminjs/design-system';
import { ApiClient, OriginalTopBar, useCurrentAdmin } from 'adminjs';
import type { Dashboard } from '../../domain/tickets/ticket-queries.js';
import { SPACE, TYPE } from '../tokens.js';
import { adminRoot } from './api.js';

const api = new ApiClient();

/**
 * The top bar of AdminJS with three additions in front of it: a ticket search (a number opens that ticket's list
 * entry, text looks in the subjects; press / or Ctrl+K from anywhere), a "+ New ticket" button, and a bell with the
 * number of open tickets assigned to the signed-in agent.
 */
const TopBar = (props: React.ComponentProps<typeof OriginalTopBar>) => {
  const [currentAdmin] = useCurrentAdmin();
  const agentId = (currentAdmin as { agentId?: string | null } | undefined)?.agentId ?? null;
  const input = useRef<HTMLInputElement | null>(null);
  // Shows what the list is currently searched for.
  const [text, setText] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get('filters.number') ?? q.get('filters.subject') ?? '';
  });
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!agentId) return;
    api
      .getDashboard<Dashboard>()
      .then((r) => setOpen(r.data.mineOpen))
      .catch(() => setOpen(null));
  }, [agentId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((event.key === 'k' && (event.ctrlKey || event.metaKey)) || (event.key === '/' && !typing)) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = `${adminRoot()}/resources/Ticket`;

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    const query = new URLSearchParams();
    if (/^#?\d+$/.test(value)) query.set('filters.number', value.replace('#', ''));
    else query.set('filters.subject', value);
    window.location.assign(`${adminRoot()}/resources/Ticket?${query.toString()}`);
  };

  const control = { fontSize: TYPE.body, padding: '6px 12px', borderRadius: 4, border: '1px solid #CBD5E1', background: '#FFFFFF', color: '#1E293B' } as const;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm, flexShrink: 0, borderBottom: '1px solid #E2E8F0', paddingLeft: SPACE.lg }}>
      <form onSubmit={search} role="search" style={{ display: 'flex', alignItems: 'center' }}>
        <input
          ref={input}
          type="search"
          value={text}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
          placeholder="Search tickets  ( / )"
          aria-label="Search tickets by number or subject. Shortcut: slash or Control K"
          style={{ ...control, width: 240 }}
        />
      </form>
      <a href={`${list}/actions/new`} style={{ ...control, background: '#3040d6', color: '#FFFFFF', borderColor: '#3040d6', fontWeight: 600, textDecoration: 'none' }}>
        + New ticket
      </a>
      {agentId && (
        <a
          href={`${list}?filters.assignedAgent=${encodeURIComponent(agentId)}&filters.status=__open__`}
          title="Open tickets assigned to you"
          aria-label={`Open tickets assigned to you: ${open ?? 'unknown'}`}
          style={{ ...control, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
        >
          <Icon icon="Bell" size={16} />
          {open ?? '–'}
        </a>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <OriginalTopBar {...props} />
      </div>
    </div>
  );
};

export default TopBar;
