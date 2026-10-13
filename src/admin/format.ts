/** One place for how dates are written in the interface: relative in lists and timelines, full in a tooltip. */

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const FULL = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const DAY = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

const UNITS: Array<[unit: Intl.RelativeTimeFormatUnit, seconds: number]> = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "2 days ago", "in 3 hours", "just now". */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (abs >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return RELATIVE.format(Math.round(seconds / 60), 'minute');
}

/** "13 Oct 2026, 12:48". */
export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : FULL.format(date);
}

/** "13 Oct 2026". */
export function formatDay(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : DAY.format(date);
}

/** Two letters for an avatar: "Anna Petrova" -> "AP". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '')).toUpperCase();
}
