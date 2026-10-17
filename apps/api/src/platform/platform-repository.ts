/**
 * The API-owned platform business repository port.
 *
 * The platform feature surfaces (identity/directory, knowledge, conversations,
 * retrieval/suggestions, review, reports and channels) never touch a storage
 * adapter directly: they depend on this port. Two adapters implement it and the
 * environment boundary picks one, exactly like the authentication port does:
 *
 * - `memory` for `APP_ENV=test`, backed by the deterministic in-process
 *   `KefuStore` so the whole platform workflow stays exercisable with no
 *   database and the core/domain unit tests keep their store.
 * - `postgres` for `APP_ENV=local` and `APP_ENV=production`, backed by the
 *   tables migrations `0002`-`0005` declare.
 *
 * Every method is asynchronous because the durable adapter is, and every
 * method takes the caller's verified tenant context as its first argument:
 * the adapter scopes each statement by `tenant_id`, so a caller cannot read or
 * write outside the tenant the request was authorized for. The *authorization*
 * rules (which tenant, which store, which role) stay in the services and in
 * {@link AccessService}; the repository only enforces the tenant boundary the
 * service resolved.
 *
 * Records are immutable values, matching the domain types in `@kefu/core`, so
 * an adapter can never share mutable state with a caller.
 */

import type {
  AgentAvailabilityStatus,
  AgentPresence,
  ApplyProductImportBatchInput,
  ApprovedPhrase,
  AttachMessageMediaInput,
  ApprovalResult,
  AssignmentCandidate,
  AuditEntry,
  CategoryAttribute,
  Conversation,
  ConversationAssignment,
  ConversationIntent,
  ConversationRoutingWeight,
  DispatchOutcome,
  FaqItem,
  FaqItemPatch,
  FaqQuestionVariant,
  FaqQuestionVariantPatch,
  ImportBatchWithErrors,
  IngestResult,
  InboundMessageInput,
  InternalAttachmentRecord,
  InternalMessage,
  InternalThread,
  KnowledgeIndexStatusFilter,
  KnowledgeIndexStatusSummary,
  Member,
  Message,
  NewCategoryAttribute,
  NewFaqQuestionVariant,
  NewProductCategory,
  NewProductImportBatch,
  NewProductImportError,
  NewProductSku,
  NewProductSpu,
  OutboundMessageInput,
  PersonalPhrase,
  PersonalPhrasePatch,
  Product,
  ProductCategory,
  ProductImportBatch,
  ProductImportBatchPatch,
  ProductImportError,
  ProductPatch,
  ProductSku,
  ProductSkuPatch,
  ProductSpu,
  ProductSpuPatch,
  RetentionSummary,
  ReviewPolicy,
  Shortcut,
  ShortcutPatch,
  Store,
  StoreConversationResult,
  SuggestionCandidate,
  SuggestionOrigin,
  SuggestionProvider,
  SuggestionSet,
  TakeoverAuthority,
  Tenant,
} from '@kefu/core';
import type { AppEnvironment } from '@kefu/core';

/** Injection token carrying the environment-selected platform repository. */
export const PLATFORM_REPOSITORY = Symbol('PLATFORM_REPOSITORY');

/** Stable refusal codes a durable adapter can raise from a write. */
export type PlatformWriteErrorCode = 'not_found' | 'invalid_state';

/**
 * Raised when a durable write is refused by the state it finds.
 *
 * A service re-validates state before it calls the repository, but a durable
 * adapter has to validate again inside its own transaction: the row can change
 * between the caller's read and the write. Reporting that through a plain
 * `Error` would turn a legitimate race into a 500, so the adapter raises this
 * instead and the service maps it to the same stable HTTP answer it would have
 * produced from its own check.
 */
export class PlatformWriteError extends Error {
  /**
   * @param code - Stable refusal code.
   * @param message - Human-readable reason, safe to expose.
   */
  constructor(
    readonly code: PlatformWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformWriteError';
  }
}

/** Data used to create a knowledge product. */
export type CreateProductRecord = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly now?: string;
};

