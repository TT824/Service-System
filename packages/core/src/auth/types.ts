/**
 * Authentication and access-control domain types.
 *
 * These types mirror the durable schema added by migrations `0003_auth_identity`
 * and `0004_auth_sessions`, so a record read from PostgreSQL and a record held
 * by the deterministic in-memory adapter are the same value. Credential
 * material never appears here: a password is an encoded hash, and a token,
 * device credential or one-time code is present only as a fingerprint/hash.
 */

import type { Member, PlatformRole } from '../platform/types';

/** Identity providers an account can sign in with. */
export type AuthProvider = 'password' | 'phone' | 'wecom' | 'oidc';

/** Account lifecycle states (mirrors `user_accounts.status`). */
export type AccountStatus = 'pending' | 'active' | 'locked' | 'disabled';

/**
 * Effective access state of an authenticated session.
 *
 * - `active`: the account, member link and tenant are all usable.
 * - `pending_config`: the account exists but its tenant/member configuration is
 *   incomplete, so only the account center is reachable.
 * - `disabled`: the account or its member was disabled; nothing is reachable.
 */
export type AccessState = 'active' | 'pending_config' | 'disabled';

/** Purpose a one-time code was issued for (mirrors `otp_challenges.purpose`). */
export type OtpPurpose = 'sign_in' | 'bind_identity' | 'rebind_identity' | 'recover';

/** Delivery channel of a one-time code. */
export type OtpChannel = 'sms' | 'email';

/** One-time code lifecycle (mirrors `otp_challenges.status`). */
export type OtpStatus = 'pending' | 'consumed' | 'expired' | 'revoked';

/** How a session was authenticated (mirrors `auth_sessions.auth_method`). */
export type SessionAuthMethod = 'password' | 'otp' | 'sso' | 'trusted_device';

/**
 * How an access context was authenticated.
 *
 * Every context a session produces carries a {@link SessionAuthMethod}. The
 * extra `header` member exists only for the demo identity path (`x-member-id`
 * outside production), so such a context can say truthfully that it was not
 * derived from a verified credential instead of claiming a method it never used.
 */
export type AccessAuthMethod = SessionAuthMethod | 'header';

/** Session lifecycle (mirrors `auth_sessions.status`). */
export type SessionStatus = 'active' | 'revoked' | 'expired';

/**
 * Revocation reasons the durable schema records.
 *
 * Deliberately the closed set of `auth_sessions.revoked_reason`. Higher-level
 * causes (a password reset, a disabled account, a revoked device) all revoke
 * with `admin_revoked`, which keeps the stored reason inside the schema
 * constraint instead of widening it.
 */
export type SessionRevokedReason =
  'sign_out' | 'rotated' | 'admin_revoked' | 'reuse_detected' | 'expired';

/** Trusted device lifecycle (mirrors `trusted_devices.status`). */
export type DeviceStatus = 'active' | 'revoked' | 'expired';

/** Why a trusted device stopped being trusted. */
export type DeviceRevokedReason = 'user' | 'admin' | 'expired' | 'compromised';

/** Platform a trusted device belongs to. */
export type DevicePlatform = 'web' | 'ios' | 'android' | 'desktop' | 'unknown';

/** Every device platform the schema accepts. */
export const DEVICE_PLATFORMS: ReadonlyArray<DevicePlatform> = [
  'web',
  'ios',
  'android',
  'desktop',
  'unknown',
];

/** A user account (`user_accounts`). */
export type UserAccount = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  /** Encoded scrypt hash, or `null` when the account has no password credential. */
  readonly passwordHash: string | null;
  readonly passwordUpdatedAt: string | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: string | null;
  readonly lastLoginAt: string | null;
  /**
   * The account's avatar as a base64 `data:` URL, or `null` when it has none.
   *
   * Stored on the row rather than pointed at, and bounded by
   * `AVATAR_MAX_DATA_URL_LENGTH`: see `avatar.ts` for why, and for what a value
   * has to look like to be accepted at all.
   */
  readonly avatarUrl: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** One external identity of an account (`user_identities`). */
