/**
 * Raw request-body capture for the WeCom callback routes.
 *
 * A real WeCom callback is authenticated with a digest over the *exact bytes*
 * WeCom sent: `sha1(sort(Token, timestamp, nonce, Encrypt))` where `Encrypt`
 * lives inside the callback's XML envelope. Parsing that XML with the JSON body
 * parser and re-serializing it would change the bytes the digest covers — the
 * very defect the Mock transport could afford and a real one cannot.
 *
 * The callback body is XML with a content type the default JSON parser does not
 * claim, so this middleware takes the stream for one route prefix before any
 * parser sees it, records the bytes on `req.rawBody`, and marks the request as
 * already read so a later parser cannot try to consume it a second time. The
 * Mock transport keeps working unchanged: the controller reads the same
 * `rawBody` string for both, so a Mock callback's JSON is a body it parses
 * itself rather than one Nest parsed for it.
 *
 * It stays dependency free — no XML or body-parser package is added — and it
 * refuses an oversized body instead of buffering it without bound.
 */

import { PayloadTooLargeException } from '@nestjs/common';
import type { NextFunction, Request } from 'express';

/** Route prefix whose request bodies are captured verbatim. */
export const WECOM_CALLBACK_PATH = '/api/v1/channels/wecom';

/** Largest callback body accepted, in bytes. */
const MAX_BODY_BYTES = 1_000_000;

/** A request whose raw bytes this middleware has recorded. */
export type RequestWithRawBody = Request & {
  /** The body exactly as received, when captured. */
  rawBody?: Buffer;
  /** Express/body-parser flag marking the body as already read. */
  _body?: boolean;
};

/**
 * Buffer one callback request's bytes onto `req.rawBody`.
 *
 * @param req - Incoming request.
 * @param _res - Unused response; present so Express passes `next` correctly.
 * @param next - Continuation.
 */
export function captureWecomRawBody(req: Request, _res: unknown, next: NextFunction): void {
  const target = req as RequestWithRawBody;
  if (!hasBody(req) || typeof target.rawBody !== 'undefined') {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;

  req.on('data', (chunk: Buffer) => {
    if (overflowed) {
      return;
    }
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      // Drop what was buffered: the caller gets a refusal, never a truncated
      // body that would fail signature verification for a misleading reason.
      overflowed = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (overflowed) {
      next(new PayloadTooLargeException('the channel callback body is too large'));
      return;
    }
    target.rawBody = Buffer.concat(chunks);
    // Keep the JSON/urlencoded parsers from reading a stream that is already
    // drained. They leave `req.body` untouched, and the controller reads
    // `rawBody` instead.
    target._body = true;
    next();
  });
  req.on('error', () => {
    next(new PayloadTooLargeException('the channel callback body could not be read'));
  });
}

/** Whether a request declares a body at all. A `GET` handshake declares none. */
function hasBody(req: Request): boolean {
  return (
    typeof req.headers['content-length'] === 'string' ||
    typeof req.headers['transfer-encoding'] === 'string'
  );
}
