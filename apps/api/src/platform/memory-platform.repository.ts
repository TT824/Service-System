/**
 * In-process {@link PlatformRepository}.
 *
 * A thin adapter over the deterministic {@link KefuStore} the core package
 * ships, used by `APP_ENV=test` (and by unit tests directly). The store already
 * enforces the tenant boundary and the conversation/review rules, so this
 * adapter adds no policy of its own: it projects the store's synchronous surface
 * onto the asynchronous port every platform service depends on.
 *
 * Keeping the store behind the same port as the PostgreSQL adapter is what lets
 * the interface tests exercise the real HTTP surface with no database, while the
 * domain/unit tests keep talking to {@link KefuStore} directly.
 */

import {
  KefuStore,
  summarizeKnowledgeIndexCounts,
  type AgentPresence,
  type ApplyProductImportBatchInput,
  type ApprovalResult,
  type ApprovedPhrase,
  type AssignmentCandidate,
  type AttachMessageMediaInput,
  type AuditEntry,
  type CategoryAttribute,
  type Conversation,
  type ConversationAssignment,
  type DispatchOutcome,
  type FaqItem,
  type FaqItemPatch,
  type FaqQuestionVariant,
  type FaqQuestionVariantPatch,
  type ImportBatchWithErrors,
  type IngestResult,
  type InboundMessageInput,
  type KnowledgeIndexStatusFilter,
  type KnowledgeIndexStatusSummary,
  type Member,
  type Message,
  type NewCategoryAttribute,
  type NewFaqQuestionVariant,
  type NewProductCategory,
  type NewProductImportBatch,
  type NewProductImportError,
  type NewProductSku,
  type NewProductSpu,
  type OutboundMessageInput,
  type Product,
  type ProductCategory,
  type ProductImportBatch,
  type ProductImportBatchPatch,
  type ProductImportError,
  type ProductPatch,
  type ProductSku,
  type ProductSkuPatch,
  type ProductSpu,
  type ProductSpuPatch,
  type RetentionSummary,
  type ReviewPolicy,
  type Shortcut,
  type ShortcutPatch,
  type Store,
  type StoreConversationResult,
  type TakeoverAuthority,
  type SuggestionSet,
  type Tenant,
} from '@kefu/core';
import type {
  AppendAuditRecord,
  CreateFaqRecord,
  CreateProductRecord,
  CreateShortcutRecord,
  CreateSuggestionSetRecord,
  DispatchDueInput,
  PlatformRepository,
  SetAgentPresenceRecord,
} from './platform-repository';

/** Platform repository backed by the deterministic in-process store. */
export class MemoryPlatformRepository implements PlatformRepository {
  /**
   * @param store - The platform kernel store this adapter projects.
   */
  constructor(private readonly store: KefuStore) {}

  // --------------------------------------------------------------------------
  // Directory
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listTenants(): Promise<ReadonlyArray<Tenant>> {
    return this.store.listTenants();
  }

