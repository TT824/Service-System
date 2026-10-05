/**
 * Deterministic in-process store for the platform kernel.
 *
 * The MVP runs every internal service on a single-process, deterministic store
 * so the platform is usable locally without PostgreSQL. Every tenant-owned read
 * or mutation requires a tenant id and enforces the tenant boundary inside the
 * store; every store-owned path requires the store id as well. The SQL
 * migrations describe the same model for a real database; this store is the
 * runnable stand-in behind the application services and stable API contracts.
 */

import { createAuditEntry, AUDIT_ACTIONS } from './audit';
import { countsAsFirstReply } from './types';
import {
  claimConversation,
  closeConversation,
  conversationReadAccess,
  openConversationForInbound,
  recordFirstReply,
  returnConversation,
  touchConversationForInbound,
  transferConversation,
  type ConversationTransition,
  type TakeoverAuthority,
} from './conversation';
import {
  isAssignmentDue,
  planAutoAssign,
  rejectionReasonCode,
  type AgentAvailabilityStatus,
  type AgentPresence,
  type AssignmentAction,
  type AssignmentCandidate,
  type AssignmentReasonCode,
  type ConversationAssignment,
  type DispatchOutcome,
} from './assignment';
import type {
  CategoryAttribute,
  NewCategoryAttribute,
  NewProductCategory,
  NewProductSku,
  NewProductSpu,
  ProductCategory,
  ProductSku,
  ProductSkuPatch,
  ProductSpu,
  ProductSpuPatch,
} from './catalog';
import type {
  ApplyProductImportBatchInput,
  FaqQuestionVariant,
  FaqQuestionVariantPatch,
  ImportBatchWithErrors,
  NewFaqQuestionVariant,
  NewProductImportBatch,
  NewProductImportError,
  ProductImportBatch,
  ProductImportBatchPatch,
  ProductImportError,
} from './imports';
import { evaluateRetention, tenantRetentionPolicies, type RetentionSummary } from './retention';
import { defaultReviewPolicy } from './review';
import type {
  ApprovedPhrase,
  AuditEntry,
  Conversation,
  FaqItem,
  FaqItemPatch,
  Member,
  Message,
  Product,
  ProductPatch,
  ReviewPolicy,
  Shortcut,
  ShortcutPatch,
  SuggestionCandidate,
  SuggestionProvider,
  SuggestionSet,
  Tenant,
  Store,
} from './types';
import { DEFAULT_RETENTION_DAYS, isReviewEligibleSource } from './types';
import type { MessageSource } from './types';

/** Result of a conversation mutation performed through the store. */
export type StoreConversationResult =
  | { readonly ok: true; readonly conversation: Conversation }
  | {
      readonly ok: false;
      readonly code: 'not_found' | 'conflict' | 'not_claimed' | 'invalid_state';
      readonly reason: string;
    };

/** Result of an idempotent message ingestion/send. */
export type IngestResult = {
  readonly conversation: Conversation;
  readonly message: Message;
  readonly created: boolean;
  readonly reopened: boolean;
};

/** Result of a review approval. */
export type ApprovalResult =
  | {
      readonly ok: true;
      readonly message: Message;
      readonly phrase: ApprovedPhrase;
    }
  | {
      readonly ok: false;
      readonly code: 'not_found' | 'not_eligible' | 'already_reviewed';
      readonly reason: string;
    };

/** Data used to send an outbound message. */
export type OutboundMessageInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly source: MessageSource;
  readonly candidateId?: string | null;
  readonly dedupKey?: string | null;
  readonly now?: string;
};

/** Data used to ingest an inbound message. */
export type InboundMessageInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly channel: string;
  readonly externalCustomerId: string;
  readonly externalConversationId: string;
  readonly externalMessageId?: string | null;
  readonly messageType?: Message['messageType'];
  readonly content: string;
  readonly dedupKey?: string | null;
  readonly now?: string;
};

/**
 * Data used to record a message's stored media.
 *
 * Separate from {@link InboundMessageInput} because the two happen at different
 * moments: the message is persisted from the callback, and its media is
 * attached afterwards, once the bytes have been fetched and written. A
 * reference that could only be set at insert time would be a reference the
 * platform has to have before it has anything to point at.
 */
export type AttachMessageMediaInput = {
  readonly tenantId: string;
  readonly messageId: string;
  /** Object-store key the bytes were written under. */
  readonly key: string;
  /** Content type the bytes were stored with. */
  readonly mimeType: string;
  /** Size in bytes. */
  readonly bytes: number;
};

/** The default seeded platform super administrator member id. */
export const PLATFORM_ADMIN_MEMBER_ID = 'u-platform-admin';

const T1 = 'tenant-acme';
const T2 = 'tenant-beta';
const S1 = 'store-acme-flagship';
const S2 = 'store-acme-distribution';
const S3 = 'store-beta-official';

/**
 * In-memory platform kernel store.
 *
 * A new store instance is created per Nest application, so each test file and
 * each process boot starts from the same deterministic seed.
 */
export class KefuStore {
  private tenants: Tenant[] = [];
  private stores: Store[] = [];
  private members: Member[] = [];
  private products: Product[] = [];
  private faqs: FaqItem[] = [];
  private shortcuts: Shortcut[] = [];
  private categories: ProductCategory[] = [];
  private categoryAttributes: CategoryAttribute[] = [];
  private spus: ProductSpu[] = [];
  private skus: ProductSku[] = [];
  private faqVariants: FaqQuestionVariant[] = [];
  private importBatches: ProductImportBatch[] = [];
  private importErrors: ProductImportError[] = [];
  private conversations: Conversation[] = [];
  private messages: Message[] = [];
  private presence: AgentPresence[] = [];
  private assignments: ConversationAssignment[] = [];
  private approvedPhrases: ApprovedPhrase[] = [];
  private auditEntries: AuditEntry[] = [];
  private suggestionSets: SuggestionSet[] = [];
  private reviewPolicy: ReviewPolicy = defaultReviewPolicy();
  private sequence = 1000;

  constructor() {
    this.seed();
  }

  // --------------------------------------------------------------------------
  // Tenants, stores and members
  // --------------------------------------------------------------------------

  listTenants(): ReadonlyArray<Tenant> {
    return [...this.tenants];
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.tenants.find((tenant) => tenant.id === tenantId);
  }

  listStores(tenantId: string): ReadonlyArray<Store> {
    return this.stores.filter((store) => store.tenantId === tenantId);
  }

  getStore(tenantId: string, storeId: string): Store | undefined {
    return this.stores.find((store) => store.tenantId === tenantId && store.id === storeId);
  }

  getMember(memberId: string): Member | undefined {
    return this.members.find((member) => member.id === memberId);
  }

  listMembers(tenantId: string): ReadonlyArray<Member> {
    return this.members.filter((member) => member.tenantId === tenantId && member.enabled);
  }

  /**
   * Insert or replace one tenant.
   *
   * Idempotent by id: the directory holds exactly one row per tenant, so
   * upserting the same tenant twice leaves the same single row. The
   * authentication directory publishes the directory rows it creates through
   * this method, which is what keeps one in-process deployment from running two
   * directories that disagree about a tenant that was just provisioned.
   *
   * @param tenant - The tenant row to store.
   * @returns The stored row.
   */
  upsertTenant(tenant: Tenant): Tenant {
    return this.replaceById(this.tenants, tenant);
  }

  /**
   * Insert or replace one store.
   *
   * Idempotent by id, under the same rule as {@link upsertTenant}. The store
   * keeps the tenant it names: this method does not move a store between
   * tenants, because a store id belongs to exactly one tenant in every schema
   * the platform ships.
   *
   * @param store - The store row to store.
   * @returns The stored row.
   */
  upsertStore(store: Store): Store {
    return this.replaceById(this.stores, store);
  }

  /**
   * Insert or replace one member.
   *
   * Idempotent by id, under the same rule as {@link upsertTenant}. A platform
   * member (`tenantId: null`) is accepted: the invariant that forbids a
   * tenant-scoped platform administrator is enforced where members are created,
   * not here, and the directory mirror must be able to store exactly what the
   * authentication directory stores.
   *
   * @param member - The member row to store.
   * @returns The stored row.
   */
  upsertMember(member: Member): Member {
    return this.replaceById(this.members, member);
  }

  /** Replace the row with the same id, or append it when the id is new. */
  private replaceById<T extends { readonly id: string }>(rows: T[], row: T): T {
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    if (index === -1) {
      rows.push(row);
    } else {
      rows[index] = row;
    }
    return row;
  }

  // --------------------------------------------------------------------------
  // Knowledge
  // --------------------------------------------------------------------------

  // The knowledge reads return every row of the tenant scope, disabled ones
  // included: 停用 is a state the management surface has to be able to see and
  // undo, and a read that hid the row would make it unreachable. Which rows may
  // be *used* is decided once, by `usableKnowledge` in `./knowledge`.
  listProducts(tenantId: string, storeId?: string): ReadonlyArray<Product> {
    return this.products.filter(
      (item) => item.tenantId === tenantId && (storeId === undefined || item.storeId === storeId),
    );
  }

  listFaqs(tenantId: string, storeId?: string): ReadonlyArray<FaqItem> {
    return this.faqs.filter(
      (item) => item.tenantId === tenantId && (storeId === undefined || item.storeId === storeId),
    );
  }