export type UserIdentity = {
  readonly id: string;
  readonly userId: string;
  readonly provider: AuthProvider;
  /** Provider-scoped identifier (phone number, OIDC `sub`, ...). Not a secret. */
  readonly subject: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** An account acting through a tenant member (`member_user_links`). */
export type MemberUserLink = {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string | null;
  readonly memberId: string;
  readonly linkedBy: string | null;
  readonly linkedAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** A store a member may operate on (`member_store_scopes`). */
export type MemberStoreScope = {
  readonly tenantId: string;
  readonly memberId: string;
  readonly storeId: string;
  readonly isPrimary: boolean;
  readonly grantedBy: string | null;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** An issued one-time code (`otp_challenges`). */
export type OtpChallenge = {
  readonly id: string;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly purpose: OtpPurpose;
  readonly channel: OtpChannel;
  /** Delivery destination (phone number / email). Routing data, not a secret. */
  readonly subject: string;
  /** Hash of the delivered code. The code itself is never persisted. */
  readonly codeHash: string;
  readonly codeAlgorithm: string;
  readonly status: OtpStatus;
  readonly failedAttempts: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** A device the user chose to remember (`trusted_devices`). */
export type TrustedDevice = {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string | null;
  readonly label: string;
  readonly platform: DevicePlatform;
  /** Fingerprint of the device credential; the credential itself is never stored. */
  readonly credentialFingerprint: string;
  readonly status: DeviceStatus;
  readonly idempotencyKey: string | null;
  readonly trustedAt: string;
  readonly expiresAt: string | null;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: DeviceRevokedReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** One issued bearer session (`auth_sessions`). */
export type AuthSession = {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string | null;
  readonly memberId: string | null;
  readonly trustedDeviceId: string | null;
  /** Fingerprint of the bearer token handed to the client. */
  readonly tokenFingerprint: string;
  readonly previousTokenFingerprint: string | null;
  readonly rotationFamilyId: string;
  readonly authMethod: SessionAuthMethod;
  readonly status: SessionStatus;
  readonly mfaSatisfied: boolean;
  readonly clientFingerprint: string | null;
  readonly idempotencyKey: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: SessionRevokedReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Where a one-time code was delivered. */
export type OtpDelivery = {
  readonly challengeId: string;
  readonly channel: OtpChannel;
  readonly subject: string;
  readonly purpose: OtpPurpose;
  /** The plaintext code. Exists only in transit; providers must not persist it. */
  readonly code: string;
  readonly expiresAt: string;
};

/** Claims an OIDC provider returns for an authorization code exchange. */
export type OidcIdentityClaims = {
  /** Issuer/provider key the identity is namespaced under. */
  readonly provider: string;
  /** Provider-scoped subject (`sub` claim). */
  readonly subject: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly email?: string;
};

/**
 * The resolved access context of one authenticated request.
 *
 * This is what a business service needs: who the user is, which member they act
 * through, and the tenant/store scope that request may touch.
 */
export type AccessContext = {
  readonly userId: string;
  readonly sessionId: string;
  readonly accountStatus: AccountStatus;
  readonly accessState: AccessState;
  /** `null` when the account is not linked to a member yet (`pending_config`). */
  readonly member: Member | null;
  readonly tenantId: string | null;
  readonly storeId: string | null;
  readonly role: PlatformRole | null;
  readonly authorizedStoreIds: ReadonlyArray<string>;
  readonly authMethod: AccessAuthMethod;
  readonly expiresAt: string;
};

/** Public description of one active session (never carries the token). */
export type SessionSummary = {
  readonly id: string;
  readonly authMethod: SessionAuthMethod;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly memberId: string | null;
  readonly tenantId: string | null;
  readonly current: boolean;
};

/** Public description of one trusted device (never carries the credential). */
export type DeviceSummary = {
  readonly id: string;
  readonly label: string;
  readonly platform: DevicePlatform;
  readonly status: DeviceStatus;
  readonly trustedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly current: boolean;
};
