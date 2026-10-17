import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  WecomCredentialResolution,
  WecomCredentialValues,
} from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import {
  TEST_CALLBACK_TOKEN,
  TEST_CORP_ID,
  TEST_ENCODING_AES_KEY,
  TEST_KF_SECRET,
  TEST_OPEN_KF_ID,
  wecomCallbackSignature,
} from '../../test/wecom-callback-support';
import type { WecomRealTransport } from './real-wecom.adapter';
import {
  CALLBACK_SELFCHECK_TIMEOUT_MS,
  WecomCallbackSelfCheckService,
  isPublicAddress,
  validateProbeTarget,
  type WecomCallbackProbe,
  type WecomCallbackProbeRequest,
  type WecomCallbackProbeResponse,
} from './wecom-callback-selfcheck.service';

/**
 * Answers the mocked `node:dns/promises` returns.
 *
 * `vi.hoisted` because the module factory is evaluated before this file's own
 * statements run: a plain `const` would still be in its temporal dead zone when
 * the service imports `lookup`.
 */
const dns = vi.hoisted(() => ({
  answers: [] as ReadonlyArray<{ readonly address: string }>,
  failure: null as Error | null,
}));

vi.mock('node:dns/promises', () => ({
  lookup: async (): Promise<ReadonlyArray<{ readonly address: string }>> => {
    if (dns.failure !== null) {
      throw dns.failure;
    }
    return dns.answers;
  },
}));

/** One public literal address, so the address rule needs no DNS answer. */
const PUBLIC_URL = 'https://93.184.216.34/api/v1/channels/wecom/callback';

/** The credential set a real deployment signs a handshake with. */
const VALUES: WecomCredentialValues = {
  corpId: TEST_CORP_ID,
  kfSecret: TEST_KF_SECRET,
  callbackToken: TEST_CALLBACK_TOKEN,
  aesKey: TEST_ENCODING_AES_KEY,
  openKfId: TEST_OPEN_KF_ID,
};

/** A reader that always resolves to one credential set. */
function readerOf(resolution: WecomCredentialResolution): WecomCredentialReader {
  return async () => resolution;
}

/** A reader answering with the set a deployment is configured to speak as. */
function readyReader(origin: 'console' | 'environment' = 'console'): WecomCredentialReader {
  return readerOf({ _tag: 'ready', values: VALUES, origin });
}

/** A reader answering that this deployment holds no usable set. */
function unconfiguredReader(): WecomCredentialReader {
  return readerOf({
    _tag: 'unconfigured',
    origin: 'environment',
    problems: [{ variable: 'WECOM_TOKEN', code: 'missing' }],
  });
}

/** How the stand-in deployment answers the handshake. */
type ProbeBehaviour = 'echo' | 'refuse' | 'other-body' | 'empty-body' | 'server-error' | 'throw';

/** One fake probe, with the requests it was called with. */
type ProbedUrls = {
  readonly probe: WecomCallbackProbe;
  readonly calls: WecomCallbackProbeRequest[];
};

/**
 * Stand in for the deployment that owns the public URL.
 *
 * Written as the *server* rather than as a canned answer: it checks the digest
 * it was sent against the callback token — with the format's own digest, not the
 * production helper — and opens the ciphertext with a decoder written from the
 * documented frame, refusing a payload minted for another corp exactly as the
 * real route does. A canned body would pass even if the check signed the wrong
 * bytes, framed the plaintext wrongly or appended no receiver id, which is
 * precisely what the check exists to catch in a deployment.
 *
 * A factory rather than a class, because the port is a function: a class
 * instance with a `probe` method is not the thing the service calls.
 *
 * @param behaviour - How this stand-in answers.
 * @returns The probe and an array of the requests it received.
 */
function echoingProbe(behaviour: ProbeBehaviour = 'echo'): ProbedUrls {
  const calls: WecomCallbackProbeRequest[] = [];
  const probe: WecomCallbackProbe = async (
    request: WecomCallbackProbeRequest,
  ): Promise<WecomCallbackProbeResponse> => {
    calls.push(request);
    switch (behaviour) {
      case 'throw':
        // Shaped like Node's `fetch`, which reports every transport failure with
        // the real reason on `cause`.
        throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      case 'server-error':
        return { status: 502, body: 'bad gateway' };
      case 'other-body':
        return { status: 200, body: '<html>nothing to see here</html>' };
      case 'empty-body':
        return { status: 200, body: '' };
      case 'refuse':
        // What this deployment answers a signature it will not accept: the
        // platform's own error envelope.
        return { status: 200, body: refusalEnvelope('the signature does not match') };
      default: {
        const url = new URL(request.url);
        const param = (name: string): string => url.searchParams.get(name) ?? '';
        const ciphertext = param('echostr');
        const expected = wecomCallbackSignature(
          TEST_CALLBACK_TOKEN,
          param('timestamp'),
          param('nonce'),
          ciphertext,
        );
        if (expected !== param('msg_signature')) {
          return { status: 200, body: refusalEnvelope('the signature does not match') };
        }
        const opened = openFrame(TEST_ENCODING_AES_KEY, ciphertext);
        if (opened.receiveId !== TEST_CORP_ID) {
          return {
            status: 200,
            body: refusalEnvelope('the payload was encrypted for a different receiver id'),
          };
        }
        return { status: 200, body: opened.message };
      }
    }
  };
  return { probe, calls };
}

