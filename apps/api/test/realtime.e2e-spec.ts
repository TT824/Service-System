import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KefuStore, parseAppConfig, type RealtimeEvent } from '@kefu/core';
import {
  MOCK_WECOM_FAIL_TRIGGER,
  MOCK_WECOM_SIGNATURE,
  MOCK_WECOM_SIGNATURE_HEADER,
} from '@kefu/wecom';
import { AppModule } from '../src/app.module';
import { AssignmentScheduler } from '../src/assignment/assignment-scheduler';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';

const T1 = 'tenant-acme';
const T2 = 'tenant-beta';
const S1 = 'store-acme-flagship';
/** A second store of the same tenant, so a store refusal is about the store. */
const S2 = 'store-acme-distribution';
/** A store of the *other* tenant, so a tenant refusal is about the tenant. */
const S3 = 'store-beta-official';
const AGENT_1 = 'u-t1-agent-1';
const ADMIN_1 = 'u-t1-admin';
const AGENT_T2 = 'u-t2-agent-1';
const PLATFORM_ADMIN = 'u-platform-admin';
const REALTIME_PATH = '/api/v1/realtime';

/** One parsed server-sent event, with its envelope already decoded. */
type Frame = {
  /** The SSE `id:` field, which repeats the envelope's `event_id`. */
  readonly id: string | undefined;
  /** The SSE `event:` field, which repeats the envelope's `event_type`. */
  readonly name: string | undefined;
  /** The decoded envelope the frame carried. */
  readonly envelope: RealtimeEvent;
};

/** The instants these tests judge the sweep at, anchored to the real clock. */
const NOW = new Date().toISOString();

/**
 * Every stream a test opened, so teardown can close them all.
 *
 * An SSE response is a held-open socket; a stream left open would keep the
 * server from closing and let a later test's frames be written into a
 * connection nobody is reading.
 */
const openStreams: Stream[] = [];

/** Wait for a wall-clock delay, so a negative assertion has time to be wrong. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A live SSE connection under test.
 *
 * `EventSource` is deliberately not used: it cannot send an `Authorization`
 * header, and putting a credential in the URL is exactly what the platform's
 * token store forbids. The client therefore reads the response body itself —
 * the same shape the browser app uses, so what these tests exercise is the
 * transport the product actually ships.
 *
 * Refusals are asserted with `supertest` instead: a refused stream is an
 * ordinary JSON response that ends, and only an accepted one stays open.
 */
class Stream {
  readonly #frames: Frame[] = [];
  readonly #decoder = new TextDecoder();
  #buffer = '';
  #failure: unknown;
  #ended = false;

