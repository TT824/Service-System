/**
 * Platform kernel domain types.
 *
 * These types describe the internal MVP surface: identity, tenants and stores,
 * conversations and messages, knowledge (product/FAQ/shortcut), retrieval and
 * suggestions, review state, approved phrases, audit entries, jobs and
 * retention. They are plain TypeScript types and constants with no runtime
 * dependency, shared by the API services, worker and the web contract.
 */

/** Platform role of a member/account. */
export type PlatformRole = 'platform_admin' | 'merchant_admin' | 'agent';

/** Every role the kernel recognizes. */
export const PLATFORM_ROLES: ReadonlyArray<PlatformRole> = [
  'platform_admin',
  'merchant_admin',
  'agent',
];

/** A member account (identity) that can act inside the platform. */
export type Member = {
  readonly id: string;
  readonly tenantId: string | null;
  readonly storeId: string | null;
  readonly role: PlatformRole;
  readonly username: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly createdAt: string;
};

/** A customer-service tenant that owns all business data. */
export type Tenant = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
};

/** A store owned by exactly one tenant. */
export type Store = {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
};

/** Conversation lifecycle states. */
export type ConversationStatus = 'open' | 'claimed' | 'closed';

/** Direction of a message relative to the platform. */
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Message payload types the MVP understands.
 *
 * `text` and `link` are delivered as themselves. The other three are the ones a
 * channel has to upload before it can send them, because the providers that
 * carry them take a media handle rather than the bytes.
 */
export type MessageType = 'text' | 'image' | 'video' | 'file' | 'link';

/**
 * Allowed values for the outbound message source. Direct and edited candidate
 * sends are eligible for review; the other sources are metrics-only.
 */
export type MessageSource =
  'direct_candidate' | 'edited_send' | 'manual_typed' | 'shortcut' | 'faq_auto' | 'other';

/** Every allowed message source. */
export const MESSAGE_SOURCES: ReadonlyArray<MessageSource> = [
  'direct_candidate',
  'edited_send',
  'manual_typed',
  'shortcut',
  'faq_auto',
  'other',
];

/** Message sources that enter the review flow. */
export const REVIEW_ELIGIBLE_SOURCES: ReadonlyArray<MessageSource> = [
  'direct_candidate',
  'edited_send',
];

/**
 * Check whether a message source is eligible for review.
 *
 * @param source - The outbound message source.
 * @returns `true` when the message should enter the review queue.
 */
export function isReviewEligibleSource(source: MessageSource): boolean {
  return (REVIEW_ELIGIBLE_SOURCES as ReadonlyArray<MessageSource>).includes(source);
}

/**
 * Whether an outbound of this source answers the customer as a human would.
 *
 * The first-reply clock asks "how long did this customer wait for a person",
 * so an automated send must not stop it. Today only the offline auto-reply is
 * automated, and it is recorded as `other`; keeping the predicate here rather
 * than at the two `sendOutbound` call sites is what stops the SQL and in-memory
 * adapters from disagreeing about which sends count.
 *
 * @param source - The outbound message source.
 * @returns `true` when the send should stamp the conversation's first reply.
 */
export function countsAsFirstReply(source: MessageSource): boolean {
  return source !== 'other';
}

/**
 * Media as a caller hands it over, before it becomes {@link MessageMedia}.
 *
 * The name may be absent and the provider's handle may be absent — an outbound
 * picture picked without a file name has neither — and both are normalized to
 * `null` on the way into the row, so no reader has to tell `undefined` from
 * "there is none".
 */
export type MessageMediaInput = {
  readonly key: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly name?: string | null;
  readonly providerMediaId?: string | null;
};

/**
 * The media of an outbound message, refusing the two shapes nothing can read.
 *
 * A media message with no media is a bubble that can never be filled; a text
 * message with media is a picture no transcript would draw. Both are mistakes in
 * a caller rather than states a customer can produce, so they are thrown on
 * rather than stored — which means the rule has to be in one place, and this is
 * it: keeping it here rather than at the two `sendOutbound` call sites is what
 * stops the SQL and in-memory adapters from disagreeing about what a message is.
 *
 * @param input - The message kind and the media the caller supplied.
 * @returns The media to record, or `null` for a message that has none.
 * @throws {Error} When the kind and the media disagree.
 */
