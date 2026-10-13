/** Design tokens of the interface: one place for type sizes, spacing and the colors of statuses and priorities. */

/** Text sizes in px. Field labels are never smaller than `label`. */
export const TYPE = { label: 12, body: 14, small: 12, h3: 16, h2: 20, h1: 24 } as const;

/** Spacing in px. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export interface Tone {
  /** Text and border color. */
  color: string;
  /** Fill. Text on it keeps WCAG AA contrast (4.5:1). */
  background: string;
}

const GREY: Tone = { color: '#475569', background: '#F1F5F9' };

/** Workflow statuses, the same in lists, ticket page, dashboard and history. */
export const STATUS_TONES: Record<string, Tone> = {
  NEW: { color: '#1D4ED8', background: '#DBEAFE' },
  IN_PROGRESS: { color: '#4338CA', background: '#E0E7FF' },
  WAITING_CUSTOMER: { color: '#854D0E', background: '#FEF9C3' },
  RESOLVED: { color: '#166534', background: '#DCFCE7' },
  UNRESOLVED: { color: '#B91C1C', background: '#FEE2E2' },
  CLOSED: GREY,
};

/** Solid fills for bars and charts, the same color families as the status pills (blue, indigo, yellow, green, red, grey). */
export const STATUS_BAR: Record<string, string> = {
  NEW: '#3B82F6',
  IN_PROGRESS: '#6366F1',
  WAITING_CUSTOMER: '#EAB308',
  RESOLVED: '#22C55E',
  UNRESOLVED: '#EF4444',
  CLOSED: '#94A3B8',
};

export const PRIORITY_TONES: Record<string, Tone> = {
  LOW: GREY,
  NORMAL: { color: '#1D4ED8', background: '#DBEAFE' },
  HIGH: { color: '#9A3412', background: '#FFEDD5' },
  URGENT: { color: '#B91C1C', background: '#FEE2E2' },
};

export const ACTIVE_TONE: Tone = { color: '#166534', background: '#DCFCE7' };
export const NEUTRAL_TONE = GREY;
