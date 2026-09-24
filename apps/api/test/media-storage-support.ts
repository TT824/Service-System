import type {
  MediaObjectBody,
  MediaStorage,
  MediaStorageFailureCode,
  MediaStorageResult,
  StoredMediaObject,
} from '../src/media/media-storage';

/**
 * An object store that keeps its objects in a map.
 *
 * The port's whole reason for existing is that the ingest path has to be
 * exercisable without a running MinIO, so the double is the point rather than a
 * convenience: a test that had to reach a real bucket to prove a picture was
 * kept would be a test nobody could run.
 *
 * It is also the place a failure is scripted, because "the store refused" and
 * "the store is down" are answers this platform must survive rather than crash
 * on — the two are distinguished here exactly as the MinIO adapter distinguishes
 * them, so a caller cannot pass one test with the other's answer.
 */
export class MemoryMediaStorage implements MediaStorage {
  /** Objects by key, as written. */
  readonly objects = new Map<string, MediaObjectBody>();

  /** Every key `put` was called with, in order, including refused ones. */
  readonly writes: string[] = [];

  /**
   * When set, every call answers this failure instead of touching the map.
   *
   * One switch rather than one per method: a store that is unreachable is
   * unreachable for reads and writes alike, and a real outage does not respect
   * which half of the port a caller is on.
   */
  failure: { readonly code: MediaStorageFailureCode; readonly reason: string } | null = null;

  /** @inheritdoc */
  async put(input: {
    readonly key: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<MediaStorageResult<StoredMediaObject>> {
    this.writes.push(input.key);
    if (this.failure !== null) {
      return { ok: false, ...this.failure };
    }
    this.objects.set(input.key, { mimeType: input.mimeType, bytes: input.bytes });
    return {
      ok: true,
      value: { key: input.key, mimeType: input.mimeType, bytes: input.bytes.byteLength },
    };
  }

  /** @inheritdoc */
  async get(key: string): Promise<MediaStorageResult<MediaObjectBody>> {
    if (this.failure !== null) {
      return { ok: false, ...this.failure };
    }
    const object = this.objects.get(key);
    return object === undefined
      ? { ok: false, code: 'media_object_missing', reason: 'no such object' }
      : { ok: true, value: object };
  }
}
