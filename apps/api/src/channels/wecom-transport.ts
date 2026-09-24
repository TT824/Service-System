/**
 * The single description of what the WeCom channel actually is right now.
 *
 * Two surfaces report the channel — `GET /channels` and `GET /access/status` —
 * and they used to describe it with different words, so an operator could read
 * "disabled" on the account page and "operational" on the channel page in the
 * same session. Both now derive from {@link describeWecomTransport}, so the two
 * cannot drift, and neither can claim more than was checked:
 *
 * - `enableRequested` is what the environment asked for (`WECOM_ENABLED`). It is
 *   a *request*, never evidence that credentials exist.
 * - `credentialsPresent` is derived from the resolved credential set — the
 *   console's when it holds one, the environment's otherwise — by checking the
 *   five fields through `@kefu/core`'s one rule. Only the resulting boolean
 *   leaves this module, so no secret value is ever logged, returned or compared
 *   against a fixture.
 * - `credentialSource` says *which* set was read, so "a field is missing" comes
 *   with the place to go and fill it in.
 * - `missingCredentials` names the fields that set still needs. It carries names
 *   only, which is what makes "not configured" actionable without printing
 *   anything sensitive.
 * - `realTransportConnected` is the last thing the real transport actually
 *   *proved*. It starts `false`, and only a successful token fetch — the one
 *   operation that simultaneously exercises the credential and the network —
 *   turns it on through {@link markWecomConnected}. A Mock boot never sets it.
 * - `lastConnectionError` is the platform's own account of why the last real
 *   connection attempt did not succeed: a stable code, a platform-authored
 *   message and the instant it was recorded. It is `null` while connected, and
 *   `null` too on a Mock or disabled channel, where nothing was attempted and
 *   {@link WecomTransportStatus.missingCredentials} is the actionable fact
 *   instead. Nothing the provider sent ever reaches it — the provider's
 *   `errmsg` is unbounded text under a third party's control, and this value is
 *   returned to an operator's browser.
 *
 * {@link markWecomConnected} is process-wide state on purpose: it records what
 * the bound transport verified, both channel surfaces read it, and there is
 * exactly one writer. A per-caller copy would let the two surfaces disagree
 * again, which is the defect this module exists to prevent.
 */

import {
  wecomProblemVariables,
  type AppConfig,
  type WecomCredentialOrigin,
  type WecomCredentialResolution,
} from '@kefu/core';

/** Which transport carries the WeCom channel. */
export type WecomTransportMode = 'mock' | 'real' | 'disabled';

/**
 * Stable codes a failed connection attempt can be reported with.
 *
 * Deliberately a closed set the platform chooses: the transport probe answers a
 * boolean, and the provider's own error document is never allowed to name a
 * code that reaches a browser.
 */
export type WecomConnectionErrorCode = 'wecom_probe_failed';

/**
 * Platform-authored account of why the last real connection attempt failed.
 *
 * Safe to render: `message` is written by this module, `at` is when the attempt
 * was recorded, and neither the credential nor anything the provider sent is
 * carried — see {@link WecomTransportStatus.lastConnectionError}.
 */
export type WecomConnectionError = {
  /** Stable machine code chosen by the platform. */
  readonly code: WecomConnectionErrorCode;
  /** Platform-authored, credential-free description of the failure. */
  readonly message: string;
  /** When the failed attempt was recorded, as an ISO-8601 instant. */
  readonly at: string;
};

