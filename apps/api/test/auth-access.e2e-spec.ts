import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalOtpProvider,
  parseAppConfig,
  SEEDED_PLATFORM_ADMIN_MEMBER_ID,
  type AppConfig,
  type AuthRepository,
  type OtpProvider,
} from '@kefu/core';
import { AppModule } from '../src/app.module';
import { AUTH_OTP_PROVIDER, AUTH_REPOSITORY } from '../src/auth/auth.tokens';
import { applyHttpDefaults } from '../src/configure-app';

/** Password used by the accounts this suite creates. */
const PASSWORD = 'correct-horse-battery-staple';
/** Password a recovery flow switches to. */
const NEW_PASSWORD = 'a-completely-different-passphrase';

/** Host prefix of every generated phone number. */
const PHONE_PREFIX = '+8613800';

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
  return `user-${sequence}`;
}

/** A stable display name. */
const DISPLAY_NAME = '认证测试账号';

/**
 * A one-pixel PNG as a base64 `data:` URL.
 *
 * The route checks the bytes of whatever it is handed, so the tests that mean
 * to succeed need a value that really is an image rather than a string shaped
 * like one.
 */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/**
 * Interface tests for the persistent authentication, account and access-control
 * workflow.
 *
 * These boot the real Nest application and drive it over HTTP with `supertest`,
 * so the global identity guard, the session-backed access resolution, the
 * response envelope and the stable error codes are all exercised as a client
 * sees them. The in-memory adapter is used (the `test` boundary), so the whole
 * workflow runs without PostgreSQL; the durable adapter is covered separately by
 * the PostgreSQL integration suite.
 */
