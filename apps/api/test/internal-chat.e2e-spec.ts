import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KefuStore,
  PLATFORM_ADMIN_MEMBER_ID,
  parseAppConfig,
  type AuthRepository,
  type InternalMessage,
  type InternalThread,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { AUTH_REPOSITORY } from '../src/auth/auth.tokens';
import { applyHttpDefaults, attachJsonLogger } from '../src/configure-app';
import { MEDIA_STORAGE } from '../src/media/media-storage';
import { MediaUrlService } from '../src/media/media-url.service';
import { MemoryMediaStorage } from './media-storage-support';

const T1 = 'tenant-acme';
const T2 = 'tenant-beta';
const AGENT_1 = 'u-t1-agent-1';
const AGENT_2 = 'u-t1-agent-2';
/** A third seat of the same tenant, used to prove membership is enforced. */
const ADMIN_1 = 'u-t1-admin';
/** A seat of a *different* tenant, used to prove the tenant boundary holds. */
const BETA_AGENT = 'u-t2-agent-1';
/** The platform administrator: a member of no tenant, reachable from every one. */
const PLATFORM_ADMIN = PLATFORM_ADMIN_MEMBER_ID;
/** A one-pixel PNG: the smallest picture the platform will accept. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type DataEnvelope = { request_id: string; data: unknown };
type ErrorEnvelope = { request_id: string; code: string; message: string };

/** One message as the endpoint reports it: the row, plus the file's address. */
type MessageWithAttachment = InternalMessage & {
  readonly attachment: {
    readonly id: string;
    readonly kind: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly url: string;
  } | null;
};

