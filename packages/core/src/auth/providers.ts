/**
 * Outbound identity providers: one-time code delivery and OIDC.
 *
 * The platform ships interfaces plus *deterministic local* implementations and
 * deliberately refuses to pretend a real provider exists. In `local` and `test`
 * the local provider is used, so the whole workflow is exercisable without a
 * network call or a third-party account. In `production` a provider must be
 * named explicitly; with nothing configured the platform resolves an
 * *unconfigured* provider that fails closed at call time with
 * `provider_not_configured` instead of silently accepting codes or identities
 * nobody verified.
 */

import type { AppEnvironment } from '../app-config';
import { AuthError } from './errors';
import { fingerprintSecret } from './token';
import type { OidcIdentityClaims, OtpDelivery } from './types';

/** Delivers a one-time code to its destination. */
export interface OtpProvider {
  /** Stable provider key, echoed in diagnostics. */
  readonly kind: string;
  /**
   * Deliver one code.
   *
   * @param delivery - Challenge, destination and plaintext code.
   * @throws {AuthError} `provider_not_configured` when no real provider is wired.
   */
  send(delivery: OtpDelivery): Promise<void>;
}

/** One recorded local delivery, exposed for tests and local inspection. */
export type RecordedOtpDelivery = {
  readonly challengeId: string;
  readonly channel: string;
  readonly subject: string;
  readonly purpose: string;
  readonly code: string;
  readonly expiresAt: string;
};

/**
 * Deterministic in-process one-time code provider.
 *
 * It performs no network call and stores only what a test needs to read the
 * code back. Deliveries live in memory for the lifetime of the process and are
 * never written to a log.
 */
export class LocalOtpProvider implements OtpProvider {
  readonly kind = 'local';
  #deliveries: RecordedOtpDelivery[] = [];

  /** @inheritdoc */
  async send(delivery: OtpDelivery): Promise<void> {
    this.#deliveries.push({
      challengeId: delivery.challengeId,
      channel: delivery.channel,
      subject: delivery.subject,
      purpose: delivery.purpose,
      code: delivery.code,
      expiresAt: delivery.expiresAt,
    });
  }

  /** Every delivery recorded so far, oldest first. */
  deliveries(): ReadonlyArray<RecordedOtpDelivery> {
    return [...this.#deliveries];
  }

  /**
   * Most recent delivery to a destination.
   *
   * @param subject - Destination the code was sent to.
   * @returns The latest delivery, or `undefined` when none was recorded.
   */
  lastDeliveryFor(subject: string): RecordedOtpDelivery | undefined {
    for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) {
      const delivery = this.#deliveries[index];
      if (delivery !== undefined && delivery.subject === subject) {
        return delivery;
      }
    }
    return undefined;
  }

  /** Forget every recorded delivery. */
  clear(): void {
    this.#deliveries = [];
  }

  /**
   * The plaintext code one recorded delivery carried.
   *
   * Deliberately *not* part of the {@link OtpProvider} interface: reading a
   * code back is something only the deterministic local provider can do, and
   * only the local composition boundary asks for it. Production adapters have
   * no equivalent, so a code they delivered cannot be recovered from the
   * platform by construction.
   *
   * @param challengeId - Challenge the delivery was issued for.
   * @returns The code, or `undefined` when no such delivery was recorded.
   */
  codeForChallenge(challengeId: string): string | undefined {
    for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) {
      const delivery = this.#deliveries[index];
      if (delivery !== undefined && delivery.challengeId === challengeId) {
        return delivery.code;
      }
    }
    return undefined;
  }
}

/**
 * Provider used when production has no real provider configured.
 *
 * Every call fails closed with `provider_not_configured`, so an unconfigured
 * production deployment can never issue a code the platform cannot actually
 * deliver, nor accept one it never sent.
 */
export class UnconfiguredOtpProvider implements OtpProvider {
  readonly kind = 'unconfigured';

  /**
   * @param reason - Configuration detail included in the failure message.
   */
  constructor(private readonly reason: string) {}

  /** @inheritdoc */
  async send(): Promise<void> {
    throw new AuthError('provider_not_configured', this.reason);
  }
}

/** Exchanges an authorization code for verified OIDC claims. */
export interface OidcProvider {
  /** Stable provider key, namespacing the `sub` claim it returns. */
  readonly kind: string;
  /**
   * Exchange an authorization code.
   *
   * @param code - Authorization code returned by the provider.
   * @param redirectUri - Redirect URI the code was issued for, when known.
   * @returns Verified claims for the authenticated identity.
   * @throws {AuthError} `provider_not_configured` when no real provider is wired.
   */
  exchangeCode(code: string, redirectUri?: string): Promise<OidcIdentityClaims>;
}