/** Data used to create a knowledge FAQ entry. */
export type CreateFaqRecord = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly question: string;
  readonly answer: string;
  readonly tags: ReadonlyArray<string>;
  readonly now?: string;
};

/**
 * Data used to create a knowledge shortcut.
 *
 * `storeId` is `string | null` rather than optional: the caller has decided
 * whether the phrase belongs to one store or to the whole merchant, and passing
 * `null` is how it says "the whole merchant". A missing field would leave the
 * adapter guessing, and the two adapters would guess differently.
 */
export type CreateShortcutRecord = {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly code: string;
  readonly title: string;
  readonly content: string;
  readonly intentCode?: string | null;
  readonly sortOrder?: number;
  readonly now?: string;
};

/**
 * Data used to create a personal quick phrase.
 *
 * `memberId` is required and is never taken from a request body: it is the id of
 * the member the session proved, passed down from the controller. An adapter
 * accepting an owner the caller chose would be the whole isolation hole.
 */
export type CreatePersonalPhraseRecord = {
  readonly tenantId: string;
  readonly memberId: string;
  readonly category: string;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly text: string;
  readonly now?: string;
};

/** Data used to persist a generated suggestion set. */
export type CreateSuggestionSetRecord = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  /**
   * Which generator wrote {@link CreateSuggestionSetRecord.candidates}.
   *
   * Required rather than defaulted, so the writer has to know: a service that
   * quietly omitted it would store a model's drafts under a column that says
   * the tenant's own knowledge produced them, and nothing downstream could
   * tell. `'none'` is a caller's explicit claim, not a fallback.
   */
  readonly provider: SuggestionProvider;
  /**
   * What the message was read as — see {@link ConversationIntent}.
   *
   * Required for the same reason `provider` is: a writer that omitted it would
   * store a chitchat set as if it had been searched for, and the empty
   * `candidates` would then read as a failure instead of the decision it was.
   */
  readonly intent: ConversationIntent;
  /**
   * What the candidates are — see {@link SuggestionOrigin}.
   *
   * Required and not derived from `provider`: a 话术库 hit is stored with
   * `provider: 'none'` on purpose, and only this field says the set was
   * deliberate rather than merely ungenerated.
   */
  readonly origin: SuggestionOrigin;
  readonly candidates: ReadonlyArray<SuggestionCandidate>;
  readonly fallbackReasons: ReadonlyArray<string>;
  readonly now?: string;
};

/** Data used to append an immutable audit entry. */
export type AppendAuditRecord = {
  readonly tenantId: string | null;
  readonly actorMemberId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
};

/** One seat's 分流权重, as an administrator submitted it. */
export type RoutingWeightEntry = {
  readonly memberId: string;
  readonly weight: number;
};

/** Data used to store 分流权重 for the seats a save names. */
export type SaveRoutingWeightsRecord = {
  readonly tenantId: string;
  /**
   * The seats this save speaks for. Seats left out keep the weight they had —
   * the write is an upsert, never a replace (see {@link PlatformRepository.saveRoutingWeights}).
   */
  readonly weights: ReadonlyArray<RoutingWeightEntry>;
  /** The administrator who made the choice; stored on every row it touches. */
  readonly updatedBy: string;
  readonly now: string;
};

/** Data used to record an agent seat's availability. */
export type SetAgentPresenceRecord = {
  readonly tenantId: string;
  readonly memberId: string;
  /** The member's store, which the caller resolves; the adapter does not guess it. */
  readonly storeId: string;
  readonly status: AgentAvailabilityStatus;
  readonly now: string;
};

/** Data used to run one dispatch sweep. */
export type DispatchDueInput = {
  /** Instant the sweep judges presence and stamps writes at (ISO). */
  readonly now: string;
  /** Most conversations to consider in this sweep. */
  readonly limit: number;
};

/**
 * What one dispatch sweep did to one conversation.
 *
 * Declared in `@kefu/core` beside {@link AutoAssignPlan}, because the in-memory
 * store produces it too and core cannot depend on this package.
 */
export type { DispatchOutcome } from '@kefu/core';

/**
 * Re-exported so the repository implementations can name the shape of a media
 * write without importing `@kefu/core` themselves.
 */
