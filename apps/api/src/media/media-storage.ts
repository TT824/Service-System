/**
 * The object-storage port: where a customer's image bytes are kept.
 *
 * A port rather than a direct MinIO call, for the same reason the rest of this
 * application has one: the ingest path must be testable without a running
 * object store, and the store must be replaceable without touching the code that
 * downloads, projects or serves a message.
 *
 * It lives here rather than in `@kefu/core` because only this application uses
 * it — the worker and the console never touch stored media — and a core export
 * would make every change to it a rebuild of `packages/core`, which the
 * interface suite resolves from `dist` (see `vitest.interface.config.ts`). The
 * precedent is `WECOM_BINDING_REPOSITORY`, which is equally application-local.
 *
 * **Failures are values, not throws.** A store that is down at the moment a
 * customer sends a photo must not fail the callback that carries it: the message
 * is already the customer's and the platform's job is to keep it, with or
 * without the picture. So every method answers a {@link MediaStorageResult}, and
 * the caller decides what to write down about the missing bytes.
 */

/** Why an object could not be stored or read back. */
export type MediaStorageFailureCode =
  /** The object store could not be reached at all (refused, timed out, DNS). */
  | 'media_store_unreachable'
  /** The store answered and refused the request for its own reasons. */
  | 'media_store_rejected'
  /** The object is not there — deleted, or never written. */
  | 'media_object_missing';

/** One object as it was written, in the terms the message row records it. */
export type StoredMediaObject = {
  /** The key the object was written under. */
  readonly key: string;
  /** The MIME type the object was written with, as the content type of a read. */
  readonly mimeType: string;
  /** Size in bytes, so a caller can report it without reading the object back. */
  readonly bytes: number;
};

/** One object as it was read back. */
export type MediaObjectBody = {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};

/** The answer of one store or read. */
export type MediaStorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: MediaStorageFailureCode;
      /** One line naming the failure's shape, never a credential or a body. */
      readonly reason: string;
    };

/** Object storage for customer media. */
export interface MediaStorage {
  /**
   * Write one object, creating the bucket if the deployment has not yet.
   *
   * @param input - Key, content type and bytes.
   * @returns The stored object, or why it was not stored.
   */
  put(input: {
    readonly key: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<MediaStorageResult<StoredMediaObject>>;

  /**
   * Read one object back.
   *
   * @param key - The key the object was written under.
   * @returns Its content type and bytes, or why they could not be read.
   */
  get(key: string): Promise<MediaStorageResult<MediaObjectBody>>;
}

/** Injection token carrying the bound {@link MediaStorage}. */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

/**
 * The key one message's media is stored under.
 *
 * Namespaced by tenant first so that a tenant's objects can be listed and
 * deleted as a set — the thing an offboarding or a data-deletion request
 * actually needs. The message id follows, so two messages can never collide
 * even when the same customer sends the same picture twice.
 *
 * @param tenantId - The tenant the message belongs to.
 * @param messageId - The platform's id for the message.
 * @returns The object key.
 */
export function mediaObjectKey(tenantId: string, messageId: string): string {
  return `tenants/${tenantId}/messages/${messageId}`;
}

/**
 * The key one internal attachment's bytes are stored under.
 *
 * A sibling of {@link mediaObjectKey} rather than a second parameter on it, and
 * a separate segment, because the two namespaces answer different questions.
 * A customer message's media is fetched *from* a provider during ingest and is
 * keyed by the message it belongs to; an internal attachment is uploaded *by* a
 * colleague and is keyed by the attachment, which exists before any message
 * names it. Keying both by message id would make an unsent draft unaddressable
 * — there would be no message id to build the key from.
 *
 * The tenant still comes first, so a tenant's objects remain enumerable and
 * deletable as a set, which is what an offboarding actually needs.
 *
 * @param tenantId - The tenant the uploader belongs to.
 * @param attachmentId - The platform's id for the attachment.
 * @returns The object key.
 */
export function internalAttachmentObjectKey(tenantId: string, attachmentId: string): string {
  return `tenants/${tenantId}/internal-attachments/${attachmentId}`;
}

/**
 * The key the platform's own copy of an outbound file is stored under.
 *
 * Keyed by a generated media id rather than by the message, because the bytes
 * are written *before* the message exists: the provider has to be handed the
 * file first — it will not accept a message naming a `media_id` it was never
 * given — and only then is the row that records both written. A key built from
 * the message id would have nothing to be built from at that moment.
 *
 * Third namespace of its own for the reason `0020`'s is a namespace of its own:
 * what these three hold is three different things. A customer message's media is
 * a copy of what the provider sent us; an internal attachment is a colleague's
 * file that will never leave the platform; this is a seat's file that has
 * *already* left for the customer and is kept here only so the transcript can
 * still show what was said.
 *
 * @param tenantId - The tenant whose seat uploaded the file.
 * @param mediaId - The platform's id for this upload.
 * @returns The object key.
 */
export function outboundMediaObjectKey(tenantId: string, mediaId: string): string {
  return `tenants/${tenantId}/outbound-media/${mediaId}`;
}
