import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { Pill } from './Badge.js';

/** Text / background of each workflow status. */
export const STATUS_COLORS: Record<string, { color: string; background: string }> = {
  NEW: { color: '#6D28D9', background: '#F3E8FF' },
  IN_PROGRESS: { color: '#1D4ED8', background: '#DBEAFE' },
  WAITING_CUSTOMER: { color: '#92400E', background: '#FEF3C7' },
  RESOLVED: { color: '#166534', background: '#DCFCE7' },
  UNRESOLVED: { color: '#B91C1C', background: '#FEE2E2' },
  CLOSED: { color: '#475569', background: '#F1F5F9' },
};

const FALLBACK = { color: '#475569', background: '#F1F5F9' };

export const StatusPill = ({ code, label }: { code: string; label: string }) => <Pill label={label} {...(STATUS_COLORS[code] ?? FALLBACK)} />;

const StatusBadge = ({ record, property }: ShowPropertyProps) => {
  const status = record.populated?.[property.path];
  if (!status) return <span>—</span>;
  return <StatusPill code={String(status.params?.code ?? '')} label={status.title ?? String(status.id)} />;
};

export default StatusBadge;