/** Honest, credential-free description of the WeCom channel's current state. */
export type WecomTransportStatus = {
  readonly provider: 'wecom';
  /** Which transport is bound: the real client, the local Mock, or none. */
  readonly mode: WecomTransportMode;
  /** Whether the environment asked for WeCom to be enabled. */
  readonly enableRequested: boolean;
  /** Whether a complete, usable credential set was found. */
  readonly credentialsPresent: boolean;
  /**
   * Which set the deployment authenticates with.
   *
   * `console` is the set an operator typed and stored, `environment` the one the
   * deployment's own configuration carries, and `none` a Mock boot, which
   * authenticates with nothing. Reported so an operator told a field is missing
   * knows which of the two places to go and fill in — the difference between
   * opening the form and editing a file on the server.
   */
  readonly credentialSource: WecomCredentialOrigin | 'none';
  /**
   * Whether this build claims the whole message loop operates end to end.
   *
   * Only a Mock boot claims it, because the Mock's loop closes in-process. A
   * configured real transport reports `false`: its callback and send paths are
   * wired, but nothing here proves the loop against a live deployment.
   */
  readonly operational: boolean;
  /**
   * Whether the real transport has proven it reaches WeCom. Only a successful
   * token fetch sets it; a Mock boot and a configuration-only real boot keep it
   * `false`.
   */
  readonly realTransportConnected: boolean;
  /**
   * Why the last real connection attempt failed, or `null`.
   *
   * Null while connected, while nothing has been attempted yet, and on a Mock or
   * disabled channel — where `missingCredentials` names what to fix instead.
   */
  readonly lastConnectionError: WecomConnectionError | null;
  /**
   * Names of the environment variables a real-mode boot is still missing.
   * Variable names only — never a value, a prefix or a length.
   */
  readonly missingCredentials: ReadonlyArray<string>;
  /** One-line, honest description of what is and is not connected. */
  readonly note: string;
};

/** Reason shown while the Mock transport is bound. */
const MOCK_NOTE =
  'Mock WeCom transport: callbacks and deliveries run end to end in this process for ' +
  'verification. No real enterprise WeChat connection exists, no credential is used for ' +
  'network access and no customer is reached.';

/** Reason shown when the real transport is asked for without usable credentials. */
const NOT_CONFIGURED_NOTE =
  'Real WeCom transport requested (WECOM_TRANSPORT=real) but its credentials are incomplete, ' +
  'so the channel is disabled: no callback is verified, nothing is sent and no customer is ' +
  'reached. Fill in every field named in missingCredentials — on the channel page when ' +
  'credentialSource is "console", in the deployment environment when it is "environment".';

/** Reason shown when the real transport is fully configured but unproven. */
const REAL_UNPROVEN_NOTE =
  'Real WeCom customer-service transport configured. No token has been fetched yet, so this ' +
  'build has not proven it can reach enterprise WeChat and does not claim a connection.';

/** Reason shown after a real token fetch succeeded. */
const REAL_CONNECTED_NOTE =
  'Real WeCom customer-service transport configured and connected: a token was fetched from ' +
  'enterprise WeChat with the customer-service credential.';

/** Reason shown after a real token fetch failed. */
const REAL_FAILED_NOTE =
  'Real WeCom customer-service transport configured, but the last token probe did not return a ' +
  'token, so this build does not claim a connection. The platform-authored reason is in ' +
  'lastConnectionError.';

/**
 * What a failed token probe is reported as.
 *
 * One message for both shapes of failure — a refused credential and an
 * unreachable endpoint — because the probe answers one boolean. It names both
 * possibilities rather than guessing, and it is written here rather than taken
 * from the provider: an `errmsg` is unbounded text under a third party's
 * control and every field this message reaches is documented as safe to expose.
 *
 * Exported because the 连接 route writes it into the stored verdict, and a
 * verdict that is later rendered beside a live status must be the same sentence
 * as the one the live status would have produced.
 */
export const WECOM_PROBE_FAILED_MESSAGE =
  'no access token was returned by enterprise WeChat: the customer-service credential was ' +
  'refused or the endpoint could not be reached';

/**
 * What the bound real transport last proved, and why the last attempt failed.
 *
 * Mutable, single-writer, process-wide. Never exported directly: callers read it
 * through {@link describeWecomTransport} and write it through
 * {@link markWecomConnected}.
 */
const connection: { connected: boolean; lastError: WecomConnectionError | null } = {
  connected: false,
  lastError: null,
};