describe('Authentication and access control (interface)', () => {
  let app: INestApplication;
  let otp: LocalOtpProvider;

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
  });

  afterAll(async () => {
    await app.close();
  });

  /** The supertest agent bound to the running application. */
  function api(): ReturnType<typeof request> {
    return request(app.getHttpServer());
  }

  /** Request a one-time code and return the code the provider delivered. */
  async function sendCode(subject: string, purpose = 'sign_in'): Promise<string> {
    const response = await api()
      .post('/api/v1/auth/otp/send')
      .send({ subject, channel: 'sms', purpose });
    expect(response.status).toBe(200);
    const delivery = otp.lastDeliveryFor(subject);
    if (delivery === undefined) {
      throw new Error('the provider recorded no delivery for the destination');
    }
    return delivery.code;
  }

  /** Register an account and return its bearer token. */
  async function register(options: { readonly password?: string }): Promise<{
    readonly token: string;
    readonly userId: string;
    readonly subject: string;
    readonly username: string;
  }> {
    const subject = nextPhone();
    const username = nextUsername();
    const code = await sendCode(subject);
    const response = await api()
      .post('/api/v1/auth/register')
      .send({
        subject,
        channel: 'sms',
        code,
        username,
        display_name: DISPLAY_NAME,
        ...(options.password === undefined ? {} : { password: options.password }),
      });
    expect(response.status).toBe(201);
    const token = response.body.data.token as string;
    expect(typeof token).toBe('string');
    const session = await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`);
    expect(session.status).toBe(200);
    return { token, userId: session.body.data.account.id as string, subject, username };
  }

  /** Sign in over HTTP with a password and, optionally, a remembered device. */
  async function signIn(
    username: string,
    password: string,
    deviceCredential?: string,
  ): Promise<{ readonly status: number; readonly authMethod: string }> {
    const response = await api()
      .post('/api/v1/auth/login/password')
      .send({
        username,
        password,
        ...(deviceCredential === undefined ? {} : { device_credential: deviceCredential }),
      });
    return {
      status: response.status,
      authMethod: response.body.data?.session?.authMethod as string,
    };
  }

  /** Remember the current client as a trusted device and return its credential. */
  async function rememberDevice(token: string): Promise<{ credential: string; deviceId: string }> {
    const enrolled = await api()
      .post('/api/v1/auth/devices')
      .set('authorization', `Bearer ${token}`)
      .send({ label: '客服工作台', platform: 'web' });
    expect(enrolled.status).toBe(201);
    return {
      credential: enrolled.body.data.credential as string,
      deviceId: enrolled.body.data.device.id as string,
    };
  }

  /** Link an account to a member as the seeded platform administrator. */
  async function linkAccount(userId: string, memberId: string): Promise<void> {
    const linked = await api()
      .post(`/api/v1/admin/members/${memberId}/link`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({ user_id: userId });
    expect(linked.status).toBe(200);
  }

  /** The member an account acts through, read as the seeded platform administrator. */
  async function memberIdOf(userId: string): Promise<string | null> {
    const response = await api()
      .get('/api/v1/admin/accounts')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(response.status).toBe(200);
    const rows = response.body.data as ReadonlyArray<{ id: string; memberId: string | null }>;
    return rows.find((row) => row.id === userId)?.memberId ?? null;
  }

  /**
   * Let an applicant in, as the platform administrator behind the approval bell.
   *
   * This is the only door: registration leaves an account waiting, and no
   * credential it holds can open the console by itself.
   */
  async function approve(userId: string): Promise<void> {
    const approved = await api()
      .post(`/api/v1/admin/accounts/${userId}/approve`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({});
    expect(approved.status).toBe(200);
  }

  /** Create a seat in the deployment's organisation, as the platform administrator. */
  async function createSeat(displayName: string): Promise<string> {
    const created = await api()
      .post('/api/v1/admin/members')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({
        tenant_id: 'tenant-acme',
        role: 'agent',
        username: nextUsername(),
        display_name: displayName,
      });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  }

  /** Revoke one member's link as the seeded platform administrator. */
  async function revokeLink(memberId: string): Promise<void> {
    const revoked = await api()
      .delete(`/api/v1/admin/members/${memberId}/link`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(revoked.status).toBe(200);
  }

  // --------------------------------------------------------------------------
  // One-time codes
  // --------------------------------------------------------------------------

  it('delivers a one-time code without ever echoing it', async () => {
    const subject = nextPhone();
    const response = await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' });
    expect(response.status).toBe(200);
    expect(response.body.request_id).toBeTruthy();
    expect(response.body.meta).toEqual({});
    expect(response.body.data.challengeId).toBeTruthy();

    const delivery = otp.lastDeliveryFor(subject);
    expect(delivery?.code).toMatch(/^[0-9]{6}$/);
    // The code exists only in the delivery; the wire payload must not carry it.
    expect(JSON.stringify(response.body)).not.toContain(delivery?.code);
  });

  it('rate limits a rapid resend to the same destination', async () => {
    const subject = nextPhone();
    expect(
      (await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' })).status,
    ).toBe(200);
    const again = await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('too_many_requests');
  });

  it('rejects a one-time code that was never issued', async () => {
    const response = await api().post('/api/v1/auth/login/otp').send({
      subject: nextPhone(),
      channel: 'sms',
      code: '000000',
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('burns the challenge once the attempt budget is spent', async () => {
    const subject = nextPhone();
    const code = await sendCode(subject);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await api()
        .post('/api/v1/auth/login/otp')
        .send({ subject, channel: 'sms', code: wrong });
      expect(failure.status).toBe(401);
    }
    // The correct code is worthless now: the challenge was revoked, not left open.
    const burned = await api()
      .post('/api/v1/auth/login/otp')
      .send({ subject, channel: 'sms', code });
    expect(burned.status).not.toBe(200);
  });

  it('refuses to reuse a consumed code', async () => {
    const subject = nextPhone();
    const code = await sendCode(subject);
    const username = nextUsername();
    const first = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username,
      display_name: DISPLAY_NAME,
    });
    expect(first.status).toBe(201);
    const replay = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: DISPLAY_NAME,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('conflict');
  });

  // --------------------------------------------------------------------------
  // Registration, sessions and passwords
  // --------------------------------------------------------------------------

  it('registers into a waiting account that holds no workspace yet', async () => {
    const subject = nextPhone();
    const code = await sendCode(subject);
    const response = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: DISPLAY_NAME,
      password: PASSWORD,
    });
    expect(response.status).toBe(201);
    // Registration is an application, not a provisioning: the account holds no
    // tenant, no member and no role, and the console is closed to it until the
    // platform administrator lets it in.
    expect(response.body.data.access.accessState).toBe('pending_config');
    expect(response.body.data.access.role).toBeNull();
    expect(response.body.data.access.tenantId).toBeNull();
    expect(response.body.data.access.member).toBeNull();
    expect(response.body.data.access.authMethod).toBe('otp');
    // The stored session is summarised, so no fingerprint reaches the client.
    expect(JSON.stringify(response.body.data.session)).not.toContain('fingerprint');

    const bearer = { authorization: `Bearer ${response.body.data.token as string}` };
    const userId = response.body.data.access.userId as string;

    // The credential is real and reaches nothing: not the directory, not the
    // catalogue, not the conversation list.
    expect((await api().get('/api/v1/admin/tenants').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/knowledge/products').set(bearer)).status).toBe(403);
    expect((await api().get('/api/v1/conversations').set(bearer)).status).toBe(403);

    // The account center is the one door it has, and it answers.
    expect((await api().get('/api/v1/account/center').set(bearer)).status).toBe(200);

    // The bell is what opens the console, and it hands the account a seat.
    await approve(userId);
    const approved = await api().get('/api/v1/account/access').set(bearer);
    expect(approved.status).toBe(200);
    expect(approved.body.data.access.accessState).toBe('active');
    expect(approved.body.data.access.role).toBe('agent');
    expect(approved.body.data.access.tenantId).toBe('tenant-acme');
    expect(approved.body.data.access.member?.id).toBeTruthy();
    // And the catalogue it now reads is the organisation's, not an empty one of
    // its own making.
    expect((await api().get('/api/v1/knowledge/products').set(bearer)).status).toBe(200);
  });

  it('signs in with a password and refuses a wrong one', async () => {
    const subject = nextPhone();
    const username = nextUsername();
    const code = await sendCode(subject);
    await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username,
      display_name: DISPLAY_NAME,
      password: PASSWORD,
    });

    const ok = await api()
      .post('/api/v1/auth/login/password')
      .send({ username, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.access.authMethod).toBe('password');

    const wrong = await api()
      .post('/api/v1/auth/login/password')
      .send({ username, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
  });

  it('invalidates a token on sign out', async () => {
    const { token } = await register({ password: PASSWORD });
    expect(
      (await api().post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`).send({}))
        .status,
    ).toBe(200);
    const after = await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('rotates a token and detects the replayed one', async () => {
    const { token } = await register({ password: PASSWORD });
    const rotated = await api()
      .post('/api/v1/auth/session/rotate')
      .set('authorization', `Bearer ${token}`)
      .send({});
    expect(rotated.status).toBe(200);
    const next = rotated.body.data.token as string;
    expect(next).not.toBe(token);

    // The replacement works, the superseded token is refused.
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${next}`)).status,
    ).toBe(200);
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('invalidates every session when the password is reset', async () => {
    const { token, subject, username } = await register({ password: PASSWORD });
    const code = await sendCode(subject, 'recover');
    const reset = await api().post('/api/v1/auth/password/reset').send({
      subject,
      channel: 'sms',
      code,
      new_password: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(401);
    // And the credential the reset was about is the one that changed: a reset
    // that revoked the sessions but left the old password working would pass
    // the check above unchanged.
    expect((await signIn(username, PASSWORD)).status).toBe(401);
    expect((await signIn(username, NEW_PASSWORD)).status).toBe(200);
  });

  it('changes the password from a live session without ending that session', async () => {
    const { token, username } = await register({ password: PASSWORD });
    const second = await api()
      .post('/api/v1/auth/login/password')
      .send({ username, password: PASSWORD });
    expect(second.status).toBe(200);
    const otherToken = second.body.data.token as string;

    const changed = await api()
      .post('/api/v1/auth/password/change')
      .set('authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD });

    expect(changed.status).toBe(200);
    // The other session goes; the one making the request stays, because that is
    // the screen the operator is standing on while they type.
    //
    // `revokedSessions`, like the reset receipt beside it: these receipts are
    // the domain result handed back unchanged, not a re-spelled payload.
    expect(changed.body.data.revokedSessions).toBe(1);
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(200);
    expect(
      (
        await api().get('/api/v1/auth/session').set('authorization', `Bearer ${otherToken}`)
      ).status,
    ).toBe(401);

    expect((await signIn(username, PASSWORD)).status).toBe(401);
    expect((await signIn(username, NEW_PASSWORD)).status).toBe(200);
  });

  it('answers a wrong current password with 400, not with a session the client would drop', async () => {
    const { token, username } = await register({ password: PASSWORD });

    const refused = await api()
      .post('/api/v1/auth/password/change')
      .set('authorization', `Bearer ${token}`)
      .send({ current_password: 'not-the-password', new_password: NEW_PASSWORD });

    // A 401 here would tell every client to treat a typo as an expired session
    // and sign the operator out of the page they are standing on.
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('bad_request');
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(200);
    // And the credential is untouched: a refusal that still wrote would be a
    // refusal that locked the operator out.
    expect((await signIn(username, PASSWORD)).status).toBe(200);
    expect((await signIn(username, NEW_PASSWORD)).status).toBe(401);
  });

  it('refuses a password change without a session', async () => {
    const refused = await api()
      .post('/api/v1/auth/password/change')
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD });

    expect(refused.status).toBe(401);
  });

  it('reports the verified number on the session payload', async () => {
    const { token, subject } = await register({ password: PASSWORD });

    const session = await api()
      .get('/api/v1/auth/session')
      .set('authorization', `Bearer ${token}`);

    expect(session.status).toBe(200);
    // The account menu reads this row: a payload that dropped the number would
    // leave every operator reading their username where their number belongs.
    expect(session.body.data.account.phone).toBe(subject);
  });

  /**
   * Send an avatar for the account behind a token.
   *
   * A fresh request every time, deliberately: a `supertest` request object that
   * has already been awaited keeps the body it was first given, so reusing one
   * for a second value quietly re-sends the first and every refusal looks like
   * an acceptance.
   */
  function postAvatar(
    token: string,
    body: Record<string, unknown>,
  ): ReturnType<ReturnType<typeof api>['post']> {
    return api().post('/api/v1/auth/avatar').set('authorization', `Bearer ${token}`).send(body);
  }

  it('stores an avatar and reports it on the session payload', async () => {
    const { token } = await register({ password: PASSWORD });

    const stored = await postAvatar(token, { avatar_url: ONE_PIXEL_PNG });
    expect(stored.status).toBe(200);

    const session = await api()
      .get('/api/v1/auth/session')
      .set('authorization', `Bearer ${token}`);
    // Read back through the session rather than trusting the write's own
    // response: `/auth/session` is the payload the console draws the avatar
    // from, and a value that only ever existed in a reply would show up as a
    // picture that disappears on the next reload.
    expect(session.body.data.account.avatar_url).toBe(ONE_PIXEL_PNG);
  });

  it('removes the avatar when told to, and only then', async () => {
    const { token } = await register({ password: PASSWORD });

    // A request that never mentions the field is malformed rather than a third
    // way of saying "no picture": the caller that forgets it means to set one,
    // and silently clearing the account instead would be a write nobody asked
    // for.
    expect((await postAvatar(token, {})).status).toBe(400);
    expect(
      (
        await api()
          .get('/api/v1/auth/session')
          .set('authorization', `Bearer ${token}`)
      ).body.data.account.avatar_url,
    ).toBeNull();

    expect((await postAvatar(token, { avatar_url: ONE_PIXEL_PNG })).status).toBe(200);
    expect((await postAvatar(token, { avatar_url: null })).status).toBe(200);

    const session = await api()
      .get('/api/v1/auth/session')
      .set('authorization', `Bearer ${token}`);
    expect(session.body.data.account.avatar_url).toBeNull();
  });

  it('refuses an avatar whose bytes are not the type it claims', async () => {
    const { token } = await register({ password: PASSWORD });
    expect((await postAvatar(token, { avatar_url: ONE_PIXEL_PNG })).status).toBe(200);

    const lying = `data:image/png;base64,${Buffer.from('this is not a png').toString('base64')}`;
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

    for (const value of [lying, svg, 'https://example.com/avatar.png']) {
      const refused = await postAvatar(token, { avatar_url: value });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('bad_request');
    }

    // None of the three refusals overwrote the picture that was already there.
    const session = await api()
      .get('/api/v1/auth/session')
      .set('authorization', `Bearer ${token}`);
    expect(session.body.data.account.avatar_url).toBe(ONE_PIXEL_PNG);
  });

  it('refuses an avatar without a session', async () => {
    const refused = await api().post('/api/v1/auth/avatar').send({ avatar_url: ONE_PIXEL_PNG });

    expect(refused.status).toBe(401);
  });

  it('refuses a sign-in code for a password reset', async () => {
    const { subject, username } = await register({ password: PASSWORD });
    // Issued for `sign_in`, which is the purpose `sendCode` defaults to.
    const code = await sendCode(subject);

    const refused = await api().post('/api/v1/auth/password/reset').send({
      subject,
      channel: 'sms',
      code,
      new_password: NEW_PASSWORD,
    });

    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('unauthorized');
    // The refusal is the claim, not the status alone: a reset that quietly went
    // through would have swapped the password under a 401-shaped log line.
    expect((await signIn(username, PASSWORD)).status).toBe(200);
    expect((await signIn(username, NEW_PASSWORD)).status).toBe(401);
  });

  // --------------------------------------------------------------------------
  // Trusted devices
  // --------------------------------------------------------------------------

  it('enrols, lists and revokes a trusted device', async () => {
    const { token } = await register({ password: PASSWORD });
    const enrolled = await api()
      .post('/api/v1/auth/devices')
      .set('authorization', `Bearer ${token}`)
      .send({ label: '客服工作台', platform: 'web' });
    expect(enrolled.status).toBe(201);
    // The credential is returned once and never stored in the clear.
    expect(typeof enrolled.body.data.credential).toBe('string');
    const deviceId = enrolled.body.data.device.id as string;

    const listed = await api().get('/api/v1/auth/devices').set('authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body.data)).not.toContain(enrolled.body.data.credential);

    const revoked = await api()
      .post(`/api/v1/auth/devices/${deviceId}/revoke`)
      .set('authorization', `Bearer ${token}`)
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revokedSessions).toBe(1);
    // Revoking the device killed the session bound to it.
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('treats a sign-in as remembered only while the credential is live', async () => {
    const { token, username } = await register({ password: PASSWORD });
    const { credential, deviceId } = await rememberDevice(token);

    const remembered = await signIn(username, PASSWORD, credential);
    expect(remembered.status).toBe(200);
    expect(remembered.authMethod).toBe('trusted_device');

    // A client with no credential, or with one that was never issued, is simply
    // an ordinary password sign-in — never a refusal.
    expect((await signIn(username, PASSWORD)).authMethod).toBe('password');
    expect((await signIn(username, PASSWORD, 'never-issued')).authMethod).toBe('password');

    const revoked = await api()
      .post(`/api/v1/auth/devices/${deviceId}/revoke`)
      .set('authorization', `Bearer ${token}`)
      .send({});
    expect(revoked.status).toBe(200);

    const afterRevoke = await signIn(username, PASSWORD, credential);
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.authMethod).toBe('password');
  });

  it('stops trusting a remembered device once the password is reset', async () => {
    const { token, subject, username } = await register({ password: PASSWORD });
    const { credential } = await rememberDevice(token);
    expect((await signIn(username, PASSWORD, credential)).authMethod).toBe('trusted_device');

    const code = await sendCode(subject, 'recover');
    const reset = await api().post('/api/v1/auth/password/reset').send({
      subject,
      channel: 'sms',
      code,
      new_password: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect(reset.body.data.revokedDevices).toBe(1);

    const afterReset = await signIn(username, NEW_PASSWORD, credential);
    expect(afterReset.status).toBe(200);
    expect(afterReset.authMethod).toBe('password');
  });

  // --------------------------------------------------------------------------
  // OIDC
  // --------------------------------------------------------------------------

  it('binds, signs in with and unbinds an external identity', async () => {
    const { token } = await register({ password: PASSWORD });
    const bound = await api()
      .post('/api/v1/auth/identities/oidc')
      .set('authorization', `Bearer ${token}`)
      .send({ code: 'local-authorization-code-1' });
    expect(bound.status).toBe(200);
    expect(bound.body.data.provider).toBe('oidc');

    const sso = await api()
      .post('/api/v1/auth/login/oidc')
      .send({ code: 'local-authorization-code-1' });
    expect(sso.status).toBe(200);
    expect(sso.body.data.access.authMethod).toBe('sso');

    const center = await api()
      .get('/api/v1/account/center')
      .set('authorization', `Bearer ${token}`);
    expect(center.status).toBe(200);
    const oidcIdentity = (
      center.body.data.identities as ReadonlyArray<{ id: string; provider: string }>
    ).find((identity) => identity.provider === 'oidc');
    expect(oidcIdentity).toBeDefined();

    const unbound = await api()
      .delete(`/api/v1/auth/identities/${oidcIdentity?.id}`)
      .set('authorization', `Bearer ${token}`);
    expect(unbound.status).toBe(200);

    const orphaned = await api()
      .post('/api/v1/auth/login/oidc')
      .send({ code: 'local-authorization-code-1' });
    expect(orphaned.status).toBe(401);
  });

  it('requires a verified local account before an external identity can be bound', async () => {
    const subject = nextPhone();
    const code = await sendCode(subject);
    const registered = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: DISPLAY_NAME,
      // No password: the verified one-time code is the whole local credential.
    });
    expect(registered.status).toBe(201);
    const token = registered.body.data.token as string;

    // The verified phone identity is a local credential, so binding is allowed.
    const bound = await api()
      .post('/api/v1/auth/identities/oidc')
      .set('authorization', `Bearer ${token}`)
      .send({ code: 'local-authorization-code-2' });
    expect(bound.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // pending_config boundary
  // --------------------------------------------------------------------------

  it('allows the account center but refuses tenant business data while unconfigured', async () => {
    const { token, userId } = await register({ password: PASSWORD });
    const bearer = { authorization: `Bearer ${token}` };

    // Registration alone leaves the account in exactly the state this test is
    // about: a real credential with no member behind it.
    const before = await api().get('/api/v1/account/access').set(bearer);
    expect(before.status).toBe(200);
    expect(before.body.data.access.accessState).toBe('pending_config');
    expect(before.body.data.access.tenantId).toBeNull();

    // Letting it in is what gives it a member and a tenant, so the boundary can
    // be re-tested from a state that had a link to lose.
    await approve(userId);
    const memberId = await memberIdOf(userId);
    expect(memberId).toBeTruthy();
    const tenantId = (await api().get('/api/v1/account/access').set(bearer)).body.data.access
      .tenantId as string;
    expect(tenantId).toBe('tenant-acme');

    // Revoking the account's link leaves it unconfigured again: it holds a valid
    // session but no member to act through.
    await revokeLink(memberId as string);

    const access = await api()
      .get('/api/v1/account/access')
      .set('authorization', `Bearer ${token}`);
    expect(access.status).toBe(200);
    expect(access.body.data.access.accessState).toBe('pending_config');

    expect(
      (await api().get('/api/v1/account/center').set('authorization', `Bearer ${token}`)).status,
    ).toBe(200);

    const denied = await api().get('/api/v1/admin/tenants').set('authorization', `Bearer ${token}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');

    // Tenant business data is refused for the same reason, through the surface a
    // client actually uses rather than the administrative directory.
    const deniedBusiness = await api()
      .get('/api/v1/knowledge/products')
      .set('authorization', `Bearer ${token}`);
    expect(deniedBusiness.status).toBe(403);
    expect(deniedBusiness.body.code).toBe('forbidden');

    // There is no route for the account to lift its own restriction: only the
    // platform administrator can, and what it does is link the account to a seat.
    const seatId = await createSeat('恢复的客服');
    await linkAccount(userId, seatId);

    const after = await api().get('/api/v1/account/access').set(bearer);
    expect(after.status).toBe(200);
    expect(after.body.data.access.accessState).toBe('active');
    // The role comes from the seat it was linked to, not from the registration
    // that first created the account.
    expect(after.body.data.access.role).toBe('agent');
    expect(after.body.data.access.tenantId).toBe(tenantId);
    expect(after.body.data.access.member?.id).toBe(seatId);
    // And the workspace it recovered is one its tenant business endpoints accept.
    const recoveredBusiness = await api().get('/api/v1/knowledge/products').set(bearer);
    expect(recoveredBusiness.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // Bearer verification on business routes
  // --------------------------------------------------------------------------

  it('refuses an unknown bearer token on a business route', async () => {
    const response = await api()
      .get('/api/v1/knowledge/products')
      .set('authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('refuses a revoked bearer token on a business route', async () => {
    const { token } = await register({ password: PASSWORD });
    expect(
      (await api().post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`).send({}))
        .status,
    ).toBe(200);
    const response = await api()
      .get('/api/v1/knowledge/products')
      .set('authorization', `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('scopes a verified session to its own member, never to a default identity', async () => {
    const { token, userId } = await register({ password: PASSWORD });
    const bearer = { authorization: `Bearer ${token}` };

    // A freshly registered session is answered as the account it was issued for
    // and nothing more: never as the seeded platform administrator the header
    // path would have defaulted to, and never inside a seeded tenant.
    const own = await api().get('/api/v1/admin/tenants').set(bearer);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('forbidden');

    // The account center names the same account and no identity at all: the
    // credential is not quietly bound to a member on its way through.
    const access = await api().get('/api/v1/account/access').set(bearer);
    expect(access.status).toBe(200);
    expect(access.body.data.access.userId).toBe(userId);
    expect(access.body.data.access.member).toBeNull();
    expect(access.body.data.access.tenantId).toBeNull();

    // The credential is pinned to the identity it was minted for. Linked to a
    // seat, it keeps the seat the server resolved at issue time; what a seat can
    // read is the whole organisation, decided server-side.
    const seatId = await createSeat('被顶替的客服');
    await linkAccount(userId, seatId);
    const still = await api().get('/api/v1/account/access').set(bearer);
    expect(still.status).toBe(200);
    expect(still.body.data.access.member?.id).toBe(seatId);
    expect(still.body.data.access.tenantId).toBe('tenant-acme');
    const products = await api().get('/api/v1/knowledge/products').set(bearer);
    expect(products.status).toBe(200);
    const rows = products.body.data as ReadonlyArray<{ tenantId: string }>;
    // The seat reads the organisation's catalogue — not an empty workspace of
    // its own, which is what the account held before it was let in.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === 'tenant-acme')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Administration
  // --------------------------------------------------------------------------

  it('administers tenants, stores, members, roles and store scopes', async () => {
    const platformAdmin = { 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID };

    const tenants = await api().get('/api/v1/admin/tenants').set(platformAdmin);
    expect(tenants.status).toBe(200);
    const listedTenants = tenants.body.data as ReadonlyArray<{ id: string }>;
    expect(listedTenants.length).toBeGreaterThanOrEqual(1);

    // The deployment serves one organisation, so both endpoints that would make
    // or unmake one refuse.
    const refused = await api()
      .post('/api/v1/admin/tenants')
      .set(platformAdmin)
      .send({ code: `t-${sequence}-${Date.now()}`, name: '新租户' });
    expect(refused.status).toBe(403);
    const refusedFlag = await api()
      .post(`/api/v1/admin/tenants/${listedTenants[0]?.id as string}/enabled`)
      .set(platformAdmin)
      .send({ enabled: false });
    expect(refusedFlag.status).toBe(403);
    // Neither attempt changed the directory.
    const afterRefusals = await api().get('/api/v1/admin/tenants').set(platformAdmin);
    expect(
      (afterRefusals.body.data as ReadonlyArray<{ id: string }>).map((tenant) => tenant.id),
    ).toEqual(listedTenants.map((tenant) => tenant.id));

    // Everything below still works, retargeted at the organisation that exists.
    const tenantId = listedTenants[0]?.id as string;

    const store = await api()
      .post('/api/v1/admin/stores')
      .set(platformAdmin)
      .send({ tenant_id: tenantId, code: `s-${sequence}-${Date.now()}`, name: '主门店' });
    expect(store.status).toBe(201);
    const storeId = store.body.data.id as string;

    const member = await api().post('/api/v1/admin/members').set(platformAdmin).send({
      tenant_id: tenantId,
      store_id: storeId,
      role: 'agent',
      username: nextUsername(),
      display_name: '新客服',
    });
    expect(member.status).toBe(201);
    const memberId = member.body.data.id as string;

    const promoted = await api()
      .post(`/api/v1/admin/members/${memberId}/role`)
      .set(platformAdmin)
      .send({ role: 'merchant_admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('merchant_admin');

    const granted = await api()
      .post('/api/v1/admin/store-scopes')
      .set(platformAdmin)
      .send({ tenant_id: tenantId, member_id: memberId, store_id: storeId, is_primary: true });
    expect(granted.status).toBe(201);
    expect(granted.body.data.isPrimary).toBe(true);

    const scopes = await api()
      .get(`/api/v1/admin/members/${memberId}/store-scopes`)
      .set(platformAdmin);
    expect(scopes.status).toBe(200);
    expect(scopes.body.data).toHaveLength(1);

    const revokedScope = await api()
      .delete(`/api/v1/admin/members/${memberId}/store-scopes/${storeId}`)
      .set(platformAdmin);
    expect(revokedScope.status).toBe(200);
    expect(revokedScope.body.data.revoked).toBe(true);

    const accounts = await api().get('/api/v1/admin/accounts').set(platformAdmin);
    expect(accounts.status).toBe(200);
    const listed = accounts.body.data as ReadonlyArray<{ password_configured?: boolean }>;
    expect(JSON.stringify(listed)).not.toContain('scrypt');
  });

  it('reports linkage and access state for every listed account', async () => {
    const platformAdmin = { 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID };
    const { userId } = await register({ password: PASSWORD });

    /** The listed row for one account id. */
    async function rowOf(id: string, headers: Record<string, string>) {
      const response = await api().get('/api/v1/admin/accounts').set(headers);
      expect(response.status).toBe(200);
      const rows = response.body.data as ReadonlyArray<{
        id: string;
        accessState: string;
        memberId: string | null;
        tenantId: string | null;
      }>;
      return rows.find((row) => row.id === id);
    }

    // A freshly registered account reports itself as waiting for a member, and
    // holds neither a seat nor a tenant to point at — exactly like its own
    // session does.
    const waiting = await rowOf(userId, platformAdmin);
    expect(waiting?.accessState).toBe('pending_config');
    expect(waiting?.memberId).toBeNull();
    expect(waiting?.tenantId).toBeNull();

    // The bell is what staffs it, and the row follows.
    await approve(userId);
    const approvedRow = await rowOf(userId, platformAdmin);
    expect(approvedRow?.accessState).toBe('active');
    expect(approvedRow?.memberId).toBeTruthy();
    expect(approvedRow?.tenantId).toBe('tenant-acme');

    // Linked to a seeded tenant's member, the newest link wins and the row names
    // that member and tenant.
    await linkAccount(userId, 'u-t1-agent-1');
    const active = await rowOf(userId, platformAdmin);
    expect(active?.accessState).toBe('active');
    expect(active?.memberId).toBe('u-t1-agent-1');
    expect(active?.tenantId).toBe('tenant-acme');

    // A tenant administrator still sees only their own tenant's accounts, so the
    // account in its own trial tenant is not theirs to administer.
    const acme = await api().get('/api/v1/admin/accounts').set({ 'x-member-id': 'u-t1-admin' });
    expect(acme.status).toBe(200);
    const acmeRows = acme.body.data as ReadonlyArray<{ tenantId: string | null }>;
    expect(acmeRows.length).toBeGreaterThan(0);
    expect(acmeRows.every((row) => row.tenantId === 'tenant-acme')).toBe(true);
  });

  it('refuses to mint platform authority from a merchant administrator', async () => {
    const acmeAdmin = { 'x-member-id': 'u-t1-admin' };

    // A platform administrator of the caller's own tenant: refused before
    // anything is written.
    const created = await api().post('/api/v1/admin/members').set(acmeAdmin).send({
      tenant_id: 'tenant-acme',
      role: 'platform_admin',
      username: nextUsername(),
      display_name: '越权管理员',
    });
    expect(created.status).toBe(403);
    expect(created.body.code).toBe('forbidden');

    // Promoting an own-tenant member instead: refused too, and the member
    // keeps the role it had.
    const promoted = await api()
      .post('/api/v1/admin/members/u-t1-agent-1/role')
      .set(acmeAdmin)
      .send({ role: 'platform_admin' });
    expect(promoted.status).toBe(403);
    expect(promoted.body.code).toBe('forbidden');

    const members = await api().get('/api/v1/admin/tenants/tenant-acme/members').set(acmeAdmin);
    expect(members.status).toBe(200);
    expect(
      (members.body.data as ReadonlyArray<{ role: string }>).filter(
        (member) => member.role === 'platform_admin',
      ),
    ).toHaveLength(0);

    // Binding an account to an own-tenant member still works, and still does
    // not carry the platform-wide account lifecycle with it.
    const { token, userId } = await register({ password: PASSWORD });
    await linkAccount(userId, 'u-t1-agent-2');
    const disabled = await api()
      .post(`/api/v1/admin/accounts/${userId}/disable`)
      .set(acmeAdmin)
      .send({});
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('forbidden');
    // The refused call changed nothing: the account and its session are intact.
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`)).status,
    ).toBe(200);

    // A real platform administrator still creates a platform-level member with
    // no tenant and no store.
    const platformMember = await api()
      .post('/api/v1/admin/members')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({
        role: 'platform_admin',
        username: nextUsername(),
        display_name: '平台管理员二',
      });
    expect(platformMember.status).toBe(201);
    expect(platformMember.body.data.role).toBe('platform_admin');
    expect(platformMember.body.data.tenantId).toBeNull();

    // And still cannot make a tenant member into a platform administrator:
    // those two facts are mutually exclusive by design.
    const invalid = await api()
      .post('/api/v1/admin/members/u-t1-agent-2/role')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({ role: 'platform_admin' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('bad_request');
  });

  it('refuses cross-tenant administration with 403', async () => {
    const acmeAdmin = { 'x-member-id': 'u-t1-admin' };
    expect(
      (await api().get('/api/v1/admin/tenants/tenant-acme/stores').set(acmeAdmin)).status,
    ).toBe(200);
    expect(
      (await api().get('/api/v1/admin/tenants/tenant-beta/stores').set(acmeAdmin)).status,
    ).toBe(403);
  });

  it('disables an account and revokes its sessions', async () => {
    const { token, userId } = await register({ password: PASSWORD });
    const disabled = await api()
      .post(`/api/v1/admin/accounts/${userId}/disable`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({});
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.revokedSessions).toBeGreaterThanOrEqual(1);

    const after = await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('forbidden');

    const enabled = await api()
      .post(`/api/v1/admin/accounts/${userId}/enable`)
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID)
      .send({});
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.status).toBe('active');
  });

  it('lists and revokes a remembered device of another account', async () => {
    const platformAdmin = { 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID };
    const { token, userId, username } = await register({ password: PASSWORD });
    const { credential, deviceId } = await rememberDevice(token);

    const listed = await api().get(`/api/v1/admin/accounts/${userId}/devices`).set(platformAdmin);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(deviceId);
    expect(listed.body.data[0].label).toBe('客服工作台');
    expect(listed.body.data[0].status).toBe('active');
    // An administrator is not the device's owner, so the row must not answer the
    // owner's question. The absence is the assertion.
    expect(JSON.stringify(listed.body.data)).not.toContain('current');
    expect(JSON.stringify(listed.body.data)).not.toContain('fingerprint');

    const revoked = await api()
      .post(`/api/v1/admin/accounts/${userId}/devices/${deviceId}/revoke`)
      .set(platformAdmin)
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(revoked.body.data.deviceId).toBe(deviceId);

    // The revocation reached the session the device held, not merely the list.
    const after = await api().get('/api/v1/auth/session').set('authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('unauthorized');

    // And the credential stops being honoured, without locking the operator out.
    expect((await signIn(username, PASSWORD, credential)).authMethod).toBe('password');

    // The revoked device is still listed, now labelled with what it is: an
    // administrator needs to see that the action landed.
    const afterRevoke = await api()
      .get(`/api/v1/admin/accounts/${userId}/devices`)
      .set(platformAdmin);
    expect(afterRevoke.body.data).toHaveLength(1);
    expect(afterRevoke.body.data[0].status).toBe('revoked');

    const again = await api()
      .post(`/api/v1/admin/accounts/${userId}/devices/${deviceId}/revoke`)
      .set(platformAdmin)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('conflict');

    const missing = await api()
      .post(`/api/v1/admin/accounts/${userId}/devices/device-nobody/revoke`)
      .set(platformAdmin)
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });

  it('refuses account device administration to a merchant administrator', async () => {
    const acmeAdmin = { 'x-member-id': 'u-t1-admin' };
    const platformAdmin = { 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID };
    const { token, userId } = await register({ password: PASSWORD });
    const { deviceId } = await rememberDevice(token);
    await linkAccount(userId, 'u-t1-agent-2');

    // The account acts through a member of the caller's own tenant, exactly as
    // in the lifecycle case, and that is still not enough.
    const listed = await api().get(`/api/v1/admin/accounts/${userId}/devices`).set(acmeAdmin);
    expect(listed.status).toBe(403);
    expect(listed.body.code).toBe('forbidden');

    const revoked = await api()
      .post(`/api/v1/admin/accounts/${userId}/devices/${deviceId}/revoke`)
      .set(acmeAdmin)
      .send({});
    expect(revoked.status).toBe(403);
    expect(revoked.body.code).toBe('forbidden');

    // Nothing moved: the refusal has to leave the device trusted.
    const stillThere = await api()
      .get(`/api/v1/admin/accounts/${userId}/devices`)
      .set(platformAdmin);
    expect(stillThere.body.data[0].status).toBe('active');
  });

  it('refuses account lifecycle administration to a merchant administrator', async () => {
    const acmeAdmin = { 'x-member-id': 'u-t1-admin' };
    const platformAdmin = { 'x-member-id': SEEDED_PLATFORM_ADMIN_MEMBER_ID };
    const acme = await register({ password: PASSWORD });
    const beta = await register({ password: PASSWORD });
    await linkAccount(acme.userId, 'u-t1-agent-2');
    await linkAccount(beta.userId, 'u-t2-agent-1');

    // The account acts through a member of the caller's own tenant, which is no
    // longer enough: the account lifecycle is platform-wide, not per-tenant.
    const ownDisable = await api()
      .post(`/api/v1/admin/accounts/${acme.userId}/disable`)
      .set(acmeAdmin)
      .send({});
    expect(ownDisable.status).toBe(403);
    expect(ownDisable.body.code).toBe('forbidden');
    expect(
      (await api().post(`/api/v1/admin/accounts/${acme.userId}/enable`).set(acmeAdmin).send({}))
        .status,
    ).toBe(403);

    // Binding another tenant's account into the caller's own tenant does not
    // hand its lifecycle over either.
    const bound = await api()
      .post('/api/v1/admin/members/u-t1-agent-1/link')
      .set(acmeAdmin)
      .send({ user_id: beta.userId });
    expect(bound.status).toBe(200);
    const boundDisable = await api()
      .post(`/api/v1/admin/accounts/${beta.userId}/disable`)
      .set(acmeAdmin)
      .send({});
    expect(boundDisable.status).toBe(403);
    expect(boundDisable.body.code).toBe('forbidden');
    expect(
      (await api().post(`/api/v1/admin/accounts/${beta.userId}/enable`).set(acmeAdmin).send({}))
        .status,
    ).toBe(403);

    // The refused calls changed nothing for either account.
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${acme.token}`)).status,
    ).toBe(200);
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${beta.token}`)).status,
    ).toBe(200);

    // The platform administrator still reaches the account that acts through a
    // single tenant...
    expect(
      (
        await api()
          .post(`/api/v1/admin/accounts/${acme.userId}/disable`)
          .set(platformAdmin)
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (await api().get('/api/v1/auth/session').set('authorization', `Bearer ${acme.token}`)).status,
    ).toBe(403);
    expect(
      (await api().post(`/api/v1/admin/accounts/${acme.userId}/enable`).set(platformAdmin).send({}))
        .status,
    ).toBe(200);

    // ...and the one that acts through several tenants at once.
    expect(
      (
        await api()
          .post(`/api/v1/admin/accounts/${beta.userId}/disable`)
          .set(platformAdmin)
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (await api().post(`/api/v1/admin/accounts/${beta.userId}/enable`).set(platformAdmin).send({}))
        .status,
    ).toBe(200);
  });

  it('refuses a tenant-scoped platform administrator every administrative surface', async () => {
    const repository = app.get<AuthRepository>(AUTH_REPOSITORY);
    const { token, userId } = await register({ password: PASSWORD });

    // The account starts in the trial workspace registration gave it; revoking
    // that link leaves the rogue row below as its only membership.
    for (const link of await repository.listActiveLinksForUser(userId)) {
      await repository.saveLink({
        ...link,
        revokedAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
      });
    }

    // What the refusals below must not change. The directory is shared with the
    // rest of the file, so it is read rather than assumed.
    const beforeRogue = await api()
      .get('/api/v1/admin/tenants/tenant-acme/stores')
      .set({ 'x-member-id': 'u-t1-admin' });
    expect(beforeRogue.status).toBe(200);

    // The rogue row the invariant forbids: the platform role held *inside* a
    // tenant. It is written through the repository port because the service can
    // no longer mint it — this is a database that predates migration `0005`, or
    // a write that bypassed the service. The session is then resolved over HTTP
    // so the request carries exactly the context the guard derives for a real
    // client.
    await repository.saveMember({
      id: 'u-rogue-admin',
      tenantId: 'tenant-acme',
      storeId: null,
      role: 'platform_admin',
      username: 'rogue-admin',
      displayName: '越权管理员',
      enabled: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await repository.saveLink({
      id: 'link-rogue-admin',
      userId,
      tenantId: 'tenant-acme',
      memberId: 'u-rogue-admin',
      linkedBy: null,
      linkedAt: '2026-08-01T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    const rogue = { authorization: `Bearer ${token}` };
    const access = await api().get('/api/v1/account/access').set(rogue);
    expect(access.status).toBe(200);
    expect(access.body.data.access.role).toBe('platform_admin');
    expect(access.body.data.access.tenantId).toBe('tenant-acme');

    // Every platform-level read and write is refused before the handler runs.
    const tenants = await api().get('/api/v1/admin/tenants').set(rogue);
    expect(tenants.status).toBe(403);
    expect(tenants.body.code).toBe('forbidden');

    const createdTenant = await api()
      .post('/api/v1/admin/tenants')
      .set(rogue)
      .send({ code: 'rogue', name: '越权租户' });
    expect(createdTenant.status).toBe(403);
    expect(createdTenant.body.code).toBe('forbidden');

    const accounts = await api().get('/api/v1/admin/accounts').set(rogue);
    expect(accounts.status).toBe(403);
    expect(accounts.body.code).toBe('forbidden');

    const disabled = await api()
      .post(`/api/v1/admin/accounts/${userId}/disable`)
      .set(rogue)
      .send({});
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('forbidden');

    // ...and so is tenant administration, including of the tenant the rogue
    // member names: the record is not quietly demoted to a tenant administrator.
    const foreignStores = await api().get('/api/v1/admin/tenants/tenant-beta/stores').set(rogue);
    expect(foreignStores.status).toBe(403);
    expect(foreignStores.body.code).toBe('forbidden');

    const ownMembers = await api().get('/api/v1/admin/tenants/tenant-acme/members').set(rogue);
    expect(ownMembers.status).toBe(403);

    const createdStore = await api()
      .post('/api/v1/admin/stores')
      .set(rogue)
      .send({ tenant_id: 'tenant-beta', code: 'rogue', name: '越权门店' });
    expect(createdStore.status).toBe(403);

    // Nothing was written: the tenant directory is exactly what it was, and the
    // account the caller acts through is still usable.
    const acme = await api().get('/api/v1/admin/tenants/tenant-acme/stores').set({
      'x-member-id': 'u-t1-admin',
    });
    expect(acme.status).toBe(200);
    expect(acme.body.data).toEqual(beforeRogue.body.data);
    expect((await api().get('/api/v1/auth/session').set(rogue)).status).toBe(200);
  });
});

/**
 * Identity-source tests for an environment that does not honour the demo
 * headers.
 *
 * This is the production-shaped boundary: `x-member-id` is refused outright and
 * an anonymous business request is 401. It runs against a `local` application
 * with `AUTH_DEMO_IDENTITY_HEADERS=false`, which is the same rule production
 * applies unconditionally — and which the `test` application above cannot
 * demonstrate, because `test` always accepts the demo headers.
 */
describe('Identity source rejection (interface)', () => {
  let app: INestApplication;
  let otp: LocalOtpProvider;

  beforeAll(async () => {
    // `AUTH_STORAGE=memory` keeps this suite independent of PostgreSQL: the
    // assertions are about the identity-source boundary, not about persistence.
    const parsed = parseAppConfig({
      APP_ENV: 'local',
      AUTH_DEMO_IDENTITY_HEADERS: 'false',
      AUTH_STORAGE: 'memory',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    app = await boot(parsed.config);
    const provider = app.get<OtpProvider>(AUTH_OTP_PROVIDER);
    if (!(provider instanceof LocalOtpProvider)) {
      throw new Error('an environment without demo headers must still issue local codes');
    }
    otp = provider;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a spoofed member header', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('x-member-id', SEEDED_PLATFORM_ADMIN_MEMBER_ID);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('forbidden');
  });

  it('requires authentication for a business request', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/knowledge/products');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('rejects an unknown bearer token', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/account/access')
      .set('authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('rejects malformed and unknown bearer tokens on a business route', async () => {
    const malformed = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('authorization', 'Bearer');
    expect(malformed.status).toBe(401);
    expect(malformed.body.code).toBe('unauthorized');

    const unknown = await request(app.getHttpServer())
      .get('/api/v1/knowledge/products')
      .set('authorization', 'Bearer not-a-real-token');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('unauthorized');
  });

  it('scopes a verified bearer to its own account, never to a default identity', async () => {
    const subject = nextPhone();
    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/send')
      .send({ subject, channel: 'sms' });
    expect(sent.status).toBe(200);
    const code = otp.lastDeliveryFor(subject)?.code ?? '';
    const registered = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: DISPLAY_NAME,
    });
    expect(registered.status).toBe(201);
    const token = registered.body.data.token as string;

    // The session is genuine and reaches nothing on its own: not the seeded
    // platform directory the header fallback used to supply, and not the
    // platform administrator identity that would reach every tenant.
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/tenants')
      .set('authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('forbidden');

    // The credential is nevertheless a real one, and the account center says
    // whose it is while granting it no identity beyond that.
    const access = await request(app.getHttpServer())
      .get('/api/v1/account/access')
      .set('authorization', `Bearer ${token}`);
    expect(access.status).toBe(200);
    expect(access.body.data.access.accessState).toBe('pending_config');
    expect(access.body.data.access.member).toBeNull();
    expect(access.body.data.access.tenantId).toBeNull();
  });

  it('keeps the health probes reachable without an identity', async () => {
    const live = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(live.status).toBe(200);
    expect(live.body.data.status).toBe('ok');
  });

  it('keeps the identity-establishing endpoints public', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login/password')
      .send({ username: 'nobody', password: 'irrelevant' });
    // Reached the handler: refused for the credential, not for being anonymous.
    expect(response.status).toBe(401);
  });

  it('does not echo the code without the local opt-in', async () => {
    const subject = nextPhone();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/send')
      .send({ subject, channel: 'sms' });
    expect(response.status).toBe(200);
    // A `local` deployment that has not opted in still hides the code, so the
    // reveal cannot be turned on by the environment boundary alone.
    expect(response.body.data).not.toHaveProperty('developmentCode');
    const code = otp.lastDeliveryFor(subject)?.code ?? '';
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(JSON.stringify(response.body)).not.toContain(code);
  });
});

/**
 * Interface tests for the local-development one-time code reveal.
 *
 * This is the one configuration in which the platform hands a code back, so the
 * suite pins down both halves of the contract: the code that is echoed is the
 * code that was delivered and can complete a real sign-in, and it still exists
 * only as a hash in durable state.
 */
describe('Development one-time code reveal (interface)', () => {
  let app: INestApplication;
  let otp: LocalOtpProvider;
  let repository: AuthRepository;

  beforeAll(async () => {
    const parsed = parseAppConfig({
      APP_ENV: 'local',
      AUTH_DEMO_IDENTITY_HEADERS: 'false',
      AUTH_STORAGE: 'memory',
      AUTH_DEVELOPMENT_OTP_VISIBLE: 'true',
    });
    if (parsed._tag !== 'ok') {
      throw new Error(`test config could not be parsed: ${parsed.error.message}`);
    }
    app = await boot(parsed.config);
    const provider = app.get<OtpProvider>(AUTH_OTP_PROVIDER);
    if (!(provider instanceof LocalOtpProvider)) {
      throw new Error('the opted-in local boundary must still resolve the local provider');
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

  it('echoes the delivered code and keeps only its hash in durable state', async () => {
    const subject = nextPhone();
    const response = await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' });
    expect(response.status).toBe(200);

    const delivery = otp.lastDeliveryFor(subject);
    expect(response.body.data.developmentCode).toBe(delivery?.code);
    expect(response.body.data.developmentCode).toMatch(/^[0-9]{6}$/);
    // The rest of the existing payload is untouched.
    expect(response.body.data.challengeId).toBe(delivery?.challengeId);
    expect(response.body.data.resent).toBe(false);

    const stored = await repository.getOtp(response.body.data.challengeId as string);
    expect(stored?.codeHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(response.body.data.developmentCode);
  });

  it('lets a client complete the sign-in loop with the revealed code alone', async () => {
    const subject = nextPhone();
    const sent = await api().post('/api/v1/auth/otp/send').send({ subject, channel: 'sms' });
    const code = sent.body.data.developmentCode as string;

    const registered = await api().post('/api/v1/auth/register').send({
      subject,
      channel: 'sms',
      code,
      username: nextUsername(),
      display_name: DISPLAY_NAME,
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    // The loop the reveal exists to unblock ends at a real credential, but the
    // account it belongs to waits for the approval bell like any other.
    expect(registered.body.data.access.accessState).toBe('pending_config');
    expect(registered.body.data.access.role).toBeNull();
  });
});
