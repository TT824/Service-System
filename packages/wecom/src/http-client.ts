/**
 * The outbound HTTP port of the WeCom transport.
 *
 * No WeCom caller in this repository calls `fetch` itself. Every provider
 * request goes through {@link WecomHttpClient}, so a unit test binds a fake
 * client and proves the whole protocol — token acquisition, retry-after-auth-
 * failure, send mapping — without a socket, and the one implementation that does
 * reach the network stays a thin, reviewable wrapper around Node's global
 * `fetch`.
 *
 * Responses are returned as `{ status, body }` with the body already parsed:
 * WeCom answers every JSON endpoint with a JSON document, including its errors,
 * so an error is a body the caller maps rather than an exception it has to
 * catch. A non-JSON body becomes `null` instead of throwing.
 *
 * The one endpoint that does *not* answer JSON is the media download, and it is
 * the reason {@link WecomHttpClient.download} exists beside `send`: reading a
 * PNG as text — which is what `send` does to every response — replaces every
 * byte that is not valid UTF-8 and hands back a corrupt picture with a `200`.
 * A second method also buys the bound `send` cannot express, a maximum body
 * size enforced *while* reading, so a provider answer of unexpected size cannot
 * be buffered into the process before anyone can refuse it.
 *
 * The port is app-neutral on purpose: it is the one seam the API process and the
 * Worker process both bind, so neither of them can grow a second opinion about
 * how a WeCom request is made or how long it may take.
 */

/**
 * One `multipart/form-data` file part.
 *
 * The media upload endpoint is the only WeCom request in this repository that is
 * not JSON, so this is the minimum the port has to carry for it: one named part,
 * as bytes, with the content type the caller already knows. The wire encoding
 * (a boundary, the part headers, the body framing) is the client's business —
 * nothing above this port has to know how a multipart body is assembled.
 */
export type WecomMultipartFile = {
  /** Form field name the provider expects the part under. */
  readonly field: string;
  /** File name presented in the part header. */
  readonly filename: string;
  /** Content type of {@link bytes}, used for the part header. */
  readonly contentType: string;
  /** The file itself. */
  readonly bytes: Uint8Array;
};

/** One provider request. */
export type WecomHttpRequest = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** JSON request body; omitted for a `GET`. */
  readonly body?: unknown;
  /**
   * `multipart/form-data` body, mutually exclusive with {@link body}.
   *
   * A request carries at most one of the two, because WeCom's JSON endpoints and
   * its media upload endpoint take different content types, and a request that
   * named both would leave which one wins to the client.
   */
  readonly multipart?: WecomMultipartFile;
  /** Hard deadline for the whole request, so a stalled provider cannot hang a caller. */
  readonly timeoutMs: number;
};

/** One provider response with its JSON body already parsed. */
export type WecomHttpResponse = {
  readonly status: number;
  /** Parsed JSON body, or `null` when the body was empty or not JSON. */
  readonly body: unknown;
};

/** One media download. */
export type WecomDownloadRequest = {
  readonly url: string;
  /** Hard deadline for the whole download, so a stalled provider cannot hang a caller. */
  readonly timeoutMs: number;
  /**
   * The most this client will read before refusing the body.
   *
   * Enforced while reading rather than after, because the point of a bound is
   * that the bytes beyond it are never held: a caller that checked the size
   * afterwards would already have buffered whatever the provider sent.
   */
  readonly maxBytes: number;
};

/**
 * One download's outcome.
 *
 * Three cases rather than one, because the provider answers this endpoint two
 * different ways and a caller has to be able to tell them apart: a successful
 * download carries bytes and a content type, a rejected one carries the same
 * JSON error document every other WeCom endpoint answers with, and a body past
 * {@link WecomDownloadRequest.maxBytes} is this client's own refusal — no
 * provider error at all, and nothing to map from one.
 */
export type WecomDownloadResponse =
  | {
      readonly kind: 'media';
      readonly status: number;
      /** The response's content type, lowercased and without parameters. */
      readonly contentType: string | null;
      /** The bytes exactly as the provider sent them. */
      readonly bytes: Uint8Array;
    }
  | {
      /** The provider answered with a JSON document instead of media. */
      readonly kind: 'json';
      readonly status: number;
      readonly body: unknown;
    }
  | {
      /** The body was longer than {@link WecomDownloadRequest.maxBytes}. */
      readonly kind: 'too_large';
      readonly status: number;
      readonly limitBytes: number;
    };

