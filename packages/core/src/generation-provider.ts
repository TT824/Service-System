/**
 * The generation provider boundary: a question and the knowledge that may answer
 * it in, anchored drafts out.
 *
 * This is the second thing in this repository that is not ours — the embedding
 * service is the first — and it sits on the same kind of seam for the same
 * reason: everything that can be decided without a socket (what a draft is, what
 * makes one usable, what an unusable answer means) is decided here and in the
 * implementation beside it, so a unit test with a fake HTTP client proves the
 * whole thing.
 *
 * **A draft is anchored, and the anchor is not the model's to choose.** A
 * candidate is a reply *and* the entry it was written from, and the entry has to
 * be one this request supplied. The model is asked for an id and answers with
 * one, but a model is free to invent an id, to answer with a title instead, or
 * to answer with the ids of a different tenant's catalogue if the prompt ever
 * leaked one — so an answer that names an id nobody sent is **dropped**, not
 * repaired and not guessed at. The consequence is deliberate: a set's candidates
 * always point at knowledge the caller can re-read in its own scope, which is
 * what makes "select and send" able to cite something real.
 *
 * **Failure is a value, and an empty draft is a failure.** `{ ok: false, code,
 * reason }` is the shape for every way this can go wrong, because that report is
 * what becomes a fallback reason on a persisted set. Two of the branches are
 * worth naming here because they are not obvious:
 *
 *   * **A 200 with an empty `content` is not "the model had nothing to say".**
 *     The configured model is a reasoning model: it spends tokens on a private
 *     `reasoning_content` channel before it writes anything, and when the token
 *     budget runs out mid-thought the answer is `content: ""` with
 *     `finish_reason: "length"`. Measured against the live endpoint on
 *     2026-09-18: a 30-token budget produced exactly that. Reading it as "no
 *     candidates" would have made a too-small budget look like a quiet model.
 *   * **The reported model is not checked against the requested one.** The
 *     embedding provider refuses an answer whose echoed model differs from its
 *     own, because that name addresses a vector row. Nothing here is addressed
 *     by a model name — the set records `deepseek`, not a model — and the live
 *     endpoint rewrites the name anyway: `deepseek-chat` comes back as
 *     `deepseek-flash`. Copying that rule would have rejected every answer.
 *
 * **A caller may have no provider.** No API key configured means no drafts are
 * generated, which `AppConfig.generation` states as a supported state rather
 * than as a misconfiguration, and which the caller answers by falling back to
 * the deterministic engine. The absence is `GenerationProvider | undefined`
 * rather than a stub that fails every call, for the same reason the embedding
 * port states it that way: an absent provider is a deployment that chose not to
 * spend on this, and it must not read as an outage.
 */

/** One draft, and the knowledge entry it was written from. */
export type GeneratedCandidate = {
  /** The `id` of an entry this request supplied. Never a model-invented id. */
  readonly sourceId: string;
  /** The reply text, ready to be sent after a human reads it. */
  readonly content: string;
};

/** One knowledge entry, as the model is allowed to see it. */
export type GenerationKnowledgeEntry = {
  readonly id: string;
  readonly title: string;
  readonly content: string;
};

/** What a generation provider is asked for. */
export type GenerationRequest = {
  /** The customer's question, verbatim. */
  readonly query: string;
  /** The recalled entries the drafts may be built from, best first. */
  readonly knowledge: ReadonlyArray<GenerationKnowledgeEntry>;
  /** How many drafts to ask for. */
  readonly limit: number;
};

/** One generation attempt's result, as the provider reports it. */
export type GenerationResult =
  | { readonly ok: true; readonly candidates: ReadonlyArray<GeneratedCandidate> }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * Injection token carrying the bound {@link GenerationProvider}, or `undefined`.
 *
 * Declared here, beside the interface, for the same reason the recall legs
 * declare theirs beside their own: the composition root that binds it and the
 * service that reads it are in different files, and a token kept in the module
 * would make the service import the module that imports the service.
 */
export const GENERATION_PROVIDER = Symbol('GENERATION_PROVIDER');

/** The outbound half of suggestion generation. */
export interface GenerationProvider {
  /**
   * The model this provider asks, for log lines and reason strings.
   *
   * Unlike the embedding provider's `model` this is **not** part of anything's
   * address: `suggestion_sets.provider` records the provider (`deepseek`), not
   * the model, so a wrong name here costs a misleading log line rather than a
   * corrupted row.
   */
  readonly model: string;

  /**
   * Write drafts for one question from the knowledge given.
   *
   * @param request - The question, the entries that may be used, and how many
   *   drafts to ask for.
   * @returns The drafts that named a supplied entry, or a reported failure.
   */
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