export type { AttachMessageMediaInput } from '@kefu/core';

/**
 * Platform business fact source.
 *
 * The directory section answers identity/scope questions, the knowledge,
 * conversation, review and suggestion sections are the tenant business data,
 * and the audit/retention section feeds the report views.
 */
export interface PlatformRepository {
  // --------------------------------------------------------------------------
  // Directory (tenants, stores, members)
  // --------------------------------------------------------------------------

  /** Every tenant, ordered by id. */
  listTenants(): Promise<ReadonlyArray<Tenant>>;
  /** One tenant by id. */
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  /** Stores of one tenant, ordered by id. */
  listStores(tenantId: string): Promise<ReadonlyArray<Store>>;
  /** One store inside a tenant. */
  getStore(tenantId: string, storeId: string): Promise<Store | undefined>;
  /** One member by id, enabled or not. */
  getMember(memberId: string): Promise<Member | undefined>;
  /** Enabled members of one tenant, ordered by id. */
  listMembers(tenantId: string): Promise<ReadonlyArray<Member>>;
  /**
   * Enabled platform administrators, ordered by id.
   *
   * They carry `tenantId === null`, so no tenant listing contains them; a
   * surface that has to reach the platform side asks for them by name.
   */
  listPlatformAdministrators(): Promise<ReadonlyArray<Member>>;

  // --------------------------------------------------------------------------
  // Knowledge (products, FAQs, shortcuts)
  // --------------------------------------------------------------------------

  /**
   * Products of a tenant, optionally narrowed to one store, enabled or not.
   *
   * The disabled rows are included on purpose: the management surface has to be
   * able to find a 停用 row again to put it back. Deciding which rows may be
   * used as candidate material is the caller's job, through `usableKnowledge`.
   */
  listProducts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Product>>;
  /** One product inside the tenant scope. */
  getProduct(tenantId: string, productId: string): Promise<Product | undefined>;
  /** Create a product; the adapter assigns the id. */
  createProduct(input: CreateProductRecord): Promise<Product>;
  /** Apply a patch to one product, or answer `undefined` when the tenant has no such id. */
  updateProduct(
    tenantId: string,
    productId: string,
    patch: ProductPatch,
    now?: string,
  ): Promise<Product | undefined>;

  /** FAQs of a tenant, optionally narrowed to one store, enabled or not. */
  listFaqs(tenantId: string, storeId?: string): Promise<ReadonlyArray<FaqItem>>;
  /** One FAQ inside the tenant scope. */
  getFaq(tenantId: string, faqId: string): Promise<FaqItem | undefined>;
  /** Create an FAQ entry; the adapter assigns the id. */
  createFaq(input: CreateFaqRecord): Promise<FaqItem>;
  /** Apply a patch to one FAQ entry, or answer `undefined` when the tenant has no such id. */
  updateFaq(
    tenantId: string,
    faqId: string,
    patch: FaqItemPatch,
    now?: string,
  ): Promise<FaqItem | undefined>;

  /** Shortcuts of a tenant, optionally narrowed to one store, enabled or not. */
  listShortcuts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Shortcut>>;
  /** One shortcut inside the tenant scope. */
  getShortcut(tenantId: string, shortcutId: string): Promise<Shortcut | undefined>;
  /** Create a shortcut; the adapter assigns the id. */
  createShortcut(input: CreateShortcutRecord): Promise<Shortcut>;
  /** Apply a patch to one shortcut, or answer `undefined` when the tenant has no such id. */
  updateShortcut(
    tenantId: string,
    shortcutId: string,
    patch: ShortcutPatch,
    now?: string,
  ): Promise<Shortcut | undefined>;

