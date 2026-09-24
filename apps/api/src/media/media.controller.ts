import { Controller, Get, HttpException, HttpStatus, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public-route.decorator';
import { queryString } from '../http/query-param';
import { JsonLogger } from '../logging/json-logger';
import {
  MEDIA_CONTROLLER_PATH,
  MEDIA_URL_EXPIRY_PARAM,
  MEDIA_URL_SIGNATURE_PARAM,
  MEDIA_URL_TENANT_PARAM,
  MediaUrlService,
} from './media-url.service';
import { MessageMediaService } from './media.service';

/**
 * The bytes of a stored customer image, served under a signed URL.
 *
 * This is the one route in the platform an `<img>` tag has to reach, and an
 * `<img>` carries no identity header — so the URL *is* the credential, and the
 * route is `@Public()` in exactly the way the WeCom callback is: the global
 * guard cannot authenticate it, so it authenticates itself. What it verifies is
 * {@link MediaUrlService}'s signature over the tenant, the message and the
 * expiry; a request without a valid one is refused before any lookup happens.
 *
 * The response is written directly rather than returned, because the body is the
 * image itself and not the `{ request_id, data, meta }` envelope — wrapping a
 * PNG in JSON would corrupt it. Nothing about the picture identifies a person,
 * so the bytes carry no tenant header and no filename back to the caller.
 */
@Controller(MEDIA_CONTROLLER_PATH)
export class MediaController {
  /**
   * @param media - The stored bytes and the message they belong to.
   * @param urls - Signature minting and verification.
   * @param logger - Where a refusal explains itself.
   */
  constructor(
    private readonly media: MessageMediaService,
    private readonly urls: MediaUrlService,
    private readonly logger: JsonLogger,
  ) {}

  /**
   * Stream one message's stored image.
   *
   * Three answers, deliberately distinct:
   *
   * - **No valid signature** → `403 forbidden`. The caller is not the holder of
   *   a link this platform minted. Nothing is looked up first, so an invalid
   *   signature learns nothing about which message ids exist.
   * - **Signed, but nothing stored** → `404 not_found`. A stale link to a
   *   message whose picture was never kept, or whose row is gone.
   * - **Signed and stored, but the object store is down** → `503
   *   service_unavailable`. The picture exists on record; the platform cannot
   *   reach it right now, and a retry may well succeed.
   *
   * @param messageId - The message the URL was signed for.
   * @param query - The URL's own parameters: tenant, expiry and signature.
   * @param res - The raw response, written rather than returned.
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
    });
    if (!verdict.ok) {
      // Logged rather than explained: which half of the check failed is useful
      // to an operator chasing a broken picture, and useless to the caller.
      this.logger.logStructured(
        'warn',
        'media URL refused',
        { message: messageId, reason: verdict.reason },
        MediaController.name,
      );
      throw new HttpException(
        { code: 'forbidden', message: 'a valid media URL is required' },
        HttpStatus.FORBIDDEN,
      );
    }

    const stored = await this.media.read({
      tenantId: verdict.tenantId,
      messageId: verdict.messageId,
    });
    if (!stored.ok) {
      this.logger.logStructured(
        'warn',
        'stored media could not be read',
        { message: messageId, reason: stored.reason, detail: stored.detail },
        MediaController.name,
      );
      throw stored.reason === 'not_found'
        ? new HttpException(
            { code: 'not_found', message: 'no stored media for this message' },
            HttpStatus.NOT_FOUND,
          )
        : new HttpException(
            { code: 'service_unavailable', message: 'media storage is unavailable' },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
    }

    res
      .type(stored.mimeType)
      // Private, and shorter than the URL's own life: the link is a bearer
      // credential, so a shared cache must never hold the bytes, while a
      // transcript that re-renders should not refetch a picture it already has.
      .setHeader('Cache-Control', 'private, max-age=300')
      .send(Buffer.from(stored.bytes));
  }
}
