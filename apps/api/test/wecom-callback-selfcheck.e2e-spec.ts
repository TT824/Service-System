import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ADMIN_MEMBER_ID } from '@kefu/core';
import { WECOM_HTTP_CLIENT } from '@kefu/wecom';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { resetWecomConnectionState } from '../src/channels/wecom-transport';
import {
  WECOM_CALLBACK_PROBE,
  type WecomCallbackProbe,
} from '../src/channels/wecom-callback-selfcheck.service';
import { FakeWecomHttp, realWecomConfig } from './wecom-callback-support';

/**
 * Interface tests for the callback self-check route.
 *
 * The one thing faked here is the network hop: the probe is replaced with a
 * client that turns the URL it was handed into a request against this very
 * application. Everything else is production — the platform-administrator
 * guard, the body read under the raw-callback prefix, the credential resolution,
 * the frame and the digest the check mints, and the real `GET
 * /wecom/callback` handler that decrypts them. A passing verdict therefore
 * proves the two halves of the handshake agree, which is the whole claim the
 * route makes.
 *
 * What it does not prove is that a real socket, a real certificate and a real
 * WeCom console agree with that — none of which a test can reach.
 */

/** The public address the operator would register, in its public-literal form. */
const CALLBACK_URL = 'https://93.184.216.34/api/v1/channels/wecom/callback';

/** A seat: reaches every route, refused by the ones that are not its to use. */
const AGENT_MEMBER_ID = 'u-t1-agent-1';

/** How the stand-in network answers this suite's checks. */
type ProbeMode = 'loopback' | 'corrupt-signature' | 'wrong-body' | 'down';

/** Flipped per test; the bound probe reads it at call time. */
let probeMode: ProbeMode = 'loopback';

/** The booted application, so the loopback probe can reach its own routes. */
let app: INestApplication;

/** A fake provider, so binding the adapter at boot opens no socket. */
const http = new FakeWecomHttp(() => ({
  status: 200,
  body: { errcode: 0, errmsg: 'ok', access_token: 'test-access-token', expires_in: 7200 },
}));

/**
 * Send the handshake back to the application that asked for it.
 *
 * `loopback` is the honest case: the URL's path and query are replayed against
 * this application's own callback route, so the check is answered by the code
 * that would answer WeCom. The other modes stand in for the ways a real URL
 * disappoints: a deployment that refuses the digest, one that answers something
 * else, and one that does not answer at all.
 */
const loopbackProbe: WecomCallbackProbe = async (probeRequest) => {
  const url = new URL(probeRequest.url);
  if (probeMode === 'down') {
    throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED') });
  }
  if (probeMode === 'wrong-body') {
    return { status: 200, body: '<html>this is not the handshake you are looking for</html>' };
  }
  const params = new URLSearchParams(url.search);
  if (probeMode === 'corrupt-signature') {
    params.set('msg_signature', '0'.repeat(40));
  }
  const response = await request(app.getHttpServer()).get(`${url.pathname}?${params.toString()}`);
  return { status: response.status, body: response.text };
};

beforeAll(async () => {
  resetWecomConnectionState();
  const config = realWecomConfig();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(WECOM_HTTP_CLIENT)
    .useValue(http)
    .overrideProvider(WECOM_CALLBACK_PROBE)
    .useValue(loopbackProbe)
    .compile();
  app = moduleRef.createNestApplication();
  applyHttpDefaults(app, config);
  await app.init();
  attachJsonLogger(app);
});

afterAll(async () => {
  await app.close();
});

/** POST one self-check as the platform administrator. */
function checkAs(memberId: string, url = CALLBACK_URL, tenantId?: string): request.Test {
  const call = request(app.getHttpServer())
    .post('/api/v1/channels/wecom/callback-selfcheck')
    .set('x-member-id', memberId);
  if (tenantId !== undefined) {
    call.set('x-tenant-id', tenantId);
  }
  return call.send({ url });
}

/** One self-check verdict, as the route returns it. */
type Verdict = {
  readonly ok: boolean;
  readonly stage: string;
  readonly detail: string;
  readonly http_status: number | null;
  readonly probed_url: string | null;
  readonly credential_source: string | null;
  readonly checked_at: string;
};