  /**
   * Personal quick phrases belonging to one member, newest first.
   *
   * Both ids are required. A personal phrase is private to its owner, so there
   * is no tenant-wide read of them, and the store-scoped reads a shortcut has do
   * not exist here at all.
   */
  listPersonalPhrases(tenantId: string, memberId: string): Promise<ReadonlyArray<PersonalPhrase>>;
  /** One personal phrase, only when it belongs to the asking member. */
  getPersonalPhrase(
    tenantId: string,
    memberId: string,
    phraseId: string,
  ): Promise<PersonalPhrase | undefined>;
  /** Create a personal phrase for one member; the adapter assigns the id. */
  createPersonalPhrase(input: CreatePersonalPhraseRecord): Promise<PersonalPhrase>;
  /**
   * Patch one of a member's own phrases.
   *
   * Answers `undefined` both when the id is unknown and when it belongs to
   * somebody else: the caller turns either into the same `not_found`, so the
   * response cannot be used to test whether another agent's phrase exists.
   */
  updatePersonalPhrase(
    tenantId: string,
    memberId: string,
    phraseId: string,
    patch: PersonalPhrasePatch,
    now?: string,
  ): Promise<PersonalPhrase | undefined>;

  // --------------------------------------------------------------------------
  // Index status
  //
  // `knowledge_chunks` and `knowledge_chunk_embeddings` (`0011`) are written by
  // the Worker's index sweep and never by this repository: the API reads them,
  // and only through the read model below. The two adapters answer it
  // differently and both answers are true — `MemoryPlatformRepository` states why
  // the in-process store reports zeros rather than a sample of slices.
  // --------------------------------------------------------------------------

  /**
   * What the tenant's slices are doing: per-state counts, and the latest
   * failures with the reason each one recorded.
   *
   * `filter` narrows the slice set and then every number describes that set —
   * including `total` and `embeddings`, so the answer never mixes a filtered
   * count with an unfiltered one.
   */
  knowledgeIndexStatus(
    tenantId: string,
    filter: KnowledgeIndexStatusFilter,
  ): Promise<KnowledgeIndexStatusSummary>;

  // --------------------------------------------------------------------------
  // Catalogue
  //
  // Separate from the `products` rows above: those are the flat knowledge model
  // the reply pipeline reads, these are the category / attribute / SPU / SKU
  // structure SDD-012 imports into and SDD-014 indexes. A create whose parent
  // (category, or product for a variant) is not in the caller's tenant answers
  // `undefined` rather than writing a row across a tenant boundary.
  // --------------------------------------------------------------------------

  /** Categories of a tenant, optionally one store. */
  listCategories(tenantId: string, storeId?: string): Promise<ReadonlyArray<ProductCategory>>;
  /** One category inside the tenant scope. */
  getCategory(tenantId: string, categoryId: string): Promise<ProductCategory | undefined>;
  /** Create a category, or answer `undefined` when the named parent is out of scope. */
  createCategory(input: NewProductCategory): Promise<ProductCategory | undefined>;
  /** Attribute declarations of one category. */
  listCategoryAttributes(
    tenantId: string,
    categoryId: string,
  ): Promise<ReadonlyArray<CategoryAttribute>>;
  /** Declare one attribute, or answer `undefined` when the category is out of scope. */
  createCategoryAttribute(input: NewCategoryAttribute): Promise<CategoryAttribute | undefined>;

  /** Products of a tenant, optionally filtered by store and category. */
  listSpus(
    tenantId: string,
    filter?: { readonly storeId?: string | undefined; readonly categoryId?: string | undefined },
  ): Promise<ReadonlyArray<ProductSpu>>;
  /** One product inside the tenant scope. */
  getSpu(tenantId: string, spuId: string): Promise<ProductSpu | undefined>;
  /** Create a product, or answer `undefined` when the named category is out of scope. */
  createSpu(input: NewProductSpu): Promise<ProductSpu | undefined>;
  /** Apply a patch to one product, or answer `undefined` when the tenant has no such id. */
  updateSpu(
    tenantId: string,
    spuId: string,
    patch: ProductSpuPatch,
    now?: string,
  ): Promise<ProductSpu | undefined>;

