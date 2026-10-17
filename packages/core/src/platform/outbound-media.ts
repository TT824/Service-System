/**
 * What a seat may send a customer besides words, and how much of it.
 *
 * This is the gate the console's picker is allowed to disagree with but not to
 * decide past: the same rules that stop a 30 MB spreadsheet in the browser stop
 * it here, because a limit the frontend enforces and the backend does not is a
 * suggestion, and the channel's own refusal is a much worse answer than ours —
 * it arrives after the seat has waited for an upload.
 *
 * The numbers are the channel's, not ours. WeCom accepts three kinds of media on
 * the customer-service send path and each has its own ceiling; the three differ
 * because they are stored and delivered differently upstream, not because
 * anything here decided they should. They are written down a second time in
 * `@kefu/wecom`, where the same limits are enforced from the provider's side of
 * the call, and a test asserts the two agree — the duplication is deliberate (a
 * transport package that cannot be imported by the domain has to state its own
 * bounds) but drift between them is not.
 *
 * Two caveats worth knowing before trusting a number here:
 *
 *   * The provider's public documentation is not self-consistent. The generic
 *     temporary-media page gives image 10 MB / video 10 MB / file 20 MB; the
 *     customer-service pages have been read as saying image 2 MB. The 2 MB
 *     figure is the one the *inbound* path already caps at
 *     (`MediaService.capture`), so the two halves of the platform disagree by
 *     construction. Nothing here silently drops a message over it: a file over
 *     the real ceiling comes back as a provider refusal, which the seat sees.
 *   * `video/mp4` is the only clip type any of the documentation lists.
 */

/** The kinds of media a seat can send. */
export const OUTBOUND_MEDIA_KINDS = ['image', 'video', 'file'] as const;

/** Which of the three a file is. Decides the ceiling and the provider's msgtype. */
export type OutboundMediaKind = (typeof OUTBOUND_MEDIA_KINDS)[number];

/**
 * How large a file may be, per kind, in bytes.
 *
 * Three ceilings rather than one for the same reason `0013` splits media into
 * three columns: they are three different things to a provider. A picture is
 * stored and re-encoded as an image, a clip is transcoded, and a document is
 * kept as opaque bytes — and the channel charges each a different amount of
 * room. A single flat limit would either refuse documents the channel would
 * happily carry or promise pictures a size it will not.
 */
export const OUTBOUND_MEDIA_MAX_BYTES: Readonly<Record<OutboundMediaKind, number>> = {
  image: 10 * 1024 * 1024,
  video: 10 * 1024 * 1024,
  file: 20 * 1024 * 1024,
};

/**
 * The image types that may be sent, and the only video type.
 *
 * Narrower than the closed allowlist the internal transcript renders, and for a
 * different reason: there the question is what a browser may be handed, here it
 * is what the channel will accept. WebP is the visible cost of that difference —
 * a browser renders it and a modern console produces it from a screenshot, but
 * no version of the provider's documentation lists it for images, so allowing it
 * would mean an upload that fails minutes later with a message about the
 * provider rather than about the file. Refusing it here says "这个格式不支持"
 * while the seat is still looking at the picker.
 *
 * `image/svg+xml` is refused for the reason it is refused everywhere else: it
 * looks like a picture and is a document that can carry script.
 *
 * A type that claims to be an image or a clip and is on neither list is refused
 * rather than demoted to a document. Silently turning a picture into a download
 * would be a worse answer than saying so.
 */
export const OUTBOUND_MEDIA_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
];
/** @see OUTBOUND_MEDIA_IMAGE_TYPES */
export const OUTBOUND_MEDIA_VIDEO_TYPES: readonly string[] = ['video/mp4'];

/**
 * Longest stored file name, in characters.
 *
 * The name is shown to the customer and sent to the provider as the file's
 * name, so it is bounded rather than unbounded: a row is not a place to keep
 * whatever a client felt like sending. 120 characters is enough for every real
 * document name and short enough that the name cannot become the message.
 */
