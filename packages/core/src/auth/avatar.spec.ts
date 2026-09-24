import { describe, expect, it } from 'vitest';

import {
  AVATAR_MAX_DATA_URL_LENGTH,
  assertAvatarDataUrl,
  isAvatarMediaType,
} from './avatar';
import { isAuthError } from './errors';

/** A one-pixel PNG: the smallest thing the platform will accept. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Build a data URL from raw bytes, the way a client with a picture would. */
function dataUrl(mediaType: string, bytes: ReadonlyArray<number> | Buffer): string {
  return `data:${mediaType};base64,${Buffer.from(bytes as Buffer).toString('base64')}`;
}

/** The first twelve bytes of a RIFF/WEBP file: container tag, size, format tag. */
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
]);

/** The start of a JPEG: `SOI` and the first marker. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);

/** Assert a value is refused as an avatar. */
function expectRefused(value: string): void {
  try {
    assertAvatarDataUrl(value);
    expect.unreachable('the value should not have been accepted');
  } catch (error) {
    expect(isAuthError(error)).toBe(true);
    if (isAuthError(error)) {
      expect(error.code).toBe('avatar_invalid');
    }
  }
}

describe('assertAvatarDataUrl', () => {
  it('accepts a PNG, a JPEG and a WebP', () => {
    expect(() => assertAvatarDataUrl(PNG)).not.toThrow();
    expect(() => assertAvatarDataUrl(dataUrl('image/jpeg', JPEG_BYTES))).not.toThrow();
    expect(() => assertAvatarDataUrl(dataUrl('image/webp', WEBP_BYTES))).not.toThrow();
  });

  it('refuses an SVG, which is a document rather than a picture', () => {
    // The one media type this allow-list exists for: an SVG can carry script and
    // references to other origins, and it would pass a `data:image/` prefix
    // check as easily as a PNG does.
    expectRefused(dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')));
  });

  it('refuses bytes that are not the type they claim to be', () => {
    // The declared type is the one thing a caller fully controls. Without the
    // signature check this value would be stored as an "image/png".
    expectRefused(dataUrl('image/png', JPEG_BYTES));
    expectRefused(dataUrl('image/jpeg', Buffer.from('this is not a jpeg at all')));
    // A RIFF container on its own is an AVI or a WAV as readily as a WebP.
    expectRefused(
      dataUrl('image/webp', Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(8)])),
    );
  });

  it('refuses a payload too short to carry a signature', () => {
    expectRefused(dataUrl('image/png', Buffer.from([0x89, 0x50])));
    expectRefused('data:image/png;base64,');
  });

  it('refuses anything that is not a base64 image data URL', () => {
    expectRefused('https://example.com/avatar.png');
    expectRefused('/avatars/alice.png');
    expectRefused('data:image/png,notbase64');
    expectRefused('data:text/html;base64,PHNjcmlwdD4=');
    expectRefused('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  });

  it('accepts exactly the stored length and refuses one character past it', () => {
    const prefix = 'data:image/png;base64,';
    // The two values differ only in length, and both carry a real PNG at the
    // front, so the second one is refused by the bound rather than by anything
    // about its bytes — which is the only way to tell the two refusals apart.
    const body = PNG.slice(prefix.length).replace(/=+$/, '');
    const ofLength = (total: number): string =>
      prefix + body + 'A'.repeat(total - prefix.length - body.length);

    expect(() => assertAvatarDataUrl(ofLength(65280))).not.toThrow();
    expect(() => assertAvatarDataUrl(ofLength(AVATAR_MAX_DATA_URL_LENGTH))).not.toThrow();
    expectRefused(ofLength(AVATAR_MAX_DATA_URL_LENGTH + 1));
  });
});

describe('isAvatarMediaType', () => {
  it('knows the allow-list and nothing else', () => {
    expect(isAvatarMediaType('image/png')).toBe(true);
    expect(isAvatarMediaType('image/gif')).toBe(false);
    expect(isAvatarMediaType('image/svg+xml')).toBe(false);
    expect(isAvatarMediaType('text/plain')).toBe(false);
  });
});