/** The platform error envelope a deployment answers a refused request with. */
function refusalEnvelope(message: string): string {
  return JSON.stringify({ code: 'unauthorized', message });
}

/** Build the service under test over the fakes a case needs. */
function serviceOf(input: {
  readonly probe: WecomCallbackProbe;
  readonly credentials?: WecomCredentialReader;
  readonly transport?: WecomRealTransport | null;
}): WecomCallbackSelfCheckService {
  return new WecomCallbackSelfCheckService(
    input.transport === undefined ? ({} as WecomRealTransport) : input.transport,
    input.credentials ?? readyReader(),
    input.probe,
  );
}

describe('WecomCallbackSelfCheckService', () => {
  it('reports a handshake that round-trips, naming what it proved', async () => {
    const fake = echoingProbe();
    const verdict = await serviceOf({ probe: fake.probe }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({
      ok: true,
      stage: 'ok',
      http_status: 200,
      probed_url: 'https://93.184.216.34/api/v1/channels/wecom/callback',
      credential_source: 'console',
    });
    expect(fake.calls).toHaveLength(1);
    expect(verdict.checked_at).toBe(new Date(verdict.checked_at).toISOString());
  });

  it('never puts the callback token or the AES key on the wire', async () => {
    const fake = echoingProbe();
    await serviceOf({ probe: fake.probe }).check(PUBLIC_URL);

    const request = fake.calls[0];
    expect(request).toBeDefined();
    expect(request?.url).not.toContain(TEST_CALLBACK_TOKEN);
    expect(request?.url).not.toContain(TEST_ENCODING_AES_KEY);
    expect(request?.timeoutMs).toBe(CALLBACK_SELFCHECK_TIMEOUT_MS);
  });

  it('carries all four handshake parameters, on the operator’s own query string', async () => {
    const fake = echoingProbe();
    await serviceOf({ probe: fake.probe }).check(`${PUBLIC_URL}?deployment=blue`);

    const params = new URL(fake.calls[0]?.url ?? '').searchParams;
    expect(params.get('deployment')).toBe('blue');
    for (const name of ['msg_signature', 'timestamp', 'nonce', 'echostr']) {
      expect(params.get(name)).toBeTruthy();
    }
  });

  it('names the platform refusal when the address is right and the credentials are not', async () => {
    const verdict = await serviceOf({ probe: echoingProbe('refuse').probe }).check(PUBLIC_URL);

    expect(verdict.ok).toBe(false);
    expect(verdict.stage).toBe('plaintext');
    expect(verdict.detail).toContain('unauthorized');
    expect(verdict.http_status).toBe(200);
  });

  it('describes a 200 that is not the plaintext without echoing the body', async () => {
    const verdict = await serviceOf({ probe: echoingProbe('other-body').probe }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: false, stage: 'plaintext' });
    expect(verdict.detail).toContain('not the plaintext it was sent');
    expect(verdict.detail).not.toContain('nothing to see here');
  });

  it('tells an empty body apart from a body that is merely wrong', async () => {
    const verdict = await serviceOf({ probe: echoingProbe('empty-body').probe }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: false, stage: 'plaintext' });
    expect(verdict.detail).toContain('empty body');
  });

  it('reports a status WeCom would read as a failure to deliver', async () => {
    const verdict = await serviceOf({ probe: echoingProbe('server-error').probe }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: false, stage: 'status', http_status: 502 });
    expect(verdict.detail).toContain('502');
  });

  it('reports the reason a request could not be completed, including its cause', async () => {
    const verdict = await serviceOf({ probe: echoingProbe('throw').probe }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: false, stage: 'request', http_status: null });
    expect(verdict.detail).toContain('ECONNREFUSED');
    expect(verdict.probed_url).toBe('https://93.184.216.34/api/v1/channels/wecom/callback');
  });

  it('refuses a non-public address before making any request', async () => {
    const fake = echoingProbe();
    const verdict = await serviceOf({ probe: fake.probe }).check(
      'https://127.0.0.1/api/v1/channels/wecom/callback',
    );

    expect(verdict).toMatchObject({ ok: false, stage: 'url', probed_url: null });
    expect(verdict.detail).toContain('127.0.0.1');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a name that resolves to a private address even beside a public one', async () => {
    dns.answers = [{ address: '93.184.216.34' }, { address: '10.0.0.7' }];
    dns.failure = null;
    const fake = echoingProbe();
    try {
      const verdict = await serviceOf({ probe: fake.probe }).check('https://kefu.example.com/callback');
      expect(verdict).toMatchObject({ ok: false, stage: 'url' });
      expect(verdict.detail).toContain('10.0.0.7');
      expect(fake.calls).toHaveLength(0);
    } finally {
      dns.answers = [];
    }
  });

  it('probes a name that resolves only to public addresses', async () => {
    dns.answers = [{ address: '93.184.216.34' }];
    dns.failure = null;
    const fake = echoingProbe();
    try {
      const verdict = await serviceOf({ probe: fake.probe }).check('https://kefu.example.com/callback');
      expect(verdict.ok).toBe(true);
      expect(verdict.probed_url).toBe('https://kefu.example.com/callback');
    } finally {
      dns.answers = [];
    }
  });

  it('reports a host that does not resolve at all', async () => {
    dns.failure = Object.assign(new Error('getaddrinfo ENOTFOUND kefu.invalid'), {
      code: 'ENOTFOUND',
    });
    const fake = echoingProbe();
    try {
      const verdict = await serviceOf({ probe: fake.probe }).check('https://kefu.invalid/callback');
      expect(verdict).toMatchObject({ ok: false, stage: 'url' });
      expect(verdict.detail).toContain('did not resolve');
      expect(fake.calls).toHaveLength(0);
    } finally {
      dns.failure = null;
    }
  });

  it('refuses a URL that is not https before reading a credential', async () => {
    const credentials = vi.fn(unconfiguredReader());
    const fake = echoingProbe();
    const verdict = await serviceOf({ probe: fake.probe, credentials }).check(
      'http://93.184.216.34/api/v1/channels/wecom/callback',
    );

    expect(verdict).toMatchObject({ ok: false, stage: 'url' });
    expect(verdict.detail).toContain('https');
    expect(credentials).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a deployment with no usable credential set, before any request', async () => {
    const fake = echoingProbe();
    const verdict = await serviceOf({ probe: fake.probe, credentials: unconfiguredReader() }).check(
      PUBLIC_URL,
    );

    expect(verdict).toMatchObject({ ok: false, stage: 'credentials', credential_source: null });
    expect(verdict.detail).toContain('WECOM_TOKEN');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a build that binds the mock transport', async () => {
    const fake = echoingProbe();
    const verdict = await serviceOf({ probe: fake.probe, transport: null }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: false, stage: 'transport' });
    expect(verdict.detail).toContain('WECOM_TRANSPORT');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports which credential set signed a passing check', async () => {
    const fake = echoingProbe();
    const verdict = await serviceOf({
      probe: fake.probe,
      credentials: readyReader('environment'),
    }).check(PUBLIC_URL);

    expect(verdict).toMatchObject({ ok: true, credential_source: 'environment' });
    expect(verdict.detail).toContain('environment');
  });
});