  /**
   * Shortcuts a store can use, its own first.
   *
   * With no store asked for, this is the management list: every row of the
   * tenant, whatever its scope. With a store, it is the working list — that
   * store's own phrases plus the merchant-level ones, because a welcome message
   * belongs to the whole tenant while 本店发货时效 does not. Store-level rows come
   * first, then `sortOrder`, then the code, so the ordering is total and stable.
   */
  listShortcuts(tenantId: string, storeId?: string): ReadonlyArray<Shortcut> {
    return this.shortcuts
      .filter(
        (item) =>
          item.tenantId === tenantId &&
          (storeId === undefined || item.scopeType === 'tenant' || item.storeId === storeId),
      )
      .sort((a, b) => {
        if (a.scopeType !== b.scopeType) {
          return a.scopeType === 'store' ? -1 : 1;
        }
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        return a.code < b.code ? -1 : 1;
      });
  }

  getProduct(tenantId: string, productId: string): Product | undefined {
    return this.products.find((item) => item.tenantId === tenantId && item.id === productId);
  }

  getFaq(tenantId: string, faqId: string): FaqItem | undefined {
    return this.faqs.find((item) => item.tenantId === tenantId && item.id === faqId);
  }

  getShortcut(tenantId: string, shortcutId: string): Shortcut | undefined {
    return this.shortcuts.find((item) => item.tenantId === tenantId && item.id === shortcutId);
  }

