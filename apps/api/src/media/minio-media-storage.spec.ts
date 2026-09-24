import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MinioMediaStorage,
  type MinioObjectClient,
  type MinioObjectStat,
} from './minio-media-storage';

/**
 * Unit tests for the object-store adapter's own decisions.
 *
 * That a MinIO really accepts a object and hands it back is proved against the
 * running container in `apps/api/test/media-storage.integration.spec.ts`. What
 * is left for this file is everything a healthy store never shows: which
 * failures are classified how, what is *not* said in a reason, when the bucket
 * is created, and what happens to an object too large to read. A green
 * integration run cannot see any of them.
 */

/** A failure shaped the way the SDK's failures are: a code, and a message. */
function storeError(code: string, message = 'the object store refused this'): Error {
  return Object.assign(new Error(message), { code });
}

/** What one fake object store was asked, so the caller's behaviour is visible. */
type Recorded = {
  readonly made: string[];
  readonly put: ReadonlyArray<{ key: string; size: number; mime: string }>;
  readonly destroyed: number;
};

/**
 * An object store that answers what the test tells it to.
 *
 * `objects` is both the store's content and the way a test arranges one: the
 * fake serves what is in the map and rejects anything else the way MinIO does.
 */
function storeOver(
  objects: Map<string, { mime: string; bytes: Buffer }>,
  overrides: {
    readonly makeBucket?: () => Promise<void>;
    readonly putObject?: () => Promise<unknown>;
    readonly statObject?: (key: string) => Promise<MinioObjectStat>;
  } = {},
): { readonly client: MinioObjectClient; readonly recorded: Recorded } {
  const made: string[] = [];
  const put: Array<{ key: string; size: number; mime: string }> = [];
  const counter = { destroyed: 0 };

  const client: MinioObjectClient = {
    bucketExists: () => Promise.resolve(made.length > 0),
    makeBucket: (bucket: string) => {
      made.push(bucket);
      return overrides.makeBucket === undefined ? Promise.resolve() : overrides.makeBucket();
    },
    putObject: (bucket, key, body, size, metadata) => {
      put.push({ key, size, mime: metadata['Content-Type'] ?? '' });
      if (overrides.putObject !== undefined) {
        return overrides.putObject();
      }
      objects.set(`${bucket}/${key}`, { mime: metadata['Content-Type'] ?? '', bytes: body });
      return Promise.resolve({});
    },
    statObject: (_bucket, key) => {
      if (overrides.statObject !== undefined) {
        return overrides.statObject(key);
      }
      const found = objects.get(`${_bucket}/${key}`);
      return found === undefined
        ? Promise.reject(storeError('NoSuchKey'))
        : Promise.resolve({ metaData: { 'content-type': found.mime } });
    },
    getObject: (_bucket, key) => {
      const found = objects.get(`${_bucket}/${key}`);
      if (found === undefined) {
        return Promise.reject(storeError('NoSuchKey'));
      }
      const stream = Readable.from([found.bytes]);
      const destroy = stream.destroy.bind(stream);
      stream.destroy = ((error?: Error) => {
        counter.destroyed += 1;
        return destroy(error);
      }) as typeof stream.destroy;
      return Promise.resolve(stream);
    },
  };

  return {
    client,
    recorded: {
      made,
      put,
      // A getter, so a test reads the count at the moment it asserts rather than
      // holding a snapshot taken before the read that was supposed to bump it.
      get destroyed(): number {
        return counter.destroyed;
      },
    },
  };
}

const BUCKET = 'media';

