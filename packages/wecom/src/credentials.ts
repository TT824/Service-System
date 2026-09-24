/**
 * The account a transport authenticates with, read where it is used.
 *
 * These five values used to arrive as constructor arguments: a snapshot taken
 * when a process built its transport. That was right while the only place they
 * could come from was the environment, which is read once at boot. It stopped
 * being right the moment the console learned to store them — an operator types
 * five fields, clicks 连接, and expects the *running* process to speak as that
 * company from the next message on, without a restart. A snapshot cannot do
 * that; a thunk can.
 *
 * So no transport here holds a credential any more. They hold a {@link
 * WecomCredentialReader} and ask it at the point of use, once per operation.
 * What the answer *is* — which set wins, and what makes one unusable — is
 * `@kefu/core`'s `resolveWecomCredentials`, in one place for every process.
 * This module is only about what a transport does with the answer.
 *
 * The reader is asynchronous because the honest implementations read a store:
 * both applications resolve it from the database, with the environment as the
 * fallback for a deployment nobody has typed anything into yet.
 */

import {
  wecomProblemVariables,
  type ChannelResult,
  type WecomCredentialResolution,
  type WecomCredentialValues,
} from '@kefu/core';

/**
 * Answer "what are we authenticating with right now".
 *
 * A reader rather than a value, because the answer is allowed to change while a
 * process runs; each transport implementation calls it once per operation, so a
 * credential written from the console is in effect for the next request and not
 * for the next restart.
 */
export type WecomCredentialReader = () => Promise<WecomCredentialResolution>;

/** What one read produced: the values to authenticate with, or the refusal. */
export type WecomCredentialUse =
  | { readonly _tag: 'ready'; readonly values: WecomCredentialValues }
  | { readonly _tag: 'refused'; readonly refusal: ChannelResult<never> };

/**
 * Read the account, or the refusal that stops the operation.
 *
 * The shape every transport entry point starts with, so that "we are not
 * configured" is decided in one place and cannot be one thing on the send path
 * and another on the upload path.
 *
 * @param read - The transport's credential reader.
 * @returns The values to use, or the stable refusal to return instead.
 */
export async function useWecomCredentials(
  read: WecomCredentialReader,
): Promise<WecomCredentialUse> {
  const resolution = await read();
  if (resolution._tag === 'ready') {
    return { _tag: 'ready', values: resolution.values };
  }
  const refusal = wecomConfigurationBlocker(wecomProblemVariables(resolution.problems));
  if (refusal === null) {
    // Unreachable: an unconfigured resolution always names at least one problem,
    // which is what makes falling through to a request impossible.
    throw new Error('an unconfigured credential resolution reported no problem');
  }
  return { _tag: 'refused', refusal };
}

/**
 * Refuse every operation while a real-mode credential is missing.
 *
 * Shared by the send and upload halves so the two cannot disagree about what an
 * unconfigured transport says — or about the fact that it makes no request at
 * all to discover what it already knows.
 *
 * @param missing - Variable names of the fields that are absent or unusable.
 * @returns The stable refusal, or `null` when nothing is missing.
 */
export function wecomConfigurationBlocker(
  missing: ReadonlyArray<string>,
): ChannelResult<never> | null {
  if (missing.length === 0) {
    return null;
  }
  return {
    ok: false,
    code: 'channel_not_configured',
    message: `the WeCom customer-service transport is not configured: ${missing.join(', ')}`,
    retryable: false,
  };
}
