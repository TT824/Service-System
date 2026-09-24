/**
 * Injection tokens for the authentication module.
 *
 * The domain services are plain classes constructed from their dependencies, so
 * the Nest layer only has to say *which* repository and *which* providers to
 * use. Naming them as tokens keeps that choice in one place and lets an
 * interface test swap the deterministic in-memory adapter for the durable one
 * without reaching into the module.
 */

/** Chosen {@link AuthRepository} implementation. */
export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

/** Chosen one-time code delivery provider. */
export const AUTH_OTP_PROVIDER = Symbol('AUTH_OTP_PROVIDER');

/** Chosen OIDC provider. */
export const AUTH_OIDC_PROVIDER = Symbol('AUTH_OIDC_PROVIDER');