describe('MinioMediaStorage', () => {
  it('stores an object and creates the bucket the first time it is needed', async () => {
    const objects = new Map<string, { mime: string; bytes: Buffer }>();
    const { client, recorded } = storeOver(objects);
    const storage = new MinioMediaStorage(client, BUCKET);
    const bytes = new TextEncoder().encode('not really a png');

    const first = await storage.put({
      key: 'tenants/t1/messages/m1',
      mimeType: 'image/png',
      bytes,
    });
    const second = await storage.put({
      key: 'tenants/t1/messages/m2',
      mimeType: 'image/jpeg',
      bytes,
    });

    expect(first).toEqual({
      ok: true,
      value: { key: 'tenants/t1/messages/m1', mimeType: 'image/png', bytes: bytes.byteLength },
    });
    expect(second.ok).toBe(true);
    // Created once: the second write must not pay for a bucket that exists.
    expect(recorded.made).toEqual([BUCKET]);
    expect(recorded.put.map((entry) => entry.key)).toEqual([
      'tenants/t1/messages/m1',
      'tenants/t1/messages/m2',
    ]);
    expect(recorded.put.map((entry) => entry.mime)).toEqual(['image/png', 'image/jpeg']);
  });

  it('reports an unreachable store instead of throwing at the caller', async () => {
    // The ingest path calls this while a customer's callback is being answered.
    // A refused connection must be a value the caller can write down, not an
    // exception that turns the callback into a 5xx.
    const { client } = storeOver(new Map(), {
      makeBucket: () => Promise.reject(storeError('ECONNREFUSED')),
    });
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.put({
      key: 'tenants/t1/messages/m1',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({
      ok: false,
      code: 'media_store_unreachable',
      reason: 'the object store could not be reached: ECONNREFUSED',
    });
  });

  it('treats a bucket another instance created as success', async () => {
    const { client, recorded } = storeOver(new Map(), {
      makeBucket: () => Promise.reject(storeError('BucketAlreadyOwnedByYou')),
    });
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.put({
      key: 'tenants/t1/messages/m1',
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
    });

    expect(result.ok).toBe(true);
    expect(recorded.made).toEqual([BUCKET]);
  });

  it('never puts the store’s own message, which can quote a credential, in a reason', async () => {
    // An S3 error body echoes the request that produced it — including a signed
    // authorization header. These reasons are logged and, on the ingest path,
    // travel with the message, so only the code may cross this boundary.
    const { client } = storeOver(new Map(), {
      putObject: () =>
        Promise.reject(
          storeError(
            'SignatureDoesNotMatch',
            'The request signature we calculated does not match. Authorization: AWS4-HMAC-SHA256 Credential=minioadmin/20260920',
          ),
        ),
    });
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.put({
      key: 'tenants/t1/messages/m1',
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('SignatureDoesNotMatch');
    expect(result.ok ? '' : result.reason).not.toContain('minioadmin');
    expect(result.ok ? '' : result.reason).not.toContain('AWS4-HMAC');
  });

  it('reads an object back with the content type it was written with', async () => {
    const objects = new Map([
      ['media/tenants/t1/messages/m1', { mime: 'image/webp', bytes: Buffer.from('bytes') }],
    ]);
    const { client } = storeOver(objects);
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.get('tenants/t1/messages/m1');

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.mimeType : '').toBe('image/webp');
    expect(result.ok ? Buffer.from(result.value.bytes).toString() : '').toBe('bytes');
  });

  it('says an object is missing when the store says so', async () => {
    const { client } = storeOver(new Map());
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.get('tenants/t1/messages/gone');

    expect(result).toEqual({
      ok: false,
      code: 'media_object_missing',
      reason: 'the object could not be described: NoSuchKey',
    });
  });

  it('refuses to read an object larger than the read cap, and stops reading it', async () => {
    // The write path caps a customer image at 2 MB, so this is defence against a
    // foreign or corrupt object — the read must fail rather than buffer it.
    const oversized = Buffer.alloc(9 * 1024 * 1024, 1);
    const objects = new Map([
      ['media/tenants/t1/messages/huge', { mime: 'image/png', bytes: oversized }],
    ]);
    const { client, recorded } = storeOver(objects);
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.get('tenants/t1/messages/huge');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('media_store_rejected');
    expect(result.ok ? '' : result.reason).toContain('larger than');
    expect(recorded.destroyed).toBeGreaterThan(0);
  });

  it('reports a store that cannot describe the object as unreachable, not as missing', async () => {
    // The two are different facts and the caller acts on them differently: a
    // missing object will never appear, an unreachable store might answer in a
    // second, and a console that showed the first when the second were true
    // would tell an operator the picture is gone for good.
    const { client } = storeOver(new Map(), {
      statObject: () => Promise.reject(storeError('ECONNREFUSED')),
    });
    const storage = new MinioMediaStorage(client, BUCKET);

    const result = await storage.get('tenants/t1/messages/m1');

    expect(result.ok ? '' : result.code).toBe('media_store_unreachable');
  });
});
