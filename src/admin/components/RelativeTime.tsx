import React from 'react';
import type { ShowPropertyProps } from 'adminjs';
import { formatDateTime, formatRelative } from '../format.js';

/** "2 days ago" with the full date and time in the tooltip. */
export const RelativeTime = ({ value }: { value: string | Date | null | undefined }) => {
  if (!value) return <span>—</span>;
  return <time dateTime={new Date(value).toISOString()} title={formatDateTime(value)}>{formatRelative(value)}</time>;
};

/** The same, as a list/show cell of a date property. */
const RelativeTimeCell = ({ record, property }: ShowPropertyProps) => <RelativeTime value={record.params?.[property.path] as string | undefined} />;

export default RelativeTimeCell;