  /** Variants of one product. */
  listSkus(tenantId: string, spuId: string): Promise<ReadonlyArray<ProductSku>>;
  /**
   * Variants of one store, across every product in it.
   *
   * A product import plans against the whole store rather than one product: the
   * file says which variants exist, and whether each is new depends on every SKU
   * code the store already has. Reading them one product at a time would make
   * that a query per product in the catalogue.
   */
  listSkusByStore(tenantId: string, storeId: string): Promise<ReadonlyArray<ProductSku>>;
  /** One variant inside the tenant scope. */
  getSku(tenantId: string, skuId: string): Promise<ProductSku | undefined>;
  /** Create a variant, or answer `undefined` when the product is out of scope. */
  createSku(input: NewProductSku): Promise<ProductSku | undefined>;
  /** Apply a patch to one variant, or answer `undefined` when the tenant has no such id. */
  updateSku(
    tenantId: string,
    skuId: string,
    patch: ProductSkuPatch,
    now?: string,
  ): Promise<ProductSku | undefined>;

  // --------------------------------------------------------------------------
  // FAQ near-questions
  // --------------------------------------------------------------------------

  /** Near-questions of one FAQ, in creation order. */
  listFaqVariants(tenantId: string, faqId: string): Promise<ReadonlyArray<FaqQuestionVariant>>;
  /** One near-question inside the tenant scope. */
  getFaqVariant(tenantId: string, variantId: string): Promise<FaqQuestionVariant | undefined>;
  /** Add a near-question, or answer `undefined` when the FAQ is out of scope. */
  createFaqVariant(input: NewFaqQuestionVariant): Promise<FaqQuestionVariant | undefined>;
  /** Apply a patch to one near-question, or answer `undefined` when the tenant has no such id. */
  updateFaqVariant(
    tenantId: string,
    variantId: string,
    patch: FaqQuestionVariantPatch,
    now?: string,
  ): Promise<FaqQuestionVariant | undefined>;

  // --------------------------------------------------------------------------
  // Product import batches
  // --------------------------------------------------------------------------

