/**
 * Internal collaboration: messages between colleagues of one tenant.
 *
 * Deliberately a separate model from a customer conversation, rather than a
 * conversation with an `internal` channel. A customer conversation is bound to
 * an external channel, a customer identity, a serving store and the 48-hour
 * service window, and it flows into the workspace queue, the response-time
 * metrics and the customer-record export. Colleague chatter has none of those
 * properties and must not acquire them by accident: putting it in the same table
 * would make an internal message count as a served customer and would expose it
 * through every surface that already reads conversations.
 *
 * What the two do share is exactly two things, and only those are reused: the
 * tenant boundary, and the realtime channel (which announces "something
 * changed"; the state itself is still read over REST).
 *
 * One participant may sit outside that boundary: the platform administrator,
 * who belongs to no tenant. A thread with them is stored under the seat's
 * tenant — the tenant of the colleague being talked to — so both sides reach it
 * by naming the same tenant and the read path stays exactly as it was.
 */

/**
 * Longest message body accepted, in characters.
 *
 * Sized for a colleague pasting a paragraph of context, not for a document. The
 * limit exists so one seat cannot write an unbounded row, and it is enforced in
 * the service before the write rather than only by the column, so the refusal is
 * a stable 400 instead of a storage error.
 */
export const INTERNAL_MESSAGE_MAX_LENGTH = 2000;

/** A thread kind. Only one-to-one exists today; groups would extend this union. */
export type InternalThreadKind = 'direct';

/**
 * A one-to-one thread between two colleagues.
 *
 * Participants are stored sorted (`participantMemberIds[0] < [1]`) and the id is
 * derived from them, so "open a chat with X" is idempotent by construction: both
 * sides computing the same pair land on the same row instead of racing to create
 * two threads that each hold half the conversation.
 */
export type InternalThread = {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: InternalThreadKind;
  /** The two participants, ascending. Membership, not a read cursor. */
  readonly participantMemberIds: readonly [string, string];
  readonly createdAt: string;
  /** Last append, so a list can be ordered without reading every message. */
  readonly lastMessageAt: string;
};

/** One message inside an internal thread. */
export type InternalMessage = {
  readonly id: string;
  readonly tenantId: string;
  readonly threadId: string;
  /** The colleague who wrote it. Never the customer side — there is none. */
  readonly senderMemberId: string;
  /**
   * The text of the message. Empty is legal: a message may be nothing but an
   * attachment, and an empty string says that more plainly than a placeholder
   * sentence the reader would have to learn to ignore.
   */
  readonly body: string;
  /** The file the message carries, or `null` for a text-only message. */
  readonly attachment: InternalMessageAttachment | null;
  readonly createdAt: string;
};

/**
 * A file one colleague sent another, as the message carries it.
 *
 * The bytes are not here. This is the *description* of a stored object — what a
 * transcript needs to lay the message out and to ask for the file — and the
 * only way to reach the bytes is the signed route, which re-establishes the
 * tenant from the signature rather than from this record.
 */
export type InternalMessageAttachment = {
  readonly id: string;
  readonly kind: InternalAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
};

/**
 * A stored attachment as the repository keeps it.
 *
 * The message record above is the projection a reader sees; this is the row.
 * The two are deliberately separate, and the difference is `messageId`: a row
 * exists before any message names it — that is the upload — and until a message
 * does, the row is a draft only its uploader may claim.
 */
export type InternalAttachmentRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly uploaderMemberId: string;
  readonly kind: InternalAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly objectKey: string;
  /** The message that claimed it, or `null` while it is still a draft. */
  readonly messageId: string | null;
  readonly createdAt: string;
};

/** The attachment kinds a colleague can send. */
export const INTERNAL_ATTACHMENT_KINDS = ['image', 'video', 'file'] as const;

/** What kind of file an attachment is. Decides the limit and how it is served. */
export type InternalAttachmentKind = (typeof INTERNAL_ATTACHMENT_KINDS)[number];

/**
 * How large an attachment may be, per kind, in bytes.
 *
 * Three limits rather than one, because the three are sent for different
 * reasons. A picture is pasted to be looked at and 5 MB is far more than a chat
 * screenshot needs; a video is minutes long and 50 MB is one phone clip; a
 * document is a document, and 20 MB holds any PDF or spreadsheet a colleague
 * would hand over mid-conversation.
 */
export const INTERNAL_ATTACHMENT_MAX_BYTES: Readonly<Record<InternalAttachmentKind, number>> = {
  image: 5 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  file: 20 * 1024 * 1024,
};

/**
 * The only image types that may be rendered inline, and the only video types.
 *
 * A closed allowlist, and it is a security boundary rather than a taste: these
 * bytes are served back under the deployment's own origin with the declared
 * content type, so a type a browser would *execute* must never get in here.
 * `image/svg+xml` is the one that looks like an image and is not — an SVG is a
 * document that can carry script, so it is not on this list and an upload
 * claiming it is refused rather than quietly demoted.
 *
 * Anything else becomes a `file`, which is downloaded as opaque bytes and never
 * rendered, so no denylist of "active" types is needed or wanted: unknown types
 * are not a risk here, they are just files.
 */
export const INTERNAL_ATTACHMENT_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
/** @see INTERNAL_ATTACHMENT_IMAGE_TYPES */
export const INTERNAL_ATTACHMENT_VIDEO_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

/** Longest stored file name, in characters. */
export const INTERNAL_ATTACHMENT_FILE_NAME_MAX_LENGTH = 120;

