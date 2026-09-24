/**
 * Content safety: what may be sent, and what may be shown to a model.
 *
 * Two independent concerns that share a block because they share a subject —
 * both decide something about text on its way out of the platform:
 *
 * - {@link screenContent} blocks banned phrasing in anything a seat sends and
 *   in anything a model proposes (§4.5, UC-17).
 * - {@link maskPii} redacts personal data from the prompt handed to the
 *   generation provider (§4.5).
 *
 * The rule library is *passed in*, not owned, so a deployment or a test can
 * substitute its own list — see `rules.ts` for why that matters.
 */

export * from './rules';
export * from './screen';
export * from './pii';

/**
 * The injection token for the rule library, mirroring `GENERATION_PROVIDER`.
 *
 * A token rather than a direct import of {@link DEFAULT_CONTENT_SAFETY_RULES}
 * at the call sites, because the tests need to swap in an empty library and
 * watch the interception stop happening. A hardcoded import would make that
 * impossible, and the interception would then be unfalsifiable.
 */
export const CONTENT_SAFETY_RULES = Symbol('CONTENT_SAFETY_RULES');
