import { LocalOtpProvider, type AppConfig, type OtpProvider } from '@kefu/core';

/**
 * Local-development one-time code reveal.
 *
 * The domain service delivers a code and forgets it; every other surface — the
 * response, the logs, the errors, the database — sees only its hash. That is
 * the right default everywhere, but it makes the sign-in loop impossible to
 * exercise locally, where no SMS or e-mail provider exists to carry the code
 * out of the process.
 *
 * The single exception lives here, at the HTTP boundary, where both the parsed
 * environment and the resolved provider are known together. It is deliberately
 * narrow: revealing is a local decision, the provider must be the deterministic
 * in-process one, and the operator must have opted in explicitly. A production
 * deployment satisfies none of the three, and a provider whose `kind` merely
 * *looks* local is not enough — the class itself must be the local one, so a
 * future adapter cannot inherit the behaviour by name.
 */
export type DevelopmentOtpRevealInput = {
  readonly config: AppConfig;
  /** Provider the composition root actually resolved for this application. */
  readonly provider: OtpProvider;
  /** Challenge the code was just issued for. */
  readonly challengeId: string;
};

/**
 * The plaintext code to echo back to the caller, when that is permitted.
 *
 * @param input - Parsed configuration, resolved provider and challenge id.
 * @returns The code in local development with the opt-in flag set, otherwise
 * `undefined`. Never throws: a code that cannot be revealed is simply absent.
 */
export function resolveDevelopmentOtpCode(input: DevelopmentOtpRevealInput): string | undefined {
  if (input.config.appEnv !== 'local') {
    return undefined;
  }
  if (!input.config.auth.developmentOtpVisible) {
    return undefined;
  }
  if (!(input.provider instanceof LocalOtpProvider)) {
    return undefined;
  }
  return input.provider.codeForChallenge(input.challengeId);
}
