/** Single place where emails are normalized before lookup or persistence. */
export function normalizeEmail(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