/** Prefix of every subject the local OIDC provider derives. */
export const LOCAL_OIDC_PROVIDER_KEY = 'local-oidc';

/**
 * Derive the deterministic subject of a local OIDC authorization code.
 *
 * The code is hashed rather than embedded, so a code that leaks into a report
 * or a log line cannot be replayed as an identity. The value returned here is
 * the provider-scoped subject; the platform stores it namespaced with the
 * issuer key (see {@link namespacedIdentitySubject}).
 *
 * @param code - Authorization code.
 * @returns The provider-scoped subject.
 */
export function localOidcSubject(code: string): string {
  return fingerprintSecret(code).slice(0, 24);
}

/**
 * Namespace a provider subject under its issuer.
 *
 * `user_identities.provider` is constrained to the four providers the schema
 * knows, so an external issuer cannot be its own `provider` value. The issuer
 * key is folded into the subject instead, which keeps two different issuers
 * that happen to use the same `sub` from colliding.
 *
 * @param provider - Issuer key.
 * @param subject - Provider-scoped subject.
 * @returns The stored subject.
 */
export function namespacedIdentitySubject(provider: string, subject: string): string {
  return `${provider}:${subject}`;
}

/**
 * Deterministic in-process OIDC provider.
 *
 * No network call is made and no provider secret is held. A code maps to a
 * stable subject, which is exactly what the bind/login/unbind workflow needs
 * to be exercised end to end in local and test environments.
 */
export class LocalOidcProvider implements OidcProvider {
  readonly kind = LOCAL_OIDC_PROVIDER_KEY;

  /**
   * @param issuer - Issuer key the identities are namespaced under.
   */
  constructor(private readonly issuer: string = LOCAL_OIDC_PROVIDER_KEY) {}

  /** @inheritdoc */
  async exchangeCode(code: string): Promise<OidcIdentityClaims> {
    if (code.trim().length === 0) {
      throw new AuthError('provider_error', 'authorization code must not be empty');
    }
    return {
      provider: this.issuer,
      subject: localOidcSubject(code),
      displayName: '本地联合身份用户',
      username: `oidc-${fingerprintSecret(code).slice(0, 8)}`,
    };
  }
}

/** OIDC provider used when production has no real provider configured. */
export class UnconfiguredOidcProvider implements OidcProvider {
  readonly kind = 'unconfigured';

  /**
   * @param reason - Configuration detail included in the failure message.
   */
  constructor(private readonly reason: string) {}

  /** @inheritdoc */
  async exchangeCode(): Promise<OidcIdentityClaims> {
    throw new AuthError('provider_not_configured', this.reason);
  }
}

/** Inputs that decide which one-time code provider is resolved. */
export type ProviderResolutionInput = {
  readonly appEnv: AppEnvironment;
  /** Explicitly configured provider key, or an empty string when unset. */
  readonly configured: string;
};

/**
 * Resolve the one-time code provider for an environment.
 *
 * @param input - Runtime environment and configured provider key.
 * @returns A local provider outside production, otherwise the configured one.
 * @throws {AuthError} `provider_not_configured` when production names a provider
 * the platform has no adapter for.
 */
export function resolveOtpProvider(input: ProviderResolutionInput): OtpProvider {
  if (input.appEnv !== 'production') {
    return new LocalOtpProvider();
  }
  const configured = input.configured.trim();
  if (configured.length === 0) {
    return new UnconfiguredOtpProvider(
      'AUTH_OTP_PROVIDER must be configured before one-time codes can be sent in production',
    );
  }
  // No real SMS/e-mail adapter is in scope for this task; naming one is an
  // explicit acknowledgement that a real provider must be wired here.
  return new UnconfiguredOtpProvider(
    `no one-time code adapter is installed for AUTH_OTP_PROVIDER=${configured}`,
  );
}

/**
 * Resolve the OIDC provider for an environment.
 *
 * @param input - Runtime environment and configured provider key.
 * @returns A local provider outside production, otherwise the configured one.
 * @throws {AuthError} `provider_not_configured` when production names a provider
 * the platform has no adapter for.
 */
export function resolveOidcProvider(input: ProviderResolutionInput): OidcProvider {
  if (input.appEnv !== 'production') {
    return new LocalOidcProvider();
  }
  const configured = input.configured.trim();
  if (configured.length === 0) {
    return new UnconfiguredOidcProvider(
      'AUTH_OIDC_PROVIDER must be configured before OIDC sign-in can be used in production',
    );
  }
  return new UnconfiguredOidcProvider(
    `no OIDC adapter is installed for AUTH_OIDC_PROVIDER=${configured}`,
  );
}
