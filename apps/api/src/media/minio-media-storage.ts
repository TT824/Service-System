import { Client } from 'minio';
import type {
  MediaObjectBody,
  MediaStorage,
  MediaStorageResult,
  StoredMediaObject,
} from './media-storage';

/**
 * The MinIO/S3 implementation of {@link MediaStorage}.
 *
 * The SDK is reached through {@link MinioObjectClient} — a five-method seam —
 * rather than directly, so this file's decisions (which failures are "the store
 * is down" and which are "the store said no", when the bucket is created, how
 * much is read back) are unit-testable without a running object store. The only
 * place the SDK itself appears is {@link minioObjectClient}, at the wiring
 * boundary, and that is deliberate: an S3 client's error surface is large and
 * version-dependent, and the rest of this file must not be about it.
 */

/** One object as it comes back from the store, with its recorded metadata. */
export type MinioObjectStat = {
  readonly metaData?: Readonly<Record<string, unknown>>;
};

/**
 * The slice of the MinIO client this adapter uses.
 *
 * Structural, so the production client is adapted to it once in
 * {@link minioObjectClient} and a test can hand in anything with the same five
 * methods.
 */
export interface MinioObjectClient {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<void>;
  putObject(
    bucket: string,
    key: string,
    body: Buffer,
    size: number,
    metadata: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  statObject(bucket: string, key: string): Promise<MinioObjectStat>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
}

/** Credentials and endpoint of one object store, as the application config states them. */
export type MinioMediaStorageConfig = {
  readonly endPoint: string;
  readonly port: number;
  readonly useSSL: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
};

/**
 * The largest object this adapter will read back into memory.
 *
 * Larger than anything the ingest path writes (which caps a customer's image at
 * 2 MB), because a read must not be the thing that discovers a size the write
 * path would have refused — and small enough that a corrupt or foreign object
 * cannot exhaust the heap.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Bucket-creation results that mean another caller already created it. */
const BUCKET_ALREADY_OWNED = ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'];

/** MinIO's name for "that object is not there". */
const OBJECT_MISSING_CODES = ['NoSuchKey', 'NotFound', 'NoSuchBucket'];

/** The content type written with an object, as MinIO reports it back. */
function contentTypeOf(stat: MinioObjectStat, fallback: string): string {
  const raw = stat.metaData?.['content-type'] ?? stat.metaData?.['Content-Type'];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

/** The classifiable name of a thrown store failure, without its message. */
function failureNameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string' && record.code.length > 0) return record.code;
    if (typeof record.name === 'string' && record.name.length > 0) return record.name;
  }
  return 'unknown error';
}

/** The MIME type written with an object that was stored without one. */
const DEFAULT_OBJECT_MIME = 'application/octet-stream';

/** Store customer media in a MinIO/S3-compatible bucket. */
export class MinioMediaStorage implements MediaStorage {
  /**
   * Whether the bucket is known to exist, cached after the first successful
   * creation so that a steady state costs no extra round trip.
   *
   * Held per instance rather than checked at boot: the API may start before the
   * object store does (they are separate containers), and a customer's photo
   * arriving into a store that is not up yet must not be a start-up failure —
   * it must be a message stored without its bytes.
   */
  #bucketReady = false;

  /**
   * @param client - The object-store seam.
   * @param bucket - The bucket media is kept in.
   */
  constructor(
    private readonly client: MinioObjectClient,
    private readonly bucket: string,
  ) {}

  /** @inheritdoc */
  async put(input: {
    readonly key: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<MediaStorageResult<StoredMediaObject>> {
    const ready = await this.#ensureBucket();
    if (!ready.ok) return ready;

    try {
      const body = Buffer.from(input.bytes);
      await this.client.putObject(this.bucket, input.key, body, body.byteLength, {
        'Content-Type': input.mimeType,
      });
      return {
        ok: true,
        value: { key: input.key, mimeType: input.mimeType, bytes: body.byteLength },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'media_store_rejected',
        reason: `the object store refused the object: ${failureNameOf(error)}`,
      };
    }
  }

  /** @inheritdoc */
  async get(key: string): Promise<MediaStorageResult<MediaObjectBody>> {
    let stat: MinioObjectStat;
    try {
      stat = await this.client.statObject(this.bucket, key);
    } catch (error) {
      const name = failureNameOf(error);
      return {
        ok: false,
        code: OBJECT_MISSING_CODES.includes(name)
          ? 'media_object_missing'
          : 'media_store_unreachable',
        reason: `the object could not be described: ${name}`,
      };
    }

    try {
      const bytes = await readAll(await this.client.getObject(this.bucket, key));
      if (bytes === null) {
        return {
          ok: false,
          code: 'media_store_rejected',
          reason: `the object is larger than ${MAX_READ_BYTES} bytes`,
        };
      }
      return { ok: true, value: { mimeType: contentTypeOf(stat, DEFAULT_OBJECT_MIME), bytes } };
    } catch (error) {
      const name = failureNameOf(error);
      return {
        ok: false,
        code: OBJECT_MISSING_CODES.includes(name)
          ? 'media_object_missing'
          : 'media_store_unreachable',
        reason: `the object could not be read: ${name}`,
      };
    }
  }

  /**
   * Make sure the bucket exists, creating it the first time it is needed.
   *
   * @returns `{ ok: true }` once the bucket is known to exist.
   */
  async #ensureBucket(): Promise<MediaStorageResult<undefined>> {
    if (this.#bucketReady) return { ok: true, value: undefined };
    try {
      if (!(await this.client.bucketExists(this.bucket))) {
        await this.client.makeBucket(this.bucket);
      }
      this.#bucketReady = true;
      return { ok: true, value: undefined };
    } catch (error) {
      const name = failureNameOf(error);
      if (BUCKET_ALREADY_OWNED.includes(name)) {
        // Another instance created it between the check and the call: the bucket
        // is there, which is all this method promises.
        this.#bucketReady = true;
        return { ok: true, value: undefined };
      }
      return {
        ok: false,
        code: 'media_store_unreachable',
        reason: `the object store could not be reached: ${name}`,
      };
    }
  }
}

/**
 * Read a whole object into memory, refusing anything oversized.
 *
 * @param stream - The object's stream.
 * @returns The bytes, or `null` when the object exceeds {@link MAX_READ_BYTES}.
 */
async function readAll(stream: NodeJS.ReadableStream): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > MAX_READ_BYTES) {
      // Stops reading rather than buffering the rest: the caller gets a failure
      // it can report, and the connection is released by the stream's own
      // teardown.
      (stream as { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Adapt the real MinIO client to {@link MinioObjectClient}.
 *
 * The five methods are forwarded explicitly rather than by structural typing, so
 * that a version of the SDK that changes a signature fails here — in the one
 * file that is about the SDK — instead of somewhere in the ingest path.
 *
 * @param config - Endpoint and credentials.
 * @returns The object-store seam.
 */
export function minioObjectClient(config: MinioMediaStorageConfig): MinioObjectClient {
  const client = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  return {
    bucketExists: (bucket) => client.bucketExists(bucket),
    makeBucket: (bucket) => client.makeBucket(bucket).then(() => undefined),
    putObject: (bucket, key, body, size, metadata) =>
      client.putObject(bucket, key, body, size, { ...metadata }),
    statObject: (bucket, key) => client.statObject(bucket, key),
    getObject: (bucket, key) => client.getObject(bucket, key),
  };
}