  /** Import attempts of a tenant, newest first, optionally one store. */
  listImportBatches(tenantId: string, storeId?: string): Promise<ReadonlyArray<ProductImportBatch>>;
  /** One import attempt inside the tenant scope. */
  getImportBatch(tenantId: string, batchId: string): Promise<ProductImportBatch | undefined>;
  /** Open an import attempt. */
  createImportBatch(input: NewProductImportBatch): Promise<ProductImportBatch>;
  /** Move the progress of one attempt, or answer `undefined` when the tenant has no such id. */
  updateImportBatch(
    tenantId: string,
    batchId: string,
    patch: ProductImportBatchPatch,
    now?: string,
  ): Promise<ProductImportBatch | undefined>;
  /** Record failed lines, or answer `undefined` when the batch is out of scope. */
  appendImportErrors(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId'>>;
    readonly now?: string;
  }): Promise<ReadonlyArray<ProductImportError> | undefined>;
  /** Failed lines of one batch, by row number. */
  listImportErrors(tenantId: string, batchId: string): Promise<ReadonlyArray<ProductImportError>>;
  /**
   * Apply a whole import in one unit of work: the products and variants the plan
   * names, the batch that records the attempt, and the lines it refused.
   *
   * The three are one call because they are one fact. An adapter that landed the
   * products but not the batch would leave a catalogue nobody can account for; a
   * batch without its failed lines would tell an operator that 400 rows arrived
   * when 398 did. The PostgreSQL adapter therefore runs the lot inside a single
   * transaction and rolls back on any failure.
   *
   * A product the plan creates is matched on `(tenant_id, store_id, product_code)`
   * rather than assumed absent, so a row created between planning and writing is
   * overwritten instead of raising a constraint error.
   *
   * @param input - Scope, the plan, the refused lines and the terminal counts.
   * @returns The batch and the failure rows written for it.
   * @throws When the plan names something the adapter cannot write.
   */
  applyProductImportBatch(input: ApplyProductImportBatchInput): Promise<ImportBatchWithErrors>;

  // --------------------------------------------------------------------------
  // Conversations and messages
  // --------------------------------------------------------------------------

  /**
   * Conversations of a tenant, newest activity first, optionally one store.
   *
   * `visibleToMemberId` narrows the list to what one seat may read: the pool it
   * could claim, its own conversations, and the ones it handed over (whose
   * transcripts it keeps up to the hand-over). Administrators pass nothing and
   * see the tenant.
   */
  listConversations(
    tenantId: string,
    storeId?: string,
    visibleToMemberId?: string,
  ): Promise<ReadonlyArray<Conversation>>;
  /** One conversation inside the tenant scope. */
  getConversation(tenantId: string, conversationId: string): Promise<Conversation | undefined>;
  /** Messages of a tenant, oldest first, optionally one conversation. */
  listMessages(tenantId: string, conversationId?: string): Promise<ReadonlyArray<Message>>;
  /** One message inside the tenant scope. */
  getMessage(tenantId: string, messageId: string): Promise<Message | undefined>;

  /** Claim an open conversation with an optimistic version check. */
  claim(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult>;

  /**
   * Return a claimed conversation to the open pool.
   *
   * `authority` says whether the actor may act without being the assignee — the
   * caller resolves it (see `TakeoverAuthority`), the rule itself is core's.
   */
  returnToPool(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult>;

  /**
   * Transfer a claimed conversation to another member.
   *
   * `authority` is the same resolved permission {@link returnToPool} takes.
   */
  transfer(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    toMemberId: string,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult>;

  /** Close an open or claimed conversation. */
  close(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    actorIsAdmin: boolean,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult>;

  /** Send an outbound message, idempotent by `dedupKey`. */
  sendOutbound(input: OutboundMessageInput): Promise<IngestResult>;

  /** Ingest an inbound message; a closed conversation reopens. Idempotent by `dedupKey`. */
  ingestInbound(input: InboundMessageInput): Promise<IngestResult>;

  /**
   * Record the stored media of one message, after the bytes have been written.
   *
   * A separate write from {@link ingestInbound} because it happens later and can
   * fail on its own: the message is the customer's whether or not the platform
   * comes to hold the picture, so the callback must not be able to lose the
   * message by failing to fetch its media.
   *
   * @param input - Tenant, message and the reference to record.
   * @returns `true` when a message was updated, `false` when none matched.
   */
  attachMessageMedia(input: AttachMessageMediaInput): Promise<boolean>;

  // --------------------------------------------------------------------------
  // Assignment (agent seats, dispatch, assignment history)
  // --------------------------------------------------------------------------

  /**
   * Record a seat's availability, creating the row on first use.
   *
   * A seat that has never connected has no row at all, so this is an upsert:
   * the first `accepting` is what puts an agent into the dispatch pool.
   */
  setAgentPresence(input: SetAgentPresenceRecord): Promise<AgentPresence>;

  /** One seat's presence, or `undefined` when it has never connected. */
  getAgentPresence(tenantId: string, memberId: string): Promise<AgentPresence | undefined>;

  /**
   * Every presence row a tenant holds, for a roster's 在线/离线 lamps.
   *
   * The counterpart to {@link getAgentPresence} for a question about somebody
   * else: presence was self-only on the wire, so a console showing every seat's
   * status had no source for it. Unfiltered by role, since `agent_presence` only
   * ever holds seats — and a seat that never reported in is **absent** from the
   * result rather than present as `offline`.
   */
  listTenantAgentPresence(tenantId: string): Promise<ReadonlyArray<AgentPresence>>;

  /**
   * Refresh a seat's liveness without changing its status.
   *
   * Returns `undefined` when the seat has no row: a heartbeat is not a way to
   * come online, so it must not invent a status the agent never set.
   */
  heartbeatAgentPresence(
    tenantId: string,
    memberId: string,
    now: string,
  ): Promise<AgentPresence | undefined>;

  /**
   * Every agent seat, with its presence and its load.
   *
   * Deliberately *unfiltered* by eligibility: that is a rule in `@kefu/core`,
   * and an adapter that pre-filtered would be a second, silently divergent copy
   * of it. A seat with no presence row still appears, reported `offline`.
   *
   * A store id narrows the list to one store; `undefined` reads every seat of
   * the tenant, which is what a caller asks for when the store is not meant to
   * decide anything — a seat is no longer pinned by the one it belongs to.
   */
  listAssignmentCandidates(
    tenantId: string,
    storeId: string | undefined,
  ): Promise<ReadonlyArray<AssignmentCandidate>>;

  /** Assignment history of one conversation, newest first. */
  listAssignments(
    tenantId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<ConversationAssignment>>;

  /**
   * When this member last handed the conversation away, if it ever did.
   *
   * The latest successful row that moved it off the member — a refused attempt
   * moved nothing. It is the instant the member's transcript of the
   * conversation stops.
   */
  lastHandoverFrom(
    tenantId: string,
    conversationId: string,
    memberId: string,
  ): Promise<string | undefined>;

  /**
   * Every seat of a tenant an administrator has given a 分流权重 to.
   *
   * A seat nobody has set is **absent** rather than reported as
   * `DEFAULT_ASSIGNMENT_WEIGHT`: the reader applies the default, so this answers
   * "what has been configured" while `listAssignmentCandidates` answers "what is
   * in force". That split is what keeps an unconfigured tenant reading back an
   * empty list instead of a full table of ones.
   */
  listRoutingWeights(tenantId: string): Promise<ReadonlyArray<ConversationRoutingWeight>>;

  /**
   * Store 分流权重 for the seats a save names, in one write.
   *
   * **Upsert-only**: a seat absent from `weights` keeps the weight it had, so a
   * settings form that drew only part of the roster cannot silently reset the
   * rest. `weight: DEFAULT_ASSIGNMENT_WEIGHT` is how a seat returns to the
   * default, and it is stored rather than deleted so the change keeps its author
   * and its instant.
   *
   * Whether a named seat may carry a weight is the caller's judgement: it needs
   * the roster, which the caller has already read.
   */
  saveRoutingWeights(
    input: SaveRoutingWeightsRecord,
  ): Promise<ReadonlyArray<ConversationRoutingWeight>>;

  /**
   * Assign every due pooled conversation this sweep can, in one transaction.
   *
   * The dispatcher proper. Selection is `planAutoAssign` from `@kefu/core`;
   * this method only executes its verdict, so the durable and in-memory
   * adapters cannot disagree about who should receive a conversation.
   *
   * Each conversation is claimed by a compare-and-swap on `version`, so two
   * sweeps running concurrently produce exactly one winner per conversation and
   * the loser writes nothing.
   */
  dispatchDue(input: DispatchDueInput): Promise<ReadonlyArray<DispatchOutcome>>;

  // --------------------------------------------------------------------------
  // Review
  // --------------------------------------------------------------------------

  /** The platform-wide review policy, or the deterministic default. */
  getReviewPolicy(): Promise<ReviewPolicy>;
  /** Replace the platform-wide review policy. */
  setReviewPolicy(policy: ReviewPolicy): Promise<ReviewPolicy>;
  /** Pending review queue of a tenant, optionally one store. */
  listReviewQueue(tenantId: string, storeId?: string): Promise<ReadonlyArray<Message>>;
  /** Approve a candidate-backed message, writing its approved phrase. */
  approveMessage(
    tenantId: string,
    messageId: string,
    approvedBy: string,
    now: string,
  ): Promise<ApprovalResult>;
  /** Approved phrases of a tenant, newest first. */
  listApprovedPhrases(tenantId: string): Promise<ReadonlyArray<ApprovedPhrase>>;

  // --------------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------------

  /** Persist a generated suggestion set; the adapter assigns the id. */
  createSuggestionSet(input: CreateSuggestionSetRecord): Promise<SuggestionSet>;
  /** One suggestion set inside the tenant scope. */
  getSuggestionSet(tenantId: string, suggestionId: string): Promise<SuggestionSet | undefined>;
  /**
   * Every suggestion set of a tenant, newest first.
   *
   * Read by the §4.8 report, which needs the *conversations* that have produced
   * a set rather than any set's contents: that set of conversations is the
   * report's 商品咨询 proxy.
   */
  listSuggestionSets(tenantId: string): Promise<ReadonlyArray<SuggestionSet>>;

  // --------------------------------------------------------------------------
  // Audit and retention
  // --------------------------------------------------------------------------

  /** Append an immutable audit entry. */
  appendAudit(input: AppendAuditRecord): Promise<AuditEntry>;
  /** Audit entries of a tenant, newest first. */
  listAudit(tenantId: string): Promise<ReadonlyArray<AuditEntry>>;
  /** Retention evaluation for one tenant at `now`. */
  summarizeRetention(tenantId: string, now: string): Promise<RetentionSummary>;

  // --------------------------------------------------------------------------
  // Internal collaboration (colleague to colleague)
  // --------------------------------------------------------------------------

  /**
   * The threads a member takes part in, most recently active first.
   *
   * Scoped by membership, not by store: internal chat is tenant-wide, so two
   * colleagues in different stores of the same tenant can still talk.
   */
  listInternalThreads(tenantId: string, memberId: string): Promise<ReadonlyArray<InternalThread>>;
  /** One thread inside the tenant scope. */
  getInternalThread(tenantId: string, threadId: string): Promise<InternalThread | undefined>;
  /**
   * The one-to-one thread between two members, created on first use.
   *
   * Idempotent by construction: the adapter derives the id from the ascending
   * participant pair, so two seats opening the same chat converge on one row
   * instead of each creating its own half of the conversation.
   */
  ensureDirectInternalThread(input: EnsureDirectInternalThreadRecord): Promise<InternalThread>;
  /** Every message of a thread, oldest first. */
  listInternalMessages(tenantId: string, threadId: string): Promise<ReadonlyArray<InternalMessage>>;
  /**
   * Append one message and advance the thread's activity stamp.
   *
   * The message and its attachment are written together, in one transaction,
   * and the attachment is *claimed* — the draft's `message_id` is set from
   * `NULL` in the same statement that writes the message. Two facts, one commit:
   * a message that shows a file the sender had already removed, or a draft
   * claimed by a message that was never written, are both impossible.
   */
  appendInternalMessage(input: AppendInternalMessageRecord): Promise<InternalMessage | undefined>;
  /**
   * Store one uploaded attachment as a draft, before any message names it.
   *
   * The bytes are already in object storage when this runs: the upload is what
   * created them, and the row is the record of what was written. If this write
   * fails, the object is an orphan the bucket's own namespace can enumerate —
   * never the reverse, which would be a row promising bytes nobody has.
   */
  createInternalAttachment(
    input: CreateInternalAttachmentRecord,
  ): Promise<InternalAttachmentRecord>;
  /**
   * The attachment of one message, tenant-scoped.
   *
   * The serve path's only lookup: the signed URL carries a tenant and a message
   * id, and a message of another tenant simply does not resolve.
   */
  getInternalMessageAttachment(
    tenantId: string,
    messageId: string,
  ): Promise<InternalAttachmentRecord | undefined>;
}

/** Input to {@link PlatformRepository.ensureDirectInternalThread}. */
export type EnsureDirectInternalThreadRecord = {
  readonly tenantId: string;
  readonly memberIdA: string;
  readonly memberIdB: string;
  readonly now: string;
};

/** Input to {@link PlatformRepository.appendInternalMessage}. */
export type AppendInternalMessageRecord = {
  readonly tenantId: string;
  readonly threadId: string;
  readonly senderMemberId: string;
  readonly body: string;
  /** The draft to claim and attach, or `null` for a text-only message. */
  readonly attachmentId: string | null;
  readonly createdAt: string;
};

/** Input to {@link PlatformRepository.createInternalAttachment}. */
export type CreateInternalAttachmentRecord = {
  /** Minted by the caller, because the object key is derived from it. */
  readonly id: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly uploaderMemberId: string;
  readonly kind: InternalAttachmentRecord['kind'];
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly objectKey: string;
  readonly createdAt: string;
};

/**
 * Decide which platform repository an environment uses.
 *
 * `test` is deterministic and in-process so the whole workflow runs with no
 * database; `local` and `production` read and write PostgreSQL. There is no
 * explicit override: the environment boundary *is* the policy, which is what
 * keeps a production boot from silently falling back to an in-process store.
 *
 * @param appEnv - Application runtime boundary.
 * @returns `memory` for `test`, `postgres` otherwise.
 */
export function resolvePlatformStorageMode(appEnv: AppEnvironment): 'memory' | 'postgres' {
  return appEnv === 'test' ? 'memory' : 'postgres';
}