  /**
   * @param reader - Body reader of the accepted response.
   * @param abort - Aborts the request, which is how the stream is closed.
   */
  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly abort: AbortController,
  ) {
    void this.#pump();
  }

  /**
   * Open a stream and start collecting frames.
   *
   * @param origin - Base URL of the running test server (`http://host:port`).
   * @param memberId - Member to act as.
   * @param query - Extra query string, if any.
   * @returns The connected stream.
   */
  static async open(origin: string, memberId: string, query = ''): Promise<Stream> {
    const abort = new AbortController();
    const response = await fetch(`${origin}${REALTIME_PATH}${query}`, {
      headers: { accept: 'text/event-stream', 'x-member-id': memberId },
      signal: abort.signal,
    });
    if (response.status !== 200 || response.body === null) {
      abort.abort();
      throw new Error(`the stream did not open: HTTP ${response.status}`);
    }
    const stream = new Stream(response.body.getReader(), abort);
    openStreams.push(stream);
    return stream;
  }

  /** Every frame received so far, in arrival order. */
  get frames(): ReadonlyArray<Frame> {
    return [...this.#frames];
  }

  /** The frames that announce business facts, excluding handshake and keepalive. */
  domain(): ReadonlyArray<Frame> {
    return this.#frames.filter(
      (frame) => frame.name !== 'realtime.connected' && frame.name !== 'realtime.ping',
    );
  }

  /**
   * Wait for the first frame matching a predicate.
   *
   * @param predicate - Which frame to wait for.
   * @param label - What the caller was waiting for, for the failure message.
   * @param timeoutMs - How long to wait before giving up.
   * @returns The matching frame.
   * @throws {Error} When the stream failed, ended, or stayed silent too long.
   */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.#frames.find(predicate);
      if (found !== undefined) {
        return found;
      }
      if (this.#failure !== undefined) {
        throw new Error(`${label}: the stream failed`, { cause: this.#failure });
      }
      if (this.#ended) {
        throw new Error(`${label}: the stream ended after ${this.#frames.length} frames`);
      }
      if (Date.now() > deadline) {
        throw new Error(`${label}: no frame arrived within ${timeoutMs}ms`);
      }
      await delay(10);
    }
  }

  /**
   * Let the stream run for a while without waiting for anything.
   *
   * The only way to test that a frame was *not* delivered: after the same fact
   * has demonstrably reached a stream that is allowed to see it, the streams
   * that are not are given the same window of wall clock to prove otherwise.
   *
   * @param ms - How long to keep collecting.
   */
  async settle(ms: number): Promise<void> {
    await delay(ms);
  }

  /** Close the connection. Idempotent. */
  close(): void {
    this.abort.abort();
  }

  /** Read the body until the peer closes, parsing complete frames as they land. */
  async #pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          return;
        }
        this.#buffer += this.#decoder.decode(value, { stream: true });
        this.#drain();
      }
    } catch (error: unknown) {
      this.#failure = error;
    } finally {
      this.#ended = true;
    }
  }

  /** Split every complete block out of the buffer and parse it. */
  #drain(): void {
    for (;;) {
      const boundary = this.#buffer.indexOf('\n\n');
      if (boundary === -1) {
        return;
      }
      const block = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const frame = parseFrame(block);
      if (frame !== undefined) {
        this.#frames.push(frame);
      }
    }
  }
}

/**
 * Parse one SSE block into a frame.
 *
 * @param block - The bytes between two blank lines.
 * @returns The frame, or `undefined` for a block that carries no data — a
 * comment or a keepalive line, which is not a frame.
 * @throws {SyntaxError} When the payload is not JSON, which would mean the
 * server wrote something this contract does not allow.
 */
