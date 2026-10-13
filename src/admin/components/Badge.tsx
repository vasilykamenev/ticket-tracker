import React from 'react';
import { TYPE } from '../tokens.js';

/** A small colored pill used for statuses, priorities and flags, so they read the same in lists and details. */
export function Pill({ label, color, background }: { label: string; color: string; background?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: TYPE.small,
        fontWeight: 600,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        color,
        background: background ?? `${color}1f`,
        border: `1px solid ${color}55`,
      }}
    >
      {label}
    </span>
  );
}
