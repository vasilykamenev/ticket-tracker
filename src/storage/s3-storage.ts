import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type ObjectStorage, type PresignOptions, type StoredObject, contentDisposition } from './storage.js';

export interface S3Options {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** For tests: replaces the HTTP transport so no network is used. */
  clientConfig?: Partial<S3ClientConfig>;
}

/**
 * Supabase Storage through its S3-compatible API (PutObject, GetObject, HeadObject, DeleteObject and
 * ListObjectsV2 are what the application needs). Supabase needs path-style addressing. These credentials
 * give privileged access to the whole bucket, so every download still goes through our own authorization
 * and only short-lived presigned URLs ever reach the browser.
 */
export class S3Storage implements ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3Options) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      ...options.clientConfig,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 answers 204 for a missing key, so this is idempotent by itself.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignGet(key: string, options: PresignOptions): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(options.filename),
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresSeconds },
    );
  }

  async *list(prefix: string): AsyncIterable<StoredObject> {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        if (object.Key) yield { key: object.Key, size: object.Size ?? 0, lastModified: object.LastModified ?? new Date(0) };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}
