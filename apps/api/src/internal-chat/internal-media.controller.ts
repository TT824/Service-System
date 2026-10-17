import { Controller, Get, HttpException, HttpStatus, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public-route.decorator';
import { queryString } from '../http/query-param';
import { JsonLogger } from '../logging/json-logger';
import {
  INTERNAL_MEDIA_CONTROLLER_PATH,
  MEDIA_URL_EXPIRY_PARAM,
  MEDIA_URL_SIGNATURE_PARAM,
  MEDIA_URL_TENANT_PARAM,
  MediaUrlService,
} from '../media/media-url.service';
import { InternalAttachmentService } from './internal-attachment.service';

/**
 * The bytes of a file one colleague sent another, served under a signed URL.
 *
 * The same shape as the customer media route, for the same reason: this is the
 * one address an `<img>`, a `<video>` or a download link has to reach, and none
 * of those three can carry the identity header every other route in this API
 * requires. So the URL *is* the credential and the route authenticates itself —
 * `@Public()` in exactly the way the WeCom callback is.
 *
 * Two things are checked before any bytes move, and they are checked in this
 * order on purpose: the signature first (a caller without a valid link learns
 * nothing about which message ids exist), then the attachment's own tenant
 * lookup, which is what makes the minted tenant — not a header — decide whose
 * file this is.
 *
 * ## How the response is typed
 *
 * The stored content type is only trusted as far as the upload's closed
 * allowlist let it in. An image or a video is served inline with the type it was
 * validated as; **everything else is served as `application/octet-stream` with a
 * download disposition**, whatever type it claimed. That, plus `nosniff`, is
 * what makes it impossible for a sender to have this origin deliver a document a
 * browser would execute — the cheapest way for a chat feature to become a
 * stored-XSS bug.
 */
@Controller(INTERNAL_MEDIA_CONTROLLER_PATH)
export class InternalMediaController {
  /**
   * @param attachments - The stored bytes and the message they belong to.
   * @param urls - Signature verification.
   * @param logger - Where a refusal explains itself.
   */
  constructor(
    private readonly attachments: InternalAttachmentService,
    private readonly urls: MediaUrlService,
    private readonly logger: JsonLogger,
  ) {}

  /**
   * Stream one message's attachment.
   *
   * @param messageId - The message the URL was signed for.
   * @param query - The URL's own parameters: tenant, expiry and signature.
   * @param res - The raw response, written rather than returned — the body is a
   *   file, and the `{ request_id, data, meta }` envelope would corrupt it.
   */
  @Public()
  @Get(':messageId')
  async read(
    @Param('messageId') messageId: string,
    @Query() query: Readonly<Record<string, unknown>>,
    @Res() res: Response,
  ): Promise<void> {
    const verdict = this.urls.verify({
      messageId,
      tenantId: queryString(query, MEDIA_URL_TENANT_PARAM),
      expiry: queryString(query, MEDIA_URL_EXPIRY_PARAM),
      signature: queryString(query, MEDIA_URL_SIGNATURE_PARAM),
      purpose: 'internal-attachment',
    });
    if (!verdict.ok) {
      this.logger.logStructured(
        'warn',
        'internal attachment URL refused',
        { message: messageId, reason: verdict.reason },
        InternalMediaController.name,
      );
      throw new HttpException(
        { code: 'forbidden', message: 'a valid media URL is required' },
        HttpStatus.FORBIDDEN,
      );
    }

    const stored = await this.attachments.read({
      tenantId: verdict.tenantId,
      messageId: verdict.messageId,
    });
    if (!stored.ok) {
      this.logger.logStructured(
        'warn',
        'stored internal attachment could not be read',
        { message: messageId, reason: stored.reason, detail: stored.detail },
        InternalMediaController.name,
      );
      throw stored.reason === 'not_found'
        ? new HttpException(
            { code: 'not_found', message: 'no stored attachment for this message' },
            HttpStatus.NOT_FOUND,
          )
        : new HttpException(
            { code: 'service_unavailable', message: 'media storage is unavailable' },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
    }

    const inline = stored.kind === 'image' || stored.kind === 'video';
    res
      .type(inline ? stored.mimeType : 'application/octet-stream')
      // The type above is only as good as the upload's allowlist; this is what
      // stops a browser from deciding for itself that the bytes are HTML.
      .setHeader('X-Content-Type-Options', 'nosniff')
      // Private, and shorter than the URL's own life: the link is a bearer
      // credential, so a shared cache must never hold the bytes, while a
      // transcript that re-renders should not refetch a file it already has.
      .setHeader('Cache-Control', 'private, max-age=300')
      .setHeader('Content-Disposition', contentDisposition(inline, stored.fileName))
      .send(Buffer.from(stored.bytes));
  }
}

/**
 * The `Content-Disposition` header for one stored file.
 *
 * Two spellings of the same name, because headers are ASCII and file names are
 * not: `filename` carries a folded-down version for anything old, and
 * `filename*` carries the real one, percent-encoded, which is what every current
 * browser uses. `对账单.png` therefore downloads as itself.
 *
 * @param inline - Whether the browser may render it in place.
 * @param fileName - The stored name.
 * @returns The header value.
 */
function contentDisposition(inline: boolean, fileName: string): string {
  const ascii = fileName.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