/**
 * Record what a real token operation proved about the connection.
 *
 * A success clears the recorded failure: the platform must not keep showing an
 * operator an error that the very next attempt disproved.
 *
 * @param connected - `true` only after WeCom answered with a token.
 * @param at - When the attempt was observed; defaults to now.
 */
export function markWecomConnected(
  connected: boolean,
  at: string = new Date().toISOString(),
): void {
  connection.connected = connected;
  connection.lastError = connected
    ? null
    : { code: 'wecom_probe_failed', message: WECOM_PROBE_FAILED_MESSAGE, at };
}

/** Reset the recorded connection state, used by tests and by a mock-only boot. */
export function resetWecomConnectionState(): void {
  connection.connected = false;
  connection.lastError = null;
}

/** Whether a non-empty value is present, without revealing it. */
function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Describe the WeCom channel from parsed configuration and a credential reading.
 *
 * The credential half is handed in already resolved — {@link
 * WecomCredentialResolution}, from `@kefu/core`'s single rule — rather than read
 * from the environment here, because since the console can store a set there are
 * two places one can come from and only one of them is configuration. A caller
 * that had to be trusted to merge them would be the third place the rule lives.
 *
 * @param config - Parsed application configuration.
 * @param resolution - Which credential set the deployment authenticates with.
 * @returns The transport status both channel surfaces report.
 */
export function describeWecomTransport(
  config: AppConfig,
  resolution: WecomCredentialResolution,
): WecomTransportStatus {
  const credentials = config.wecom;

  if (credentials.transport === 'mock') {
    const credentialsPresent =
      hasValue(credentials.corpId) &&
      hasValue(credentials.agentId) &&
      hasValue(credentials.secret.unwrap()) &&
      hasValue(credentials.token.unwrap()) &&
      hasValue(credentials.aesKey.unwrap());
    return {
      provider: 'wecom',
      mode: 'mock',
      enableRequested: credentials.enabled,
      credentialsPresent,
      // The Mock authenticates with nothing, whatever a stored set happens to
      // hold: it makes no provider call for one to be used by.
      credentialSource: 'none',
      operational: true,
      realTransportConnected: false,
      // A Mock boot attempted no connection, so it has no connection failure to
      // report — the Mock's own refusal triggers are not connection errors.
      lastConnectionError: null,
      missingCredentials: [],
      note: MOCK_NOTE,
    };
  }

  if (resolution._tag === 'unconfigured') {
    return {
      provider: 'wecom',
      mode: 'disabled',
      enableRequested: credentials.enabled,
      credentialsPresent: false,
      credentialSource: resolution.origin,
      operational: false,
      realTransportConnected: false,
      // Nothing was probed: the boot refused before any network call, so the
      // honest diagnosis is the missing-variable list, not a probe failure.
      lastConnectionError: null,
      missingCredentials: wecomProblemVariables(resolution.problems),
      note: NOT_CONFIGURED_NOTE,
    };
  }

  const connected = connection.connected;
  const lastConnectionError = connected ? null : connection.lastError;
  return {
    provider: 'wecom',
    mode: 'real',
    enableRequested: credentials.enabled,
    credentialsPresent: true,
    credentialSource: resolution.origin,
    // "Operational" means the whole loop is *proven* to work end to end, and a
    // token is not that proof. Callback capability is no longer what is missing:
    // the real transport verifies the callback URL, resolves the callback's
    // account to a tenant, pulls `kf/sync_msg`, sends, uploads media and
    // downloads what a customer sent. What is still unproven is the loop against
    // a live deployment — the registered callback URL, an operator-provisioned
    // binding and a real round trip. So a configured transport stays "not
    // proven" whatever its token probe returned.
    operational: false,
    realTransportConnected: connected,
    lastConnectionError,
    missingCredentials: [],
    note: connected
      ? REAL_CONNECTED_NOTE
      : lastConnectionError === null
        ? REAL_UNPROVEN_NOTE
        : REAL_FAILED_NOTE,
  };
}