/** A validated attachment, ready to be stored. */
export type ValidatedInternalAttachment = {
  readonly kind: InternalAttachmentKind;
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
export function internalAttachmentMimeType(value: unknown): string {
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
 * Which kind a content type is, and therefore which rules apply to it.
 *
 * @param mimeType - A normalized content type.
 * @returns The kind.
 * @throws {Error} When an image or video type is outside the closed allowlist.
 */
export function internalAttachmentKindFor(mimeType: string): InternalAttachmentKind {
  if (INTERNAL_ATTACHMENT_IMAGE_TYPES.includes(mimeType)) {
    return 'image';
  }
  if (INTERNAL_ATTACHMENT_VIDEO_TYPES.includes(mimeType)) {
    return 'video';
  }
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
    // A type that claims to be renderable but is not on the list. Refused
    // rather than stored as a file: the sender picked it as a picture or a
    // clip, and silently turning it into a download would be a worse answer
    // than "这个格式不支持".
    throw new Error(`content type ${mimeType} is not an accepted image or video type`);
  }
  return 'file';
}

/**
 * Clean a client-supplied file name down to something safe to store and show.
 *
 * A name is display text and a `Content-Disposition` value, and both readings
 * are hostile to the same characters: a path separator invents a directory, a
 * control character breaks a header, and an unbounded length is a way to write
 * a row larger than the message that carries it. What survives is kept as-is —
 * including non-ASCII, because 对账单.png is a file name too.
 *
 * @param value - The declared file name.
 * @returns The cleaned name.
 * @throws {Error} When nothing is left to name the file with.
 */
export function internalAttachmentFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('the file must have a name');
  }
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, ' ').trim();
  if (cleaned.length === 0) {
    throw new Error('the file must have a name');
  }
  if (cleaned.length <= INTERNAL_ATTACHMENT_FILE_NAME_MAX_LENGTH) {
    return cleaned;
  }
  // Truncated from the end but keeping the extension: the part of a file name
  // the reader and the download both need is the tail.
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, INTERNAL_ATTACHMENT_FILE_NAME_MAX_LENGTH - extension.length)}${extension}`;
}

/**
 * Validate one uploaded file, or say why it cannot be sent.
 *
 * The single gate, and it runs on the server for a client that already checked:
 * a limit the frontend enforces and the backend does not is a suggestion, and
 * the size of a row in a shared bucket is not something to negotiate.
 *
 * @param input - The declared name, content type and byte size.
 * @returns The kind and the cleaned metadata to store.
 * @throws {Error} When the file is unnameable, untyped, or too large for its kind.
 */
export function internalAttachment(input: {
  readonly fileName: unknown;
  readonly mimeType: unknown;
  readonly byteSize: unknown;
}): ValidatedInternalAttachment {
  const fileName = internalAttachmentFileName(input.fileName);
  const mimeType = internalAttachmentMimeType(input.mimeType);
  const kind = internalAttachmentKindFor(mimeType);
  if (typeof input.byteSize !== 'number' || !Number.isInteger(input.byteSize)) {
    throw new Error('the file must have a size');
  }
  const limit = INTERNAL_ATTACHMENT_MAX_BYTES[kind];
  if (input.byteSize <= 0) {
    throw new Error('the file is empty');
  }
  if (input.byteSize > limit) {
    throw new Error(`the file is larger than ${String(limit)} bytes`);
  }
  return { kind, fileName, mimeType, byteSize: input.byteSize };
}

/**
 * The stable id of the one-to-one thread between two members.
 *
 * Derived rather than assigned. Two seats that both press "发消息" at the same
 * instant must converge on one thread; a generated id would give them one each,
 * and the conversation would appear to lose half its messages depending on which
 * window you looked at.
 *
 * @param tenantId - Tenant both participants belong to.
 * @param memberIdA - One participant.
 * @param memberIdB - The other participant.
 * @returns The deterministic thread id.
 */
export function directInternalThreadId(
  tenantId: string,
  memberIdA: string,
  memberIdB: string,
): string {
  const [first, second] = sortedPair(memberIdA, memberIdB);
  return `internal-direct:${tenantId}:${first}:${second}`;
}

/**
 * The two member ids of a pair, ascending.
 *
 * @param memberIdA - One member.
 * @param memberIdB - The other.
 * @returns The pair with the lexicographically smaller id first.
 */
export function sortedPair(
  memberIdA: string,
  memberIdB: string,
): readonly [string, string] {
  return memberIdA <= memberIdB ? [memberIdA, memberIdB] : [memberIdB, memberIdA];
}

/**
 * Whether a member is a participant of a thread.
 *
 * The single membership rule, so the service's read gate and its write gate
 * cannot disagree about who may see a thread.
 *
 * @param thread - The thread being read or written.
 * @param memberId - The acting member.
 * @returns `true` when the member is one of the two participants.
 */
export function internalThreadIncludes(thread: InternalThread, memberId: string): boolean {
  return thread.participantMemberIds.includes(memberId);
}

/**
 * Validate a message body and return the text to store.
 *
 * The empty case is the interesting one, and it is not a special case but a
 * consequence of what a message is: a message that carries an attachment is
 * already saying something, so the text is allowed to say nothing. A message
 * with neither is still refused, because that one is a stray Enter key rather
 * than a message.
 *
 * @param body - Raw request value.
 * @param hasAttachment - Whether the same message carries a file.
 * @returns The trimmed body, empty when the message is attachment-only.
 * @throws {Error} When there is no attachment and no usable text.
 */
export function internalMessageBody(body: unknown, hasAttachment = false): string {
  if (typeof body !== 'string') {
    if (body === undefined && hasAttachment) {
      return '';
    }
    throw new Error('content must be a string');
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    if (hasAttachment) {
      return '';
    }
    throw new Error('content must not be empty');
  }
  if (trimmed.length > INTERNAL_MESSAGE_MAX_LENGTH) {
    throw new Error(`content must be at most ${INTERNAL_MESSAGE_MAX_LENGTH} characters`);
  }
  return trimmed;
}