export function outboundMessageMedia(input: {
  readonly messageType: MessageType;
  readonly media: MessageMediaInput | null;
}): MessageMedia | null {
  if (input.messageType === 'text' || input.messageType === 'link') {
    if (input.media !== null) {
      throw new Error(`cannot send a ${input.messageType} message with media attached`);
    }
    return null;
  }
  const media = input.media;
  if (media === null) {
    throw new Error(`cannot send a ${input.messageType} message with no media`);
  }
  return {
    key: media.key,
    mimeType: media.mimeType,
    bytes: media.bytes,
    name: media.name ?? null,
    providerMediaId: media.providerMediaId ?? null,
  };
}

/** Review lifecycle of a message. */
export type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';

/** A customer conversation inside one store. */
export type Conversation = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string | null;
  readonly title: string | null;
  readonly status: ConversationStatus;
  readonly version: number;
  readonly assignedMemberId: string | null;
  readonly openedAt: string;
  readonly lastMessageAt: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
  /**
   * When the conversation entered the pool for its *current* round.
   *
   * Re-stamped by every return and reopen, because it answers "how long has
   * this round been waiting", which is what the pool view shows. Compare with
   * {@link Conversation.firstResponseStartedAt}, which is stamped once.
   */
  readonly pendingSince: string | null;
  /**
   * The instant the first-response clock started, stamped when the
   * conversation first entered the pool and never cleared.
   *
   * Deliberately not re-stamped by a return or a transfer: the metric is "how
   * long did this customer wait for their first human reply", and that wait
   * began once. See {@link firstResponseDurationMs} for the read.
   */
  readonly firstResponseStartedAt: string | null;
  /**
   * When the conversation is due for automatic assignment.
   *
   * Set to the pool-entry instant, so a pooled conversation is due immediately.
   * `null` means "not in the pool" — assigned, or closed. A conversation whose
   * assignment found nobody stays due rather than clearing this, which is what
   * lets the next sweep retry it.
   */
  readonly nextAssignmentAt: string | null;
  /**
   * How many parkings this pool round has recorded. Observability only; nothing
   * branches on it.
   *
   * A hand-off resets it, because the round is over: a conversation an agent is
   * holding is not mid-dispatch, and if it comes back to the pool the count
   * starts again. A sweep that parks the conversation sets it to `1`; one that
   * finds it already parked changes nothing, because waiting is not an attempt
   * and a `wait` writes no row at all. So a conversation nobody can take reads
   * `1` — "we looked and parked it" — rather than climbing once per sweep.
   */
  readonly dispatchAttempts: number;
  /** When the current assignee took the conversation. */
  readonly assignedAt: string | null;
  /**
   * When the offline auto-reply was sent.
   *
   * Set inside the transaction that decides the entry has nobody to take it,
   * which is what makes it a "exactly one sweeper sends this" guard rather than
   * a best-effort flag, and what {@link isOfflineFallback} reads.
   */
  readonly offlineReplyAt: string | null;
  /** First valid outbound of the round; reset to `null` by a reopen. */
  readonly firstReplyAt: string | null;
};

/**
 * Stored media of a message, as the platform recorded it.
 *
 * A reference rather than the bytes: the picture itself lives in object storage
 * under {@link MessageMedia.key}, and every reader that needs it goes through
 * the media route. `mimeType` and `bytes` are carried alongside so a reader can
 * decide how to present the message — and how much room to give it — without
 * fetching the object first.
 */
export type MessageMedia = {
  /** Object-store key the bytes were written under. */
  readonly key: string;
  /** Content type the bytes were stored with, as the provider reported it. */
  readonly mimeType: string;
  /** Size in bytes. */
  readonly bytes: number;
  /**
   * What the file is called, or `null` when nothing named it.
   *
   * Only an outbound document or clip has one: the seat picked a file with a
   * name, and for those two kinds the name is most of what the bubble says.
   * An inbound picture arrives without one — the provider hands us bytes and a
   * content type and no file name of its own — and a customer's screenshot has
   * never had a name worth showing.
   */
  readonly name: string | null;
  /**
   * The provider's handle for these bytes, or `null` when there is none.
   *
   * Written outbound and only outbound: the channel will not accept a message
   * naming a `media_id` it has not been given, so the upload happens before the
   * row is written and the handle is recorded with it. Inbound media has no
   * handle worth keeping — the bytes were downloaded from the provider's
   * temporary copy, and that copy expires in days.
   */
  readonly providerMediaId: string | null;
};

