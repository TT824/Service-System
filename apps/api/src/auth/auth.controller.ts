import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthService,
  DEVICE_PLATFORMS,
  type AccessContext,
  type AppConfig,
  type AuthSession,
  type DevicePlatform,
  type OtpChannel,
  type OtpPurpose,
  type OtpProvider,
  type SendOtpResult,
  type SessionIssueResult,
  type SessionSummary,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { bodyOptionalString, bodyRecord, bodyRequiredString } from '../http/request-body';
import { AUTH_OTP_PROVIDER } from './auth.tokens';
import { bearerTokenOf } from './bearer-token';
import { resolveDevelopmentOtpCode } from './development-otp';
import { Public } from './public-route.decorator';
import { SessionAccessService } from './session-access.service';

/** Sign-in and registration payload: the issued token plus its context. */
type IssuedSessionPayload = {
  readonly token: string;
  readonly expires_at: string;
  readonly session: SessionSummary;
  readonly access: AccessContext;
};

const OTP_CHANNELS: ReadonlyArray<OtpChannel> = ['sms', 'email'];
const OTP_PURPOSES: ReadonlyArray<OtpPurpose> = [
  'sign_in',
  'bind_identity',
  'rebind_identity',
  'recover',
];

/**
 * Authentication endpoints.
 *
 * Every route here is either public because it *establishes* an identity
 * (`/auth/otp/send`, `/auth/register`, `/auth/login/*`, `/auth/password/reset`)
 * or authenticated because it operates on the caller's own session. A bearer
 * token is returned exactly once, at the moment it is issued, and never again:
 * the platform stores only its fingerprint, so it cannot be re-read later.
 */
