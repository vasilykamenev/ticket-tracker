/**
 * The only way the application talks to file storage. Two implementations: `S3Storage` (Supabase Storage
 * through its S3-compatible API) and `MemoryStorage` (tests and local development). Files are never written
 * to the application server's disk. The bucket and object keys are chosen by the server, never by the browser.
 */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface PresignOptions {
  /** Name shown in the browser's save dialog; sent as Content-Disposition: attachment. */
  filename: string;
  contentType: string;
  expiresSeconds: number;
}

export interface ObjectStorage {
  readonly bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** A short-lived URL that downloads the object as an attachment. Never log it. */
  presignGet(key: string, options: PresignOptions): Promise<string>;
  list(prefix: string): AsyncIterable<StoredObject>;
}

/**
 * `Content-Disposition: attachment` with a safe filename. An ASCII fallback plus the RFC 5987 form for
 * everything else; quotes, backslashes and control characters are removed so a name cannot break the header.
 */
export function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
