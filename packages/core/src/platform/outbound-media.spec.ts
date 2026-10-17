import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_MEDIA_MAX_BYTES,
  outboundMedia,
  outboundMediaFileName,
  outboundMediaKindFor,
  outboundMediaMimeType,
} from './outbound-media';

const MIB = 1024 * 1024;

/** A whole file the console could have picked, with overrides for one test each. */
function picked(overrides: Partial<{ fileName: string; mimeType: string; byteSize: number }> = {}) {
  return {
    fileName: '报价单-2026-10.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: 20480,
    ...overrides,
  };
}

describe('outboundMedia', () => {
  it('sorts a file into the kind the provider has a msgtype for', () => {
    expect(outboundMedia(picked({ fileName: '对账单.png', mimeType: 'image/png' })).kind).toBe(
      'image',
    );
    expect(outboundMedia(picked({ fileName: '开箱.mp4', mimeType: 'video/mp4' })).kind).toBe(
      'video',
    );
    expect(outboundMedia(picked()).kind).toBe('file');
  });

  it('normalizes the declared type before deciding anything from it', () => {
    // A browser is free to add a charset and to shout. Neither spelling is a
    // second decision, and the stored type is the normalized one.
    const validated = outboundMedia(picked({ mimeType: 'IMAGE/PNG; charset=binary' }));
    expect(validated.kind).toBe('image');
    expect(validated.mimeType).toBe('image/png');
  });

  it('refuses a picture the channel has no msgtype it would accept', () => {
    // WebP renders in every modern browser and is not on the provider's list:
    // refusing it here is what turns "上传失败" minutes later into a sentence
    // the seat reads while still looking at the picker.
    expect(() => outboundMedia(picked({ mimeType: 'image/webp' }))).toThrow(/not an accepted/);
    // An SVG looks like a picture and is a document that can carry script.
    expect(() => outboundMedia(picked({ mimeType: 'image/svg+xml' }))).toThrow(/not an accepted/);
    // A clip the provider will not take: only MP4 is documented.
    expect(() => outboundMedia(picked({ mimeType: 'video/quicktime' }))).toThrow(
      /not an accepted/,
    );
  });

  it('applies each kind its own ceiling rather than one flat limit', () => {
    // The same weight is over the line for a picture and well inside it for a
    // document, which is the whole reason the ceilings are three numbers.
    expect(OUTBOUND_MEDIA_MAX_BYTES.image).toBeLessThan(OUTBOUND_MEDIA_MAX_BYTES.file);
    expect(() => outboundMedia(picked({ mimeType: 'image/png', byteSize: 11 * MIB }))).toThrow(
      /larger than/,
    );
    expect(
      outboundMedia(picked({ mimeType: 'application/zip', byteSize: 11 * MIB })).kind,
    ).toBe('file');
    expect(() => outboundMedia(picked({ mimeType: 'application/zip', byteSize: 21 * MIB }))).toThrow(
      /larger than/,
    );
  });

  it('refuses an empty file and a size that is not a size', () => {
    expect(() => outboundMedia(picked({ byteSize: 0 }))).toThrow(/empty/);
    expect(() => outboundMedia(picked({ byteSize: 1.5 }))).toThrow(/size/);
  });
});

describe('outboundMediaFileName', () => {
  it('keeps a name that is already safe, non-ASCII included', () => {
    expect(outboundMediaFileName('报价单-2026-10.xlsx')).toBe('报价单-2026-10.xlsx');
  });

  it('takes the path off a name no browser would have sent', () => {
    // A separator invents a directory in whatever reads the name next, and the
    // name is read by the provider as a URL parameter and by the browser as a
    // `Content-Disposition` value.
    expect(outboundMediaFileName('C:\\Users\\agent\\报价单.xlsx')).toBe('C: Users agent 报价单.xlsx');
    expect(outboundMediaFileName('../../etc/passwd')).toBe('.. .. etc passwd');
  });

  it('strips control characters rather than storing them', () => {
    expect(outboundMediaFileName('报价\u0000单\u001f.pdf')).toBe('报价单.pdf');
  });

  it('shortens a long name from the end and keeps the extension', () => {
    const long = `${'字'.repeat(200)}.pdf`;
    const shortened = outboundMediaFileName(long);
    expect(shortened.length).toBe(120);
    expect(shortened.endsWith('.pdf')).toBe(true);
  });

  it('refuses a file with nothing left to name it with', () => {
    expect(() => outboundMediaFileName('   ')).toThrow(/name/);
    expect(() => outboundMediaFileName('\u0000\u0001')).toThrow(/name/);
    expect(() => outboundMediaFileName(undefined)).toThrow(/name/);
  });
});

describe('outboundMediaMimeType', () => {
  it('refuses something that is not a type at all', () => {
    expect(() => outboundMediaMimeType('not a type')).toThrow(/type\/subtype/);
    expect(() => outboundMediaMimeType(undefined)).toThrow(/content type/);
  });

  it('reads a bare family as a family with no subtype and refuses it', () => {
    expect(() => outboundMediaMimeType('image/')).toThrow(/type\/subtype/);
  });
});

describe('outboundMediaKindFor', () => {
  it('treats anything outside the two media families as a document', () => {
    expect(outboundMediaKindFor('application/pdf')).toBe('file');
    expect(outboundMediaKindFor('text/csv')).toBe('file');
    expect(outboundMediaKindFor('application/octet-stream')).toBe('file');
  });
});
