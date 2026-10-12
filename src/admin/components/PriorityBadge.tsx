import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { Pill } from './Badge.js';

/** Text / background of each priority. */
const PRIORITY_COLORS: Record<string, { color: string; background: string }> = {
  LOW: { color: '#475569', background: '#F1F5F9' },
  NORMAL: { color: '#1D4ED8', background: '#DBEAFE' },
  HIGH: { color: '#9A3412', background: '#FFEDD5' },
  URGENT: { color: '#B91C1C', background: '#FEE2E2' },
};

const FALLBACK = { color: '#475569', background: '#F1F5F9' };

export const PriorityPill = ({ value }: { value: string }) => <Pill label={value} {...(PRIORITY_COLORS[value] ?? FALLBACK)} />;

const PriorityBadge = ({ record, property }: ShowPropertyProps) => {
  const value = record.params?.[property.path];
  if (!value) return <span>—</span>;
  return <PriorityPill value={String(value)} />;
};

export default PriorityBadge;
