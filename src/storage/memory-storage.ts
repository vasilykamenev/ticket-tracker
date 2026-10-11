import { type ObjectStorage, type PresignOptions, type StoredObject, contentDisposition } from './storage.js';

interface Entry {
  data: Buffer;
  contentType: string;
  lastModified: Date;
}

/**
 * In-process storage for tests and local development: nothing touches the disk, and everything is gone on
 * restart. It also lets tests inject failures and read back what was stored.
 */
export class MemoryStorage implements ObjectStorage {
  readonly bucket: string;
  private readonly objects = new Map<string, Entry>();
  /** Set to make the next call of that kind throw once (to exercise failure handling). */
  failNext: { put?: Error; delete?: Error; head?: Error } = {};

  constructor(bucket = 'ticket-attachments') {
    this.bucket = bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.throwIfFailing('put');
    this.objects.set(key, { data: Buffer.from(body), contentType, lastModified: new Date() });
  }

  async head(key: string): Promise<{ size: number } | null> {
    this.throwIfFailing('head');
    const entry = this.objects.get(key);
    return entry ? { size: entry.data.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.throwIfFailing('delete');
    this.objects.delete(key);
  }

  async presignGet(key: string, options: PresignOptions): Promise<string> {
    const params = new URLSearchParams({
      expires: String(options.expiresSeconds),
      disposition: contentDisposition(options.filename),
      type: options.contentType,
    });
    return `https://storage.test/${this.bucket}/${key}?${params.toString()}`;
  }

  async *list(prefix: string): AsyncIterable<StoredObject> {
    for (const [key, entry] of [...this.objects]) {
      if (key.startsWith(prefix)) yield { key, size: entry.data.length, lastModified: entry.lastModified };
    }
  }

  // --- test helpers
  has(key: string): boolean {
    return this.objects.has(key);
  }

  get(key: string): Buffer | undefined {
    return this.objects.get(key)?.data;
  }

  get count(): number {
    return this.objects.size;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Back-dates an object, to test cleanup of old orphans. */
  age(key: string, lastModified: Date): void {
    const entry = this.objects.get(key);
    if (entry) entry.lastModified = lastModified;
  }

  private throwIfFailing(kind: 'put' | 'delete' | 'head'): void {
    const error = this.failNext[kind];
    if (error) {
      delete this.failNext[kind];
      throw error;
    }
  }
}
