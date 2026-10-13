/** Shown in the page footer; a click opens the visitor's mail program with a new message to this address. */
export const AUTHOR_NAME = 'Vasily Kamenev';
export const AUTHOR_EMAIL = 'vasily.kamenev@gmail.com';
export const COPYRIGHT_FIRST_YEAR = 2026;

/** "2026" while it is 2026, "2026–2028" later. */
export function copyrightYears(now: Date = new Date()): string {
  const year = now.getFullYear();
  return year > COPYRIGHT_FIRST_YEAR ? `${COPYRIGHT_FIRST_YEAR}–${year}` : String(COPYRIGHT_FIRST_YEAR);
}