/** A persisted conversation message. */
export type Message = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly channel: string;
  readonly direction: MessageDirection;
  readonly source: MessageSource | null;
  readonly messageType: MessageType;
  readonly content: string;
  readonly dedupKey: string | null;
  readonly reviewEligible: boolean;
  readonly reviewState: ReviewState;
  readonly candidateId: string | null;
  /**
   * The message's stored media, or `null` when it has none.
   *
   * `null` is the whole answer to "is there a picture behind this message": an
   * image the platform failed to fetch, an image too large to keep, a voice
   * note and every text message all have no stored media, and the transcript
   * shows the placeholder it would have shown before the pipeline existed.
   */
  readonly media: MessageMedia | null;
  readonly createdAt: string;
};

/** Knowledge kinds managed by the platform. */
export type KnowledgeKind = 'product' | 'faq' | 'shortcut';

/** A product sold through a store (knowledge source). */
export type Product = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/**
 * The mutable fields of a product.
 *
 * A field left out means "keep the current value": a patch states what changes,
 * and an omitted field is not a request to clear one. `enabled` is the 停用 /
 * 恢复 switch — a disabled product keeps its row, its id and its history, it
 * only stops being candidate material.
 */
export type ProductPatch = {
  readonly sku?: string;
  readonly title?: string;
  readonly description?: string;
  readonly enabled?: boolean;
};

/** A FAQ entry usable as a reply source. */
export type FaqItem = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly question: string;
  readonly answer: string;
  readonly tags: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** The mutable fields of a FAQ entry; omitted fields keep their value. */
export type FaqItemPatch = {
  readonly question?: string;
  readonly answer?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly enabled?: boolean;
};

/**
 * Who a shortcut belongs to.
 *
 * `tenant` means every store of the merchant sees it (欢迎语, 售后政策); `store`
 * means one store only (本店发货时效).
 */
export const SHORTCUT_SCOPE_TYPES = ['tenant', 'store'] as const;
/** One shortcut scope. */
export type ShortcutScopeType = (typeof SHORTCUT_SCOPE_TYPES)[number];

/**
 * A canned shortcut usable as a reply source.
 *
 * `storeId` is `null` exactly when `scopeType` is `tenant`; the two fields are
 * one fact and the database holds them to it with a CHECK constraint.
 */