/** Outbound HTTP port used by the WeCom customer-service transport. */
export interface WecomHttpClient {
  /**
   * Perform one request.
   *
   * @param request - Method, URL, optional JSON body and deadline.
   * @returns The response status and parsed body.
   * @throws {Error} When the request cannot be completed at all (DNS, TLS, timeout).
   */
  send(request: WecomHttpRequest): Promise<WecomHttpResponse>;

  /**
   * Download one binary response.
   *
   * @param request - URL, deadline and the largest body that will be read.
   * @returns The bytes and content type, a JSON answer, or an oversized refusal.
   * @throws {Error} When the request cannot be completed at all (DNS, TLS, timeout).
   */
  download(request: WecomDownloadRequest): Promise<WecomDownloadResponse>;
}

/** Injection token carrying the bound {@link WecomHttpClient}. */
export const WECOM_HTTP_CLIENT = Symbol('WECOM_HTTP_CLIENT');

/**
 * The production client: Node 20's global `fetch`.
 *
 * Every request is bounded by an `AbortController` deadline, so a provider that
 * accepts the connection and then stalls surfaces as a failure the caller can
 * classify instead of a request that never returns.
 */
export class FetchWecomHttpClient implements WecomHttpClient {
  /** @inheritdoc */
  async send(request: WecomHttpRequest): Promise<WecomHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        ...bodyOf(request),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, body: parseJsonBody(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** @inheritdoc */
  async download(request: WecomDownloadRequest): Promise<WecomDownloadResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, { method: 'GET', signal: controller.signal });
      const contentType = normalizeContentType(response.headers.get('content-type'));
      const bytes = await readBounded(response, request.maxBytes);
      if (bytes === null) {
        return { kind: 'too_large', status: response.status, limitBytes: request.maxBytes };
      }
      if (isJsonAnswer(contentType, bytes)) {
        return {
          kind: 'json',
          status: response.status,
          body: parseJsonBody(new TextDecoder().decode(bytes)),
        };
      }
      return { kind: 'media', status: response.status, contentType, bytes };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A response's content type as this port reports it: lowercase, no parameters. */
function normalizeContentType(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const value = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return value.length === 0 ? null : value;
}

/**
 * Whether a downloaded body is a JSON document rather than media.
 *
 * The content type is believed when it says JSON. When it says nothing, the
 * first non-whitespace byte decides: every image format this endpoint serves
 * starts with a byte that cannot begin a JSON document, so a body that opens
 * with `{` is the provider's error document wearing an unhelpful header — and
 * returning those bytes as media would hand the caller a corrupt "image" whose
 * real content is an `errcode` nobody reads.
 *
 * @param contentType - The normalized response content type.
 * @param bytes - The body.
 * @returns `true` when the body is to be parsed as JSON.
 */
function isJsonAnswer(contentType: string | null, bytes: Uint8Array): boolean {
  if (contentType !== null) {
    return contentType.includes('json');
  }
  const first = bytes.find(
    (byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
  );
  return first === 0x7b;
}

/**
 * Read a response body up to a size limit.
 *
 * @param response - The response being read.
 * @param maxBytes - The largest body that may be buffered.
 * @returns The bytes, or `null` when the body exceeded the limit.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // Cancelled rather than read to the end: the connection is released and
      // the bytes past the limit are never held.
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Build the body fields of one `fetch` call.
 *
 * A JSON request is serialized and labelled explicitly. A multipart request is
 * handed over as a `FormData` with *no* content type of its own: `fetch` writes
 * the `multipart/form-data; boundary=...` header itself, and a caller that set
 * one would be naming a boundary the framing does not use.
 *
 * @param request - The request being sent.
 * @returns The `headers`/`body` pair to spread into the `fetch` init.
 */
function bodyOf(request: WecomHttpRequest): {
  readonly headers?: Record<string, string>;
  readonly body?: string | FormData;
} {
  if (request.multipart !== undefined) {
    const form = new FormData();
    form.append(
      request.multipart.field,
      new Blob([request.multipart.bytes], { type: request.multipart.contentType }),
      request.multipart.filename,
    );
    return { body: form };
  }
  if (request.body === undefined) {
    return {};
  }
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) };
}

/** Parse a response body, treating anything that is not JSON as absent. */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