describe('validateProbeTarget', () => {
  it('accepts an https URL and reports its parts', () => {
    const target = validateProbeTarget(`  ${PUBLIC_URL}  `);
    expect(target.ok).toBe(true);
    expect(target.ok && target.url.hostname).toBe('93.184.216.34');
  });

  it('refuses what a URL may not be', () => {
    expect(validateProbeTarget('').ok).toBe(false);
    expect(validateProbeTarget('   ').ok).toBe(false);
    expect(validateProbeTarget('kefu.example.com/callback').ok).toBe(false);
    expect(validateProbeTarget('https://user:secret@kefu.example.com/callback').ok).toBe(false);
    expect(validateProbeTarget('https://kefu.example.com/callback#fragment').ok).toBe(false);
    expect(validateProbeTarget('ftp://kefu.example.com/callback').ok).toBe(false);
  });

  it('says which rule a refused URL broke', () => {
    const credentials = validateProbeTarget('https://user:secret@kefu.example.com/callback');
    expect(credentials.ok).toBe(false);
    expect(credentials.ok === false && credentials.reason).toContain('credentials');

    const fragment = validateProbeTarget('https://kefu.example.com/callback#fragment');
    expect(fragment.ok === false && fragment.reason).toContain('fragment');
  });
});

describe('isPublicAddress', () => {
  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '203.0.113.9',
    '2606:2800:220:1:248:1893:25c8:1946',
  ])('accepts the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-address',
  ])('refuses the address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('accepts an IPv4-mapped public address', () => {
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true);
  });
});

/**
 * Open a self-check ciphertext from the documented frame alone.
 *
 * Not the production reader: this is the other half of the pair the self-check
 * mints, and a test that reused `decryptWecomPayload` would agree with a framing
 * mistake in either direction.
 *
 * @param encodingAesKey - The 43-character `EncodingAESKey`.
 * @param ciphertext - Base64 ciphertext the check sent.
 * @returns The message and the receiver id the frame carried.
 */
function openFrame(
  encodingAesKey: string,
  ciphertext: string,
): { readonly message: string; readonly receiveId: string } {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  const messageLength = plain.readUInt32BE(16);
  return {
    message: plain.subarray(20, 20 + messageLength).toString('utf8'),
    receiveId: plain.subarray(20 + messageLength).toString('utf8'),
  };
}
