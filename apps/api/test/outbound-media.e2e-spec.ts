import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KefuStore, parseAppConfig, type Message } from '@kefu/core';
import { AppModule } from '../src/app.module';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { MEDIA_STORAGE, outboundMediaObjectKey } from '../src/media/media-storage';
import { MemoryMediaStorage } from './media-storage-support';

const T1 = 'tenant-acme';
/** The seat the seeded open conversation is assigned to. */
const AGENT_1 = 'u-t1-agent-1';
/** A colleague in the same store, who is not the assignee. */
const AGENT_2 = 'u-t1-agent-2';
/** The seeded conversation claimed by {@link AGENT_1}, and open. */
const CONVERSATION = 'conversation-acme-1';
/** The seeded conversation that is already closed. */
const CLOSED_CONVERSATION = 'conversation-acme-3';
/** A one-pixel PNG: the smallest picture the platform will accept. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type DataEnvelope = { request_id: string; data: unknown };
type ErrorEnvelope = { request_id: string; code: string; message: string; details?: unknown };

/** One message as the transcript endpoint reports it. */
type MessageView = Message & {
  readonly media: {
    readonly key: string;
    readonly mimeType: string;
    readonly bytes: number;
    readonly name: string | null;
    readonly providerMediaId: string | null;
  } | null;
};

/** What the send answers: the recorded message and its delivery projection. */
type DispatchedView = {
  readonly message: MessageView;
  readonly delivery: { readonly status: string };
};

/**
 * Sending a customer a picture, a clip or a document, over the real HTTP stack.
 *
 * What only an endpoint test can settle is the *order*, and the order is the
 * whole feature: the platform's own copy has to be written before the provider
 * is asked for its handle, and the message row that names both has to come last.
 * A unit test of the service cannot see that, because the two writes are two
 * different ports and only the endpoint wires both of them.
 *
 * The cases that would fail *silently* are the refusals: a file this platform
 * will not send must be refused **before** anything is uploaded, or a seat gets
 * a provider error about bytes they never sent, and an operator finds an object
 * in the bucket that no message points at. Every refusal below therefore asserts
 * on `storage.writes` as well as on the status, which is the difference between
 * "the response was a 400" and "nothing was uploaded".
 *
 * ## Why this file binds the mock transport
 *
 * `WECOM_TRANSPORT=mock`, the same way `channel-loop.e2e-spec.ts` boots. The
 * real adapter is bound in this deployment without credentials, and its
 * `uploadMedia` refuses with `channel_not_configured` — which is honest, but it
 * means a happy path could not be exercised at all. The difference matters
 * because the two halves fail differently: a *delivery* failure is recorded as a
 * value and still answers `201`, while an *upload* failure is thrown before the
 * message exists. Only the mock's `uploadMedia` answers, and it answers without
 * network I/O.
 *
 * ## What this file does not cover
 *
 * Anything on a real WeCom account. What is proven here is the platform's own
 * half: validation, our copy, the row, the transcript, the signed read-back.
 * Whether the provider accepts the upload, and what its size ceilings really
 * are, is settled nowhere yet — the credentials are not in hand.
 */
