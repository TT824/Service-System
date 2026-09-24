import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalOtpProvider,
  SEEDED_PLATFORM_ADMIN_MEMBER_ID,
  parseAppConfig,
  type AppConfig,
  type AuthRepository,
  type Member,
  type OtpProvider,
  type Store,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { AUTH_OTP_PROVIDER, AUTH_REPOSITORY } from '../src/auth/auth.tokens';
import { applyHttpDefaults } from '../src/configure-app';

/** Password used by the accounts this suite creates. */
const PASSWORD = 'correct-horse-battery-staple';

/** Host prefix of every generated phone number. */
const PHONE_PREFIX = '+8613900';

/** Fresh destinations and usernames per test, so rate limits never collide. */
let sequence = 0;

/** A destination phone number no other test has used. */
function nextPhone(): string {
  sequence += 1;
  return `${PHONE_PREFIX}${String(sequence).padStart(5, '0')}`;
}

/** A username no other test has used. */
function nextUsername(): string {
  sequence += 1;
  return `onboarding-${sequence}`;
}

/** Boot the API with a given configuration. */
async function boot(config: AppConfig): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  }).compile();
  const app = moduleRef.createNestApplication();
  applyHttpDefaults(app, config);
  await app.init();
  return app;
}

/** One account's access context as the wire reports it. */
type WireAccess = {
  readonly userId: string;
  readonly accessState: string;
  readonly role: string | null;
  readonly tenantId: string | null;
  readonly member: Member | null;
  readonly authorizedStoreIds: ReadonlyArray<string>;
};

/** One knowledge product as the knowledge surface reports it. */
type ProductRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly sku: string;
  readonly title: string;
  readonly enabled: boolean;
};

/** One row of the platform administrator's account listing. */
type AccountRow = {
  readonly id: string;
  readonly accessState: string;
  readonly memberId: string | null;
  readonly tenantId: string | null;
};

/**
 * Interface tests for trial onboarding.
 *
 * Registration is the whole onboarding path: an account that has just proved a
 * destination gets one trial tenant, one default store, one merchant
 * administrator member and one active link, and the session it is issued with
 * can reach tenant business data inside that workspace. The suite drives the
 * real HTTP surface, so the guarantee is asserted where a client observes it —
 * the registration response, the administration endpoints and the account
 * center — rather than against the domain service directly.
 *
 * The retry endpoint is the way out of `pending_config` that does not wait for
 * an administrator, and it is exercised here as a client would use it: called
 * whenever the access context reports the account is unconfigured, however
 * often that happens.
 */
/**
 * Interface tests for registration onboarding.
 *
 * Registration is an *application*, not a provisioning. An account that has just
 * proved a destination holds a real credential and nothing else: no member, no
 * tenant, no role, and no business data behind it. The approval bell is the only
 * door in, and what it hands the account is a seat in the one organisation this
 * deployment serves.
 *
 * The suite drives the real HTTP surface, so the guarantee is asserted where a
 * client observes it — the registration response, the administration endpoints
 * and the account center — rather than against the domain service directly.
 */