@Controller('auth')
export class AuthController {
  /**
   * @param auth - Domain service that owns the sign-in workflows.
   * @param sessionAccess - Resolves and caches the caller's access context.
   * @param config - Parsed configuration, consulted for the local OTP reveal.
   * @param otpProvider - Provider the composition root resolved for this app.
   */
  constructor(
    private readonly auth: AuthService,
    private readonly sessionAccess: SessionAccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_OTP_PROVIDER) private readonly otpProvider: OtpProvider,
  ) {}

  // --------------------------------------------------------------------------
  // Public: establishing an identity
  // --------------------------------------------------------------------------

  /** Send a one-time code to a phone number or e-mail address. */
  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: unknown): Promise<SendOtpResult> {
    const record = bodyRecord(body);
    const result = await this.auth.sendOtp({
      subject: bodyRequiredString(record, 'subject'),
      channel: requireChannel(record),
      purpose: requirePurpose(record),
    });
    // The code itself is never echoed: it exists only in the delivery the
    // provider performed. The one exception is an explicit local-development
    // opt-in backed by the deterministic in-process provider, decided here
    // because this is the only place that knows both the environment and the
    // provider that was actually resolved.
    const developmentCode = resolveDevelopmentOtpCode({
      config: this.config,
      provider: this.otpProvider,
      challengeId: result.challengeId,
    });
    return developmentCode === undefined ? result : { ...result, developmentCode };
  }

  /** Register an account from a verified one-time code. */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown): Promise<IssuedSessionPayload> {
    const record = bodyRecord(body);
    const password = bodyOptionalString(record, 'password');
    const result = await this.auth.register({
      subject: bodyRequiredString(record, 'subject'),
      channel: requireChannel(record),
      code: bodyRequiredString(record, 'code'),
      username: bodyRequiredString(record, 'username'),
      displayName: bodyRequiredString(record, 'display_name'),
      ...(password === undefined ? {} : { password }),
    });
    return toIssuedSession(result);
  }

  /** Sign in with username and password. */
  @Public()
  @Post('login/password')
  @HttpCode(HttpStatus.OK)
  async loginWithPassword(@Body() body: unknown): Promise<IssuedSessionPayload> {
    const record = bodyRecord(body);
    const clientFingerprint = bodyOptionalString(record, 'client_fingerprint');
    // Not `required`: a client that has never remembered this device, or has had
    // it revoked, simply omits it and signs in with the password alone.
    const deviceCredential = bodyOptionalString(record, 'device_credential');
    const result = await this.auth.loginWithPassword({
      username: bodyRequiredString(record, 'username'),
      password: bodyRequiredString(record, 'password'),
      ...(deviceCredential === undefined ? {} : { deviceCredential }),
      ...(clientFingerprint === undefined ? {} : { clientFingerprint }),
    });
    return toIssuedSession(result);
  }

  /** Sign in with a one-time code. */
  @Public()
  @Post('login/otp')
  @HttpCode(HttpStatus.OK)
  async loginWithOtp(@Body() body: unknown): Promise<IssuedSessionPayload> {
    const record = bodyRecord(body);
    const clientFingerprint = bodyOptionalString(record, 'client_fingerprint');
    const result = await this.auth.loginWithOtp({
      subject: bodyRequiredString(record, 'subject'),
      channel: requireChannel(record),
      code: bodyRequiredString(record, 'code'),
      ...(clientFingerprint === undefined ? {} : { clientFingerprint }),
    });
    return toIssuedSession(result);
  }

  /** Sign in through an OIDC authorization code. */
  @Public()
  @Post('login/oidc')
  @HttpCode(HttpStatus.OK)
  async loginWithOidc(@Body() body: unknown): Promise<IssuedSessionPayload> {
    const record = bodyRecord(body);
    const redirectUri = bodyOptionalString(record, 'redirect_uri');
    const clientFingerprint = bodyOptionalString(record, 'client_fingerprint');
    const result = await this.auth.loginWithOidc({
      code: bodyRequiredString(record, 'code'),
      ...(redirectUri === undefined ? {} : { redirectUri }),
      ...(clientFingerprint === undefined ? {} : { clientFingerprint }),
    });
    return toIssuedSession(result);
  }

  /** Reset a password from a verified recovery code. */
  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    return this.auth.resetPassword({
      subject: bodyRequiredString(record, 'subject'),
      channel: requireChannel(record),
      code: bodyRequiredString(record, 'code'),
      newPassword: bodyRequiredString(record, 'new_password'),
    });
  }

  // --------------------------------------------------------------------------
  // Authenticated: the caller's own session
  // --------------------------------------------------------------------------

  /** The account and access context behind the presented token. */
  @Get('session')
  async currentSession(@Req() req: Request): Promise<unknown> {
    const resolved = await this.sessionAccess.resolve(req);
    return {
      account: {
        id: resolved.account.id,
        username: resolved.account.username,
        display_name: resolved.account.displayName,
        status: resolved.account.status,
        // `null` for an account that never verified a number — including the
        // seeded platform administrator. The console labels the field, so it has
        // to be able to tell "no number on file" from a blank one.
        phone: await this.auth.verifiedPhone(resolved.account.id),
        // The account row this session was resolved from, so the console's own
        // picture arrives in the payload that decides whether there is a console
        // to draw it in.
        avatar_url: resolved.account.avatarUrl,
      },
      access: resolved.access,
      expires_at: resolved.session.expiresAt,
      sessions: await this.auth.listSessions(this.#requireToken(req)),
    };
  }

  /** Active sessions of the account behind the presented token. */
  @Get('sessions')
  sessions(@Req() req: Request): Promise<ReadonlyArray<SessionSummary>> {
    return this.auth.listSessions(this.#requireToken(req));
  }

  /** Issue a fresh token for the same session, invalidating the old one. */
  @Post('session/rotate')
  @HttpCode(HttpStatus.OK)
  async rotate(@Req() req: Request): Promise<IssuedSessionPayload> {
    const result = await this.auth.rotateSession(this.#requireToken(req));
    return toIssuedSession(result);
  }

  /** End the presented session, or every session of the account. */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    const all = record['all_sessions'];
    if (all !== undefined && typeof all !== 'boolean') {
      throw new BadRequestException('all_sessions must be a boolean');
    }
    return this.auth.logout({
      token: this.#requireToken(req),
      ...(all === undefined ? {} : { allSessions: all }),
    });
  }

  /**
   * Change the password of the signed-in account.
   *
   * Authenticated, and deliberately not the same route as `password/reset`: that
   * one is public and proves control of a recovery destination, this one proves
   * knowledge of the current password. The difference is what each keeps alive
   * afterwards — a reset ends every session and forgets every device, a change
   * ends the other sessions and keeps this one.
   */
  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    return this.auth.changePassword({
      token: this.#requireToken(req),
      currentPassword: bodyRequiredString(record, 'current_password'),
      newPassword: bodyRequiredString(record, 'new_password'),
    });
  }

  /**
   * Replace the avatar of the signed-in account.
   *
   * `avatar_url` is required and may be `null`: the field is how a caller says
   * *this account now has this picture*, and `null` is one of the answers —
   * "no picture". An absent field is a malformed request rather than a third
   * way of saying the same thing, because the one caller that forgets to send
   * it means to set an avatar and must not silently clear the one on file.
   */
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  async setAvatar(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    const avatarUrl = record['avatar_url'];
    if (avatarUrl !== null && typeof avatarUrl !== 'string') {
      throw new BadRequestException('avatar_url must be a string or null');
    }
    return this.auth.setAvatar(this.#requireToken(req), avatarUrl);
  }

  // --------------------------------------------------------------------------
  // Authenticated: onboarding
  // --------------------------------------------------------------------------

  // `POST /auth/onboarding/retry` used to live here. It is gone, and it must not
  // come back: it minted the caller's own tenant, store and merchant
  // administrator, so once registration stops at `pending` it would be a
  // self-service approval — an applicant POSTs it and is inside, no administrator
  // involved. Approval is `POST /admin/accounts/:userId/approve` and only that.
  // `AuthService.retryOnboarding` is kept because the workspace model behind it
  // is legitimate; nothing routes to it.

  // --------------------------------------------------------------------------
  // Authenticated: trusted devices
  // --------------------------------------------------------------------------

  /** Remembered devices of the account behind the presented token. */
  @Get('devices')
  devices(@Req() req: Request): Promise<unknown> {
    return this.auth.listDevices(this.#requireToken(req));
  }

  /** Enrol the current client as a trusted device. */
  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  async enrollDevice(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    return this.auth.enrollDevice({
      token: this.#requireToken(req),
      label: bodyRequiredString(record, 'label'),
      platform: requirePlatform(record),
    });
  }

  /** Revoke a trusted device and every session bound to it. */
  @Post('devices/:deviceId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeDevice(@Req() req: Request, @Param('deviceId') deviceId: string): Promise<unknown> {
    return this.auth.revokeDevice(this.#requireToken(req), deviceId);
  }

  // --------------------------------------------------------------------------
  // Authenticated: external identities
  // --------------------------------------------------------------------------

  /** Bind an OIDC identity to the caller's account. */
  @Post('identities/oidc')
  @HttpCode(HttpStatus.OK)
  async bindOidc(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const record = bodyRecord(body);
    const redirectUri = bodyOptionalString(record, 'redirect_uri');
    return this.auth.bindOidc({
      token: this.#requireToken(req),
      code: bodyRequiredString(record, 'code'),
      ...(redirectUri === undefined ? {} : { redirectUri }),
    });
  }

  /** Unbind an external identity, refusing to remove the last credential. */
  @Delete('identities/:identityId')
  @HttpCode(HttpStatus.OK)
  async unbindOidc(@Req() req: Request, @Param('identityId') identityId: string): Promise<unknown> {
    return this.auth.unbindOidc({
      token: this.#requireToken(req),
      identityId,
    });
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * The bearer token of the request.
   *
   * The guard already refused an anonymous request, so a missing token here
   * means the caller authenticated through demo identity headers — which has no
   * session to operate on.
   */
  #requireToken(req: Request): string {
    const token = bearerTokenOf(req);
    if (token === undefined) {
      throw new UnauthorizedException('this endpoint requires a bearer session');
    }
    return token;
  }
}

/**
 * Reshape a domain session result into the wire payload.
 *
 * The session is summarised rather than returned whole: the stored record
 * carries the token fingerprint and the previous fingerprint, which are
 * operational bookkeeping the caller has no reason to see.
 */
function toIssuedSession(result: SessionIssueResult): IssuedSessionPayload {
  return {
    token: result.token,
    expires_at: result.session.expiresAt,
    session: toSessionSummary(result.session),
    access: result.access,
  };
}

/** The wire view of one stored session: no token, no fingerprint, no family id. */
function toSessionSummary(session: AuthSession): SessionSummary {
  return {
    id: session.id,
    authMethod: session.authMethod,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    memberId: session.memberId,
    tenantId: session.tenantId,
    current: true,
  };
}

/** Read and validate the `channel` field. */
function requireChannel(record: Record<string, unknown>): OtpChannel {
  const value = bodyRequiredString(record, 'channel');
  if (!OTP_CHANNELS.includes(value as OtpChannel)) {
    throw new BadRequestException(`channel must be one of ${OTP_CHANNELS.join(', ')}`);
  }
  return value as OtpChannel;
}

/** Read and validate the `purpose` field, defaulting to signing in. */
function requirePurpose(record: Record<string, unknown>): OtpPurpose {
  const value = bodyOptionalString(record, 'purpose');
  if (value === undefined) {
    return 'sign_in';
  }
  if (!OTP_PURPOSES.includes(value as OtpPurpose)) {
    throw new BadRequestException(`purpose must be one of ${OTP_PURPOSES.join(', ')}`);
  }
  return value as OtpPurpose;
}

/** Read and validate the `platform` field of a device enrolment. */
function requirePlatform(record: Record<string, unknown>): DevicePlatform {
  const value = bodyOptionalString(record, 'platform');
  if (value === undefined) {
    return 'unknown';
  }
  if (!DEVICE_PLATFORMS.includes(value as DevicePlatform)) {
    throw new BadRequestException(`platform must be one of ${DEVICE_PLATFORMS.join(', ')}`);
  }
  return value as DevicePlatform;
}