  /** @inheritdoc */
  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    return this.store.getTenant(tenantId);
  }

  /** @inheritdoc */
  async listStores(tenantId: string): Promise<ReadonlyArray<Store>> {
    return this.store.listStores(tenantId);
  }

  /** @inheritdoc */
  async getStore(tenantId: string, storeId: string): Promise<Store | undefined> {
    return this.store.getStore(tenantId, storeId);
  }

  /** @inheritdoc */
  async getMember(memberId: string): Promise<Member | undefined> {
    return this.store.getMember(memberId);
  }

  /** @inheritdoc */
  async listMembers(tenantId: string): Promise<ReadonlyArray<Member>> {
    return this.store.listMembers(tenantId);
  }

  // --------------------------------------------------------------------------
  // Knowledge
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listProducts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Product>> {
    return this.store.listProducts(tenantId, storeId);
  }

  /** @inheritdoc */
  async getProduct(tenantId: string, productId: string): Promise<Product | undefined> {
    return this.store.getProduct(tenantId, productId);
  }

  /** @inheritdoc */
  async createProduct(input: CreateProductRecord): Promise<Product> {
    return this.store.createProduct(input);
  }

  /** @inheritdoc */
  async updateProduct(
    tenantId: string,
    productId: string,
    patch: ProductPatch,
    now?: string,
  ): Promise<Product | undefined> {
    return this.store.updateProduct({
      tenantId,
      productId,
      patch,
      ...(now === undefined ? {} : { now }),
    });
  }

  /** @inheritdoc */
  async listFaqs(tenantId: string, storeId?: string): Promise<ReadonlyArray<FaqItem>> {
    return this.store.listFaqs(tenantId, storeId);
  }

  /** @inheritdoc */
  async getFaq(tenantId: string, faqId: string): Promise<FaqItem | undefined> {
    return this.store.getFaq(tenantId, faqId);
  }

  /** @inheritdoc */
  async createFaq(input: CreateFaqRecord): Promise<FaqItem> {
    return this.store.createFaq(input);
  }

  /** @inheritdoc */
  async updateFaq(
    tenantId: string,
    faqId: string,
    patch: FaqItemPatch,
    now?: string,
  ): Promise<FaqItem | undefined> {
    return this.store.updateFaq({
      tenantId,
      faqId,
      patch,
      ...(now === undefined ? {} : { now }),
    });
  }

  /** @inheritdoc */
  async listShortcuts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Shortcut>> {
    return this.store.listShortcuts(tenantId, storeId);
  }

  /** @inheritdoc */
  async getShortcut(tenantId: string, shortcutId: string): Promise<Shortcut | undefined> {
    return this.store.getShortcut(tenantId, shortcutId);
  }

  /** @inheritdoc */
  async createShortcut(input: CreateShortcutRecord): Promise<Shortcut> {
    return this.store.createShortcut(input);
  }

  /** @inheritdoc */
  async updateShortcut(
    tenantId: string,
    shortcutId: string,
    patch: ShortcutPatch,
    now?: string,
  ): Promise<Shortcut | undefined> {
    return this.store.updateShortcut({
      tenantId,
      shortcutId,
      patch,
      ...(now === undefined ? {} : { now }),
    });
  }

  // --------------------------------------------------------------------------
  // Catalogue
  // --------------------------------------------------------------------------

  /**
   * Zeros — and they are the truth here, not a stub.
   *
   * The in-process store holds no slices: `knowledge_chunks` is written by the
   * Worker's sweep into PostgreSQL, and the demo directory this adapter serves
   * has never produced one. Seeding a chunk collection into `KefuStore` would be
   * a second answer to a question only PostgreSQL can actually answer, and the
   * two would drift the first time a real sweep ran.
   *
   * The shape is the durable adapter's own, zero-fill included — that comes from
   * {@link summarizeKnowledgeIndexCounts}, the same function the SQL adapter
   * calls — so no caller can tell the adapters apart by the keys of an answer.
   */
  async knowledgeIndexStatus(
    _tenantId: string,
    _filter: KnowledgeIndexStatusFilter,
  ): Promise<KnowledgeIndexStatusSummary> {
    return Object.freeze({
      counts: summarizeKnowledgeIndexCounts([]),
      embeddings: 0,
      recentFailures: Object.freeze([]),
    });
  }

  /** @inheritdoc */
  async listCategories(
    tenantId: string,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductCategory>> {
    return this.store.listCategories(tenantId, storeId);
  }

  /** @inheritdoc */
  async getCategory(tenantId: string, categoryId: string): Promise<ProductCategory | undefined> {
    return this.store.getCategory(tenantId, categoryId);
  }

  /** @inheritdoc */
  async createCategory(input: NewProductCategory): Promise<ProductCategory | undefined> {
    return this.store.createCategory(input);
  }

  /** @inheritdoc */
  async listCategoryAttributes(
    tenantId: string,
    categoryId: string,
  ): Promise<ReadonlyArray<CategoryAttribute>> {
    return this.store.listCategoryAttributes(tenantId, categoryId);
  }

  /** @inheritdoc */
  async createCategoryAttribute(
    input: NewCategoryAttribute,
  ): Promise<CategoryAttribute | undefined> {
    return this.store.createCategoryAttribute(input);
  }

  /** @inheritdoc */
  async listSpus(
    tenantId: string,
    filter: {
      readonly storeId?: string | undefined;
      readonly categoryId?: string | undefined;
    } = {},
  ): Promise<ReadonlyArray<ProductSpu>> {
    return this.store.listSpus(tenantId, filter);
  }

  /** @inheritdoc */
  async getSpu(tenantId: string, spuId: string): Promise<ProductSpu | undefined> {
    return this.store.getSpu(tenantId, spuId);
  }

  /** @inheritdoc */
  async createSpu(input: NewProductSpu): Promise<ProductSpu | undefined> {
    return this.store.createSpu(input);
  }

  /** @inheritdoc */
  async updateSpu(
    tenantId: string,
    spuId: string,
    patch: ProductSpuPatch,
    now?: string,
  ): Promise<ProductSpu | undefined> {
    return this.store.updateSpu({ tenantId, spuId, patch, ...(now === undefined ? {} : { now }) });
  }

  /** @inheritdoc */
  async listSkus(tenantId: string, spuId: string): Promise<ReadonlyArray<ProductSku>> {
    return this.store.listSkus(tenantId, spuId);
  }

  /** @inheritdoc */
  async listSkusByStore(tenantId: string, storeId: string): Promise<ReadonlyArray<ProductSku>> {
    return this.store.listSkusByStore(tenantId, storeId);
  }

  /** @inheritdoc */
  async getSku(tenantId: string, skuId: string): Promise<ProductSku | undefined> {
    return this.store.getSku(tenantId, skuId);
  }

  /** @inheritdoc */
  async createSku(input: NewProductSku): Promise<ProductSku | undefined> {
    return this.store.createSku(input);
  }

  /** @inheritdoc */
  async updateSku(
    tenantId: string,
    skuId: string,
    patch: ProductSkuPatch,
    now?: string,
  ): Promise<ProductSku | undefined> {
    return this.store.updateSku({ tenantId, skuId, patch, ...(now === undefined ? {} : { now }) });
  }

  // --------------------------------------------------------------------------
  // FAQ near-questions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listFaqVariants(
    tenantId: string,
    faqId: string,
  ): Promise<ReadonlyArray<FaqQuestionVariant>> {
    return this.store.listFaqVariants(tenantId, faqId);
  }

  /** @inheritdoc */
  async getFaqVariant(
    tenantId: string,
    variantId: string,
  ): Promise<FaqQuestionVariant | undefined> {
    return this.store.getFaqVariant(tenantId, variantId);
  }

  /** @inheritdoc */
  async createFaqVariant(input: NewFaqQuestionVariant): Promise<FaqQuestionVariant | undefined> {
    return this.store.createFaqVariant(input);
  }

  /** @inheritdoc */
  async updateFaqVariant(
    tenantId: string,
    variantId: string,
    patch: FaqQuestionVariantPatch,
    now?: string,
  ): Promise<FaqQuestionVariant | undefined> {
    return this.store.updateFaqVariant({
      tenantId,
      variantId,
      patch,
      ...(now === undefined ? {} : { now }),
    });
  }

  // --------------------------------------------------------------------------
  // Product import batches
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listImportBatches(
    tenantId: string,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductImportBatch>> {
    return this.store.listImportBatches(tenantId, storeId);
  }

  /** @inheritdoc */
  async getImportBatch(tenantId: string, batchId: string): Promise<ProductImportBatch | undefined> {
    return this.store.getImportBatch(tenantId, batchId);
  }

  /** @inheritdoc */
  async createImportBatch(input: NewProductImportBatch): Promise<ProductImportBatch> {
    return this.store.createImportBatch(input);
  }

  /** @inheritdoc */
  async updateImportBatch(
    tenantId: string,
    batchId: string,
    patch: ProductImportBatchPatch,
    now?: string,
  ): Promise<ProductImportBatch | undefined> {
    return this.store.updateImportBatch({
      tenantId,
      batchId,
      patch,
      ...(now === undefined ? {} : { now }),
    });
  }

  /** @inheritdoc */
  async appendImportErrors(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId'>>;
    readonly now?: string;
  }): Promise<ReadonlyArray<ProductImportError> | undefined> {
    return this.store.appendImportErrors(input);
  }

  /** @inheritdoc */
  async listImportErrors(
    tenantId: string,
    batchId: string,
  ): Promise<ReadonlyArray<ProductImportError>> {
    return this.store.listImportErrors(tenantId, batchId);
  }

  /** @inheritdoc */
  async applyProductImportBatch(
    input: ApplyProductImportBatchInput,
  ): Promise<ImportBatchWithErrors> {
    return this.store.applyProductImportBatch(input);
  }

  // --------------------------------------------------------------------------
  // Conversations and messages
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listConversations(
    tenantId: string,
    storeId?: string,
    visibleToMemberId?: string,
  ): Promise<ReadonlyArray<Conversation>> {
    return this.store.listConversations(tenantId, storeId, visibleToMemberId);
  }

  /** @inheritdoc */
  async getConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<Conversation | undefined> {
    return this.store.getConversation(tenantId, conversationId);
  }

  /** @inheritdoc */
  async listMessages(tenantId: string, conversationId?: string): Promise<ReadonlyArray<Message>> {
    return this.store.listMessages(tenantId, conversationId);
  }

  /** @inheritdoc */
  async getMessage(tenantId: string, messageId: string): Promise<Message | undefined> {
    return this.store.getMessage(tenantId, messageId);
  }

  /** @inheritdoc */
  async claim(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult> {
    return this.store.claim(tenantId, conversationId, actorMemberId, expectedVersion, now);
  }

  /** @inheritdoc */
  async returnToPool(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult> {
    return this.store.returnToPool(
      tenantId,
      conversationId,
      actorMemberId,
      authority,
      expectedVersion,
      now,
    );
  }

  /** @inheritdoc */
  async transfer(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    toMemberId: string,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult> {
    return this.store.transfer(
      tenantId,
      conversationId,
      actorMemberId,
      authority,
      toMemberId,
      expectedVersion,
      now,
    );
  }

  /** @inheritdoc */
  async close(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    actorIsAdmin: boolean,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult> {
    return this.store.close(
      tenantId,
      conversationId,
      actorMemberId,
      actorIsAdmin,
      expectedVersion,
      now,
    );
  }

  /** @inheritdoc */
  async sendOutbound(input: OutboundMessageInput): Promise<IngestResult> {
    return this.store.sendOutbound(input);
  }

  /** @inheritdoc */
  async ingestInbound(input: InboundMessageInput): Promise<IngestResult> {
    return this.store.ingestInbound(input);
  }

  /** @inheritdoc */
  async attachMessageMedia(input: AttachMessageMediaInput): Promise<boolean> {
    return this.store.attachMessageMedia(input);
  }

  // --------------------------------------------------------------------------
  // Assignment
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async setAgentPresence(input: SetAgentPresenceRecord): Promise<AgentPresence> {
    return this.store.setAgentPresence(input);
  }

  /** @inheritdoc */
  async getAgentPresence(tenantId: string, memberId: string): Promise<AgentPresence | undefined> {
    return this.store.listAgentPresence(tenantId, memberId);
  }

  /** @inheritdoc */
  async listTenantAgentPresence(tenantId: string): Promise<ReadonlyArray<AgentPresence>> {
    return this.store.listTenantAgentPresence(tenantId);
  }

  /** @inheritdoc */
  async heartbeatAgentPresence(
    tenantId: string,
    memberId: string,
    now: string,
  ): Promise<AgentPresence | undefined> {
    return this.store.heartbeatAgentPresence(tenantId, memberId, now);
  }

  /** @inheritdoc */
  async listAssignmentCandidates(
    tenantId: string,
    storeId: string | undefined,
  ): Promise<ReadonlyArray<AssignmentCandidate>> {
    return this.store.listAssignmentCandidates(tenantId, storeId);
  }

  /** @inheritdoc */
  async listAssignments(
    tenantId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<ConversationAssignment>> {
    return this.store.listAssignments(tenantId, conversationId);
  }

  /** @inheritdoc */
  async lastHandoverFrom(
    tenantId: string,
    conversationId: string,
    memberId: string,
  ): Promise<string | undefined> {
    return this.store.lastHandoverFrom(tenantId, conversationId, memberId);
  }

  /** @inheritdoc */
  async dispatchDue(input: DispatchDueInput): Promise<ReadonlyArray<DispatchOutcome>> {
    return this.store.dispatchDue(input);
  }

  // --------------------------------------------------------------------------
  // Review
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getReviewPolicy(): Promise<ReviewPolicy> {
    return this.store.getReviewPolicy();
  }

  /** @inheritdoc */
  async setReviewPolicy(policy: ReviewPolicy): Promise<ReviewPolicy> {
    return this.store.setReviewPolicy(policy);
  }

  /** @inheritdoc */
  async listReviewQueue(tenantId: string, storeId?: string): Promise<ReadonlyArray<Message>> {
    return this.store.listReviewQueue(tenantId, storeId);
  }

  /** @inheritdoc */
  async approveMessage(
    tenantId: string,
    messageId: string,
    approvedBy: string,
    now: string,
  ): Promise<ApprovalResult> {
    return this.store.approveMessage(tenantId, messageId, approvedBy, now);
  }

  /** @inheritdoc */
  async listApprovedPhrases(tenantId: string): Promise<ReadonlyArray<ApprovedPhrase>> {
    return this.store.listApprovedPhrases(tenantId);
  }

  // --------------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async createSuggestionSet(input: CreateSuggestionSetRecord): Promise<SuggestionSet> {
    return this.store.createSuggestionSet(input);
  }

  /** @inheritdoc */
  async getSuggestionSet(
    tenantId: string,
    suggestionId: string,
  ): Promise<SuggestionSet | undefined> {
    return this.store.getSuggestionSet(tenantId, suggestionId);
  }

  /** @inheritdoc */
  async listSuggestionSets(tenantId: string): Promise<ReadonlyArray<SuggestionSet>> {
    return this.store.listSuggestionSets(tenantId);
  }

  // --------------------------------------------------------------------------
  // Audit and retention
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async appendAudit(input: AppendAuditRecord): Promise<AuditEntry> {
    return this.store.appendAudit(input);
  }

  /** @inheritdoc */
  async listAudit(tenantId: string): Promise<ReadonlyArray<AuditEntry>> {
    return this.store.listAudit(tenantId);
  }

  /** @inheritdoc */
  async summarizeRetention(tenantId: string, now: string): Promise<RetentionSummary> {
    return this.store.summarizeRetention(tenantId, now);
  }
}
