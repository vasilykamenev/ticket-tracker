import React from 'react';
import { PRIORITY_TONES, NEUTRAL_TONE, TYPE } from '../tokens.js';

/** A colored dot with the priority written next to it, so the color is never the only signal. */
export const PriorityMarker = ({ value }: { value: string }) => {
  const tone = PRIORITY_TONES[value] ?? NEUTRAL_TONE;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TYPE.small, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: tone.color }} />
      {value}
    </span>
  );
};

export default PriorityMarker;
