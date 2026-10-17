import { describe, expect, it } from 'vitest';
import { OUTBOUND_MEDIA_MAX_BYTES, outboundMedia } from '@kefu/core';
import {
  WECOM_FILE_MAX_BYTES,
  WECOM_MEDIA_MAX_BYTES,
  WECOM_VIDEO_MAX_BYTES,
  wecomOutboundPayload,
} from '@kefu/wecom';

/**
 * The one place the two halves of "how big may it be" meet.
 *
 * The ceilings are written down twice on purpose: `@kefu/core` owns the gate the
 * console is measured against, `@kefu/wecom` owns the bounds it enforces from
 * the provider's side of the call, and the second cannot import the first (the
 * dependency runs the other way). Two copies of a number are two numbers the day
 * one of them is edited, and the failure that follows is quiet: a file the
 * console accepts is refused by the provider, or — worse — one the provider caps
 * is uploaded in full before being refused. This spec is what makes that
 * impossible to do by accident, and it lives in the API because the API is the
 * only package that depends on both.
 */
describe('outbound media limits', () => {
  it('agrees with the transport about how much of each kind the channel takes', () => {
    expect(OUTBOUND_MEDIA_MAX_BYTES.image).toBe(WECOM_MEDIA_MAX_BYTES);
    expect(OUTBOUND_MEDIA_MAX_BYTES.video).toBe(WECOM_VIDEO_MAX_BYTES);
    expect(OUTBOUND_MEDIA_MAX_BYTES.file).toBe(WECOM_FILE_MAX_BYTES);
  });

  it('names each kind with the msgtype the transport actually sends', () => {
    // Two vocabularies that have to line up: the kind the validator decides and
    // the `msgtype` the provider's body carries. Nothing else checks that
    // `outboundMedia` calls a document a `file` and the payload builder agrees.
    const cases = [
      { fileName: '对账单.png', mimeType: 'image/png', kind: 'image' },
      { fileName: '开箱.mp4', mimeType: 'video/mp4', kind: 'video' },
      { fileName: '报价单.pdf', mimeType: 'application/pdf', kind: 'file' },
    ] as const;
    for (const entry of cases) {
      const validated = outboundMedia({
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        byteSize: 1024,
      });
      expect(validated.kind).toBe(entry.kind);
      const payload = wecomOutboundPayload({
        tenantId: 'tenant-1',
        storeId: 'store-1',
        externalCustomerId: 'customer-1',
        externalConversationId: 'conversation-1',
        correlationId: 'correlation-1',
        messageType: validated.kind,
        content: validated.fileName,
        media: { mediaId: 'MEDIA_ID_1', mimeType: validated.mimeType },
      });
      expect(payload.ok).toBe(true);
      expect(payload.ok && payload.value.msgtype).toBe(entry.kind);
    }
  });

  it('accepts nothing the transport would refuse to upload', () => {
    // The validator is allowed to be stricter than the transport (it is: WebP
    // and QuickTime are refused here and would be carried there), but not the
    // other way round — anything past this gate must be something the upload
    // path can be asked for.
    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'video/mp4']) {
      const validated = outboundMedia({ fileName: 'f', mimeType, byteSize: 1024 });
      expect(validated.kind).toBe(mimeType.startsWith('image/') ? 'image' : 'video');
      expect(validated.mimeType).toBe(mimeType);
    }
  });
});
