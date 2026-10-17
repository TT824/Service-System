/**
 * The one place the callback self-check opens a socket.
 *
 * This exists beside `@kefu/wecom`'s `WecomHttpClient` rather than inside it,
 * and the reason is the response shape. That client speaks to WeCom's JSON API:
 * it parses every body as JSON and follows redirects. The URL this check
 * requests is the operator's own deployment, which answers the handshake with
 * bare plaintext — the client's `send` would turn the answer into `null` and the
 * check could never compare it — and it is the one request in this repository
 * whose target a human typed, so it must not follow a redirect somewhere else.
 *
 * Keeping it a second thin wrapper buys both, and the cost of a second seam is
 * paid here: the imports are one type and the class is a single `fetch` with a
 * deadline, a redirect policy and a bounded read.
 */

import type {
  WecomCallbackProbe,
  WecomCallbackProbeRequest,
  WecomCallbackProbeResponse,
} from './wecom-callback-selfcheck.service';

/**
 * The most of a probed response this check will read.
 *
 * A wrong URL very often answers with an entire HTML page, and none of it can be
 * the plaintext that is being looked for. Unlike the media download — where a
 * truncated body is a corrupt file and therefore a refusal — a bound that stops
 * reading here is enough to decide the verdict, so the body is truncated rather
 * than refused. Eight kilobytes is orders of magnitude above the answer a
 * correct handshake produces.
 */
export const CALLBACK_PROBE_MAX_BODY_BYTES = 8 * 1_024;

/**
 * Perform one probe with Node's global `fetch`.
 *
 * @param request - The URL to request and the deadline for the whole request.
 * @returns The response status and the body, truncated to
 * {@link CALLBACK_PROBE_MAX_BODY_BYTES}.
 * @throws {Error} When the request cannot be completed: DNS, TLS, timeout, or a
 * redirect, which is refused rather than followed.
 */
export const fetchWecomCallbackProbe: WecomCallbackProbe = async (
  request: WecomCallbackProbeRequest,
): Promise<WecomCallbackProbeResponse> => {
  const response = await fetch(request.url, {
    method: 'GET',
    // The operator's URL, so a redirect is either a misconfiguration or an
    // attempt to have this process reach somewhere the URL rules refused.
    redirect: 'error',
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await readBoundedText(response) };
};

/**
 * Read a response body as text, stopping at {@link CALLBACK_PROBE_MAX_BODY_BYTES}.
 *
 * @param response - The response being read.
 * @returns The decoded body, possibly truncated.
 */
async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > CALLBACK_PROBE_MAX_BODY_BYTES) {
      // Cancelled rather than read further: the bytes past the bound are never
      // held, and the verdict does not need them.
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