describe('outbound media messages (e2e)', () => {
  let app: INestApplication;
  let store: KefuStore;
  /** The object store, in a map — see `media-storage-support.ts`. */
  const storage = new MemoryMediaStorage();

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(parsed.config)],
    })
      .overrideProvider(MEDIA_STORAGE)
      .useValue(storage)
      .compile();

    app = moduleRef.createNestApplication();
    applyHttpDefaults(app, parsed.config);
    await app.init();
    attachJsonLogger(app);
    store = app.get(KefuStore);
  });

  afterAll(async () => {
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  beforeEach(() => {
    // Booted once for the whole file, so the store and the object map are
    // shared: a test that asserts "nothing was uploaded" must not inherit the
    // previous test's writes, and one that asserts "the transcript grew" must
    // have a transcript to grow from.
    storage.objects.clear();
    storage.writes.length = 0;
    storage.failure = null;
    (store as unknown as { seed: () => void }).seed();
  });

  /** Identity headers for a demo seat, the way the non-production guard reads them. */
  const as = (memberId: string, tenantId = T1): Record<string, string> => ({
    'x-member-id': memberId,
    'x-tenant-id': tenantId,
  });

  /**
   * Post one file to the media send route, the way the browser does.
   *
   * Returns supertest's thenable rather than a promise, so a test can chain
   * `.expect(...)` onto it and still `await`.
   */
  const sendFile = (
    memberId: string,
    bytes: Buffer,
    filename: string,
    contentType: string,
    options: {
      readonly conversationId?: string;
      readonly fields?: Readonly<Record<string, string>>;
    } = {},
  ) => {
    const pending = request(app.getHttpServer())
      .post(
        `/api/v1/conversations/${options.conversationId ?? CONVERSATION}/messages/media`,
      )
      .set(as(memberId))
      .attach('file', bytes, { filename, contentType });
    for (const [name, value] of Object.entries(options.fields ?? {})) {
      pending.field(name, value);
    }
    return pending;
  };

  /** One conversation's transcript, as the workspace reads it. */
  const transcriptOf = async (
    conversationId = CONVERSATION,
  ): Promise<{
    readonly messages: ReadonlyArray<MessageView>;
    readonly mediaUrls: Readonly<Record<string, string>>;
  }> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set(as(AGENT_1))
      .expect(200);
    return (response.body as DataEnvelope).data as {
      readonly messages: ReadonlyArray<MessageView>;
      readonly mediaUrls: Readonly<Record<string, string>>;
    };
  };

  it('sends a picture, keeps our own copy, and records the provider handle', async () => {
    const response = await sendFile(AGENT_1, ONE_PIXEL_PNG, '对账单.png', 'image/png').expect(201);
    const { message } = (response.body as DataEnvelope).data as DispatchedView;

    expect(message.messageType).toBe('image');
    // The content is derived, not taken from the request: the channel's picture
    // message carries no text, and `[图片消息]` is what the transcript falls back
    // to when the media cannot be shown at all.
    expect(message.content).toBe('[图片消息]');
    expect(message.media).toMatchObject({
      mimeType: 'image/png',
      bytes: ONE_PIXEL_PNG.byteLength,
      name: '对账单.png',
    });
    expect(message.media?.providerMediaId).toMatch(/^mock-media-\d+$/);

    // Our own copy, under the namespace the outbound key builds — not the
    // inbound `messages/` one — and holding the bytes that were sent.
    const key = outboundMediaObjectKey(T1, 'x');
    const prefix = key.slice(0, key.length - 1);
    expect(message.media?.key.startsWith(prefix)).toBe(true);
    expect(storage.objects.get(message.media?.key ?? '')?.bytes).toEqual(ONE_PIXEL_PNG);

    // The transcript shows the message and mints a URL for it, and that URL
    // verifies back through the signed route — which is what makes the picture
    // visible in the console without a second upload path.
    const transcript = await transcriptOf();
    expect(transcript.messages.some((entry) => entry.id === message.id)).toBe(true);
    const url = transcript.mediaUrls[message.id];
    expect(typeof url).toBe('string');
    await request(app.getHttpServer()).get(url ?? '').expect(200);
  });

  it('sends a document under the seat’s own file name', async () => {
    const response = await sendFile(
      AGENT_1,
      Buffer.from('%PDF-1.4 outbound test'),
      '报价单.pdf',
      'application/pdf',
    ).expect(201);
    const { message } = (response.body as DataEnvelope).data as DispatchedView;

    expect(message.messageType).toBe('file');
    // A document's name is most of the message and is what the customer reads
    // on the bubble, so it *is* the content; a picture's name is noise.
    expect(message.content).toBe('报价单.pdf');
    expect(message.media).toMatchObject({ mimeType: 'application/pdf', name: '报价单.pdf' });
  });

  it('carries the message source and dedup key a retry would send', async () => {
    const response = await sendFile(AGENT_1, ONE_PIXEL_PNG, '对账单.png', 'image/png', {
      fields: { source: 'manual_typed', dedupKey: 'media-dedup-1' },
    }).expect(201);
    const { message } = (response.body as DataEnvelope).data as DispatchedView;

    const transcript = await transcriptOf();
    const stored = transcript.messages.find((entry) => entry.id === message.id);
    expect(stored).toMatchObject({ source: 'manual_typed', dedupKey: 'media-dedup-1' });
  });

  it('refuses a colleague who is not the assigned seat, and uploads nothing', async () => {
    const response = await sendFile(AGENT_2, ONE_PIXEL_PNG, '对账单.png', 'image/png').expect(403);
    expect((response.body as ErrorEnvelope).code).toBe('forbidden');
    expect(storage.writes).toHaveLength(0);
  });

  it('refuses a closed conversation, and uploads nothing', async () => {
    const response = await sendFile(AGENT_1, ONE_PIXEL_PNG, '对账单.png', 'image/png', {
      conversationId: CLOSED_CONVERSATION,
    }).expect(409);
    expect((response.body as ErrorEnvelope).code).toBe('conflict');
    expect(storage.writes).toHaveLength(0);
  });

  it('refuses files it will not send, and uploads nothing', async () => {
    // The four refusals a seat can actually cause, each with the sentence the
    // seat has to be able to act on. All four happen before any upload: a file
    // this platform will not send must not reach the bucket or the provider.
    //
    // The unnameable one is spaces rather than an empty string, because an empty
    // `filename` is not a file part at all: busboy drops the part and the route
    // answers its own "send it as the field `file`" — which the next test covers.
    // A name that *cleans* to nothing is the case only this gate can catch.
    const refusals: ReadonlyArray<{
      readonly bytes: Buffer;
      readonly filename: string;
      readonly contentType: string;
      readonly detail: string;
    }> = [
      {
        bytes: Buffer.from('<svg/>'),
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
        detail: 'not an accepted image or video type',
      },
      {
        bytes: ONE_PIXEL_PNG,
        filename: '   ',
        contentType: 'image/png',
        detail: 'the file must have a name',
      },
      {
        bytes: Buffer.alloc(0),
        filename: 'empty.png',
        contentType: 'image/png',
        detail: 'the file is empty',
      },
      {
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
        filename: 'huge.png',
        contentType: 'image/png',
        detail: 'larger than',
      },
    ];
    for (const refusal of refusals) {
      const response = await sendFile(
        AGENT_1,
        refusal.bytes,
        refusal.filename,
        refusal.contentType,
      ).expect(400);
      const body = response.body as ErrorEnvelope;
      expect(body.code).toBe('bad_request');
      // The reason travels in `details`, not in `message`: the global filter
      // replaces every message with the status's own text and forwards only an
      // array payload, so a string here would reach the seat as "Bad Request".
      const details = Array.isArray(body.details) ? (body.details as string[]) : [];
      expect(details.join(' ')).toContain(refusal.detail);
    }
    expect(storage.writes).toHaveLength(0);
  });

  it('refuses a request that names no file at all', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${CONVERSATION}/messages/media`)
      .set(as(AGENT_1))
      .field('source', 'manual_typed')
      .expect(400);
    expect((response.body as ErrorEnvelope).message).toBe('Bad Request');
    expect(storage.writes).toHaveLength(0);
  });

  it('answers 503 when the object store is down, and writes no message', async () => {
    // The bytes are written before the row, on purpose: a crash between the two
    // must leave an object nobody references rather than a transcript promising
    // a file that does not exist. So a store that refuses means no message.
    storage.failure = { code: 'media_store_unreachable', reason: 'refused the connection' };
    const before = (await transcriptOf()).messages.length;

    const response = await sendFile(AGENT_1, ONE_PIXEL_PNG, '对账单.png', 'image/png').expect(503);
    const body = response.body as ErrorEnvelope;
    expect(body.code).toBe('service_unavailable');
    expect(Array.isArray(body.details) ? (body.details as string[]).join(' ') : '').toContain(
      '附件存储',
    );
    expect((await transcriptOf()).messages).toHaveLength(before);
  });

  it('still sends a plain text message with no media', async () => {
    // The regression that matters most: the media route shares its gate,
    // authorization and announcement with the text one, and a change that made
    // every send require a file would leave the console unable to answer at all.
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${CONVERSATION}/messages`)
      .set(as(AGENT_1))
      .send({ content: '已为您登记，稍后寄出', source: 'manual_typed' })
      .expect(201);
    const { message } = (response.body as DataEnvelope).data as DispatchedView;

    expect(message.messageType).toBe('text');
    expect(message.media).toBeNull();
    expect(storage.writes).toHaveLength(0);
  });
});