  createProduct(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly sku: string;
    readonly title: string;
    readonly description: string;
    readonly now?: string;
  }): Product {
    const now = input.now ?? new Date().toISOString();
    const product: Product = {
      id: this.nextId('product'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      sku: input.sku,
      title: input.title,
      description: input.description,
      enabled: true,
      updatedAt: now,
      createdAt: now,
    };
    this.products.push(product);
    return product;
  }

  createFaq(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly question: string;
    readonly answer: string;
    readonly tags: ReadonlyArray<string>;
    readonly now?: string;
  }): FaqItem {
    const now = input.now ?? new Date().toISOString();
    const faq: FaqItem = {
      id: this.nextId('faq'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      question: input.question,
      answer: input.answer,
      tags: [...input.tags],
      enabled: true,
      updatedAt: now,
      createdAt: now,
    };
    this.faqs.push(faq);
    return faq;
  }

  /**
   * Create a shortcut.
   *
   * The scope follows the store: naming one makes the phrase store-level, and
   * omitting it makes the phrase merchant-level. The two can never disagree,
   * which is the same rule the CHECK constraint states.
   *
   * @param input - Tenant, optional store, and the phrase fields.
   * @returns The new shortcut.
   */
  createShortcut(input: {
    readonly tenantId: string;
    readonly storeId?: string | null;
    readonly code: string;
    readonly title: string;
    readonly content: string;
    readonly intentCode?: string | null;
    readonly sortOrder?: number;
    readonly now?: string;
  }): Shortcut {
    const now = input.now ?? new Date().toISOString();
    const storeId = input.storeId ?? null;
    const shortcut: Shortcut = {
      id: this.nextId('shortcut'),
      tenantId: input.tenantId,
      scopeType: storeId === null ? 'tenant' : 'store',
      storeId,
      code: input.code,
      title: input.title,
      content: input.content,
      intentCode: input.intentCode ?? null,
      sortOrder: input.sortOrder ?? 0,
      enabled: true,
      updatedAt: now,
      createdAt: now,
    };
    this.shortcuts.push(shortcut);
    return shortcut;
  }

  /**
   * Apply a patch to one product.
   *
   * Every field is resolved as `patch ?? current`, which is exactly what the
   * durable adapter writes as `COALESCE($n, column)`: the two adapters have to
   * agree that an absent field means "keep", not "clear".
   *
   * @param input - Tenant, product id and the fields to change.
   * @returns The updated product, or `undefined` when the tenant has no such id.
   */
  updateProduct(input: {
    readonly tenantId: string;
    readonly productId: string;
    readonly patch: ProductPatch;
    readonly now?: string;
  }): Product | undefined {
    const index = this.products.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.productId,
    );
    const current = this.products[index];
    if (current === undefined) {
      return undefined;
    }
    const updated: Product = {
      id: current.id,
      tenantId: current.tenantId,
      storeId: current.storeId,
      sku: input.patch.sku ?? current.sku,
      title: input.patch.title ?? current.title,
      description: input.patch.description ?? current.description,
      enabled: input.patch.enabled ?? current.enabled,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.products[index] = updated;
    return updated;
  }

  /**
   * Apply a patch to one FAQ entry.
   *
   * @param input - Tenant, FAQ id and the fields to change.
   * @returns The updated entry, or `undefined` when the tenant has no such id.
   */
  updateFaq(input: {
    readonly tenantId: string;
    readonly faqId: string;
    readonly patch: FaqItemPatch;
    readonly now?: string;
  }): FaqItem | undefined {
    const index = this.faqs.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.faqId,
    );
    const current = this.faqs[index];
    if (current === undefined) {
      return undefined;
    }
    const updated: FaqItem = {
      id: current.id,
      tenantId: current.tenantId,
      storeId: current.storeId,
      question: input.patch.question ?? current.question,
      answer: input.patch.answer ?? current.answer,
      tags: input.patch.tags === undefined ? current.tags : [...input.patch.tags],
      enabled: input.patch.enabled ?? current.enabled,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.faqs[index] = updated;
    return updated;
  }

  /**
   * Apply a patch to one shortcut.
   *
   * @param input - Tenant, shortcut id and the fields to change.
   * @returns The updated shortcut, or `undefined` when the tenant has no such id.
   */
  updateShortcut(input: {
    readonly tenantId: string;
    readonly shortcutId: string;
    readonly patch: ShortcutPatch;
    readonly now?: string;
  }): Shortcut | undefined {
    const index = this.shortcuts.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.shortcutId,
    );
    const current = this.shortcuts[index];
    if (current === undefined) {
      return undefined;
    }
    const updated: Shortcut = {
      id: current.id,
      tenantId: current.tenantId,
      scopeType: current.scopeType,
      storeId: current.storeId,
      code: input.patch.code ?? current.code,
      title: input.patch.title ?? current.title,
      content: input.patch.content ?? current.content,
      intentCode:
        input.patch.intentCode === undefined ? current.intentCode : input.patch.intentCode,
      sortOrder: input.patch.sortOrder ?? current.sortOrder,
      enabled: input.patch.enabled ?? current.enabled,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.shortcuts[index] = updated;
    return updated;
  }

  // --------------------------------------------------------------------------
  // Catalogue: categories, attribute declarations, products and variants
  // --------------------------------------------------------------------------

  // The catalogue is the structure SDD-012 imports into and SDD-014 indexes; the
  // legacy `products` rows above stay where they are. Every read is tenant-first,
  // and a create whose parent is outside the caller's tenant is refused rather
  // than written — that is the in-process stand-in for the foreign keys the
  // migration declares.

  listCategories(tenantId: string, storeId?: string): ReadonlyArray<ProductCategory> {
    return this.categories.filter(
      (item) => item.tenantId === tenantId && (storeId === undefined || item.storeId === storeId),
    );
  }

  getCategory(tenantId: string, categoryId: string): ProductCategory | undefined {
    return this.categories.find((item) => item.tenantId === tenantId && item.id === categoryId);
  }

  /**
   * Create a category.
   *
   * @param input - Tenant, store and the category fields.
   * @returns The new category, or `undefined` when a named parent is not the
   *   caller's own: a merchant must not file a category under another tenant's.
   */
  createCategory(input: NewProductCategory): ProductCategory | undefined {
    const parentId = input.parentId ?? null;
    if (parentId !== null && this.getCategory(input.tenantId, parentId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const category: ProductCategory = {
      id: this.nextId('category'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      parentId,
      code: input.code,
      name: input.name,
      status: 'enabled',
      updatedAt: now,
      createdAt: now,
    };
    this.categories.push(category);
    return category;
  }

  listCategoryAttributes(tenantId: string, categoryId: string): ReadonlyArray<CategoryAttribute> {
    return this.categoryAttributes.filter(
      (item) => item.tenantId === tenantId && item.categoryId === categoryId,
    );
  }

  /**
   * Declare one attribute of a category.
   *
   * @param input - Tenant, category and the declaration.
   * @returns The declaration, or `undefined` when the category is outside the
   *   caller's tenant.
   */
  createCategoryAttribute(input: NewCategoryAttribute): CategoryAttribute | undefined {
    if (this.getCategory(input.tenantId, input.categoryId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const attribute: CategoryAttribute = {
      id: this.nextId('category-attribute'),
      tenantId: input.tenantId,
      categoryId: input.categoryId,
      attributeCode: input.attributeCode,
      attributeName: input.attributeName,
      valueType: input.valueType,
      isRequired: input.isRequired ?? false,
      isSearchable: input.isSearchable ?? false,
      allowedValues: [...(input.allowedValues ?? [])],
      updatedAt: now,
      createdAt: now,
    };
    this.categoryAttributes.push(attribute);
    return attribute;
  }

  listSpus(
    tenantId: string,
    filter: {
      readonly storeId?: string | undefined;
      readonly categoryId?: string | undefined;
    } = {},
  ): ReadonlyArray<ProductSpu> {
    return this.spus.filter(
      (item) =>
        item.tenantId === tenantId &&
        (filter.storeId === undefined || item.storeId === filter.storeId) &&
        (filter.categoryId === undefined || item.categoryId === filter.categoryId),
    );
  }

  getSpu(tenantId: string, spuId: string): ProductSpu | undefined {
    return this.spus.find((item) => item.tenantId === tenantId && item.id === spuId);
  }

  listSkus(tenantId: string, spuId: string): ReadonlyArray<ProductSku> {
    return this.skus.filter((item) => item.tenantId === tenantId && item.spuId === spuId);
  }

  /** Every variant of one store, across all of its products. */
  listSkusByStore(tenantId: string, storeId: string): ReadonlyArray<ProductSku> {
    return this.skus.filter((item) => item.tenantId === tenantId && item.storeId === storeId);
  }

  getSku(tenantId: string, skuId: string): ProductSku | undefined {
    return this.skus.find((item) => item.tenantId === tenantId && item.id === skuId);
  }

  /**
   * Create a product.
   *
   * @param input - Tenant, store and the product fields.
   * @returns The new product, or `undefined` when a named category is not the
   *   caller's own. A null category is allowed: not every product is filed yet.
   */
  createSpu(input: NewProductSpu): ProductSpu | undefined {
    const categoryId = input.categoryId ?? null;
    if (categoryId !== null && this.getCategory(input.tenantId, categoryId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const spu: ProductSpu = {
      id: this.nextId('spu'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      categoryId,
      externalProductId: input.externalProductId ?? null,
      productCode: input.productCode,
      title: input.title,
      subtitle: input.subtitle ?? null,
      mainImageUrl: input.mainImageUrl ?? null,
      productUrl: input.productUrl ?? null,
      sellingPoints: [...(input.sellingPoints ?? [])],
      commonAttributes: { ...(input.commonAttributes ?? {}) },
      shelfStatus: input.shelfStatus ?? 'unknown',
      sourceType: input.sourceType ?? 'manual',
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      updatedAt: now,
      createdAt: now,
    };
    this.spus.push(spu);
    return spu;
  }

  /**
   * Create a variant of an existing product.
   *
   * @param input - Tenant, store, the product it belongs to, and the fields.
   * @returns The new variant, or `undefined` when the product is outside the
   *   caller's tenant.
   */
  createSku(input: NewProductSku): ProductSku | undefined {
    if (this.getSpu(input.tenantId, input.spuId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const sku: ProductSku = {
      id: this.nextId('sku'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      spuId: input.spuId,
      externalSkuId: input.externalSkuId ?? null,
      skuCode: input.skuCode,
      variant: { ...(input.variant ?? {}) },
      searchAttributes: { ...(input.searchAttributes ?? {}) },
      status: input.status ?? 'active',
      updatedAt: now,
      createdAt: now,
    };
    this.skus.push(sku);
    return sku;
  }

  /**
   * Apply a patch to one product.
   *
   * @param input - Tenant, product id and the fields to change.
   * @returns The updated product, or `undefined` when the tenant has no such id.
   */
  updateSpu(input: {
    readonly tenantId: string;
    readonly spuId: string;
    readonly patch: ProductSpuPatch;
    readonly now?: string;
  }): ProductSpu | undefined {
    const index = this.spus.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.spuId,
    );
    const current = this.spus[index];
    if (current === undefined) {
      return undefined;
    }
    const patch = input.patch;
    const categoryId = patch.categoryId === undefined ? current.categoryId : patch.categoryId;
    if (categoryId !== null && this.getCategory(input.tenantId, categoryId) === undefined) {
      return undefined;
    }
    const updated: ProductSpu = {
      id: current.id,
      tenantId: current.tenantId,
      storeId: current.storeId,
      categoryId,
      externalProductId: current.externalProductId,
      productCode: current.productCode,
      title: patch.title ?? current.title,
      subtitle: patch.subtitle === undefined ? current.subtitle : patch.subtitle,
      mainImageUrl: patch.mainImageUrl === undefined ? current.mainImageUrl : patch.mainImageUrl,
      productUrl: patch.productUrl === undefined ? current.productUrl : patch.productUrl,
      sellingPoints:
        patch.sellingPoints === undefined ? current.sellingPoints : [...patch.sellingPoints],
      commonAttributes:
        patch.commonAttributes === undefined
          ? current.commonAttributes
          : { ...patch.commonAttributes },
      shelfStatus: patch.shelfStatus ?? current.shelfStatus,
      sourceType: current.sourceType,
      sourceUpdatedAt: current.sourceUpdatedAt,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.spus[index] = updated;
    return updated;
  }

  /**
   * Apply a patch to one variant.
   *
   * @param input - Tenant, variant id and the fields to change.
   * @returns The updated variant, or `undefined` when the tenant has no such id.
   */
  updateSku(input: {
    readonly tenantId: string;
    readonly skuId: string;
    readonly patch: ProductSkuPatch;
    readonly now?: string;
  }): ProductSku | undefined {
    const index = this.skus.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.skuId,
    );
    const current = this.skus[index];
    if (current === undefined) {
      return undefined;
    }
    const patch = input.patch;
    const updated: ProductSku = {
      id: current.id,
      tenantId: current.tenantId,
      storeId: current.storeId,
      spuId: current.spuId,
      externalSkuId: current.externalSkuId,
      skuCode: patch.skuCode ?? current.skuCode,
      variant: patch.variant === undefined ? current.variant : { ...patch.variant },
      searchAttributes:
        patch.searchAttributes === undefined
          ? current.searchAttributes
          : { ...patch.searchAttributes },
      status: patch.status ?? current.status,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.skus[index] = updated;
    return updated;
  }

  // --------------------------------------------------------------------------
  // FAQ near-questions
  // --------------------------------------------------------------------------

  // The ways buyers phrase one question. A variant is a child of its FAQ and
  // never outlives it, so every read here is scoped by `tenantId` first and the
  // FAQ is checked before a write — a variant pointing at another tenant's FAQ
  // would be a cross-tenant read dressed up as a row.

  listFaqVariants(tenantId: string, faqId: string): ReadonlyArray<FaqQuestionVariant> {
    return this.faqVariants.filter((item) => item.tenantId === tenantId && item.faqId === faqId);
  }

  getFaqVariant(tenantId: string, variantId: string): FaqQuestionVariant | undefined {
    return this.faqVariants.find((item) => item.tenantId === tenantId && item.id === variantId);
  }

  /**
   * Add a near-question to one FAQ.
   *
   * @param input - Tenant, the FAQ it belongs to, and the phrasing.
   * @returns The new variant, or `undefined` when the tenant has no such FAQ.
   */
  createFaqVariant(input: NewFaqQuestionVariant): FaqQuestionVariant | undefined {
    if (this.getFaq(input.tenantId, input.faqId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const variant: FaqQuestionVariant = {
      id: this.nextId('faq_variant'),
      tenantId: input.tenantId,
      faqId: input.faqId,
      questionText: input.questionText,
      source: input.source ?? 'manual',
      status: 'enabled',
      updatedAt: now,
      createdAt: now,
    };
    this.faqVariants.push(variant);
    return variant;
  }

  /**
   * Apply a patch to one near-question.
   *
   * @param input - Tenant, variant id and the fields to change.
   * @returns The updated variant, or `undefined` when the tenant has no such id.
   */
  updateFaqVariant(input: {
    readonly tenantId: string;
    readonly variantId: string;
    readonly patch: FaqQuestionVariantPatch;
    readonly now?: string;
  }): FaqQuestionVariant | undefined {
    const index = this.faqVariants.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.variantId,
    );
    const current = this.faqVariants[index];
    if (current === undefined) {
      return undefined;
    }
    const updated: FaqQuestionVariant = {
      id: current.id,
      tenantId: current.tenantId,
      faqId: current.faqId,
      questionText: input.patch.questionText ?? current.questionText,
      source: current.source,
      status: input.patch.status ?? current.status,
      updatedAt: input.now ?? new Date().toISOString(),
      createdAt: current.createdAt,
    };
    this.faqVariants[index] = updated;
    return updated;
  }

  // --------------------------------------------------------------------------
  // Product import batches
  // --------------------------------------------------------------------------

  // The record of what happened to an uploaded sheet. Errors hang off a batch by
  // the composite `(tenantId, batchId)` key, so a batch id from another tenant
  // cannot be used to read or write their error lines.

  listImportBatches(tenantId: string, storeId?: string): ReadonlyArray<ProductImportBatch> {
    return this.importBatches
      .filter(
        (item) => item.tenantId === tenantId && (storeId === undefined || item.storeId === storeId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getImportBatch(tenantId: string, batchId: string): ProductImportBatch | undefined {
    return this.importBatches.find((item) => item.tenantId === tenantId && item.id === batchId);
  }

  /** Open a batch. It starts at `uploaded` with nothing counted yet. */
  createImportBatch(input: NewProductImportBatch): ProductImportBatch {
    const now = input.now ?? new Date().toISOString();
    const batch: ProductImportBatch = {
      id: this.nextId('import_batch'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      sourceType: input.sourceType,
      fileObjectKey: input.fileObjectKey ?? null,
      fileSha256: input.fileSha256 ?? null,
      status: 'uploaded',
      totalRows: 0,
      successRows: 0,
      failedRows: 0,
      startedAt: null,
      finishedAt: null,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
      createdAt: now,
    };
    this.importBatches.push(batch);
    return batch;
  }

  /**
   * Apply a patch to one batch.
   *
   * @param input - Tenant, batch id and the fields to change.
   * @returns The updated batch, or `undefined` when the tenant has no such id.
   */
  updateImportBatch(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly patch: ProductImportBatchPatch;
    readonly now?: string;
  }): ProductImportBatch | undefined {
    const index = this.importBatches.findIndex(
      (item) => item.tenantId === input.tenantId && item.id === input.batchId,
    );
    const current = this.importBatches[index];
    if (current === undefined) {
      return undefined;
    }
    const updated: ProductImportBatch = {
      ...current,
      status: input.patch.status ?? current.status,
      totalRows: input.patch.totalRows ?? current.totalRows,
      successRows: input.patch.successRows ?? current.successRows,
      failedRows: input.patch.failedRows ?? current.failedRows,
      startedAt: input.patch.startedAt === undefined ? current.startedAt : input.patch.startedAt,
      finishedAt:
        input.patch.finishedAt === undefined ? current.finishedAt : input.patch.finishedAt,
      updatedAt: input.now ?? new Date().toISOString(),
    };
    this.importBatches[index] = updated;
    return updated;
  }

  /**
   * Record failed lines against a batch.
   *
   * @param input - Tenant, batch id and one entry per failed row.
   * @returns The rows written, or `undefined` when the tenant has no such batch.
   */
  appendImportErrors(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId'>>;
    readonly now?: string;
  }): ReadonlyArray<ProductImportError> | undefined {
    if (this.getImportBatch(input.tenantId, input.batchId) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const written = input.errors.map((item) => {
      const error: ProductImportError = {
        id: this.nextId('import_error'),
        tenantId: input.tenantId,
        batchId: input.batchId,
        rowNumber: item.rowNumber,
        fieldName: item.fieldName ?? null,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage ?? null,
        rawValueMasked: item.rawValueMasked ?? null,
        createdAt: item.now ?? now,
      };
      this.importErrors.push(error);
      return error;
    });
    return written;
  }

  listImportErrors(tenantId: string, batchId: string): ReadonlyArray<ProductImportError> {
    return this.importErrors
      .filter((item) => item.tenantId === tenantId && item.batchId === batchId)
      .sort((a, b) => a.rowNumber - b.rowNumber);
  }

  /**
   * Apply one import: write the plan's products and variants, open the batch it
   * belongs to, and record the lines that did not make it — as one step.
   *
   * The three belong together, because a batch whose counts disagree with the
   * rows it wrote is a record that lies about a file, and nobody reading it later
   * can tell. The PostgreSQL adapter buys that with a transaction; this one buys
   * it by doing the writes first and opening the batch only once they are all in,
   * so an import that cannot be carried out leaves no receipt behind.
   *
   * A variant is created against the product its row named, resolved through the
   * plan's own product codes — a create has no id until it is written, which is
   * why the plan names the code and this resolves it.
   *
   * @param input - Scope, the plan, the refused lines and the terminal counts.
   * @returns The batch and the failure rows written for it.
   * @throws {Error} When the plan names a category, product or variant this store
   *   does not have, or a variant whose product was never written. The plan is
   *   computed from this store's own contents, so that is a defect in the caller
   *   rather than a state to absorb — the PostgreSQL path rolls the whole
   *   transaction back for the same reason.
   */
  applyProductImportBatch(input: ApplyProductImportBatchInput): ImportBatchWithErrors {
    const now = input.now ?? new Date().toISOString();
    const spuIdByCode = new Map<string, string>();

    for (const write of input.plan.spuWrites) {
      if (write.action === 'create') {
        const created = this.createSpu({
          tenantId: input.tenantId,
          storeId: input.storeId,
          categoryId: write.values.categoryId,
          externalProductId: write.values.externalProductId,
          productCode: write.values.productCode,
          title: write.values.title,
          subtitle: write.values.subtitle,
          mainImageUrl: write.values.mainImageUrl,
          productUrl: write.values.productUrl,
          sellingPoints: write.values.sellingPoints,
          commonAttributes: write.values.commonAttributes,
          shelfStatus: write.values.shelfStatus,
          sourceType: write.values.sourceType,
          sourceUpdatedAt: write.values.sourceUpdatedAt,
          now,
        });
        if (created === undefined) {
          throw new Error(
            `import plan files ${write.productCode} under category ${String(write.values.categoryId)}, which this store does not have`,
          );
        }
        spuIdByCode.set(write.productCode, created.id);
      } else {
        const updated = this.updateSpu({
          tenantId: input.tenantId,
          spuId: write.spuId,
          patch: write.patch,
          now,
        });
        if (updated === undefined) {
          throw new Error(
            `import plan updates product ${write.spuId} (${write.productCode}), which this store does not have`,
          );
        }
        spuIdByCode.set(write.productCode, updated.id);
      }
    }

    for (const write of input.plan.skuWrites) {
      if (write.action === 'create') {
        const spuId = spuIdByCode.get(write.productCode);
        if (spuId === undefined) {
          throw new Error(
            `import plan creates variant ${write.skuCode} under product ${write.productCode}, which the plan never writes`,
          );
        }
        const created = this.createSku({
          tenantId: input.tenantId,
          storeId: input.storeId,
          spuId,
          skuCode: write.values.skuCode,
          variant: write.values.variant,
          searchAttributes: write.values.searchAttributes,
          status: write.values.status,
          now,
        });
        if (created === undefined) {
          throw new Error(
            `import plan creates variant ${write.skuCode} under product ${spuId}, which this store does not have`,
          );
        }
      } else {
        const updated = this.updateSku({
          tenantId: input.tenantId,
          skuId: write.skuId,
          patch: write.patch,
          now,
        });
        if (updated === undefined) {
          throw new Error(
            `import plan updates variant ${write.skuId} (${write.skuCode}), which this store does not have`,
          );
        }
      }
    }

    // The batch opens in the state it ends in. It has no life of its own here:
    // the reads, the writes and the receipt are one call, so recording
    // `uploaded` → `importing` → done would be a progress story with no time
    // passing between the steps.
    const batch: ProductImportBatch = {
      id: this.nextId('import_batch'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      sourceType: input.sourceType,
      fileObjectKey: null,
      fileSha256: null,
      status: input.status,
      totalRows: input.totalRows,
      successRows: input.successRows,
      failedRows: input.failedRows,
      startedAt: now,
      finishedAt: now,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
      createdAt: now,
    };
    this.importBatches.push(batch);

    const errors = this.appendImportErrors({
      tenantId: input.tenantId,
      batchId: batch.id,
      errors: input.errors,
      now,
    });
    if (errors === undefined) {
      // Unreachable: the batch was pushed immediately above, and a missing batch
      // is the only thing that returns `undefined`.
      throw new Error(`import batch ${batch.id} vanished before its failures were recorded`);
    }
    return { batch, errors };
  }

  // --------------------------------------------------------------------------
  // Conversations and messages
  // --------------------------------------------------------------------------

  listConversations(
    tenantId: string,
    storeId?: string,
    visibleToMemberId?: string,
  ): ReadonlyArray<Conversation> {
    return this.conversations
      .filter(
        (conversation) =>
          conversation.tenantId === tenantId &&
          (storeId === undefined || conversation.storeId === storeId) &&
          // 队列与详情读的是同一条规则：筛在别处就等于给出一个点开就 403 的行。
          (visibleToMemberId === undefined ||
            conversationReadAccess({
              conversation,
              readerMemberId: visibleToMemberId,
              readerIsAdmin: false,
              handedOffAt: this.lastHandoverFrom(tenantId, conversation.id, visibleToMemberId),
            }) !== undefined),
      )
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
  }

  getConversation(tenantId: string, conversationId: string): Conversation | undefined {
    return this.conversations.find(
      (conversation) => conversation.tenantId === tenantId && conversation.id === conversationId,
    );
  }

  getConversationByExternal(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly channel: string;
    readonly externalConversationId: string;
  }): Conversation | undefined {
    return this.conversations.find(
      (conversation) =>
        conversation.tenantId === input.tenantId &&
        conversation.storeId === input.storeId &&
        conversation.channel === input.channel &&
        conversation.externalConversationId === input.externalConversationId,
    );
  }

  listMessages(tenantId: string, conversationId?: string): ReadonlyArray<Message> {
    return this.messages
      .filter(
        (message) =>
          message.tenantId === tenantId &&
          (conversationId === undefined || message.conversationId === conversationId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  getMessage(tenantId: string, messageId: string): Message | undefined {
    return this.messages.find(
      (message) => message.tenantId === tenantId && message.id === messageId,
    );
  }

  private getConversationRequired(
    tenantId: string,
    conversationId: string,
  ): StoreConversationResult {
    const conversation = this.getConversation(tenantId, conversationId);
    if (conversation === undefined) {
      return { ok: false, code: 'not_found', reason: 'conversation not found in tenant scope' };
    }
    return { ok: true, conversation };
  }

  private replaceConversation(next: Conversation): void {
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === next.id ? next : conversation,
    );
  }

  private applyTransitionResult(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly actorMemberId: string;
    readonly transition: (conversation: Conversation) => ConversationTransition;
    readonly auditAction: string;
    readonly action: AssignmentAction;
    readonly toMemberId: string | null;
    readonly now: string;
  }): StoreConversationResult {
    const { tenantId, conversationId, actorMemberId, now } = input;
    const current = this.getConversationRequired(tenantId, conversationId);
    if (!current.ok) {
      // Deliberately no history row: the conversation does not exist, so there
      // is nothing for a history row to belong to (and its foreign key would
      // refuse one). A missing conversation is answered by the 404, not the
      // ledger.
      return current;
    }
    const before = current.conversation;
    const result = input.transition(before);
    if (!result.ok) {
      // A refusal is recorded as deliberately as a success. Without this row the
      // assignee column could only ever answer "who is handling this now", never
      // "who lost the race for it" — which is half of what the history is for.
      this.recordAssignment({
        tenantId,
        storeId: before.storeId,
        conversationId,
        action: input.action,
        result: 'rejected',
        reasonCode: rejectionReasonCode(result.code),
        fromMemberId: before.assignedMemberId,
        toMemberId: input.toMemberId,
        stateVersionBefore: before.version,
        stateVersionAfter: null,
        now,
      });
      return { ok: false, code: result.code, reason: result.reason };
    }
    this.replaceConversation(result.conversation);
    this.recordAssignment({
      tenantId,
      storeId: before.storeId,
      conversationId,
      action: input.action,
      result: 'success',
      reasonCode: null,
      fromMemberId: before.assignedMemberId,
      toMemberId: result.conversation.assignedMemberId,
      stateVersionBefore: before.version,
      stateVersionAfter: result.conversation.version,
      now,
    });
    this.appendAudit({
      tenantId,
      actorMemberId,
      action: input.auditAction,
      targetType: 'conversation',
      targetId: conversationId,
      createdAt: now,
    });
    return { ok: true, conversation: result.conversation };
  }

  claim(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    expectedVersion: number,
    now: string,
  ): StoreConversationResult {
    return this.applyTransitionResult({
      tenantId,
      conversationId,
      actorMemberId,
      transition: (conversation) =>
        claimConversation(conversation, expectedVersion, actorMemberId, now),
      auditAction: AUDIT_ACTIONS.conversationClaimed,
      action: 'claim',
      toMemberId: actorMemberId,
      now,
    });
  }

  returnToPool(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    expectedVersion: number,
    now: string,
  ): StoreConversationResult {
    return this.applyTransitionResult({
      tenantId,
      conversationId,
      actorMemberId,
      transition: (conversation) =>
        returnConversation(conversation, expectedVersion, actorMemberId, authority, now),
      auditAction: AUDIT_ACTIONS.conversationReturned,
      action: 'return',
      toMemberId: null,
      now,
    });
  }

  transfer(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    authority: TakeoverAuthority,
    toMemberId: string,
    expectedVersion: number,
    now: string,
  ): StoreConversationResult {
    return this.applyTransitionResult({
      tenantId,
      conversationId,
      actorMemberId,
      transition: (conversation) =>
        transferConversation(
          conversation,
          expectedVersion,
          actorMemberId,
          authority,
          toMemberId,
          now,
        ),
      auditAction: AUDIT_ACTIONS.conversationTransferred,
      action: 'transfer',
      toMemberId,
      now,
    });
  }

  close(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    actorIsAdmin: boolean,
    expectedVersion: number,
    now: string,
  ): StoreConversationResult {
    return this.applyTransitionResult({
      tenantId,
      conversationId,
      actorMemberId,
      transition: (conversation) =>
        closeConversation(conversation, expectedVersion, actorMemberId, actorIsAdmin, now),
      auditAction: AUDIT_ACTIONS.conversationClosed,
      action: 'release',
      toMemberId: null,
      now,
    });
  }

  /** Send an outbound message with idempotency by dedup key. */
  sendOutbound(input: OutboundMessageInput): IngestResult {
    const now = input.now ?? new Date().toISOString();
    const existing = this.findByDedupKey(input.tenantId, input.dedupKey);
    if (existing !== undefined) {
      const conversation = this.getConversation(input.tenantId, existing.conversationId);
      if (conversation === undefined) {
        throw new Error('store invariant: message references a missing conversation');
      }
      return { conversation, message: existing, created: false, reopened: false };
    }

    const current = this.getConversationRequired(input.tenantId, input.conversationId);
    if (!current.ok) {
      throw new Error(`cannot send outbound: ${current.reason}`);
    }
    if (current.conversation.status === 'closed') {
      throw new Error('cannot send outbound to a closed conversation');
    }

    const reviewEligible = isReviewEligibleSource(input.source);
    const message: Message = {
      id: this.nextId('message'),
      tenantId: current.conversation.tenantId,
      storeId: current.conversation.storeId,
      conversationId: input.conversationId,
      channel: 'internal',
      direction: 'outbound',
      source: input.source,
      messageType: 'text',
      content: input.content,
      dedupKey: input.dedupKey ?? null,
      reviewEligible,
      reviewState: reviewEligible ? 'pending' : 'none',
      candidateId: input.candidateId ?? null,
      // Nothing the platform sends through the composer carries stored media
      // yet: an outbound image would be uploaded to the provider, not kept.
      media: null,
      createdAt: now,
    };
    this.messages.push(message);
    const afterSend = { ...current.conversation, lastMessageAt: now };
    this.replaceConversation(
      // Only a human-equivalent send stops the first-reply clock, so the offline
      // auto-reply does not make a customer's wait for a person look answered.
      // The else branch freezes by hand because every stored conversation is
      // frozen and `changed` is private to the rules module.
      countsAsFirstReply(input.source)
        ? recordFirstReply(afterSend, now)
        : Object.freeze(afterSend),
    );
    this.appendAudit({
      tenantId: input.tenantId,
      actorMemberId: null,
      action: AUDIT_ACTIONS.outboundMessageSent,
      targetType: 'message',
      targetId: message.id,
      createdAt: now,
    });
    const conversation = this.getConversation(input.tenantId, input.conversationId);
    if (conversation === undefined) {
      throw new Error('store invariant: conversation disappeared after send');
    }
    return { conversation, message, created: true, reopened: false };
  }

  /** Ingest an inbound message; closed conversations reopen. Idempotent by dedup key. */
  ingestInbound(input: InboundMessageInput): IngestResult {
    const now = input.now ?? new Date().toISOString();
    const existing = this.findByDedupKey(input.tenantId, input.dedupKey);
    if (existing !== undefined) {
      const conversation = this.getConversation(input.tenantId, existing.conversationId);
      if (conversation === undefined) {
        throw new Error('store invariant: message references a missing conversation');
      }
      return { conversation, message: existing, created: false, reopened: false };
    }

    const matched = this.getConversationByExternal({
      tenantId: input.tenantId,
      storeId: input.storeId,
      channel: input.channel,
      externalConversationId: input.externalConversationId,
    });

    let conversation: Conversation;
    let reopened = false;
    if (matched === undefined) {
      conversation = openConversationForInbound({
        id: this.nextId('conversation'),
        tenantId: input.tenantId,
        storeId: input.storeId,
        channel: input.channel,
        externalCustomerId: input.externalCustomerId,
        externalConversationId: input.externalConversationId,
        now,
      });
      this.conversations.push(conversation);
    } else {
      const touched = touchConversationForInbound(matched, now);
      if (!touched.ok) {
        throw new Error(`store invariant: inbound touch failed: ${touched.reason}`);
      }
      conversation = touched.conversation;
      reopened = conversation.status === 'open' && matched.status === 'closed';
      this.replaceConversation(conversation);
    }

    const message: Message = {
      id: this.nextId('message'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      conversationId: conversation.id,
      channel: input.channel,
      direction: 'inbound',
      source: null,
      messageType: input.messageType ?? 'text',
      content: input.content,
      dedupKey: input.dedupKey ?? null,
      reviewEligible: false,
      reviewState: 'none',
      candidateId: null,
      // A message is persisted before its media is fetched, so this is the
      // state every image message starts in — and the state it keeps when the
      // fetch or the store refuses.
      media: null,
      createdAt: now,
    };
    this.messages.push(message);
    this.appendAudit({
      tenantId: input.tenantId,
      actorMemberId: null,
      action: AUDIT_ACTIONS.inboundMessageIngested,
      targetType: 'message',
      targetId: message.id,
      createdAt: now,
    });
    return { conversation, message, created: true, reopened };
  }

  /**
   * Record the stored media of one message.
   *
   * The tenant is part of the lookup rather than a caller's claim to be trusted,
   * so a message id from another tenant matches nothing and changes nothing —
   * the same boundary every other tenant-owned write in this store draws.
   *
   * Idempotent by construction: the key is derived from the message id, so
   * attaching twice writes the same reference rather than a second one, which is
   * what makes a re-ingested callback safe to fetch media for.
   *
   * @param input - Tenant, message and the reference to record.
   * @returns `true` when a message was updated, `false` when none matched.
   */
  attachMessageMedia(input: AttachMessageMediaInput): boolean {
    const index = this.messages.findIndex(
      (message) => message.id === input.messageId && message.tenantId === input.tenantId,
    );
    const existing = this.messages[index];
    if (existing === undefined) {
      return false;
    }
    this.messages[index] = {
      ...existing,
      media: { key: input.key, mimeType: input.mimeType, bytes: input.bytes },
    };
    return true;
  }

  // --------------------------------------------------------------------------
  // Assignment (agent seats, dispatch, assignment history)
  // --------------------------------------------------------------------------

  listAgentPresence(tenantId: string, memberId: string): AgentPresence | undefined {
    return this.presence.find(
      (presence) => presence.tenantId === tenantId && presence.memberId === memberId,
    );
  }

  /**
   * Every presence row a tenant holds.
   *
   * Tenant-wide and deliberately unfiltered by role: `agent_presence` only ever
   * holds seats that reported in, so an administrator cannot appear here. The
   * other tenant-wide read, `listAssignmentCandidates`, joins members and filters
   * to `agent`; this one answers "what did each seat last report", which is a
   * question about presence alone.
   *
   * A member with no row is **absent from the result, not present as `offline`**:
   * the platform stores nothing for a seat that is offline. A caller drawing a
   * roster must therefore treat a missing row as 离线 itself rather than reading
   * this as the complete set of seats.
   *
   * @param tenantId - The tenant whose seats to list.
   * @returns One row per seat that has reported in, in insertion order.
   */
  listTenantAgentPresence(tenantId: string): ReadonlyArray<AgentPresence> {
    return this.presence.filter((presence) => presence.tenantId === tenantId);
  }

  setAgentPresence(input: {
    readonly tenantId: string;
    readonly memberId: string;
    readonly storeId: string;
    readonly status: AgentAvailabilityStatus;
    readonly now: string;
  }): AgentPresence {
    const existing = this.listAgentPresence(input.tenantId, input.memberId);
    if (existing === undefined) {
      const created: AgentPresence = {
        tenantId: input.tenantId,
        memberId: input.memberId,
        storeId: input.storeId,
        status: input.status,
        heartbeatAt: input.now,
        changedAt: input.now,
        createdAt: input.now,
      };
      this.presence.push(created);
      return created;
    }
    const next: AgentPresence = {
      ...existing,
      storeId: input.storeId,
      status: input.status,
      heartbeatAt: input.now,
      // A repeat of the same status is not a change, so it must not move
      // `changedAt`: "how long has this seat been away" would otherwise reset
      // every time the client re-sent its current status.
      changedAt: existing.status === input.status ? existing.changedAt : input.now,
    };
    this.replacePresence(next);
    return next;
  }

  /**
   * Refresh a seat's liveness.
   *
   * `undefined` when the seat has no row: a heartbeat is not a way to come
   * online, so it must not invent a status the agent never set.
   */
  heartbeatAgentPresence(
    tenantId: string,
    memberId: string,
    now: string,
  ): AgentPresence | undefined {
    const existing = this.listAgentPresence(tenantId, memberId);
    if (existing === undefined) {
      return undefined;
    }
    const next: AgentPresence = { ...existing, heartbeatAt: now };
    this.replacePresence(next);
    return next;
  }

  /**
   * Every agent seat, with its presence and its load.
   *
   * Unfiltered by eligibility on purpose: the eligibility rule lives in
   * `./assignment`, and a store that pre-filtered would be a second, silently
   * divergent copy of it. `status` is the row's own value — a seat with no row
   * reports `offline` — and the liveness *window* is applied by
   * {@link assignmentEligibility}, not here, so the window exists in one place.
   *
   * A store id narrows the list to one store; `undefined` reads every seat of
   * the tenant.
   */
  listAssignmentCandidates(
    tenantId: string,
    storeId: string | undefined,
  ): ReadonlyArray<AssignmentCandidate> {
    return this.members
      .filter(
        (member) =>
          member.tenantId === tenantId &&
          (storeId === undefined || member.storeId === storeId) &&
          member.role === 'agent',
      )
      .map((member) => {
        const presence = this.listAgentPresence(tenantId, member.id);
        return {
          memberId: member.id,
          tenantId,
          storeId: member.storeId,
          role: member.role,
          enabled: member.enabled,
          status: presence?.status ?? 'offline',
          heartbeatAt: presence?.heartbeatAt ?? null,
          inProgressCount: this.conversations.filter(
            (conversation) =>
              conversation.tenantId === tenantId &&
              conversation.status === 'claimed' &&
              conversation.assignedMemberId === member.id,
          ).length,
        } satisfies AssignmentCandidate;
      });
  }

  listAssignments(tenantId: string, conversationId: string): ReadonlyArray<ConversationAssignment> {
    return this.assignments
      .filter(
        (assignment) =>
          assignment.tenantId === tenantId && assignment.conversationId === conversationId,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /**
   * When this member last handed the conversation away, if it ever did.
   *
   * A hand-over is a recorded row that moved the conversation *off* the member
   * and succeeded; a refused attempt moved nothing and must not be read as one.
   * The latest such row is the instant the member's transcript stops.
   */
  lastHandoverFrom(
    tenantId: string,
    conversationId: string,
    memberId: string,
  ): string | undefined {
    const handovers = this.assignments
      .filter(
        (assignment) =>
          assignment.tenantId === tenantId &&
          assignment.conversationId === conversationId &&
          assignment.fromMemberId === memberId &&
          assignment.result === 'success',
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return handovers[0]?.createdAt;
  }

  /**
   * Assign every due pooled conversation this sweep can.
   *
   * The decisions all come from {@link planAutoAssign}, so this method only
   * executes a verdict — the in-memory store and the PostgreSQL adapter cannot
   * disagree about who should receive a conversation.
   *
   * `now` is a parameter rather than read from the clock so a caller can sweep a
   * deterministic instant, which is what makes the behaviour testable without
   * waiting.
   */
  dispatchDue(input: {
    readonly now: string;
    readonly limit: number;
  }): ReadonlyArray<DispatchOutcome> {
    const due: Array<{ conversation: Conversation; dueAt: string }> = [];
    for (const conversation of this.conversations) {
      const dueAt = conversation.nextAssignmentAt;
      if (dueAt === null || !isAssignmentDue(conversation) || dueAt > input.now) {
        continue;
      }
      due.push({ conversation, dueAt });
    }
    // Oldest wait first, id breaking ties, so two sweeps see the same order.
    due.sort((a, b) =>
      a.dueAt < b.dueAt
        ? -1
        : a.dueAt > b.dueAt
          ? 1
          : a.conversation.id < b.conversation.id
            ? -1
            : 1,
    );

    const outcomes: DispatchOutcome[] = [];
    for (const { conversation } of due.slice(0, input.limit)) {
      const candidates = this.listAssignmentCandidates(conversation.tenantId, conversation.storeId);
      const plan = planAutoAssign({ conversation, candidates, now: input.now });
      outcomes.push(this.executePlan(conversation, plan, input.now));
    }
    return outcomes;
  }

  /** Apply one {@link AutoAssignPlan} verdict and report what it did. */
  private executePlan(
    conversation: Conversation,
    plan: ReturnType<typeof planAutoAssign>,
    now: string,
  ): DispatchOutcome {
    const { tenantId, storeId, id: conversationId } = conversation;
    switch (plan.kind) {
      case 'skip':
        // `dispatchDue` only offers due conversations, so this cannot happen.
        return { kind: 'lost', conversationId };

      case 'assign': {
        // The same compare-and-swap a human claim uses; only the history row's
        // `action` differs. With no concurrency in this store the transition
        // cannot fail, but it is still the code path that decides, so a rule
        // change lands in exactly one place.
        const transition = claimConversation(
          conversation,
          conversation.version,
          plan.toMemberId,
          now,
        );
        if (!transition.ok) {
          return { kind: 'lost', conversationId };
        }
        this.replaceConversation(transition.conversation);
        this.recordAssignment({
          tenantId,
          storeId,
          conversationId,
          action: 'auto_assign',
          result: 'success',
          reasonCode: null,
          fromMemberId: conversation.assignedMemberId,
          toMemberId: plan.toMemberId,
          stateVersionBefore: conversation.version,
          stateVersionAfter: transition.conversation.version,
          now,
        });
        this.appendAudit({
          tenantId,
          actorMemberId: null,
          action: AUDIT_ACTIONS.conversationAssigned,
          targetType: 'conversation',
          targetId: conversationId,
          metadata: { toMemberId: plan.toMemberId },
          createdAt: now,
        });
        return { kind: 'assigned', tenantId, storeId, conversationId, toMemberId: plan.toMemberId };
      }

      case 'fallback': {
        // Nobody can take it and the customer has not been told. Record the
        // acknowledgement and leave the conversation exactly where it is: still
        // in the pool, still due, so the next sweep tries again. `version` is
        // deliberately *not* bumped — nothing a client can echo back changed, and
        // bumping it would make a concurrent sweep's compare-and-swap fail
        // spuriously.
        this.replaceConversation({
          ...conversation,
          offlineReplyAt: now,
          dispatchAttempts: conversation.dispatchAttempts + 1,
        });
        this.recordAssignment({
          tenantId,
          storeId,
          conversationId,
          action: 'release',
          result: 'expired',
          reasonCode: 'no_eligible_agent',
          fromMemberId: conversation.assignedMemberId,
          toMemberId: null,
          stateVersionBefore: conversation.version,
          stateVersionAfter: null,
          now,
        });
        this.appendAudit({
          tenantId,
          actorMemberId: null,
          action: AUDIT_ACTIONS.conversationOfflineReplied,
          targetType: 'conversation',
          targetId: conversationId,
          metadata: { reasonCode: 'no_eligible_agent' },
          createdAt: now,
        });
        return {
          kind: 'fallback',
          tenantId,
          storeId,
          conversationId,
          reasonCode: 'no_eligible_agent',
        };
      }

      case 'wait':
        // Already acknowledged, still nobody available. Writes nothing at all:
        // a conversation parked in the pool must not cost a row rewrite every
        // sweep for as long as it waits.
        return { kind: 'waiting', conversationId };
    }
  }

  private replacePresence(next: AgentPresence): void {
    this.presence = this.presence.map((presence) =>
      presence.tenantId === next.tenantId && presence.memberId === next.memberId ? next : presence,
    );
  }

  private recordAssignment(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly conversationId: string;
    readonly action: AssignmentAction;
    readonly result: ConversationAssignment['result'];
    readonly reasonCode: AssignmentReasonCode | null;
    readonly fromMemberId: string | null;
    readonly toMemberId: string | null;
    readonly stateVersionBefore: number;
    readonly stateVersionAfter: number | null;
    readonly now: string;
  }): ConversationAssignment {
    const assignment: ConversationAssignment = {
      id: this.nextId('assignment'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      conversationId: input.conversationId,
      action: input.action,
      result: input.result,
      reasonCode: input.reasonCode,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      stateVersionBefore: input.stateVersionBefore,
      stateVersionAfter: input.stateVersionAfter,
      createdAt: input.now,
    };
    this.assignments.push(assignment);
    return assignment;
  }

  private findByDedupKey(
    tenantId: string,
    dedupKey: string | null | undefined,
  ): Message | undefined {
    if (dedupKey === null || dedupKey === undefined || dedupKey.length === 0) {
      return undefined;
    }
    return this.messages.find(
      (message) => message.tenantId === tenantId && message.dedupKey === dedupKey,
    );
  }

  // --------------------------------------------------------------------------
  // Review
  // --------------------------------------------------------------------------

  getReviewPolicy(): ReviewPolicy {
    return this.reviewPolicy;
  }

  /** Apply a review policy update. Authorization is enforced by the service. */
  setReviewPolicy(policy: ReviewPolicy): ReviewPolicy {
    this.reviewPolicy = policy;
    return this.reviewPolicy;
  }

  listReviewQueue(tenantId: string, storeId?: string): ReadonlyArray<Message> {
    return this.messages.filter(
      (message) =>
        message.tenantId === tenantId &&
        message.reviewEligible &&
        message.reviewState === 'pending' &&
        (storeId === undefined || message.storeId === storeId),
    );
  }

  approveMessage(
    tenantId: string,
    messageId: string,
    approvedBy: string,
    now: string,
  ): ApprovalResult {
    const message = this.getMessage(tenantId, messageId);
    if (message === undefined) {
      return { ok: false, code: 'not_found', reason: 'message not found in tenant scope' };
    }
    if (!message.reviewEligible) {
      return {
        ok: false,
        code: 'not_eligible',
        reason: 'message source is not eligible for review',
      };
    }
    if (message.reviewState === 'approved' || message.reviewState === 'rejected') {
      return {
        ok: false,
        code: 'already_reviewed',
        reason: `message is already ${message.reviewState}`,
      };
    }
    const approved: Message = { ...message, reviewState: 'approved' };
    this.messages = this.messages.map((item) => (item.id === message.id ? approved : item));
    const phrase: ApprovedPhrase = {
      id: this.nextId('phrase'),
      tenantId,
      storeId: message.storeId,
      phrase: message.content,
      sourceMessageId: message.id,
      approvedBy,
      createdAt: now,
    };
    this.approvedPhrases.push(phrase);
    this.appendAudit({
      tenantId,
      actorMemberId: approvedBy,
      action: AUDIT_ACTIONS.messageApproved,
      targetType: 'message',
      targetId: message.id,
      metadata: { phraseId: phrase.id },
      createdAt: now,
    });
    return { ok: true, message: approved, phrase };
  }

  listApprovedPhrases(tenantId: string): ReadonlyArray<ApprovedPhrase> {
    return this.approvedPhrases
      .filter((phrase) => phrase.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // --------------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------------

  saveSuggestionSet(set: SuggestionSet): SuggestionSet {
    this.suggestionSets.push(set);
    return set;
  }

  getSuggestionSet(tenantId: string, suggestionId: string): SuggestionSet | undefined {
    return this.suggestionSets.find((set) => set.tenantId === tenantId && set.id === suggestionId);
  }

  /** Every suggestion set of a tenant, newest first. */
  listSuggestionSets(tenantId: string): ReadonlyArray<SuggestionSet> {
    return this.suggestionSets
      .filter((set) => set.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Persist a generated suggestion set with a store-generated id and audit entry. */
  createSuggestionSet(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly conversationId: string;
    readonly provider: SuggestionProvider;
    // Named through the set's own fields rather than by a second import of the
    // same two unions: this input has to stay exactly what a set carries, and the
    // in-memory store is the adapter most likely to drift from it unnoticed.
    readonly intent: SuggestionSet['intent'];
    readonly origin: SuggestionSet['origin'];
    readonly candidates: ReadonlyArray<SuggestionCandidate>;
    readonly fallbackReasons: ReadonlyArray<string>;
    readonly now?: string;
  }): SuggestionSet {
    const now = input.now ?? new Date().toISOString();
    const set: SuggestionSet = {
      id: this.nextId('suggestion'),
      tenantId: input.tenantId,
      storeId: input.storeId,
      conversationId: input.conversationId,
      provider: input.provider,
      intent: input.intent,
      origin: input.origin,
      candidates: Object.freeze([...input.candidates]),
      fallbackReasons: Object.freeze([...input.fallbackReasons]),
      createdAt: now,
    };
    this.suggestionSets.push(set);
    this.appendAudit({
      tenantId: input.tenantId,
      actorMemberId: null,
      action: AUDIT_ACTIONS.suggestionGenerated,
      targetType: 'suggestion',
      targetId: set.id,
      metadata: { conversationId: input.conversationId, candidateCount: set.candidates.length },
      createdAt: now,
    });
    return set;
  }

  // --------------------------------------------------------------------------
  // Audit and retention
  // --------------------------------------------------------------------------

  appendAudit(input: {
    readonly tenantId: string | null;
    readonly actorMemberId: string | null;
    readonly action: string;
    readonly targetType: string;
    readonly targetId?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt?: string;
  }): AuditEntry {
    const entry = createAuditEntry({
      id: this.nextId('audit'),
      ...input,
    });
    this.auditEntries.push(entry);
    return entry;
  }

  listAudit(tenantId: string): ReadonlyArray<AuditEntry> {
    return this.auditEntries
      .filter((entry) => entry.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  summarizeRetention(tenantId: string, now: string): RetentionSummary {
    const policies = tenantRetentionPolicies(tenantId);
    const count = (
      entity: keyof typeof DEFAULT_RETENTION_DAYS,
      items: ReadonlyArray<{ id: string; lastActivityAt: string }>,
    ): number => {
      let total = 0;
      for (const item of items) {
        const outcome = evaluateRetention({
          kind: entity,
          id: item.id,
          tenantId,
          lastActivityAt: item.lastActivityAt,
          entity,
          now,
        });
        if (outcome !== null) {
          total += 1;
        }
      }
      return total;
    };

    const expiredCountByEntity: Record<string, number> = {};
    expiredCountByEntity['message'] = count(
      'message',
      this.messages
        .filter((m) => m.tenantId === tenantId)
        .map((m) => ({ id: m.id, lastActivityAt: m.createdAt })),
    );
    expiredCountByEntity['conversation'] = count(
      'conversation',
      this.conversations
        .filter((c) => c.tenantId === tenantId && c.status === 'closed')
        .map((c) => ({ id: c.id, lastActivityAt: c.closedAt ?? c.lastMessageAt })),
    );
    expiredCountByEntity['audit_log'] = count(
      'audit_log',
      this.auditEntries
        .filter((a) => a.tenantId === tenantId)
        .map((a) => ({ id: a.id, lastActivityAt: a.createdAt })),
    );
    expiredCountByEntity['approved_phrase'] = count(
      'approved_phrase',
      this.approvedPhrases
        .filter((p) => p.tenantId === tenantId)
        .map((p) => ({ id: p.id, lastActivityAt: p.createdAt })),
    );

    const totalExpired = Object.values(expiredCountByEntity).reduce((sum, value) => sum + value, 0);
    return Object.freeze({
      tenantId,
      evaluatedAt: now,
      policies: Object.freeze(policies),
      expiredCountByEntity: Object.freeze(expiredCountByEntity),
      totalExpired,
    });
  }

  // --------------------------------------------------------------------------
  // Identifier generation
  // --------------------------------------------------------------------------

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  // --------------------------------------------------------------------------
  // Seed
  // --------------------------------------------------------------------------

  private seed(): void {
    const t0 = '2026-08-01T00:00:00.000Z';
    const t1 = '2026-09-01T02:00:00.000Z';
    const t2 = '2026-09-02T08:30:00.000Z';
    const t3 = '2026-09-05T11:00:00.000Z';
    const t4 = '2026-09-08T09:00:00.000Z';

    this.tenants = [
      { id: T1, code: 'acme', name: '云集服饰', enabled: true, createdAt: t0 },
      { id: T2, code: 'beta', name: '蓝图数码', enabled: true, createdAt: t0 },
    ];

    this.stores = [
      {
        id: S1,
        tenantId: T1,
        code: 'flagship',
        name: '云集服饰旗舰店',
        enabled: true,
        createdAt: t0,
      },
      {
        id: S2,
        tenantId: T1,
        code: 'distribution',
        name: '云集服饰分销店',
        enabled: true,
        createdAt: t0,
      },
      {
        id: S3,
        tenantId: T2,
        code: 'official',
        name: '蓝图数码官方店',
        enabled: true,
        createdAt: t0,
      },
    ];

    this.members = [
      {
        id: PLATFORM_ADMIN_MEMBER_ID,
        tenantId: null,
        storeId: null,
        role: 'platform_admin',
        username: 'root',
        displayName: '平台超级管理员',
        enabled: true,
        createdAt: t0,
      },
      {
        id: 'u-t1-admin',
        tenantId: T1,
        storeId: null,
        role: 'merchant_admin',
        username: 'acme-owner',
        displayName: '云集管理员',
        enabled: true,
        createdAt: t0,
      },
      {
        id: 'u-t1-agent-1',
        tenantId: T1,
        storeId: S1,
        role: 'agent',
        username: 'agent-01',
        displayName: '客服小云',
        enabled: true,
        createdAt: t0,
      },
      {
        id: 'u-t1-agent-2',
        tenantId: T1,
        storeId: S1,
        role: 'agent',
        username: 'agent-02',
        displayName: '客服小蓝',
        enabled: true,
        createdAt: t0,
      },
      {
        id: 'u-t2-admin',
        tenantId: T2,
        storeId: null,
        role: 'merchant_admin',
        username: 'beta-owner',
        displayName: '蓝图管理员',
        enabled: true,
        createdAt: t0,
      },
      {
        id: 'u-t2-agent-1',
        tenantId: T2,
        storeId: S3,
        role: 'agent',
        username: 'beta-agent',
        displayName: '数码顾问',
        enabled: true,
        createdAt: t0,
      },
    ];

    this.products = [
      {
        id: 'product-acme-black-xl',
        tenantId: T1,
        storeId: S1,
        sku: 'K-001',
        title: '黑色 XL 加绒卫衣',
        description: '加绒黑色连帽卫衣，XL 码现货充足。',
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'product-acme-white-m',
        tenantId: T1,
        storeId: S1,
        sku: 'K-002',
        title: '白色 M 基础卫衣',
        description: '白色圆领基础卫衣，M 码。',
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'product-beta-keyboard',
        tenantId: T2,
        storeId: S3,
        sku: 'KB-87',
        title: '87 键机械键盘',
        description: '87 键热插拔机械键盘，茶轴。',
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
    ];

    this.faqs = [
      {
        id: 'faq-acme-shrink',
        tenantId: T1,
        storeId: S1,
        question: '这款卫衣会缩水吗？',
        answer: '纯棉面料建议冷水轻柔洗涤并平铺晾干，正常穿着不易缩水。',
        tags: ['洗涤', '面料'],
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'faq-acme-return',
        tenantId: T1,
        storeId: S1,
        question: '支持七天无理由退货吗？',
        answer: '签收后七天内支持无理由退货，商品需保持吊牌完整且不影响二次销售。',
        tags: ['退货', '售后'],
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'faq-beta-shipping',
        tenantId: T2,
        storeId: S3,
        question: '键盘发货时效是多久？',
        answer: '现货商品 48 小时内发货，顺丰包邮。',
        tags: ['发货'],
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
    ];

    this.shortcuts = [
      {
        id: 'shortcut-acme-greeting',
        tenantId: T1,
        scopeType: 'store',
        storeId: S1,
        code: 'greeting',
        title: '开场白',
        content: '您好，欢迎光临云集服饰旗舰店，很高兴为您服务。',
        intentCode: null,
        sortOrder: 0,
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'shortcut-acme-closing',
        tenantId: T1,
        scopeType: 'store',
        storeId: S1,
        code: 'closing',
        title: '结束语',
        content: '感谢您的咨询，祝您生活愉快。',
        intentCode: null,
        sortOrder: 0,
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
      {
        id: 'shortcut-beta-closing',
        tenantId: T2,
        scopeType: 'store',
        storeId: S3,
        code: 'closing',
        title: '结束语',
        content: '感谢您的支持，如需帮助请随时联系我们。',
        intentCode: null,
        sortOrder: 0,
        enabled: true,
        updatedAt: t2,
        createdAt: t1,
      },
    ];

    const conversation = (
      id: string,
      storeId: string,
      customer: string,
      externalConversationId: string | null,
      title: string | null,
      status: 'open' | 'claimed' | 'closed',
      version: number,
      assignedMemberId: string | null,
      openedAt: string,
      lastMessageAt: string,
      closedAt: string | null,
    ): Conversation => ({
      id,
      tenantId: T1,
      storeId,
      channel: 'manual',
      externalCustomerId: customer,
      externalConversationId,
      title,
      status,
      version,
      assignedMemberId,
      openedAt,
      lastMessageAt,
      closedAt,
      createdAt: openedAt,
      // Derived from `status` so a seeded conversation satisfies the same pool
      // invariant the transitions maintain: pooled means due, assigned and
      // closed mean not due. Spelling these out per row would let a seed drift
      // from the rule the sweep relies on.
      pendingSince: status === 'closed' ? null : openedAt,
      firstResponseStartedAt: openedAt,
      nextAssignmentAt: status === 'open' ? lastMessageAt : null,
      dispatchAttempts: 0,
      assignedAt: status === 'claimed' ? openedAt : null,
      offlineReplyAt: null,
      // The seed does not model the reply clock, so it reports "no reply
      // recorded" rather than inventing a timestamp the messages may not
      // support. Nothing reads this yet; it becomes a seed concern only if a
      // metric test needs a seeded reply.
      firstReplyAt: null,
    });

    this.conversations = [
      conversation(
        'conversation-acme-1',
        S1,
        'customer-1001',
        'wecom-ext-1001',
        '黑色 XL 卫衣咨询',
        'claimed',
        4,
        'u-t1-agent-1',
        t1,
        t4,
        null,
      ),
      conversation(
        'conversation-acme-2',
        S1,
        'customer-1002',
        'wecom-ext-1002',
        '退货流程咨询',
        'open',
        2,
        null,
        t2,
        t3,
        null,
      ),
      conversation(
        'conversation-acme-3',
        S1,
        'customer-1003',
        'wecom-ext-1003',
        '已结束会话',
        'closed',
        3,
        null,
        t1,
        t3,
        t3,
      ),
    ];

    const message = (
      id: string,
      conversationId: string,
      direction: 'inbound' | 'outbound',
      source: MessageSource | null,
      content: string,
      createdAt: string,
      reviewState: 'none' | 'pending' | 'approved' | 'rejected' = 'none',
      candidateId: string | null = null,
    ): Message => {
      const reviewEligible = reviewState !== 'none';
      return {
        id,
        tenantId: T1,
        storeId: S1,
        conversationId,
        channel: 'manual',
        direction,
        source,
        messageType: 'text',
        content,
        dedupKey: null,
        reviewEligible,
        reviewState,
        candidateId,
        media: null,
        createdAt,
      };
    };

    this.messages = [
      message(
        'message-acme-1-1',
        'conversation-acme-1',
        'inbound',
        null,
        '你好，请问黑色 XL 卫衣有货吗？',
        t1,
      ),
      message(
        'message-acme-1-2',
        'conversation-acme-1',
        'outbound',
        'manual_typed',
        '您好，有的，黑色 XL 现货充足。',
        t2,
      ),
      message(
        'message-acme-1-3',
        'conversation-acme-1',
        'outbound',
        'direct_candidate',
        '黑色 XL 加绒卫衣现货充足，今天下单明天即可发出。',
        t3,
        'pending',
        'candidate-seed-1',
      ),
      message(
        'message-acme-1-4',
        'conversation-acme-1',
        'outbound',
        'edited_send',
        '白色 M 基础卫衣同样有货，需要帮您保留吗？',
        t4,
        'pending',
        'candidate-seed-2',
      ),
      message(
        'message-acme-1-0',
        'conversation-acme-1',
        'outbound',
        'direct_candidate',
        '感谢您的耐心等待。',
        t4,
        'approved',
        'candidate-seed-0',
      ),
      message(
        'message-acme-2-1',
        'conversation-acme-2',
        'inbound',
        null,
        '这款白色 M 有货吗？',
        t2,
      ),
      message('message-acme-3-1', 'conversation-acme-3', 'inbound', null, '我想退货怎么操作？', t1),
      message(
        'message-acme-3-2',
        'conversation-acme-3',
        'outbound',
        'manual_typed',
        '请在订单页申请退货并上传凭证。',
        t3,
      ),
    ];

    this.approvedPhrases = [
      {
        id: 'phrase-acme-1',
        tenantId: T1,
        storeId: S1,
        phrase: '感谢您的耐心等待。',
        sourceMessageId: 'message-acme-1-0',
        approvedBy: 'u-t1-admin',
        createdAt: t4,
      },
    ];

    this.auditEntries = [
      {
        id: 'audit-seed-1',
        tenantId: T1,
        actorMemberId: 'u-t1-agent-1',
        action: AUDIT_ACTIONS.conversationClaimed,
        targetType: 'conversation',
        targetId: 'conversation-acme-1',
        metadata: {},
        createdAt: t1,
      },
      {
        id: 'audit-seed-2',
        tenantId: T1,
        actorMemberId: 'u-t1-admin',
        action: AUDIT_ACTIONS.messageApproved,
        targetType: 'message',
        targetId: 'message-acme-1-0',
        metadata: { phraseId: 'phrase-acme-1' },
        createdAt: t4,
      },
      {
        id: 'audit-seed-3',
        tenantId: null,
        actorMemberId: PLATFORM_ADMIN_MEMBER_ID,
        action: AUDIT_ACTIONS.policyUpdated,
        targetType: 'review-policy',
        targetId: 'review-policy-platform',
        metadata: { requireReview: true },
        createdAt: t1,
      },
    ];
  }
}