describe('internal chat (e2e)', () => {
  let app: INestApplication;
  let store: KefuStore;
  let urls: MediaUrlService;
  /**
   * The object store, in a map.
   *
   * The port exists so this suite can drive a real upload without a running
   * MinIO — and it is the assertions on it (`writes`) that say a refused file
   * never reached storage at all, which a test that only read the status code
   * could not tell.
   */
  const storage = new MemoryMediaStorage();

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
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
    // Taken from the running application rather than rebuilt from the config: a
    // URL this test minted with its own copy of the secret would verify against
    // itself and prove nothing about what the route checks with.
    urls = app.get(MediaUrlService);
  });

  afterAll(async () => {
    const httpServer = app.getHttpServer();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await app.close();
  });

  beforeEach(() => {
    // The application is booted once for the whole file, so the store is shared.
    // `seed()` restores the directory but knows nothing about internal threads,
    // so they are cleared here: a test that asserts "no messages yet" must not
    // inherit the previous test's conversation.
    const internals = store as unknown as {
      seed: () => void;
      internalThreads: InternalThread[];
      internalMessages: InternalMessage[];
      internalAttachments: unknown[];
    };
    internals.internalThreads = [];
    internals.internalMessages = [];
    internals.internalAttachments = [];
    internals.seed();
  });

  /** Identity headers for a demo seat, the way the non-production guard reads them. */
  const as = (memberId: string, tenantId: string): Record<string, string> => ({
    'x-member-id': memberId,
    'x-tenant-id': tenantId,
  });

  // Returns supertest's own thenable rather than a promise, so a test can chain
  // `.expect(...)` onto it and still `await` the result.
  const openThread = (from: string, peerMemberId: string, tenantId = T1) =>
    request(app.getHttpServer())
      .post('/api/v1/internal-chat/threads')
      .set(as(from, tenantId))
      .send({ peerMemberId });

  const peersOf = (memberId: string, tenantId = T1) =>
    request(app.getHttpServer()).get('/api/v1/internal-chat/peers').set(as(memberId, tenantId));

  const peerIdsOf = async (memberId: string, tenantId = T1): Promise<ReadonlyArray<string>> => {
    const response = await peersOf(memberId, tenantId).expect(200);
    return ((response.body as DataEnvelope).data as ReadonlyArray<{ memberId: string }>).map(
      (peer) => peer.memberId,
    );
  };

  /**
   * Give one seeded member a picture, or take theirs away.
   *
   * Written through the two rows the console writes, never as a field on the
   * member: a picture belongs to an account and a member reaches it through an
   * active link, so a test that set `member.avatarUrl` would be asserting on a
   * shape this platform does not have. The seeded directory has no accounts at
   * all, which is why every avatar test has to build this link first.
   *
   * @param memberId - The seeded member to give a picture to.
   * @param avatarUrl - Base64 `data:` URL, or `null` for "has an account, no picture".
   */
  const giveAvatar = async (memberId: string, avatarUrl: string | null): Promise<void> => {
    const accounts = app.get<AuthRepository>(AUTH_REPOSITORY);
    const at = '2026-08-01T00:00:00.000Z';
    await accounts.saveUser({
      id: `user-${memberId}`,
      username: `user-${memberId}`,
      displayName: memberId,
      status: 'active',
      passwordHash: null,
      passwordUpdatedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      avatarUrl,
      idempotencyKey: null,
      createdAt: at,
      updatedAt: at,
    });
    await accounts.saveLink({
      id: `link-${memberId}`,
      userId: `user-${memberId}`,
      tenantId: T1,
      memberId,
      linkedBy: null,
      linkedAt: at,
      revokedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  };

  /** Open a thread and hand back the row, which almost every test needs first. */  const threadOf = async (from: string, peer: string, tenantId = T1): Promise<InternalThread> => {
    const opened = await openThread(from, peer, tenantId).expect(201);
    return ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;
  };

  /** Upload one file into a thread, the way the browser does. */
  const uploadTo = (
    from: string,
    threadId: string,
    content: Buffer,
    filename: string,
    contentType: string,
    tenantId = T1,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${threadId}/attachments`)
      .set(as(from, tenantId))
      .attach('file', content, { filename, contentType });

  /** Send one message — text, a draft, or both — the way the browser does. */
  const sendWith = (from: string, threadId: string, body: Record<string, unknown>, tenantId = T1) =>
    request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${threadId}/messages`)
      .set(as(from, tenantId))
      .send(body);

  /**
   * Fetch a signed URL and keep the bytes.
   *
   * superagent parses neither `image/png` nor `application/octet-stream` into
   * `body`, so the response is collected by hand: what this file has to settle is
   * that the route hands back the file itself, and a test that read a header
   * instead would pass on a route answering 200 with the wrong bytes.
   *
   * @param url - A minted URL, path and query.
   * @returns The status, the headers and the raw body.
   */
  const fetchBytes = (
    url: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> =>
    new Promise((resolve, reject) => {
      request(app.getHttpServer())
        .get(url)
        .buffer(true)
        .parse(
          (
            response: { on: (event: string, listener: (chunk: Buffer) => void) => void },
            callback: (error: Error | null, body: Buffer) => void,
          ) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => callback(null, Buffer.concat(chunks)));
          },
        )
        .end(
          (
            error: Error | null,
            response: { status: number; headers: Record<string, string>; body: Buffer },
          ) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ status: response.status, headers: response.headers, body: response.body });
          },
        );
    });

  it('creates one thread for a pair, however many times either side opens it', async () => {
    const first = await openThread(AGENT_1, AGENT_2).expect(201);
    const second = await openThread(AGENT_2, AGENT_1).expect(201);

    const a = (first.body as DataEnvelope).data as { thread: InternalThread };
    const b = (second.body as DataEnvelope).data as { thread: InternalThread };
    expect(a.thread.id).toBe(b.thread.id);
    // The participant order is the store's, not the caller's, so the two sides
    // cannot disagree about which thread they are in.
    expect(a.thread.participantMemberIds).toEqual([AGENT_1, AGENT_2]);
    expect(b.thread.participantMemberIds).toEqual([AGENT_1, AGENT_2]);
  });

  it('carries a message from one colleague to the other', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;

    await request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .send({ content: '  这单我先接了，你那边先别动  ' })
      .expect(201);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_2, T1))
      .expect(200);
    const messages = (read.body as DataEnvelope).data as InternalMessage[];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.senderMemberId).toBe(AGENT_1);
    // Trimmed on the way in, so a stray paste does not become a different
    // message than the two seats are looking at.
    expect(messages[0]?.body).toBe('这单我先接了，你那边先别动');
  });

  it('lists the counterpart on the peer view and never the caller', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const view = (opened.body as DataEnvelope).data as {
      thread: InternalThread;
      peer: { memberId: string; displayName: string } | null;
      lastMessage: InternalMessage | null;
    };

    expect(view.peer?.memberId).toBe(AGENT_2);
    expect(view.lastMessage).toBeNull();

    const peers = await request(app.getHttpServer())
      .get('/api/v1/internal-chat/peers')
      .set(as(AGENT_1, T1))
      .expect(200);
    const peerIds = ((peers.body as DataEnvelope).data as ReadonlyArray<{ memberId: string }>).map(
      (peer) => peer.memberId,
    );
    expect(peerIds).not.toContain(AGENT_1);
    expect(peerIds).toContain(AGENT_2);
  });

  it('reports each colleague picture, and reports nothing where there is none', async () => {
    await giveAvatar(AGENT_2, ONE_PIXEL_PNG);
    // An account that exists but holds no picture: the answer is the same as for
    // a member with no account at all — absent from the map, not an empty string.
    await giveAvatar(ADMIN_1, null);

    const peers = ((await peersOf(AGENT_1).expect(200)).body as DataEnvelope)
      .data as ReadonlyArray<{ memberId: string; avatarUrl: string | null }>;

    expect(peers.find((peer) => peer.memberId === AGENT_2)?.avatarUrl).toBe(ONE_PIXEL_PNG);
    expect(peers.find((peer) => peer.memberId === ADMIN_1)?.avatarUrl).toBeNull();
    // Every peer carries the field, so the console can tell "no picture" from
    // "this deployment does not report pictures".
    expect(peers.every((peer) => 'avatarUrl' in peer)).toBe(true);
  });

  it('carries the picture of the counterpart, not the reader, on a thread', async () => {
    await giveAvatar(AGENT_2, ONE_PIXEL_PNG);
    const thread = await threadOf(AGENT_1, AGENT_2);

    /** The peer as one reader's view of the thread reports it. */
    const peerSeenBy = async (memberId: string) => {
      const listed = await request(app.getHttpServer())
        .get('/api/v1/internal-chat/threads')
        .set(as(memberId, T1))
        .expect(200);
      const views = (listed.body as DataEnvelope).data as ReadonlyArray<{
        thread: InternalThread;
        peer: { memberId: string; avatarUrl: string | null } | null;
      }>;
      return views.find((view) => view.thread.id === thread.id)?.peer ?? null;
    };

    // Agent 2 uploaded a picture; agent 1 did not. Each sees the other's face,
    // so the picture travels with the colleague rather than with the reader.
    expect((await peerSeenBy(AGENT_1))?.memberId).toBe(AGENT_2);
    expect((await peerSeenBy(AGENT_1))?.avatarUrl).toBe(ONE_PIXEL_PNG);
    expect((await peerSeenBy(AGENT_2))?.memberId).toBe(AGENT_1);
    expect((await peerSeenBy(AGENT_2))?.avatarUrl).toBeNull();
  });

  it('refuses a colleague who is not a participant, and says nothing about where it is', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;

    const refused = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(ADMIN_1, T1))
      .expect(403);
    expect((refused.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('refuses a thread that belongs to another tenant as if it did not exist', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;

    const refused = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(BETA_AGENT, T2))
      .expect(404);
    expect((refused.body as ErrorEnvelope).code).toBe('not_found');
  });

  it('refuses a colleague from another tenant as a chat partner', async () => {
    const refused = await openThread(AGENT_1, BETA_AGENT).expect(404);
    expect((refused.body as ErrorEnvelope).code).toBe('not_found');
  });

  it('refuses an empty message and one over the length limit', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;

    await request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .send({ content: '   ' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .send({ content: 'x'.repeat(2001) })
      .expect(400);
  });

  it('refuses a chat with oneself', async () => {
    await openThread(AGENT_1, AGENT_1).expect(400);
  });

  it('offers the platform administrator as a colleague of every tenant', async () => {
    // The platform side belongs to no tenant, so no tenant listing contains it;
    // without this the agent could be written to but could not answer.
    expect(await peerIdsOf(AGENT_1, T1)).toContain(PLATFORM_ADMIN);
    expect(await peerIdsOf(BETA_AGENT, T2)).toContain(PLATFORM_ADMIN);
    // …and is not offered to itself: a platform administrator may not open a
    // second line to the platform side.
    expect(await peerIdsOf(PLATFORM_ADMIN, T1)).not.toContain(PLATFORM_ADMIN);
    expect(await peerIdsOf(PLATFORM_ADMIN, T1)).toContain(AGENT_1);
  });

  it('carries an internal message from a seat to the platform administrator and back', async () => {
    const opened = await openThread(AGENT_1, PLATFORM_ADMIN).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;
    // The thread lives in the seat's tenant, which is what both sides name: the
    // platform administrator reaches it through the tenant it is scoped to, not
    // through a tenant of its own.
    expect(thread.tenantId).toBe(T1);

    await request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .send({ content: '这家公司的接待规则想请平台侧确认一下' })
      .expect(201);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(PLATFORM_ADMIN, T1))
      .expect(200);
    const seen = (read.body as DataEnvelope).data as InternalMessage[];
    expect(seen).toHaveLength(1);
    expect(seen[0]?.senderMemberId).toBe(AGENT_1);

    await request(app.getHttpServer())
      .post(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(PLATFORM_ADMIN, T1))
      .send({ content: '收到，我这边确认后回复你' })
      .expect(201);

    const answer = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .expect(200);
    const both = (answer.body as DataEnvelope).data as InternalMessage[];
    expect(both.map((message) => message.senderMemberId)).toEqual([AGENT_1, PLATFORM_ADMIN]);

    // The platform administrator's own list holds it too, so the reply is not a
    // write-once surface they cannot find again.
    const threads = await request(app.getHttpServer())
      .get('/api/v1/internal-chat/threads')
      .set(as(PLATFORM_ADMIN, T1))
      .expect(200);
    const listed = (threads.body as DataEnvelope).data as ReadonlyArray<{
      thread: InternalThread;
    }>;
    expect(listed.map((entry) => entry.thread.id)).toContain(thread.id);
  });

  it('keeps the platform administrator out of a thread between two seats', async () => {
    const opened = await openThread(AGENT_1, AGENT_2).expect(201);
    const thread = ((opened.body as DataEnvelope).data as { thread: InternalThread }).thread;

    const refused = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(PLATFORM_ADMIN, T1))
      .expect(403);
    expect((refused.body as ErrorEnvelope).code).toBe('forbidden');
  });

  it('does not let a platform administrator reach a seat outside the tenant it is scoped to', async () => {
    const refused = await openThread(PLATFORM_ADMIN, BETA_AGENT, T1).expect(404);
    expect((refused.body as ErrorEnvelope).code).toBe('not_found');
    // The same peer is reachable once the platform administrator names that
    // tenant: the scope, not the role, is what decides.
    await openThread(PLATFORM_ADMIN, BETA_AGENT, T2).expect(201);
  });

  it('carries a picture from one colleague to the other and serves the bytes back', async () => {
    const thread = await threadOf(AGENT_1, AGENT_2);
    const bytes = Buffer.from('PNG-ish bytes, sent from one seat to another');

    const uploaded = await uploadTo(AGENT_1, thread.id, bytes, '对账单.png', 'image/png').expect(
      201,
    );
    const draft = (uploaded.body as DataEnvelope).data as {
      id: string;
      kind: string;
      byteSize: number;
    };
    expect(draft.kind).toBe('image');
    expect(draft.byteSize).toBe(bytes.byteLength);

    // No caption at all: the file is the message, and that is what the empty
    // `body` means rather than a placeholder sentence.
    const sent = await sendWith(AGENT_1, thread.id, { attachmentId: draft.id }).expect(201);
    const message = (sent.body as DataEnvelope).data as MessageWithAttachment;
    expect(message.body).toBe('');
    expect(message.attachment?.id).toBe(draft.id);
    expect(message.attachment?.fileName).toBe('对账单.png');
    const url = message.attachment?.url ?? '';
    expect(url).toContain(`/api/v1/internal-media/${encodeURIComponent(message.id)}`);
    expect(url).toContain('sig=');

    // The recipient reads the same message with the same attachment — that is
    // the whole claim of this feature: the file arrives, it is not a local
    // preview that only the sender can see.
    const read = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_2, T1))
      .expect(200);
    const received = (read.body as DataEnvelope).data as MessageWithAttachment[];
    expect(received).toHaveLength(1);
    expect(received[0]?.attachment?.id).toBe(draft.id);

    const fetched = await fetchBytes(url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/png');
    // The two headers that make this route safe to point an `<img>` at.
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(fetched.headers['cache-control']).toContain('private');
    expect(fetched.headers['content-disposition']).toContain('inline;');
    expect(fetched.body.equals(bytes)).toBe(true);
  });

  it('refuses an upload from a colleague who is not in the thread, and files it will not store', async () => {
    const thread = await threadOf(AGENT_1, AGENT_2);
    const before = storage.writes.length;

    // Membership is the thread's authority, checked by the same rule that reads
    // and writes it. Uploading is not a second, weaker capability.
    const refused = await uploadTo(
      ADMIN_1,
      thread.id,
      Buffer.from('x'),
      'a.png',
      'image/png',
    ).expect(403);
    expect((refused.body as ErrorEnvelope).code).toBe('forbidden');

    const tooLarge = await uploadTo(
      AGENT_1,
      thread.id,
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
      'big.png',
      'image/png',
    ).expect(400);
    // The reason travels in `details`, which is where the platform's error
    // envelope carries an input problem's own words — the frontend shows it, so
    // a refusal that arrived as "Bad Request" and nothing else would be a sender
    // with no idea which file to pick instead.
    const tooLargeBody = tooLarge.body as ErrorEnvelope & { details: ReadonlyArray<string> };
    expect(tooLargeBody.details.join(' ')).toContain('larger than');

    // An SVG looks like an image and is not: it is a document that can carry
    // script, this route serves images inline from the deployment's own origin,
    // and so an SVG is refused rather than quietly demoted to a download.
    await uploadTo(AGENT_1, thread.id, Buffer.from('<svg/>'), 'logo.svg', 'image/svg+xml').expect(
      400,
    );
    await uploadTo(AGENT_1, thread.id, Buffer.alloc(0), 'empty.png', 'image/png').expect(400);

    // The size gate runs before the object store, so nothing was written for any
    // refusal — the bucket never holds a file the platform refused to accept.
    expect(storage.writes).toHaveLength(before);
  });

  it('lets only the uploader send their own draft, and only once', async () => {
    const thread = await threadOf(AGENT_1, AGENT_2);
    const uploaded = await uploadTo(
      AGENT_1,
      thread.id,
      Buffer.from('a statement'),
      '账单.pdf',
      'application/pdf',
    ).expect(201);
    const draft = (uploaded.body as DataEnvelope).data as { id: string; kind: string };
    // A PDF is not on the media allowlist, so it is a `file` — which is what
    // decides that it is downloaded rather than rendered.
    expect(draft.kind).toBe('file');

    // The other participant is in this thread and still cannot claim a draft
    // that is not theirs.
    await sendWith(AGENT_2, thread.id, { attachmentId: draft.id }).expect(400);

    const sent = await sendWith(AGENT_1, thread.id, {
      attachmentId: draft.id,
      content: '这是本月账单，你看下有没有问题',
    }).expect(201);
    const message = (sent.body as DataEnvelope).data as MessageWithAttachment;
    expect(message.body).toBe('这是本月账单，你看下有没有问题');

    // A double-click that re-sends the same draft is refused rather than writing
    // the file twice.
    await sendWith(AGENT_1, thread.id, { attachmentId: draft.id }).expect(400);

    const fetched = await fetchBytes(message.attachment?.url ?? '');
    expect(fetched.status).toBe(200);
    // Opaque bytes and a download disposition, whatever type the file claimed:
    // the browser must never be handed something it would execute.
    expect(fetched.headers['content-type']).toContain('application/octet-stream');
    expect(fetched.headers['content-disposition']).toContain('attachment;');
    expect(fetched.headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('refuses a signature that was not minted for this route, and one for another tenant', async () => {
    const thread = await threadOf(AGENT_1, AGENT_2);
    const uploaded = await uploadTo(
      AGENT_1,
      thread.id,
      Buffer.from('notes'),
      '说明.txt',
      'text/plain',
    ).expect(201);
    const draft = (uploaded.body as DataEnvelope).data as { id: string };
    const sent = await sendWith(AGENT_1, thread.id, { attachmentId: draft.id }).expect(201);
    const message = (sent.body as DataEnvelope).data as MessageWithAttachment;
    const url = message.attachment?.url ?? '';

    // Without the signature there is no credential, and the route says so before
    // it looks anything up.
    await request(app.getHttpServer())
      .get(url.replace(/[?&]sig=[0-9a-f]+/, ''))
      .expect(403);

    // A signature over the same tenant and message, minted for the customer
    // media route, replayed against this one.
    const replayed = urls
      .url({ tenantId: T1, messageId: message.id })
      .replace('/api/v1/media/', '/api/v1/internal-media/');
    await request(app.getHttpServer()).get(replayed).expect(403);

    // A signature that is valid in every respect but names another tenant: the
    // tenant is inside the signature, so it decides which row is read — and
    // there is no such attachment there.
    const otherTenant = urls.url({
      tenantId: T2,
      messageId: message.id,
      purpose: 'internal-attachment',
    });
    await request(app.getHttpServer()).get(otherTenant).expect(404);
  });

  it('lets the platform administrator send a file to a seat, and vice versa', async () => {
    const thread = await threadOf(AGENT_1, PLATFORM_ADMIN);

    const uploaded = await uploadTo(
      PLATFORM_ADMIN,
      thread.id,
      Buffer.from('平台侧说明'),
      '平台说明.txt',
      'text/plain',
      T1,
    ).expect(201);
    const draft = (uploaded.body as DataEnvelope).data as { id: string };
    await sendWith(
      PLATFORM_ADMIN,
      thread.id,
      { attachmentId: draft.id, content: '这份说明你收一下' },
      T1,
    ).expect(201);

    // The seat answers with a file in the other direction, in the same thread
    // and the same tenant — the one both sides name.
    const reply = await uploadTo(
      AGENT_1,
      thread.id,
      Buffer.from('收到'),
      '回执.png',
      'image/png',
      T1,
    ).expect(201);
    const replyDraft = (reply.body as DataEnvelope).data as { id: string };
    await sendWith(AGENT_1, thread.id, { attachmentId: replyDraft.id }, T1).expect(201);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/internal-chat/threads/${thread.id}/messages`)
      .set(as(AGENT_1, T1))
      .expect(200);
    const both = (read.body as DataEnvelope).data as MessageWithAttachment[];
    expect(both.map((entry) => entry.attachment?.fileName)).toEqual(['平台说明.txt', '回执.png']);
    expect(both.map((entry) => entry.senderMemberId)).toEqual([PLATFORM_ADMIN, AGENT_1]);
  });
});
