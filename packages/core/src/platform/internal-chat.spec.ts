import { describe, expect, it } from 'vitest';
import {
  INTERNAL_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  INTERNAL_ATTACHMENT_MAX_BYTES,
  internalAttachment,
  internalAttachmentFileName,
  internalAttachmentKindFor,
  internalAttachmentMimeType,
  internalMessageBody,
} from './internal-chat';

/**
 * The validators behind a colleague sending a file.
 *
 * They are worth their own cases because they are the only thing standing
 * between the deployment's own origin and whatever a client uploads: the kind
 * they derive decides which size limit applies, and — more sharply — whether the
 * bytes may ever be served *inline*. An `image/svg+xml` that got classified as an
 * image would be a document with script in it, rendered from this platform's
 * domain.
 */
describe('internal attachment validation', () => {
  it('derives the kind from the content type, not from the caller', () => {
    expect(internalAttachmentKindFor('image/png')).toBe('image');
    expect(internalAttachmentKindFor('video/mp4')).toBe('video');
    // Not on the media allowlist, so it is an opaque file — downloaded, never
    // rendered. That is the classification that makes it safe.
    expect(internalAttachmentKindFor('application/pdf')).toBe('file');
    expect(internalAttachmentKindFor('text/plain')).toBe('file');
  });

  it('refuses an image or video type that is not on the allowlist', () => {
    // The one that looks like a picture and is not.
    expect(() => internalAttachmentKindFor('image/svg+xml')).toThrow(/not an accepted/);
    expect(() => internalAttachmentKindFor('video/x-msvideo')).toThrow(/not an accepted/);
    expect(() => internalAttachmentKindFor('image/heic')).toThrow(/not an accepted/);
  });

  it('normalizes a content type before deciding anything about it', () => {
    expect(internalAttachmentMimeType('IMAGE/PNG')).toBe('image/png');
    expect(internalAttachmentMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(() => internalAttachmentMimeType('png')).toThrow(/type\/subtype/);
    expect(() => internalAttachmentMimeType(undefined)).toThrow(/content type/);
  });

  it('cleans a file name without losing what it is called', () => {
    // A path is not a name: a separator would invent a directory in whatever
    // displays or stores it.
    expect(internalAttachmentFileName('..\\..\\etc\\passwd')).toBe('.. .. etc passwd');
    expect(internalAttachmentFileName('\u0000账单\u001f.png')).toBe('账单.png');
    // Non-ASCII survives: 对账单.png is a file name too.
    expect(internalAttachmentFileName('对账单.png')).toBe('对账单.png');
    expect(() => internalAttachmentFileName('   ')).toThrow(/name/);
  });

  it('truncates a long name from the end, keeping the extension', () => {
    const long = `${'a'.repeat(200)}.png`;
    const cleaned = internalAttachmentFileName(long);
    expect(cleaned.length).toBe(INTERNAL_ATTACHMENT_FILE_NAME_MAX_LENGTH);
    // The tail is the part a reader and a download both need.
    expect(cleaned.endsWith('.png')).toBe(true);
  });

  it('holds each kind to its own limit, and refuses an empty file', () => {
    // Exactly at the limit is legal — the comparison is `>` — so the boundary
    // the frontend promises (5 MB) is not silently 5 MB − 1 byte on the server.
    const atLimit = internalAttachment({
      fileName: 'a.png',
      mimeType: 'image/png',
      byteSize: INTERNAL_ATTACHMENT_MAX_BYTES.image,
    });
    expect(atLimit.kind).toBe('image');
    expect(atLimit.byteSize).toBe(INTERNAL_ATTACHMENT_MAX_BYTES.image);

    expect(() =>
      internalAttachment({
        fileName: 'a.png',
        mimeType: 'image/png',
        byteSize: INTERNAL_ATTACHMENT_MAX_BYTES.image + 1,
      }),
    ).toThrow(/larger than/);

    // A 20 MB picture is refused while the same 20 MB as a document is not: one
    // limit per kind, which is the whole reason the kind is derived first.
    expect(() =>
      internalAttachment({ fileName: 'a.png', mimeType: 'image/png', byteSize: 20 * 1024 * 1024 }),
    ).toThrow(/larger than/);
    expect(
      internalAttachment({
        fileName: '报表.pdf',
        mimeType: 'application/pdf',
        byteSize: 20 * 1024 * 1024,
      }).kind,
    ).toBe('file');

    expect(() =>
      internalAttachment({ fileName: 'a.png', mimeType: 'image/png', byteSize: 0 }),
    ).toThrow(/empty/);
  });

  it('accepts an empty body only when the message carries a file', () => {
    expect(internalMessageBody('  hello  ')).toBe('hello');
    // Nothing to say and nothing to show is not a message.
    expect(() => internalMessageBody('')).toThrow(/empty/);
    expect(() => internalMessageBody(undefined)).toThrow(/string/);
    // A file with no caption is.
    expect(internalMessageBody('', true)).toBe('');
    expect(internalMessageBody(undefined, true)).toBe('');
    // …but the length limit still applies to the caption it does have.
    expect(() => internalMessageBody('x'.repeat(2001), true)).toThrow(/at most/);
  });
});