describe('Registration onboarding (interface)', () => {
  let app: INestApplication;
  let otp: LocalOtpProvider;
  let repository: AuthRepository;

  beforeAll(async () => {
    const parsed = parseAppConfig({ APP_ENV: 'test' });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    app = await boot(parsed.config);
    const provider = app.get<OtpProvider>(AUTH_OTP_PROVIDER);
    if (!(provider instanceof LocalOtpProvider)) {
      throw new Error('the test boundary must resolve the deterministic local code provider');
    }
    otp = provider;
    repository = app.get<AuthRepository>(AUTH_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  /** The supertest agent bound to the running application. */
  function api(): ReturnType<typeof request> {
    return request(app.getHttpServer());
  }

  /** Request a one-time code and return the code the provider delivered. */
  async function sendCode(subject: string): Promise<string> {
    const response = await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' });
    expect(response.status).toBe(200);
    const delivery = otp.lastDeliveryFor(subject);
    if (delivery === undefined) {
      throw new Error('the provider recorded no delivery for the destination');
    }
    return delivery.code;
  }

  /** Register an account over HTTP and return its credential and access context. */
  async function register(): Promise<{
    readonly token: string;
    readonly access: WireAccess;
  }> {
    const subject = nextPhone();
    const code = await sendCode(subject);
    const response = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: '入驻测试账号',
      password: PASSWORD,
    });
    expect(response.status).toBe(201);
    const token = response.body.data.token as string;
    expect(typeof token).toBe('string');
    return { token, access: response.body.data.access as WireAccess };
  }

  /** The access context of the account behind a token. */
  async function accessOf(token: string): Promise<WireAccess> {
    const response = await api()
      .get('/api/v1/account/access')
      .set('authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    return response.body.data.access as WireAccess;
  }

  /** The listed row of one account, read as the seeded platform administrator. */
  async function accountRow(userId: string): Promise<AccountRow | undefined> {
    const response = await api()
      .get('/api/v1/admin/accounts')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(response.status).toBe(200);
    const rows = response.body.data as ReadonlyArray<AccountRow>;
    return rows.find((row) => row.id === userId);
  }

  /** Let an applicant in, as the platform administrator behind the bell. */
  async function approve(userId: string) {
    return api()
      .post(`/api/v1/admin/accounts/${userId}/approve`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({});
  }

  /** Turn an applicant away, as the platform administrator behind the bell. */
  async function reject(userId: string) {
    return api()
      .post(`/api/v1/admin/accounts/${userId}/reject`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({});
  }

  /** Revoke an account's member link as the seeded platform administrator. */
  async function revokeLink(memberId: string): Promise<void> {
    const revoked = await api()
      .delete(`/api/v1/admin/members/${memberId}/link`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(revoked.status).toBe(200);
  }

  /** Register an account and let it in, returning the credential and its seat. */
  async function staffed(): Promise<{
    readonly token: string;
    readonly userId: string;
    readonly member: Member;
  }> {
    const { token } = await register();
    const bearer = { authorization: `Bearer ${token}` };
    const waiting = await accessOf(token);
    const userId = waiting.userId as string;
    expect((await approve(userId)).status).toBe(200);
    const access = await accessOf(token);
    const member = await repository.getMember(access.member?.id as string);
    if (member === undefined) {
      throw new Error('approval produced no seat');
    }
    expect((await api().get('/api/v1/auth/session').set(bearer)).status).toBe(200);
    return { token, userId, member };
  }

  it('leaves a registered account waiting, holding no workspace', async () => {
    const { token, access } = await register();
    const bearer = { authorization: `Bearer ${token}` };

    // Registration is the application, and nothing else: no member, no tenant,
    // no role. The credential is real, which the session endpoint proves.
    expect(access.accessState).toBe('pending_config');
    expect(access.role).toBeNull();
    expect(access.tenantId).toBeNull();
    expect(access.member).toBeNull();
    expect(access.authorizedStoreIds).toEqual([]);
    expect((await api().get('/api/v1/auth/session').set(bearer)).status).toBe(200);

    // The account center is the one door it has, and it answers.
    expect((await api().get('/api/v1/account/center').set(bearer)).status).toBe(200);

    // Every other surface is closed: the administrative directory, the
    // catalogue and the conversation list alike.
    expect((await api().get('/api/v1/admin/tenants').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/admin/accounts').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/knowledge/products').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/conversations').set(bearer)).status).toBe(403);

    // The administrator's listing agrees with the session, so the waiting state
    // is visible to the person who can end it.
    const row = await accountRow(access.userId as string);
    expect(row?.accessState).toBe('pending_config');
    expect(row?.memberId).toBeNull();
    expect(row?.tenantId).toBeNull();
  });

  it('staffs a waiting account from the approval bell', async () => {
    const { token } = await register();
    const userId = (await accessOf(token)).userId as string;
    const bearer = { authorization: `Bearer ${token}` };

    const approved = await approve(userId);
    expect(approved.status).toBe(200);

    const access = await accessOf(token);
    expect(access.accessState).toBe('active');
    expect(access.role).toBe('agent');
    // The one organisation this deployment serves, and a seat inside it.
    expect(access.tenantId).toBe('tenant-acme');
    expect(access.member?.id).toBeTruthy();
    expect(access.member?.tenantId).toBe('tenant-acme');
    expect(access.member?.role).toBe('agent');
    // A seat always lands in a store — the schema requires it of every `agent`
    // — and the one it lands in is an enabled store of the organisation rather
    // than something the applicant chose. C1 widened what the seat can *read*;
    // it did not remove the pinning the schema still enforces.
    expect(access.member?.storeId).toBeTruthy();
    const stores = await api()
      .get('/api/v1/admin/tenants/tenant-acme/stores')
      .set({ 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID });
    expect(stores.status).toBe(200);
    const landed = (stores.body.data as ReadonlyArray<Store>).find(
      (store) => store.id === access.member?.storeId,
    );
    expect(landed?.enabled).toBe(true);

    // The listing agrees, and the seat is the account's own login name.
    const row = await accountRow(userId);
    expect(row?.accessState).toBe('active');
    expect(row?.memberId).toBe(access.member?.id);
    expect(row?.tenantId).toBe('tenant-acme');
    const member = await repository.getMember(access.member?.id as string);
    expect(member?.username).toBe(
      (await api().get('/api/v1/auth/session').set(bearer)).body.data.account.username,
    );
  });

  it('reaches the whole organisation once it is staffed', async () => {
    // A platform administrator reaches tenant business data through an explicit
    // tenant, which the console supplies and this suite states outright.
    const platformAdmin = {
      'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID,
      'x-tenant-id': 'tenant-acme',
    };
    const seat = await staffed();
    const headers = { authorization: `Bearer ${seat.token}` };

    // A seat always lands in a store, and the organisation has more than one:
    // that is what makes the next assertion about the seat's scope rather than
    // about there being nowhere else to look.
    const stores = await api().get('/api/v1/admin/tenants/tenant-acme/stores').set(platformAdmin);
    expect(stores.status).toBe(200);
    const elsewhere = (stores.body.data as ReadonlyArray<Store>).find(
      (store) => store.id !== seat.member.storeId,
    );
    expect(elsewhere).toBeDefined();

    // A catalogue entry another store owns, written by the administrator.
    const created = await api().post('/api/v1/knowledge/products').set(platformAdmin).send({
      storeId: elsewhere?.id as string,
      sku: `SKU-ONBOARDING-${sequence}`,
      title: '别店的商品',
      description: '由另一个门店写入，坐席也应读得到',
    });
    expect(created.status).toBe(201);
    const product = created.body.data as ProductRow;
    expect(product.storeId).not.toBe(seat.member.storeId);

    // The seat reads it: this is the widening. Pinned to one store, the seat
    // used to be answered 404 for anything outside it.
    const readBack = await api().get(`/api/v1/knowledge/products/${product.id}`).set(headers);
    expect(readBack.status).toBe(200);
    expect((readBack.body.data as ProductRow).id).toBe(product.id);

    // The list is the organisation's, and a colleague sees the same one.
    const mine = await api().get('/api/v1/knowledge/products').set(headers);
    expect(mine.status).toBe(200);
    const rows = mine.body.data as ReadonlyArray<ProductRow>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === 'tenant-acme')).toBe(true);
    expect(rows.some((row) => row.id === product.id)).toBe(true);
    const colleague = await staffed();
    const theirs = await api()
      .get('/api/v1/knowledge/products')
      .set({ authorization: `Bearer ${colleague.token}` });
    expect(theirs.status).toBe(200);
    expect((theirs.body.data as ReadonlyArray<ProductRow>).map((row) => row.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );

    // Reading the organisation is not configuring it. A seat may not write the
    // catalogue — neither in the store it landed in nor in anyone else's, and
    // the same for the FAQ list, which is the other half of the same rule.
    for (const storeId of [seat.member.storeId as string, elsewhere?.id as string]) {
      const refusedProduct = await api().post('/api/v1/knowledge/products').set(headers).send({
        storeId,
        sku: `SKU-REFUSED-${sequence}`,
        title: '不该写进去的商品',
      });
      expect(refusedProduct.status).toBe(403);
      const refusedFaq = await api().post('/api/v1/knowledge/faqs').set(headers).send({
        storeId,
        question: '不该写进去的问题',
        answer: '也不该写进去的答案',
      });
      expect(refusedFaq.status).toBe(403);
    }

    // An account still waiting behind the bell reaches none of it.
    const waiting = await register();
    expect(
      (
        await api()
          .get('/api/v1/knowledge/products')
          .set({ authorization: `Bearer ${waiting.token}` })
      ).status,
    ).toBe(403);
  });

  it('decides an application once, and only as a platform administrator', async () => {
    const { token } = await register();
    const userId = (await accessOf(token)).userId as string;

    // A staffed seat is not an administrator: approved once, it cannot approve.
    // (An environment that does not honour the demo headers refuses the
    // credential-less call outright; that boundary is `auth-access`'s.)
    const seat = await staffed();
    const asSeat = await api()
      .post(`/api/v1/admin/accounts/${userId}/approve`)
      .set({ authorization: `Bearer ${seat.token}` })
      .send({});
    expect(asSeat.status).toBe(403);
    expect(asSeat.body.code).toBe('forbidden');

    // A decision is a decision: approving an approved account is a bad request
    // rather than a second, silent relink.
    expect((await approve(userId)).status).toBe(200);
    const again = await approve(userId);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('bad_request');

    // An account that does not exist is not an application either.
    expect((await approve('no-such-account')).status).toBe(404);
  });

  it('turns an application away without leaving a half-staffed account', async () => {
    const { token } = await register();
    const userId = (await accessOf(token)).userId as string;
    const bearer = { authorization: `Bearer ${token}` };

    const rejected = await reject(userId);
    expect(rejected.status).toBe(200);

    // The refusal is recorded as the account being switched off — the state the
    // platform already refuses a sign-in for — so the waiting tab stops asking.
    expect((await api().get('/api/v1/auth/session').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/account/access').set(bearer)).status).toBe(403);
    const row = await accountRow(userId);
    expect(row?.memberId).toBeNull();
    expect(row?.tenantId).toBeNull();

    // Rejecting one account staffs nobody: the directory holds no seat that was
    // not there before.
    expect(await repository.getUser(userId)).toBeDefined();
    // And the decision is final for this application — approving a rejected
    // account is refused rather than quietly reinstating it.
    const late = await approve(userId);
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('bad_request');
  });

  it('leaves an account waiting again when its seat is unlinked, and staffs it afresh', async () => {
    const seat = await staffed();
    const bearer = { authorization: `Bearer ${seat.token}` };

    // A revoked link is what an unconfigured account is now: the credential is
    // still valid, but there is no member behind it.
    await revokeLink(seat.member.id);
    expect((await accessOf(seat.token)).accessState).toBe('pending_config');
    expect((await api().get('/api/v1/knowledge/products').set(bearer)).status).toBe(403);

    // There is no route for the account to lift its own restriction. What
    // restores it is a seat, and a new seat is what the administrator makes.
    const created = await api()
      .post('/api/v1/admin/members')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({
        tenant_id: 'tenant-acme',
        role: 'agent',
        username: nextUsername(),
        display_name: '复工客服',
      });
    expect(created.status).toBe(201);
    const replacement = created.body.data as Member;
    // No store was asked for or sent: the server places the seat itself.
    expect(replacement.storeId).toBeTruthy();

    const linked = await api()
      .post(`/api/v1/admin/members/${replacement.id}/link`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({ user_id: seat.userId });
    expect(linked.status).toBe(200);

    const back = await accessOf(seat.token);
    expect(back.accessState).toBe('active');
    expect(back.role).toBe('agent');
    expect(back.tenantId).toBe('tenant-acme');
    expect(back.member?.id).toBe(replacement.id);
    expect((await api().get('/api/v1/knowledge/products').set(bearer)).status).toBe(200);
  });
});