export type Shortcut = {
  readonly id: string;
  readonly tenantId: string;
  readonly scopeType: ShortcutScopeType;
  readonly storeId: string | null;
  readonly code: string;
  readonly title: string;
  readonly content: string;
  readonly intentCode: string | null;
  readonly sortOrder: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/**
 * The mutable fields of a shortcut; omitted fields keep their value.
 *
 * The scope is deliberately not patchable: moving a phrase between a store and
 * the whole merchant changes who can see it, which is a different operation from
 * editing what it says.
 */
export type ShortcutPatch = {
  readonly code?: string;
  readonly title?: string;
  readonly content?: string;
  readonly intentCode?: string | null;
  readonly sortOrder?: number;
  readonly enabled?: boolean;
};

/**
 * A personal quick phrase: the canned replies one agent keeps for themselves.
 *
 * Not knowledge the tenant owns, and not a shortcut with a different owner. A
 * shortcut is a fact about the merchant — 本店发货时效 is the same answer whoever
 * gives it — while a personal phrase is a working note: 欢迎语 in one's own words,
 * a follow-up sentence one has settled on. Nothing about it is shared, so
 * `memberId` is a column of the row and never a filter the caller supplies; the
 * server takes the owner from the authenticated session and the client can
 * neither read nor name anybody else's.
 *
 * There is deliberately no `code` and no `storeId`: personal phrases are not
 * addressed by anything and are not per-store.
 */
export type PersonalPhrase = {
  readonly id: string;
  readonly tenantId: string;
  readonly memberId: string;
  /** Display grouping the UI offers as a filter; `''` when the agent left it out. */
  readonly category: string;
  readonly title: string;
  /** Words that should make the phrase surface while the agent types. */
  readonly keywords: ReadonlyArray<string>;
  /** The reply text inserted into the composer. */
  readonly text: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/**
 * The mutable fields of a personal phrase; omitted fields keep their value.
 *
 * The owner is deliberately not patchable, for the same reason a shortcut's
 * scope is not: a phrase that changed hands is not the same phrase, and the
 * recipient never agreed to own it. An empty `keywords` array is a real value
 * (clear the words), which is why the patch distinguishes absent from empty
 * rather than treating both as "keep".
 */
export type PersonalPhrasePatch = {
  readonly category?: string;
  readonly title?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly text?: string;
  readonly enabled?: boolean;
};

/**
 * How the assist panel treats one customer message.
 *
 * `question` is retrieved for; `chitchat` is not. The rule that decides between
 * them is `platform/intent.ts` — this is only the shape, kept here so a
 * persisted suggestion set can carry it without the kernel's types importing a
 * classifier.
 */
export type ConversationIntent = 'chitchat' | 'question';

/**
 * Where a set's candidates came from, as one fact the console can render.
 *
 * `script` — the store's own 话术库 (a shortcut or a FAQ) answered, and no model
 * was asked: the retrieval-first rule. `catalogue` — the 商品库 answered and no
 * model wrote anything, because none is configured or none delivered. `generated`
 * — a configured provider wrote the text, anchored to knowledge it was given.
 * `none` — there are no candidates: a chitchat message, an empty question, or a
 * question nothing matched.
 *
 * Kept separate from {@link SuggestionSet.provider} on purpose. `provider` says
 * *who was capable of writing* the text; this says *what the panel is actually
 * showing* — and the two differ exactly in the case the retrieval-first rule
 * creates, where a provider is configured and was deliberately not called.
 */
export type SuggestionOrigin = 'script' | 'catalogue' | 'generated' | 'none';

/**
 * Where the retrieval layer placed one entry, for a candidate that carries it.
 *
 * `modes` is leg names rather than the retrieval layer's own enum so this file
 * stays free of that dependency; the engine's richer alias lives in
 * `platform/suggestion.ts`, and it is assignable to this one.
 */
export type SuggestionRecallEvidence = {
  readonly rank: number;
  readonly modes: ReadonlyArray<string>;
};

/** Knowledge source kinds a suggestion candidate can reference. */
export type SuggestionSourceKind = KnowledgeKind;

/** A single source-aware reply candidate. */
export type SuggestionCandidate = {
  readonly rank: number;
  readonly kind: SuggestionSourceKind;
  readonly sourceId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly title: string;
  readonly content: string;
  readonly score: number;
  /**
   * The fusion rank and legs that recalled this entry, or absent for one the
   * recall never saw — the legacy products read, which bypasses the index. The
   * console shows it as 检索依据; a candidate without it was matched by the
   * engine's own lexical count and by nothing else.
   */
  readonly recall?: SuggestionRecallEvidence;
};

/**
 * Which generator wrote a set's candidates.
 *
 * `none` is the deterministic engine — the tenant's own knowledge scored
 * lexically, no external model called — and it is what a deployment with no
 * generation key records. `deepseek` means every candidate in the set came back
 * from a configured provider and was anchored to an entry that provider was
 * given (see the generation port). A set is one or the other: a provider that
 * failed produces `none` **and** a fallback reason, never a mixture, so "were
 * these written by a model" stays a question with one answer.
 */
export type SuggestionProvider = 'none' | 'deepseek';

/** A generated suggestion set bound to a conversation. */
export type SuggestionSet = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly provider: SuggestionProvider;
  /**
   * What the message was read as. Persisted rather than recomputed because it
   * explains the empty set: a `chitchat` set has no candidates *by design*, and
   * without this field that is indistinguishable from a search that failed.
   */
  readonly intent: ConversationIntent;
  /** Why this set holds what it holds; see {@link SuggestionOrigin}. */
  readonly origin: SuggestionOrigin;
  readonly candidates: ReadonlyArray<SuggestionCandidate>;
  readonly fallbackReasons: ReadonlyArray<string>;
  readonly createdAt: string;
};

/** Stable fallback reasons recorded when a suggestion is not fully generated. */
export const SUGGESTION_FALLBACK_REASONS = {
  noProvider: 'no_generation_provider',
  noKnowledgeMatch: 'no_knowledge_match',
  emptyQuery: 'empty_query',
  /**
   * The semantic recall leg could not answer, so the answer was built from the
   * keyword leg alone. A stable code rather than the leg's own reason: this
   * value travels out on a persisted suggestion set, and the leg's vocabulary
   * (`no_embedding_provider`, and whatever a second provider adds) is the
   * retrieval layer's to change — the operator reads it there, in the recall
   * log line, where it is not a contract.
   */
  semanticRecallUnavailable: 'semantic_recall_unavailable',
  /**
   * A generation provider was configured and did not produce usable candidates,
   * so the set fell back to the deterministic engine.
   *
   * Distinct from {@link SUGGESTION_FALLBACK_REASONS.noProvider} on purpose: "we
   * did not buy generation" and "generation is configured and just failed" are
   * different facts, and only the second one means somebody should look. The
   * provider's own code (a rejected key, a rate limit, a model that named ids
   * nobody sent) stays in the log line, where it is not a contract with a
   * client — the same split the semantic recall leg's reason makes.
   */
  generationUnavailable: 'generation_unavailable',
  /**
   * One or more candidates matched a banned-phrase rule and were removed before
   * the set was written, so the set holds fewer than were proposed (§4.5,
   * UC-17). The code is shared with the send-time gate rather than spelled out
   * here twice: a seat reads this reason on a set and gets the same string back
   * from a refused send, and two literals would eventually stop agreeing.
   */
  contentBlocked: 'content_blocked',
  /**
   * The message was classified `chitchat`, so nothing was retrieved and nothing
   * was generated — see {@link ConversationIntent}.
   *
   * The one code in this list that is an outcome rather than a shortfall: no
   * search failed, no provider was missing, and the panel is not starving for
   * material. It is recorded because an empty candidate list still has to
   * explain itself, and "闲聊，无需检索" is that explanation.
   */
  chitchatNoRetrieval: 'chitchat_no_retrieval',
} as const;

/** Platform-wide review policy. Only a platform super administrator may edit it. */
export type ReviewPolicy = {
  readonly id: string;
  readonly scope: 'platform';
  readonly requireReview: boolean;
  readonly requireReviewForSources: ReadonlyArray<MessageSource>;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
};

/** A tenant-scoped approved phrase created by a review approval. */
export type ApprovedPhrase = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly phrase: string;
  readonly sourceMessageId: string;
  readonly approvedBy: string;
  readonly createdAt: string;
};

