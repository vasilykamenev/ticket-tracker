import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { NEUTRAL_TONE, PRIORITY_TONES } from '../tokens.js';
import { Pill } from './Badge.js';


export const PriorityPill = ({ value }: { value: string }) => <Pill label={value} {...(PRIORITY_TONES[value] ?? NEUTRAL_TONE)} />;

const PriorityBadge = ({ record, property }: ShowPropertyProps) => {
  const value = record.params?.[property.path];
  if (!value) return <span>—</span>;
  return <PriorityPill value={String(value)} />;
};

export default PriorityBadge;