function parseFrame(block: string): Frame | undefined {
  let id: string | undefined;
  let name: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const raw = separator === -1 ? '' : line.slice(separator + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      name = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { id, name, envelope: JSON.parse(data.join('\n')) as RealtimeEvent };
}

/** The `store_id` a frame was scoped to, for the isolation assertions. */
function storesOf(frames: ReadonlyArray<Frame>): ReadonlyArray<string | null> {
  return frames.map((frame) => frame.envelope.store_id);
}

/**
 * Interface tests for the realtime event stream.
 *
 * These boot the real Nest application over the real HTTP surface with the
 * in-process store, open genuine SSE connections against it, and drive real
 * business actions elsewhere in the same application — so what is asserted is
 * the product behaviour "a seat that did not make the change still learns about
 * it", not a publisher called in isolation.
 *
 * This file supersedes the one-shot connection assertion that used to live in
 * `app.e2e-spec.ts`: that test read the stream to completion, which is the
 * behaviour this block replaced, and it predated the tenant scope a stream now
 * has to name.
 */
describe('Realtime (interface)', () => {
  let app: INestApplication;
  let store: KefuStore;
  let scheduler: AssignmentScheduler;
  let origin: string;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test', WECOM_TRANSPORT: 'mock' });
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
    store = app.get(KefuStore);
    scheduler = app.get(AssignmentScheduler);

    // `fetch` needs an address to dial, and a held-open response makes the
    // requests supertest performs itself look like they never finish, so the
    // server is started here and both clients share it.
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address: string | AddressInfo | null = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server did not report a TCP address');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const stream of openStreams) {
      stream.close();
    }
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  afterEach(() => {
    while (openStreams.length > 0) {
      openStreams.pop()?.close();
    }
  });

  beforeEach(() => {
    // The application is booted once for the whole file, so the store is shared
    // across tests and a claim or a sweep leaves the seed changed. Reset it so
    // every test states its own preconditions instead of inheriting the previous
    // one's — including presence and assignment history, which `seed()` alone
    // deliberately leaves alone.
    const internals = store as unknown as {
      seed: () => void;
      presence: unknown[];
      assignments: unknown[];
    };
    internals.presence = [];
    internals.assignments = [];
    internals.seed();
  });

  /**
   * Seed one pending conversation in a store the seed does not cover.
   *
   * Reached through the store rather than over HTTP because the only inbound
   * HTTP path is a signed provider callback, and a test that had to forge one
   * would be testing the channel adapter instead of the stream.
   *
   * @param storeId - Store the conversation belongs to.
   * @param tenantId - Tenant the conversation belongs to.
   * @param customerId - External customer the conversation is with.
   */
  function seedInbound(tenantId: string, storeId: string, customerId: string): void {
    store.ingestInbound({
      tenantId,
      storeId,
      channel: 'wecom',
      externalCustomerId: customerId,
      externalConversationId: `wecom-ext-${customerId}`,
      content: '请问有货吗？',
      now: NOW,
    });
  }

  /**
   * Deliver one Mock provider callback over HTTP.
   *
   * The only inbound path a deployment has, and the only thing that opens a
   * customer's reply window — an outbound send without one is refused by the
   * platform's own budget rule. A test that seeded the store instead would be
   * asserting frames for a state the shipped inbound path never produces.
   *
   * @param input - External identity and content of the callback.
   * @returns The ingestion result the API returned.
   */
  async function deliverInbound(input: {
    readonly eventId: string;
    readonly externalCustomerId: string;
    readonly externalConversationId: string;
    readonly externalMessageId: string;
    readonly content: string;
  }): Promise<{
    readonly status: string;
    readonly created: boolean;
    readonly conversationId: string;
    readonly messageId: string;
  }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/channels/wecom/webhook')
      .set('x-member-id', ADMIN_1)
      .set(MOCK_WECOM_SIGNATURE_HEADER, MOCK_WECOM_SIGNATURE)
      .send({
        eventId: input.eventId,
        tenantId: T1,
        storeId: S1,
        externalCustomerId: input.externalCustomerId,
        externalConversationId: input.externalConversationId,
        externalMessageId: input.externalMessageId,
        messageType: 'text',
        content: input.content,
        occurredAt: new Date().toISOString(),
      })
      // `200`, not the Nest default `201`: WeCom reads only `200` as "received"
      // and retries anything else, so the callback routes declare it explicitly.
      .expect(200);
    return (
      response.body as {
        data: {
          status: string;
          created: boolean;
          conversationId: string;
          messageId: string;
        };
      }
    ).data;
  }

  /**
   * Claim one conversation over HTTP as an agent.
   *
   * The version to expect is read from the store rather than hard-coded, so the
   * test states "claim whatever is there" instead of a number that has to be
   * kept in step with the seed.
   *
   * @param memberId - Agent to claim as.
   * @param conversationId - Conversation to claim.
   */
  async function claim(memberId: string, conversationId: string): Promise<void> {
    const conversation = store.getConversation(T1, conversationId);
    await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/claim`)
      .set('x-member-id', memberId)
      .send({ expectedVersion: conversation?.version })
      .expect(201);
  }

  /**
   * Send one message over HTTP as the agent holding the conversation.
   *
   * @param conversationId - Conversation to reply in.
   * @param content - Message text.
   * @returns The message and the delivery it produced.
   */
  async function send(
    conversationId: string,
    content: string,
  ): Promise<{ message: { id: string }; delivery: { id: string; status: string } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set('x-member-id', AGENT_1)
      .send({
        content,
        source: 'manual_typed',
        dedupKey: `e2e-${conversationId}-${content.length}-${Date.now()}`,
      })
      .expect(201);
    return (
      response.body as {
        data: { message: { id: string }; delivery: { id: string; status: string } };
      }
    ).data;
  }

  describe('the handshake', () => {
    it('opens with a frame carrying all five envelope fields and stays open', async () => {
      const stream = await Stream.open(origin, ADMIN_1);
      const handshake = await stream.waitFor(
        (frame) => frame.name === 'realtime.connected',
        'the handshake',
      );

      expect(handshake.envelope).toMatchObject({
        event_type: 'realtime.connected',
        tenant_id: T1,
        // The administrator reads across the tenant, which is the scope the
        // REST readers already give it.
        store_id: null,
        data: { reconnect: false },
      });
      expect(handshake.envelope.event_id.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(handshake.envelope.occurred_at))).toBe(false);
      // The SSE fields repeat the envelope rather than describing it a second
      // time, so a client can route on either without merging two objects.
      expect(handshake.id).toBe(handshake.envelope.event_id);
      expect(handshake.name).toBe(handshake.envelope.event_type);

      // Still open: a fact published now is delivered on this same connection,
      // which a stream that had closed could not do.
      await request(app.getHttpServer())
        .put('/api/v1/assignment/presence')
        .set('x-member-id', AGENT_1)
        .send({ status: 'accepting' })
        .expect(200);
      const later = await stream.waitFor(
        (frame) => frame.name === 'presence.changed',
        'a frame after the handshake',
      );
      expect(later.id).not.toBe(handshake.id);
    });

    it('widens an agent to the organisation rather than pinning it to a store', async () => {
      const stream = await Stream.open(origin, AGENT_1);
      const handshake = await stream.waitFor(
        (frame) => frame.name === 'realtime.connected',
        'the handshake',
      );

      // `store_id: null` is the stream's own way of saying "not narrowed to a
      // store", which is what the subscription is now: the seat reads every
      // store of its tenant. The tenant is still named, and it is still the only
      // tenant this stream can reach.
      expect(handshake.envelope).toMatchObject({ tenant_id: T1, store_id: null });
    });

    it('reports a re-connection as informational, on the caller word alone', async () => {
      const first = await Stream.open(origin, ADMIN_1);
      const initial = await first.waitFor(
        (frame) => frame.name === 'realtime.connected',
        'the first handshake',
      );
      expect((initial.envelope.data as { reconnect: boolean }).reconnect).toBe(false);

      const second = await Stream.open(origin, ADMIN_1, '?reconnect=1');
      const resumed = await second.waitFor(
        (frame) => frame.name === 'realtime.connected',
        'the resumed handshake',
      );
      expect((resumed.envelope.data as { reconnect: boolean }).reconnect).toBe(true);
    });
  });

  describe('fan-out of real work', () => {
    it('announces a new conversation, its message, a claim and a delivery outcome', async () => {
      const stream = await Stream.open(origin, ADMIN_1);

      // A customer nobody has seen writes in. Everything below happens on the
      // conversation this callback opens — the shipped inbound path is what
      // creates it, and the same callback is what opens the customer's reply
      // window, without which every outbound send would be refused as unpaid
      // budget rather than delivered.
      const opened = await deliverInbound({
        eventId: 'event-e2e-new',
        externalCustomerId: 'customer-e2e-new',
        externalConversationId: 'wecom-ext-e2e-new',
        externalMessageId: 'message-e2e-new',
        content: '你好，这件衣服还有货吗？',
      });
      expect(opened.created).toBe(true);

      const openedFrame = await stream.waitFor(
        (frame) => frame.name === 'conversation.opened',
        'the new conversation',
      );
      expect(openedFrame.envelope).toMatchObject({
        tenant_id: T1,
        store_id: S1,
        data: { conversation_id: opened.conversationId, status: 'open', assigned_member_id: null },
      });
      const received = await stream.waitFor(
        (frame) =>
          frame.name === 'message.created' &&
          (frame.envelope.data as { message_id: string }).message_id === opened.messageId,
        'the inbound message',
      );
      expect(received.envelope).toMatchObject({
        store_id: S1,
        data: {
          conversation_id: opened.conversationId,
          direction: 'inbound',
          message_type: 'text',
        },
      });

      await claim(AGENT_1, opened.conversationId);
      const claimed = await stream.waitFor(
        (frame) =>
          frame.name === 'conversation.updated' &&
          (frame.envelope.data as { conversation_id: string }).conversation_id ===
            opened.conversationId,
        'the claim',
      );
      expect(claimed.envelope).toMatchObject({
        tenant_id: T1,
        store_id: S1,
        data: { status: 'claimed', assigned_member_id: AGENT_1 },
      });

      const sent = await send(opened.conversationId, '您好，这件还有货，今天下单明天发出。');
      expect(sent.delivery.status).toBe('sent');
      const announced = await stream.waitFor(
        (frame) =>
          frame.name === 'message.created' &&
          (frame.envelope.data as { message_id: string }).message_id === sent.message.id,
        'the sent message',
      );
      expect(announced.envelope).toMatchObject({
        store_id: S1,
        data: {
          conversation_id: opened.conversationId,
          direction: 'outbound',
          message_type: 'text',
        },
      });

      // A send the provider refuses leaves the delivery retryable, and retrying
      // is the one path that moves a delivery after the fact — so it is also the
      // path that has to be announced rather than silently re-read.
      const rejected = await send(
        opened.conversationId,
        `这条会被渠道拒绝 ${MOCK_WECOM_FAIL_TRIGGER}`,
      );
      expect(rejected.delivery.status).toBe('failed');
      await request(app.getHttpServer())
        .post(`/api/v1/channels/deliveries/${rejected.delivery.id}/retry`)
        .set('x-member-id', ADMIN_1)
        .expect(201);

      const moved = await stream.waitFor(
        (frame) =>
          frame.name === 'message.delivery_updated' &&
          (frame.envelope.data as { message_id: string }).message_id === rejected.message.id,
        'the delivery update',
      );
      expect(moved.envelope).toMatchObject({
        store_id: S1,
        data: { conversation_id: opened.conversationId, status: 'failed' },
      });
    });

    it('replays nothing on a re-connection and still delivers what happens next', async () => {
      const first = await Stream.open(origin, ADMIN_1);
      // The customer writes in, which is what opens the reply window the send
      // below needs; the conversation it opens is the one this test then works
      // on, and the frame it produces is what must not be replayed.
      const opened = await deliverInbound({
        eventId: 'event-e2e-resume',
        externalCustomerId: 'customer-e2e-resume',
        externalConversationId: 'wecom-ext-e2e-resume',
        externalMessageId: 'message-e2e-resume',
        content: '还在吗？',
      });
      await first.waitFor((frame) => frame.name === 'message.created', 'the inbound message');

      await claim(AGENT_1, opened.conversationId);
      await first.waitFor((frame) => frame.name === 'conversation.updated', 'the claim');
      first.close();

      // The compensating read a reconnecting client performs, over REST, which
      // is what makes a missed frame cost nothing.
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${opened.conversationId}`)
        .set('x-member-id', ADMIN_1)
        .expect(200);
      expect(
        (detail.body as { data: { conversation: { status: string } } }).data.conversation.status,
      ).toBe('claimed');

      const resumed = await Stream.open(origin, ADMIN_1, '?reconnect=1');
      await resumed.waitFor((frame) => frame.name === 'realtime.connected', 'the handshake');
      await resumed.settle(100);
      // No replay: the frame that already arrived was not sent again, so a
      // client cannot double-apply a change it has already shown.
      expect(resumed.domain()).toEqual([]);

      const sent = await send(opened.conversationId, '刚才是短暂断线，现在继续为您服务。');
      // Delivered rather than deferred: the re-connection did not cost the seat
      // its reply window, which is the state a re-read would have had to restore.
      expect(sent.delivery.status).toBe('sent');
      const announced = await resumed.waitFor(
        (frame) =>
          frame.name === 'message.created' &&
          (frame.envelope.data as { message_id: string }).message_id === sent.message.id,
        'a frame after the re-connection',
      );
      expect(announced.envelope.data).toMatchObject({ conversation_id: opened.conversationId });
    });
  });

  describe('scope isolation', () => {
    it('withholds a frame from every seat that is not entitled to its store or tenant', async () => {
      seedInbound(T1, S2, 'customer-e2e-s2');
      seedInbound(T2, S3, 'customer-e2e-s3');

      const adminOfT1 = await Stream.open(origin, ADMIN_1);
      const agentOfS1 = await Stream.open(origin, AGENT_1);
      const agentOfS3 = await Stream.open(origin, AGENT_T2);

      // One sweep, three stores, two tenants: every conversation is parked and
      // its customer told, which announces one message per store.
      await scheduler.runOnce(NOW);
      const announcements = (stream: Stream): Promise<Frame> =>
        stream.waitFor((frame) => frame.name === 'message.created', 'a message frame');

      await announcements(adminOfT1);
      // The same fact has demonstrably reached a stream allowed to see store S2,
      // so a stream that has not received it by the end of this window is not
      // merely slow.
      await adminOfT1.settle(150);
      await announcements(agentOfS1);
      await announcements(agentOfS3);
      await agentOfS1.settle(150);
      await agentOfS3.settle(150);

      // The tenant administrator reads across both stores of its own tenant and
      // is told nothing about the other tenant.
      const adminStores = storesOf(adminOfT1.domain());
      expect(adminStores).toContain(S1);
      expect(adminStores).toContain(S2);
      expect(adminStores).not.toContain(S3);
      // A seat is told about every store of its own organisation, whichever one
      // it was pinned to — the frame seeded into `S2` is its to receive, and
      // this is the assertion that says so rather than the older one that said
      // the opposite.
      expect([...storesOf(agentOfS1.domain())].sort()).toEqual([S1, S2].sort());
      // And the seat of the other tenant is told about its own store alone,
      // which is the positive control that makes the tenant negative above real:
      // these streams deliver when a frame is theirs to see.
      expect(storesOf(agentOfS3.domain())).toEqual([S3]);
    });
  });

  describe('refusals', () => {
    it('refuses a platform administrator that names no tenant', async () => {
      const response = await request(app.getHttpServer())
        .get(REALTIME_PATH)
        .set('x-member-id', PLATFORM_ADMIN)
        .expect(400);
      expect((response.body as { code: string }).code).toBe('bad_request');
    });

    it('refuses an unknown member rather than opening an anonymous stream', async () => {
      const response = await request(app.getHttpServer())
        .get(REALTIME_PATH)
        .set('x-member-id', 'u-does-not-exist')
        .expect(401);
      expect((response.body as { code: string }).code).toBe('unauthorized');
    });

    it('refuses a seat that names another tenant', async () => {
      const response = await request(app.getHttpServer())
        .get(REALTIME_PATH)
        .set('x-member-id', AGENT_1)
        .set('x-tenant-id', T2)
        .expect(403);
      expect((response.body as { code: string }).code).toBe('forbidden');
    });

    it('refuses a tenant that does not exist', async () => {
      const response = await request(app.getHttpServer())
        .get(REALTIME_PATH)
        .set('x-member-id', PLATFORM_ADMIN)
        .set('x-tenant-id', 'tenant-ghost')
        .expect(404);
      expect((response.body as { code: string }).code).toBe('not_found');
    });
  });
});