/** Stable audit action identifiers. */
export const AUDIT_ACTIONS = {
  policyUpdated: 'review.policy_updated',
  messageApproved: 'review.message_approved',
  messageRejected: 'review.message_rejected',
  conversationClaimed: 'conversation.claimed',
  conversationReturned: 'conversation.returned',
  conversationTransferred: 'conversation.transferred',
  conversationClosed: 'conversation.closed',
  conversationReopened: 'conversation.reopened',
  /** The dispatcher handed a pooled conversation to a seat. */
  conversationAssigned: 'conversation.assigned',
  /** Nobody was available, so the customer received the offline reply. */
  conversationOfflineReplied: 'conversation.offline_replied',
  outboundMessageSent: 'message.sent',
  inboundMessageIngested: 'message.ingested',
  suggestionGenerated: 'suggestion.generated',
  knowledgeCreated: 'knowledge.created',
  retentionSummary: 'retention.summary',
} as const;

/** A single immutable audit entry. */
export type AuditEntry = {
  readonly id: string;
  readonly tenantId: string | null;
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

/** Entities that a tenant retention policy can apply to. */
export type RetentionEntity = 'message' | 'conversation' | 'audit_log' | 'approved_phrase';

/** Tenant-level retention configuration used by the retention summary. */
export type TenantRetentionPolicy = {
  readonly tenantId: string | null;
  readonly entity: RetentionEntity;
  readonly retentionDays: number;
};

/** Deterministic default retention window per entity (days). */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<RetentionEntity, number>> = Object.freeze({
  message: 180,
  conversation: 365,
  audit_log: 90,
  approved_phrase: 730,
});