export const OUTBOUND_MEDIA_FILE_NAME_MAX_LENGTH = 120;

/** A validated file, ready to be uploaded and recorded. */
export type ValidatedOutboundMedia = {
  readonly kind: OutboundMediaKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
};

/**
 * Turn a raw `type/subtype` into the form everything else compares against.
 *
 * Parameters are dropped (`text/plain; charset=utf-8` is a `text/plain`) and
 * case is folded, because a type arrives from a client and two spellings of the
 * same type must not be two decisions.
 *
 * @param value - The declared content type.
 * @returns The normalized type.
 * @throws {Error} When it is not a `type/subtype` at all.
 */
export function outboundMediaMimeType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('the file must declare a content type');
  }
  const normalized = (value.split(';')[0] ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new Error(`content type ${value} is not a type/subtype`);
  }
  return normalized;
}

/**
 * Which kind a content type is, and therefore which ceiling applies.
 *
 * @param mimeType - A normalized content type.
 * @returns The kind.
 * @throws {Error} When an image or video type is outside the closed allowlist.
 */
export function outboundMediaKindFor(mimeType: string): OutboundMediaKind {
  if (OUTBOUND_MEDIA_IMAGE_TYPES.includes(mimeType)) {
    return 'image';
  }
  if (OUTBOUND_MEDIA_VIDEO_TYPES.includes(mimeType)) {
    return 'video';
  }
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
    throw new Error(`content type ${mimeType} is not an accepted image or video type`);
  }
  return 'file';
}

/**
 * Clean a client-supplied file name down to something safe to store and show.
 *
 * A name is display text, a `Content-Disposition` value and — for the document
 * kind — a parameter on the provider's own upload URL, and all three readings
 * are hostile to the same characters: a path separator invents a directory, a
 * control character breaks a header, and an unbounded length is a way to write a
 * row larger than the message that carries it. What survives is kept as-is,
 * including non-ASCII, because 对账单.png is a file name too.
 *
 * @param value - The declared file name.
 * @returns The cleaned name.
 * @throws {Error} When nothing is left to name the file with.
 */
export function outboundMediaFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('the file must have a name');
  }
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, ' ').trim();
  if (cleaned.length === 0) {
    throw new Error('the file must have a name');
  }
  if (cleaned.length <= OUTBOUND_MEDIA_FILE_NAME_MAX_LENGTH) {
    return cleaned;
  }
  // Truncated from the end but keeping the extension: the part of a file name
  // the reader and the download both need is the tail.
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, OUTBOUND_MEDIA_FILE_NAME_MAX_LENGTH - extension.length)}${extension}`;
}

/**
 * Validate one file a seat picked, or say why it cannot be sent.
 *
 * The single gate, run on the server for a client that already checked. It runs
 * *before* anything is uploaded anywhere, which is what makes "too large" and
 * "wrong format" arrive as sentences about the file rather than as a provider
 * error code after a wait.
 *
 * @param input - The declared name, content type and byte size.
 * @returns The kind and the cleaned metadata.
 * @throws {Error} When the file is unnameable, untyped, or too large for its kind.
 */
export function outboundMedia(input: {
  readonly fileName: unknown;
  readonly mimeType: unknown;
  readonly byteSize: unknown;
}): ValidatedOutboundMedia {
  const fileName = outboundMediaFileName(input.fileName);
  const mimeType = outboundMediaMimeType(input.mimeType);
  const kind = outboundMediaKindFor(mimeType);
  if (typeof input.byteSize !== 'number' || !Number.isInteger(input.byteSize)) {
    throw new Error('the file must have a size');
  }
  if (input.byteSize <= 0) {
    throw new Error('the file is empty');
  }
  const limit = OUTBOUND_MEDIA_MAX_BYTES[kind];
  if (input.byteSize > limit) {
    throw new Error(`the file is larger than ${String(limit)} bytes`);
  }
  return { kind, fileName, mimeType, byteSize: input.byteSize };
}
