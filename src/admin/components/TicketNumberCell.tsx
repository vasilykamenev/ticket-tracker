import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { NEUTRAL_TONE, PRIORITY_TONES } from '../tokens.js';

/**
 * The ticket number in the list, with a small marker of the priority in front of it. The color is never the only
 * signal: the marker carries the priority as its title and the Priority column spells it out.
 */
const TicketNumberCell = ({ record, property }: ShowPropertyProps) => {
  const priority = String(record.params?.priority ?? '');
  const tone = PRIORITY_TONES[priority] ?? NEUTRAL_TONE;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
      <span role="img" aria-label={`${priority || 'No'} priority`} title={priority} style={{ width: 4, height: 20, borderRadius: 2, background: tone.color }} />
      {String(record.params?.[property.path] ?? '')}
    </span>
  );
};

export default TicketNumberCell;
