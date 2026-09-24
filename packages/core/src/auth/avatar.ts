/**
 * Avatar images.
 *
 * An avatar is the picture an operator picks for their own account. It is stored
 * as a base64 `data:` URL in the account row itself — not in object storage —
 * and this module exists to keep that choice bounded.
 *
 * The row is read by `/auth/session`, which is the call the console makes to
 * decide what to render at all, so whatever the column holds travels with every
 * session. Storing a URL to a bucket instead would mean a second service that
 * can be down while the console is up, a signed URL with a lifetime shorter than
 * the session that carries it, and an object left behind by every change of
 * mind — for a 96-pixel picture nobody else ever looks at. What a bucket would
 * buy is size, and the size is what {@link AVATAR_MAX_DATA_URL_LENGTH} refuses
 * to be surprised by.
 *
 * The accepted media types are an allow-list rather than a deny-list.
 * `image/svg+xml` is the one that matters: an SVG is a document, not a picture,
 * and a document can carry script and references to other origins. Nothing in
 * this console needs an avatar that is one, so no avatar is ever stored as one.
 *
 * The bytes are also checked against the signature of the type they claim. The
 * check is not what keeps the column honest — the console is the only client
 * that speaks this route, and it only ever sends what it drew on a canvas — but
 * it is what makes the allow-list enforceable rather than merely declared: a
 * request that says `image/png` and sends something else is refused at the door
 * instead of being stored to be refused later by whatever renders it.
 */

import { AuthError } from './errors';

/** Media types an avatar may be stored as. */
export const AVATAR_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** One of the media types an avatar may be stored as. */
export type AvatarMediaType = (typeof AVATAR_MEDIA_TYPES)[number];

/**
 * Longest avatar data URL the platform stores.
 *
 * 65536 base64 characters is just under 48 KiB of image, which is several times
 * what a 96-pixel WebP or PNG needs and still small enough that the account it
 * belongs to stays a rounding error in the session payload that carries it. It
 * is a ceiling on what a client may spend on one avatar, not a target: the
 * console produces a few kilobytes.
 */
export const AVATAR_MAX_DATA_URL_LENGTH = 65_536;

/**
 * A base64 `data:` URL whose media type is an image, and nothing else.
 *
 * The media type is captured rather than restricted here so the refusal can
 * name the type that was refused; the allow-list decides afterwards.
 */
const AVATAR_DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Signature of a PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Leading bytes of a JPEG file (`SOI` followed by the first marker). */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Container tag of a WebP file, at offset 0. */
const WEBP_CONTAINER = Buffer.from('RIFF', 'ascii');

/** Format tag of a WebP file, at offset 8, past the RIFF chunk size. */
const WEBP_TAG = Buffer.from('WEBP', 'ascii');

/** Fewest bytes any accepted format needs before its signature is readable. */
const MIN_AVATAR_BYTES = 12;

/**
 * Whether a media type is one an avatar may be stored as.
 *
 * @param value - Media type to test, e.g. `image/webp`.
 * @returns `true` when the type is on the allow-list.
 */
export function isAvatarMediaType(value: string): value is AvatarMediaType {
  return (AVATAR_MEDIA_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Reject an avatar that cannot be stored.
 *
 * @param value - Candidate base64 `data:` URL.
 * @throws {AuthError} `avatar_invalid` when the value is too long, is not a
 *   base64 image data URL, is not an accepted media type, or does not carry the
 *   bytes of the type it claims.
 */
export function assertAvatarDataUrl(value: string): void {
  // Length first: it is the only check that bounds the work the rest of this
  // function does on a value a caller chose the size of.
  if (value.length > AVATAR_MAX_DATA_URL_LENGTH) {
    throw new AuthError(
      'avatar_invalid',
      `avatar must be at most ${AVATAR_MAX_DATA_URL_LENGTH} characters`,
    );
  }
  const match = AVATAR_DATA_URL_PATTERN.exec(value);
  if (match === null) {
    throw new AuthError('avatar_invalid', 'avatar must be a base64 image data URL');
  }
  const mediaType = match[1] ?? '';
  if (!isAvatarMediaType(mediaType)) {
    throw new AuthError('avatar_invalid', `unsupported avatar media type: ${mediaType}`);
  }
  const bytes = Buffer.from(match[2] ?? '', 'base64');
  if (bytes.length < MIN_AVATAR_BYTES || !matchesSignature(mediaType, bytes)) {
    throw new AuthError('avatar_invalid', `avatar bytes are not a ${mediaType} image`);
  }
}

/** Whether decoded bytes begin with the signature of the media type they claim. */
function matchesSignature(mediaType: AvatarMediaType, bytes: Buffer): boolean {
  switch (mediaType) {
    case 'image/png':
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case 'image/jpeg':
      return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
    case 'image/webp':
      // A RIFF container alone is also an AVI or a WAV, so the format tag is
      // part of the signature rather than a detail of it.
      return bytes.subarray(0, 4).equals(WEBP_CONTAINER) && bytes.subarray(8, 12).equals(WEBP_TAG);
  }
}
