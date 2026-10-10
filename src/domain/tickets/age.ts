/**
 * Age of a ticket, computed (never stored): from creation until the ticket stopped being worked
 * on (closed, resolved or unresolved), or until now while it is still active.
 */
export function ticketAgeMs(
  t: { createdAt: Date; closedAt?: Date | null; resolvedAt?: Date | null; unresolvedAt?: Date | null },
  now: Date,
): number {
  const end = t.closedAt ?? t.resolvedAt ?? t.unresolvedAt ?? now;
  return Math.max(0, end.getTime() - t.createdAt.getTime());
}

/** "3d 4h", "5h 12m", "7m", "<1m". Two most significant units. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}
