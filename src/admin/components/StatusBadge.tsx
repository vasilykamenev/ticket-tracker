import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { NEUTRAL_TONE, STATUS_TONES } from '../tokens.js';
import { Pill } from './Badge.js';


export const StatusPill = ({ code, label }: { code: string; label: string }) => <Pill label={label} {...(STATUS_TONES[code] ?? NEUTRAL_TONE)} />;

const StatusBadge = ({ record, property }: ShowPropertyProps) => {
  const status = record.populated?.[property.path];
  if (!status) return <span>—</span>;
  return <StatusPill code={String(status.params?.code ?? '')} label={status.title ?? String(status.id)} />;
};

export default StatusBadge;