/**
 * Read the verdict out of the platform envelope.
 *
 * Every successful route answers inside `{ data, meta, request_id }`, and a
 * verdict is a successful answer even when it found a problem — so the check's
 * fields are one level down, exactly as they are for every other route.
 *
 * @param response - The response the route returned.
 * @returns The verdict it carried.
 */
function verdictOf(response: request.Response): Verdict {
  return (response.body as { readonly data: Verdict }).data;
}

describe('POST /api/v1/channels/wecom/callback-selfcheck', () => {
  it('answers platform administrators with a passing round trip', async () => {
    probeMode = 'loopback';
    const response = await checkAs(PLATFORM_ADMIN_MEMBER_ID).expect(200);
    const verdict = verdictOf(response);

    expect(verdict.ok).toBe(true);
    expect(verdict.stage).toBe('ok');
    expect(verdict.http_status).toBe(200);
    // The environment set, because this boot stores nothing in the console.
    expect(verdict.credential_source).toBe('environment');
    expect(verdict.probed_url).toBe(CALLBACK_URL);
    expect(verdict.checked_at).toBe(new Date(verdict.checked_at).toISOString());
  });

  it('never returns the signature or the ciphertext it probed with', async () => {
    probeMode = 'loopback';
    const response = await checkAs(PLATFORM_ADMIN_MEMBER_ID).expect(200);
    const body = response.text;

    // The probed URL is reported without the check's own query string, so a
    // replayable handshake does not end up in a response body or a browser log.
    expect(body).not.toContain('msg_signature');
    expect(body).not.toContain('echostr');
  });

  it('reports a deployment that refuses the digest, without inventing a cause', async () => {
    probeMode = 'corrupt-signature';
    const response = await checkAs(PLATFORM_ADMIN_MEMBER_ID).expect(200);
    const verdict = verdictOf(response);

    expect(verdict.ok).toBe(false);
    expect(verdict.stage).toBe('status');
    expect(verdict.http_status).not.toBe(200);
    expect(verdict.detail).toContain('instead of 200');
  });

  it('reports a URL that answers something other than the handshake', async () => {
    probeMode = 'wrong-body';
    const response = await checkAs(PLATFORM_ADMIN_MEMBER_ID).expect(200);
    const verdict = verdictOf(response);

    expect(verdict).toMatchObject({ ok: false, stage: 'plaintext', http_status: 200 });
    // The body belongs to a server nobody has vetted and is never echoed back.
    expect(verdict.detail).not.toContain('not the handshake you are looking for');
  });

  it('reports a URL that does not answer at all', async () => {
    probeMode = 'down';
    const response = await checkAs(PLATFORM_ADMIN_MEMBER_ID).expect(200);
    const verdict = verdictOf(response);

    expect(verdict).toMatchObject({ ok: false, stage: 'request', http_status: null });
    expect(verdict.detail).toContain('ECONNREFUSED');
  });

  it('refuses a seat, which is the identity the console never has', async () => {
    const denied = await checkAs(AGENT_MEMBER_ID, CALLBACK_URL, 'tenant-acme');
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe('forbidden');
  });

  it('refuses a body with no URL, and a URL that is not usable', async () => {
    const missing = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/callback-selfcheck')
      .set('x-member-id', PLATFORM_ADMIN_MEMBER_ID)
      .send({});
    expect(missing.status).toBe(400);
    expect((missing.body as { code: string }).code).toBe('bad_request');

    // An unusable URL is a verdict rather than a request failure: the check ran
    // and this is what it found, which is what the console renders.
    const unusable = await checkAs(PLATFORM_ADMIN_MEMBER_ID, 'http://kefu.example.com/callback');
    expect(unusable.status).toBe(200);
    expect(verdictOf(unusable)).toMatchObject({ ok: false, stage: 'url' });
  });

  it('refuses an internal address rather than probing it', async () => {
    const internal = await checkAs(PLATFORM_ADMIN_MEMBER_ID, 'https://127.0.0.1/callback').expect(
      200,
    );
    expect(verdictOf(internal).stage).toBe('url');
    expect(verdictOf(internal).detail).toContain('127.0.0.1');

    const metadata = await checkAs(
      PLATFORM_ADMIN_MEMBER_ID,
      'https://169.254.169.254/latest/meta-data/',
    ).expect(200);
    expect(verdictOf(metadata).stage).toBe('url');
  });
});
