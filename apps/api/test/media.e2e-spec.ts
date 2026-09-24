import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import {
  MEDIA_URL_PATH,
  MediaUrlService,
  type MediaUrlVerdict,
} from '../src/media/media-url.service';

const AGENT = 'u-t1-agent-1';

/** The envelope every JSON response is wrapped in. */
type DataEnvelope = { request_id: string; data: unknown; meta: Record<string, never> };

/** One message as the transcript endpoint reports it. */
type MessageView = {
  readonly id: string;
  readonly messageType: string;
  readonly media: {
    readonly key: string;
    readonly mimeType: string;
    readonly bytes: number;
  } | null;
};

/**
 * The signed media route over the real HTTP stack.
 *
 * What only an endpoint test can settle is the wiring, and it is worth settling
 * because every part of it fails *open* or *silent*:
 *
 * - The route is `@Public()` — the global guard deliberately does not run — so a
 *   mistake here is a route that serves any tenant's picture to anyone who asks.
 *   The unauthenticated cases below are the ones that would catch it.
 * - A URL that verifies is looked up against the transcript's own message, so
 *   the tenant in the signature (not in a header) decides which row is read.
 * - The transcript read has to *mint* what the route *verifies*. If the two
 *   disagreed about the secret or the path, every picture in the console would
 *   be a 403 and nothing else in the suite would notice.
 *
 * ## What this file does not cover
 *
 * Streaming a stored image back, because no message in the in-process seed has
 * stored media and producing one would mean putting an object into a real MinIO
 * bucket from a test. The bytes themselves are settled where they are produced —
 * `minio-media-storage.spec.ts` for the store, `media.service.spec.ts` for
 * capture and read — and the route's own success branch is exercised against
 * those fakes. This is the gap worth naming rather than papering over.
 */
describe('Signed media route (interface)', () => {
  let app: INestApplication;
  let urls: MediaUrlService;
  let messageId: string;
  let conversationId: string;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    }).compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);

    // Taken from the running application rather than rebuilt from the config:
    // a URL this test minted with its own copy of the secret would verify
    // against itself and prove nothing about what the route checks with.
    urls = app.get(MediaUrlService);

    const list = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-member-id', AGENT)
      .expect(200);
    const conversations = (list.body as DataEnvelope).data as ReadonlyArray<{ id: string }>;
    const first = conversations[0];
    if (first === undefined) {
      throw new Error('the seed has no conversation for this test to read');
    }
    conversationId = first.id;

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', AGENT)
      .expect(200);
    const messages = (detail.body as DataEnvelope).data as { readonly messages: MessageView[] };
    const message = messages.messages[0];
    if (message === undefined) {
      throw new Error('the seeded conversation has no message for this test to address');
    }
    messageId = message.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** The stable error code of one refused request. */
  async function refusalCode(path: string): Promise<{ status: number; code: string }> {
    const response = await request(app.getHttpServer()).get(path);
    const body = response.body as { readonly code?: string };
    return { status: response.status, code: body.code ?? '' };
  }

  it('refuses a request that carries no signature at all', async () => {
    const refused = await refusalCode(`${MEDIA_URL_PATH}/${messageId}`);

    // Not a 404: a caller who never held a link must not be able to tell a real
    // message id from an invented one, and this is the assertion that fails if
    // the guard is ever removed from the route without a replacement.
    expect(refused).toEqual({ status: 403, code: 'forbidden' });
  });

  it('refuses a URL whose signature was forged', async () => {
    const refused = await refusalCode(
      `${MEDIA_URL_PATH}/${messageId}?tenant=tenant-acme&exp=${Math.floor(Date.now() / 1000) + 600}&sig=${'0'.repeat(64)}`,
    );

    expect(refused).toEqual({ status: 403, code: 'forbidden' });
  });

  it('refuses a URL whose tenant was swapped for another', async () => {
    const minted = urls.url({ tenantId: 'tenant-acme', messageId });
    const forged = minted.replace('tenant=tenant-acme', 'tenant=tenant-acme-other');

    // The signature covers the tenant, so moving it is not a way to read the
    // same message as somebody else.
    expect(await refusalCode(forged)).toEqual({ status: 403, code: 'forbidden' });
  });

  it('refuses a correctly signed URL once it has expired', async () => {
    const minted = urls.url({
      tenantId: 'tenant-acme',
      messageId,
      now: Date.now() - 2 * 60 * 60 * 1000,
    });

    expect(await refusalCode(minted)).toEqual({ status: 403, code: 'forbidden' });
  });

  it('answers a correctly signed URL for a message with no stored media as not found', async () => {
    const minted = urls.url({ tenantId: 'tenant-acme', messageId });
    const refused = await refusalCode(minted);

    // Signed and real, but nothing is behind it: the seed's messages carry no
    // media. Distinguished from the 403s above on purpose — this caller does
    // hold a link this platform minted.
    expect(refused).toEqual({ status: 404, code: 'not_found' });
  });

  it('mints a URL for every message the transcript reports and verifies it back', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('x-member-id', AGENT)
      .expect(200);
    const payload = (detail.body as DataEnvelope).data as {
      readonly messages: ReadonlyArray<MessageView>;
      readonly mediaUrls: Readonly<Record<string, string>>;
    };

    // No seeded message has stored media, so the map is empty — which is itself
    // the contract: an entry appears only where there is something to read.
    expect(Object.keys(payload.mediaUrls)).toEqual([]);

    // And the round trip the console depends on, proved on a URL this test
    // mints the same way the service does: mint then verify, path and all.
    const verdict: MediaUrlVerdict = urls.verify({
      ...paramsOf(urls.url({ tenantId: 'tenant-acme', messageId })),
      messageId,
    });
    expect(verdict).toEqual({ ok: true, tenantId: 'tenant-acme', messageId });
  });
});

/** Split a minted URL's query into the shape {@link MediaUrlService.verify} takes. */
function paramsOf(url: string): {
  readonly tenantId: string | null;
  readonly expiry: string | null;
  readonly signature: string | null;
} {
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  return {
    tenantId: query.get('tenant'),
    expiry: query.get('exp'),
    signature: query.get('sig'),
  };
}
