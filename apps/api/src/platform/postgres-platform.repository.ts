/**
 * Durable {@link PlatformRepository} over the tables migrations `0002`-`0005`
 * declare.
 *
 * The adapter owns no authorization policy: the calling service has already
 * resolved the verified tenant context and the allowed store scope, and every
 * statement here is *additionally* scoped by `tenant_id`, so a caller cannot
 * reach another tenant's rows even by mistake. What the adapter does own is the
 * durable half of the domain rules:
 *
 * - Conversations are mutated only through the shared transition functions in
 *   `@kefu/core`, applied inside a transaction that locks the row
 *   (`SELECT ... FOR UPDATE`) and then re-checks `version`. A concurrent claim
 *   therefore serialises: the loser re-reads the committed row, fails the
 *   version/state predicate and gets the same stable `conflict` the in-process
 *   store produces. Exactly one claim succeeds.
 * - Outbound and inbound messages are idempotent by `dedup_key`, enforced by
 *   the partial unique index `messages_dedup_key_idx`. A replay returns the
 *   message the first request wrote instead of inserting a second one, even
 *   when the two requests race.
 * - A review approval writes the message state, the approved phrase and the
 *   audit entry in one transaction, so a half-approved message cannot be
 *   observed.
 *
 * A write the row's own state refuses (a message to a conversation that closed
 * between the caller's read and this transaction) raises a
 * {@link PlatformWriteError} rather than a bare `Error`, so the service can keep
 * answering with its stable status code instead of a 500.
 *
 * All statements are parameterised: no caller value is ever interpolated into
 * SQL text. Timestamps are normalised to ISO strings on the way out so the
 * durable records match the in-memory ones exactly.
 */

import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  AUDIT_ACTIONS,
  DEFAULT_RETENTION_DAYS,
  KNOWLEDGE_INDEX_FAILURE_LIMIT,
  MESSAGE_SOURCES,
  claimConversation,
  closeConversation,
  countsAsFirstReply,
  createAuditEntry,
  createReviewPolicy,
  defaultReviewPolicy,
  isAssignmentDue,
  isIndexedSourceKind,
  isReviewEligibleSource,
  openConversationForInbound,
  planAutoAssign,
  rejectionReasonCode,
  returnConversation,
  summarizeKnowledgeIndexCounts,
  tenantRetentionPolicies,
  touchConversationForInbound,
  transferConversation,
  type AgentPresence,
  type ApplyProductImportBatchInput,
  type ApprovalResult,
  type ApprovedPhrase,
  type AssignmentAction,
  type AssignmentCandidate,
  type AssignmentReasonCode,
  type AuditEntry,
  type CatalogAttributeValue,
  type CatalogAttributes,
  type CategoryAttribute,
  type CategoryStatus,
  type CatalogAttributeValueType,
  type Conversation,
  type ConversationAssignment,
  type ConversationTransition,
  type DispatchOutcome,
  type FaqItem,
  type FaqItemPatch,
  type FaqQuestionVariant,
  type FaqQuestionVariantPatch,
  type FaqVariantSource,
  type FaqVariantStatus,
  type ImportBatchStatus,
  type ImportBatchWithErrors,
  type ImportSourceType,
  type IngestResult,
  type InboundMessageInput,
  type KnowledgeIndexFailure,
  type KnowledgeIndexStatusFilter,
  type KnowledgeIndexStatusSummary,
  type Member,
  type Message,
  type MessageMedia,
  type MessageSource,
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
  type RetentionEntity,
  type RetentionSummary,
  type ReviewPolicy,
  type ReviewState,
  type Shortcut,
  type ShortcutPatch,
  type ShortcutScopeType,
  type SkuStatus,
  type SpuShelfStatus,
  type SpuSourceType,
  type Store,
  type StoreConversationResult,
  type TakeoverAuthority,
  type SuggestionCandidate,
  type SuggestionProvider,
  type SuggestionSet,
  type Tenant,
  type VariantAttributes,
} from '@kefu/core';
import { DatabaseService } from '../database/database.service';
import { TransactionManager, type TransactionClient } from '../persistence/transaction-manager';
import {
  toBoolean,
  toIso,
  toIsoOrNull,
  toNumber,
  toNumberOrNull,
  toRecord,
  toRecordArray,
  toStringArray,
  toText,
  toTextOrNull,
} from '../persistence/row-values';
import {
  PlatformWriteError,
  type AppendAuditRecord,
  type AttachMessageMediaInput,
  type CreateFaqRecord,
  type CreateProductRecord,
  type CreateShortcutRecord,
  type CreateSuggestionSetRecord,
  type DispatchDueInput,
  type PlatformRepository,
  type SetAgentPresenceRecord,
} from './platform-repository';

/** The single platform review policy row. */
const PLATFORM_REVIEW_POLICY_ID = 'review-policy-platform';

/** Milliseconds in one day, used to turn a retention window into a cutoff. */
const DAY_MS = 86_400_000;

/**
 * Patch one product.
 *
 * The four nullable columns use an explicit "was it named?" boolean rather than
 * `COALESCE`: for them `NULL` is a value ("no category", "no picture"), not an
 * absence, and `COALESCE` could not tell the two apart.
 *
 * A module constant rather than a literal inside `updateSpu`, because the import
 * path applies the very same patch on a transaction connection: one product
 * changed by hand and one changed by a file must end up the same row.
 */
const SPU_PATCH_SQL = `UPDATE product_spus
    SET category_id = CASE WHEN $3::boolean THEN $4::text ELSE category_id END,
        subtitle = CASE WHEN $5::boolean THEN $6::text ELSE subtitle END,
        main_image_url = CASE WHEN $7::boolean THEN $8::text ELSE main_image_url END,
        product_url = CASE WHEN $9::boolean THEN $10::text ELSE product_url END,
        title = COALESCE($11, title),
        selling_points_json = COALESCE($12::jsonb, selling_points_json),
        common_attributes_json = COALESCE($13::jsonb, common_attributes_json),
        shelf_status = COALESCE($14, shelf_status),
        updated_at = $15
  WHERE tenant_id = $1 AND id = $2
  RETURNING *`;

/** Bind the position of {@link SPU_PATCH_SQL}. */
function spuPatchParams(
  tenantId: string,
  spuId: string,
  patch: ProductSpuPatch,
  now?: string,
): ReadonlyArray<unknown> {
  return [
    tenantId,
    spuId,
    patch.categoryId !== undefined,
    patch.categoryId ?? null,
    patch.subtitle !== undefined,
    patch.subtitle ?? null,
    patch.mainImageUrl !== undefined,
    patch.mainImageUrl ?? null,
    patch.productUrl !== undefined,
    patch.productUrl ?? null,
    patch.title ?? null,
    patch.sellingPoints === undefined ? null : JSON.stringify(patch.sellingPoints),
    patch.commonAttributes === undefined ? null : JSON.stringify(patch.commonAttributes),
    patch.shelfStatus ?? null,
    now ?? new Date().toISOString(),
  ];
}

/** Patch one variant. Shared with the import path for the reason above. */
const SKU_PATCH_SQL = `UPDATE product_skus
    SET sku_code = COALESCE($3, sku_code),
        variant_json = COALESCE($4::jsonb, variant_json),
        search_attributes_json = COALESCE($5::jsonb, search_attributes_json),
        status = COALESCE($6, status),
        updated_at = $7
  WHERE tenant_id = $1 AND id = $2
  RETURNING *`;

/** Bind the position of {@link SKU_PATCH_SQL}. */
function skuPatchParams(
  tenantId: string,
  skuId: string,
  patch: ProductSkuPatch,
  now?: string,
): ReadonlyArray<unknown> {
  return [
    tenantId,
    skuId,
    patch.skuCode ?? null,
    patch.variant === undefined ? null : JSON.stringify(patch.variant),
    patch.searchAttributes === undefined ? null : JSON.stringify(patch.searchAttributes),
    patch.status ?? null,
    now ?? new Date().toISOString(),
  ];
}

/**
 * Write a batch's failed lines.
 *
 * One statement rather than N: the rows are unnest-ed from parallel arrays, so a
 * batch's failure list either lands whole or not at all. Shared with the import
 * transaction, where "not at all" has to mean the same thing.
 */
const IMPORT_ERRORS_INSERT_SQL = `INSERT INTO product_import_errors
   (id, tenant_id, batch_id, row_number, field_name, error_code, error_message,
    raw_value_masked, created_at)
 SELECT item.id, $1, $2, item.row_number, item.field_name, item.error_code,
        item.error_message, item.raw_value_masked, $3
 FROM unnest($4::text[], $5::integer[], $6::text[], $7::text[], $8::text[], $9::text[])
   AS item(id, row_number, field_name, error_code, error_message, raw_value_masked)
 RETURNING *`;

/** One failed line, in whatever of its two shapes the caller holds it. */
type ImportErrorRow = {
  readonly rowNumber: number;
  readonly fieldName?: string | null | undefined;
  readonly errorCode: string;
  readonly errorMessage?: string | null | undefined;
  readonly rawValueMasked?: string | null | undefined;
};

/** Bind the position of {@link IMPORT_ERRORS_INSERT_SQL}. */
function importErrorParams(
  tenantId: string,
  batchId: string,
  errors: ReadonlyArray<ImportErrorRow>,
  now: string,
): ReadonlyArray<unknown> {
  return [
    tenantId,
    batchId,
    now,
    errors.map(() => `import-error-${randomUUID()}`),
    errors.map((item) => item.rowNumber),
    errors.map((item) => item.fieldName ?? null),
    errors.map((item) => item.errorCode),
    errors.map((item) => item.errorMessage ?? null),
    errors.map((item) => item.rawValueMasked ?? null),
  ];
}

/**
 * Normalise a caller-supplied idempotency key.
 *
 * The durable schema makes `(tenant_id, dedup_key)` unique for non-NULL keys,
 * so a blank key must mean "no idempotency" rather than "one shared blank key":
 * two unrelated requests that both send an empty key must not collide. The
 * in-process store already treats a blank key as absent, so this keeps the two
 * adapters behaviourally identical.
 *
 * @param dedupKey - Raw key from the request.
 * @returns The key to persist, or `null` when the request carries none.
 */
function normaliseDedupKey(dedupKey: string | null | undefined): string | null {
  if (dedupKey === null || dedupKey === undefined || dedupKey.trim().length === 0) {
    return null;
  }
  return dedupKey;
}

/**
 * Group key for the dispatcher's per-store candidate cache within one sweep.
 *
 * JSON quoting makes the key unambiguous without a separator character that
 * could also occur inside an id; this is what lets
 * {@link PostgresPlatformRepository.dispatchDue} read each store's seats once
 * per sweep rather than once per due conversation.
 *
 * @param tenantId - Tenant owning the store.
 * @param storeId - Store whose seats are being grouped.
 * @returns An opaque grouping key.
 */
function scopeKey(tenantId: string, storeId: string): string {
  return JSON.stringify([tenantId, storeId]);
}

/**
 * The instant an entity must have been idle since to be past its window.
 *
 * Mirrors the shared `evaluateRetention` rule: an entity is expired when its
 * age in days is at least the window, which is `last_activity <= now - window`.
 *
 * @param now - Evaluation instant (ISO).
 * @param entity - Retention entity kind.
 * @returns The inclusive cutoff instant (ISO).
 */
function retentionCutoff(now: string, entity: RetentionEntity): string {
  return new Date(Date.parse(now) - DEFAULT_RETENTION_DAYS[entity] * DAY_MS).toISOString();
}

/**
 * One recorded failure, as the row holds it.
 *
 * Both narrowings refuse rather than cast. `0011` allows a `source_kind` the
 * kernel does not read (`product` and `product_sku` are in the migration's
 * vocabulary and outside `INDEXED_SOURCE_KINDS` until SDD-012 lands), and a row
 * outside `failed` / `skipped` is by definition one that recorded no failure. The
 * day either arrives, this read and the schema disagree — reporting a count of it
 * would be a number nobody can act on, so the throw names the row instead.
 */
function toKnowledgeIndexFailure(row: QueryResultRow): KnowledgeIndexFailure {
  const indexStatus = toText(row['index_status']);
  if (indexStatus !== 'failed' && indexStatus !== 'skipped') {
    throw new Error(`a ${indexStatus} slice cannot carry a recorded failure`);
  }
  const sourceKind = toText(row['source_kind']);
  if (!isIndexedSourceKind(sourceKind)) {
    throw new Error(`source kind ${sourceKind} is not one of the kinds the indexer reads`);
  }
  return {
    chunkId: toText(row['id']),
    indexStatus,
    sourceKind,
    sourceId: toText(row['source_id']),
    indexAttempts: toNumber(row['index_attempts']),
    indexError: toTextOrNull(row['index_error']),
    updatedAt: toIso(row['updated_at']),
  };
}

/** Platform repository backed by the API-owned PostgreSQL pool. */
export class PostgresPlatformRepository implements PlatformRepository {
  /**
   * @param database - The API-owned connection pool, used for reads.
   * @param transactions - The transactional boundary, used for every mutation
   * that must be atomic or must serialise against a concurrent one.
   */
  constructor(
    private readonly database: DatabaseService,
    private readonly transactions: TransactionManager,
  ) {}

  // --------------------------------------------------------------------------
  // Directory
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listTenants(): Promise<ReadonlyArray<Tenant>> {
    const rows = await this.rows('SELECT * FROM tenants ORDER BY id');
    return rows.map(toTenant);
  }

  /** @inheritdoc */
  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    const rows = await this.rows('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    return optional(rows[0], toTenant);
  }

  /** @inheritdoc */
  async listStores(tenantId: string): Promise<ReadonlyArray<Store>> {
    const rows = await this.rows('SELECT * FROM stores WHERE tenant_id = $1 ORDER BY id', [
      tenantId,
    ]);
    return rows.map(toStore);
  }

  /** @inheritdoc */
  async getStore(tenantId: string, storeId: string): Promise<Store | undefined> {
    const rows = await this.rows('SELECT * FROM stores WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      storeId,
    ]);
    return optional(rows[0], toStore);
  }

  /** @inheritdoc */
  async getMember(memberId: string): Promise<Member | undefined> {
    const rows = await this.rows('SELECT * FROM members WHERE id = $1', [memberId]);
    return optional(rows[0], toMember);
  }

  /** @inheritdoc */
  async listMembers(tenantId: string): Promise<ReadonlyArray<Member>> {
    const rows = await this.rows(
      'SELECT * FROM members WHERE tenant_id = $1 AND enabled ORDER BY id',
      [tenantId],
    );
    return rows.map(toMember);
  }

  // --------------------------------------------------------------------------
  // Knowledge
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listProducts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Product>> {
    // Disabled rows are part of the answer: the management surface has to be
    // able to find a 停用 row again to put it back. Which rows may be used as
    // candidate material is decided by `usableKnowledge`, once, in the caller.
    const rows = await this.rows(
      `SELECT * FROM products
        WHERE tenant_id = $1 AND ($2::text IS NULL OR store_id = $2)
        ORDER BY id`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toProduct);
  }

  /** @inheritdoc */
  async getProduct(tenantId: string, productId: string): Promise<Product | undefined> {
    const rows = await this.rows('SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      productId,
    ]);
    return optional(rows[0], toProduct);
  }

  /** @inheritdoc */
  async createProduct(input: CreateProductRecord): Promise<Product> {
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO products (id, tenant_id, store_id, sku, title, description, enabled, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $7)
       RETURNING *`,
      [
        `product-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.sku,
        input.title,
        input.description,
        now,
      ],
    );
    return required(rows[0], toProduct);
  }

  /** @inheritdoc */
  async updateProduct(
    tenantId: string,
    productId: string,
    patch: ProductPatch,
    now?: string,
  ): Promise<Product | undefined> {
    // `COALESCE($n, column)` is the write-side meaning of an absent patch field:
    // keep the current value. `FALSE` is not NULL, so 停用 survives the trip.
    const rows = await this.rows(
      `UPDATE products
          SET sku = COALESCE($3, sku),
              title = COALESCE($4, title),
              description = COALESCE($5, description),
              enabled = COALESCE($6::boolean, enabled),
              updated_at = $7
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        productId,
        patch.sku ?? null,
        patch.title ?? null,
        patch.description ?? null,
        patch.enabled ?? null,
        now ?? new Date().toISOString(),
      ],
    );
    return optional(rows[0], toProduct);
  }

  /** @inheritdoc */
  async listFaqs(tenantId: string, storeId?: string): Promise<ReadonlyArray<FaqItem>> {
    const rows = await this.rows(
      `SELECT * FROM faqs
        WHERE tenant_id = $1 AND ($2::text IS NULL OR store_id = $2)
        ORDER BY id`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toFaqItem);
  }

  /** @inheritdoc */
  async getFaq(tenantId: string, faqId: string): Promise<FaqItem | undefined> {
    const rows = await this.rows('SELECT * FROM faqs WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      faqId,
    ]);
    return optional(rows[0], toFaqItem);
  }

  /** @inheritdoc */
  async createFaq(input: CreateFaqRecord): Promise<FaqItem> {
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO faqs (id, tenant_id, store_id, question, answer, tags, enabled, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $7)
       RETURNING *`,
      [
        `faq-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.question,
        input.answer,
        [...input.tags],
        now,
      ],
    );
    return required(rows[0], toFaqItem);
  }

  /** @inheritdoc */
  async updateFaq(
    tenantId: string,
    faqId: string,
    patch: FaqItemPatch,
    now?: string,
  ): Promise<FaqItem | undefined> {
    const rows = await this.rows(
      `UPDATE faqs
          SET question = COALESCE($3, question),
              answer = COALESCE($4, answer),
              tags = COALESCE($5::text[], tags),
              enabled = COALESCE($6::boolean, enabled),
              updated_at = $7
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        faqId,
        patch.question ?? null,
        patch.answer ?? null,
        patch.tags === undefined ? null : [...patch.tags],
        patch.enabled ?? null,
        now ?? new Date().toISOString(),
      ],
    );
    return optional(rows[0], toFaqItem);
  }

  /**
   * @inheritdoc
   *
   * The two questions are different and the query answers them together: with a
   * store, the working list — that store's phrases *and* the merchant-level ones
   * — and without one, the management list of every row the tenant owns. The
   * ordering matches the in-memory adapter: store-level first, then `sort_order`,
   * then the code, so the sequence is total and cannot differ between adapters.
   */
  async listShortcuts(tenantId: string, storeId?: string): Promise<ReadonlyArray<Shortcut>> {
    const rows = await this.rows(
      `SELECT * FROM shortcuts
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR scope_type = 'tenant' OR store_id = $2)
        ORDER BY CASE WHEN scope_type = 'store' THEN 0 ELSE 1 END, sort_order, code`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toShortcut);
  }

  /** @inheritdoc */
  async getShortcut(tenantId: string, shortcutId: string): Promise<Shortcut | undefined> {
    const rows = await this.rows('SELECT * FROM shortcuts WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      shortcutId,
    ]);
    return optional(rows[0], toShortcut);
  }

  /** @inheritdoc */
  async createShortcut(input: CreateShortcutRecord): Promise<Shortcut> {
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO shortcuts
         (id, tenant_id, scope_type, store_id, code, title, content, intent_code,
          sort_order, enabled, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $10)
       RETURNING *`,
      [
        `shortcut-${randomUUID()}`,
        input.tenantId,
        input.storeId === null ? 'tenant' : 'store',
        input.storeId,
        input.code,
        input.title,
        input.content,
        input.intentCode ?? null,
        input.sortOrder ?? 0,
        now,
      ],
    );
    return required(rows[0], toShortcut);
  }

  /** @inheritdoc */
  async updateShortcut(
    tenantId: string,
    shortcutId: string,
    patch: ShortcutPatch,
    now?: string,
  ): Promise<Shortcut | undefined> {
    const rows = await this.rows(
      `UPDATE shortcuts
          SET code = COALESCE($3, code),
              title = COALESCE($4, title),
              content = COALESCE($5, content),
              intent_code = CASE WHEN $6::boolean THEN $7::text ELSE intent_code END,
              sort_order = COALESCE($8::integer, sort_order),
              enabled = COALESCE($9::boolean, enabled),
              updated_at = $10
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        shortcutId,
        patch.code ?? null,
        patch.title ?? null,
        patch.content ?? null,
        patch.intentCode !== undefined,
        patch.intentCode ?? null,
        patch.sortOrder ?? null,
        patch.enabled ?? null,
        now ?? new Date().toISOString(),
      ],
    );
    return optional(rows[0], toShortcut);
  }

  // --------------------------------------------------------------------------
  // Catalogue
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async knowledgeIndexStatus(
    tenantId: string,
    filter: KnowledgeIndexStatusFilter,
  ): Promise<KnowledgeIndexStatusSummary> {
    // One predicate, three statements. It is written once and pasted into each,
    // so a filtered read cannot end up with counts over one slice set and vectors
    // over another — and the store rule is the shortcut list's rule, for the same
    // reason: `scope_type = 'tenant'` is `store_id IS NULL` by construction
    // (`knowledge-indexer.ts` derives one from the other) and a store's retrieval
    // reads those slices, so a broken tenant-scope slice is that store's problem.
    const scope = `tenant_id = $1
           AND ($2::text IS NULL OR scope_type = 'tenant' OR store_id = $2)
           AND ($3::text IS NULL OR source_kind = $3)
           AND ($4::text IS NULL OR source_id = $4)
           AND ($5::text IS NULL OR index_status = $5)`;
    const values: ReadonlyArray<unknown> = [
      tenantId,
      filter.storeId ?? null,
      filter.sourceKind ?? null,
      filter.sourceId ?? null,
      filter.indexStatus ?? null,
    ];

    const grouped = await this.rows(
      `SELECT index_status, count(*) AS chunk_count
         FROM knowledge_chunks
        WHERE ${scope}
        GROUP BY index_status`,
      values,
    );
    const counts = summarizeKnowledgeIndexCounts(
      grouped.map((row) => ({
        indexStatus: toText(row['index_status']),
        count: toNumber(row['chunk_count']),
      })),
    );

    // The vectors of the same slice set, which with a status filter means the
    // vectors of *those* slices — a filtered count next to an unfiltered one
    // would answer a question nobody asked. The subquery is what carries the
    // filter: the embeddings table has no store, no source and no status of its
    // own, only the slice it belongs to.
    const vectors = await this.rows(
      `SELECT count(*) AS vector_count
         FROM knowledge_chunk_embeddings
        WHERE tenant_id = $1
          AND chunk_id IN (SELECT id FROM knowledge_chunks WHERE ${scope})`,
      values,
    );
    const vectorRow = vectors[0];

    // Bounded by the kernel's limit, passed as a parameter for the same reason
    // the sweep passes its retry schedule: one definition, and the statement text
    // carries no number that could drift from it.
    const failures = await this.rows(
      `SELECT id, index_status, source_kind, source_id, index_attempts, index_error, updated_at
         FROM knowledge_chunks
        WHERE ${scope}
          AND index_status IN ('failed', 'skipped')
          AND index_error IS NOT NULL
        ORDER BY updated_at DESC, id
        LIMIT $6`,
      [...values, KNOWLEDGE_INDEX_FAILURE_LIMIT],
    );

    return Object.freeze({
      counts,
      embeddings: vectorRow === undefined ? 0 : toNumber(vectorRow['vector_count']),
      recentFailures: Object.freeze(failures.map(toKnowledgeIndexFailure)),
    });
  }

  /** @inheritdoc */
  async listCategories(
    tenantId: string,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductCategory>> {
    const rows = await this.rows(
      `SELECT * FROM product_categories
        WHERE tenant_id = $1 AND ($2::text IS NULL OR store_id = $2)
        ORDER BY code, id`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toCategory);
  }

  /** @inheritdoc */
  async getCategory(tenantId: string, categoryId: string): Promise<ProductCategory | undefined> {
    const rows = await this.rows(
      'SELECT * FROM product_categories WHERE tenant_id = $1 AND id = $2',
      [tenantId, categoryId],
    );
    return optional(rows[0], toCategory);
  }

  /** @inheritdoc */
  async createCategory(input: NewProductCategory): Promise<ProductCategory | undefined> {
    const parentId = input.parentId ?? null;
    if (parentId !== null && (await this.getCategory(input.tenantId, parentId)) === undefined) {
      // The foreign key would refuse this write anyway; answering `undefined`
      // keeps the two adapters indistinguishable to the caller.
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO product_categories
         (id, tenant_id, store_id, parent_id, code, name, status, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'enabled', $7, $7)
       RETURNING *`,
      [
        `category-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        parentId,
        input.code,
        input.name,
        now,
      ],
    );
    return optional(rows[0], toCategory);
  }

  /** @inheritdoc */
  async listCategoryAttributes(
    tenantId: string,
    categoryId: string,
  ): Promise<ReadonlyArray<CategoryAttribute>> {
    const rows = await this.rows(
      `SELECT * FROM product_category_attributes
        WHERE tenant_id = $1 AND category_id = $2
        ORDER BY attribute_code, id`,
      [tenantId, categoryId],
    );
    return rows.map(toCategoryAttribute);
  }

  /** @inheritdoc */
  async createCategoryAttribute(
    input: NewCategoryAttribute,
  ): Promise<CategoryAttribute | undefined> {
    if ((await this.getCategory(input.tenantId, input.categoryId)) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO product_category_attributes
         (id, tenant_id, category_id, attribute_code, attribute_name, value_type,
          is_required, is_searchable, allowed_values_json, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::boolean, $8::boolean, $9::jsonb, $10, $10)
       RETURNING *`,
      [
        `category-attribute-${randomUUID()}`,
        input.tenantId,
        input.categoryId,
        input.attributeCode,
        input.attributeName,
        input.valueType,
        input.isRequired ?? false,
        input.isSearchable ?? false,
        JSON.stringify(input.allowedValues ?? []),
        now,
      ],
    );
    return optional(rows[0], toCategoryAttribute);
  }

  /** @inheritdoc */
  async listSpus(
    tenantId: string,
    filter: {
      readonly storeId?: string | undefined;
      readonly categoryId?: string | undefined;
    } = {},
  ): Promise<ReadonlyArray<ProductSpu>> {
    const rows = await this.rows(
      `SELECT * FROM product_spus
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR store_id = $2)
          AND ($3::text IS NULL OR category_id = $3)
        ORDER BY product_code, id`,
      [tenantId, filter.storeId ?? null, filter.categoryId ?? null],
    );
    return rows.map(toSpu);
  }

  /** @inheritdoc */
  async getSpu(tenantId: string, spuId: string): Promise<ProductSpu | undefined> {
    const rows = await this.rows('SELECT * FROM product_spus WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      spuId,
    ]);
    return optional(rows[0], toSpu);
  }

  /** @inheritdoc */
  async createSpu(input: NewProductSpu): Promise<ProductSpu | undefined> {
    const categoryId = input.categoryId ?? null;
    if (categoryId !== null && (await this.getCategory(input.tenantId, categoryId)) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO product_spus
         (id, tenant_id, store_id, category_id, external_product_id, product_code, title,
          subtitle, main_image_url, product_url, selling_points_json, common_attributes_json,
          shelf_status, source_type, source_updated_at, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
               $13, $14, $15, $16, $16)
       RETURNING *`,
      [
        `spu-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        categoryId,
        input.externalProductId ?? null,
        input.productCode,
        input.title,
        input.subtitle ?? null,
        input.mainImageUrl ?? null,
        input.productUrl ?? null,
        JSON.stringify(input.sellingPoints ?? []),
        JSON.stringify(input.commonAttributes ?? {}),
        input.shelfStatus ?? 'unknown',
        input.sourceType ?? 'manual',
        input.sourceUpdatedAt ?? null,
        now,
      ],
    );
    return optional(rows[0], toSpu);
  }

  /** @inheritdoc */
  async updateSpu(
    tenantId: string,
    spuId: string,
    patch: ProductSpuPatch,
    now?: string,
  ): Promise<ProductSpu | undefined> {
    const rows = await this.rows(SPU_PATCH_SQL, spuPatchParams(tenantId, spuId, patch, now));
    return optional(rows[0], toSpu);
  }

  /** @inheritdoc */
  async listSkus(tenantId: string, spuId: string): Promise<ReadonlyArray<ProductSku>> {
    const rows = await this.rows(
      `SELECT * FROM product_skus
        WHERE tenant_id = $1 AND spu_id = $2
        ORDER BY sku_code, id`,
      [tenantId, spuId],
    );
    return rows.map(toSku);
  }

  /** @inheritdoc */
  async getSku(tenantId: string, skuId: string): Promise<ProductSku | undefined> {
    const rows = await this.rows('SELECT * FROM product_skus WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      skuId,
    ]);
    return optional(rows[0], toSku);
  }

  /** @inheritdoc */
  async listSkusByStore(tenantId: string, storeId: string): Promise<ReadonlyArray<ProductSku>> {
    const rows = await this.rows(
      `SELECT * FROM product_skus
        WHERE tenant_id = $1 AND store_id = $2
        ORDER BY sku_code, id`,
      [tenantId, storeId],
    );
    return rows.map(toSku);
  }

  /** @inheritdoc */
  async createSku(input: NewProductSku): Promise<ProductSku | undefined> {
    if ((await this.getSpu(input.tenantId, input.spuId)) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO product_skus
         (id, tenant_id, store_id, spu_id, external_sku_id, sku_code, variant_json,
          search_attributes_json, status, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $10)
       RETURNING *`,
      [
        `sku-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.spuId,
        input.externalSkuId ?? null,
        input.skuCode,
        JSON.stringify(input.variant ?? {}),
        JSON.stringify(input.searchAttributes ?? {}),
        input.status ?? 'active',
        now,
      ],
    );
    return optional(rows[0], toSku);
  }

  /** @inheritdoc */
  async updateSku(
    tenantId: string,
    skuId: string,
    patch: ProductSkuPatch,
    now?: string,
  ): Promise<ProductSku | undefined> {
    const rows = await this.rows(SKU_PATCH_SQL, skuPatchParams(tenantId, skuId, patch, now));
    return optional(rows[0], toSku);
  }

  // --------------------------------------------------------------------------
  // FAQ near-questions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listFaqVariants(
    tenantId: string,
    faqId: string,
  ): Promise<ReadonlyArray<FaqQuestionVariant>> {
    const rows = await this.rows(
      `SELECT * FROM faq_question_variants
        WHERE tenant_id = $1 AND faq_id = $2
        ORDER BY created_at, id`,
      [tenantId, faqId],
    );
    return rows.map(toFaqQuestionVariant);
  }

  /** @inheritdoc */
  async getFaqVariant(
    tenantId: string,
    variantId: string,
  ): Promise<FaqQuestionVariant | undefined> {
    const rows = await this.rows(
      'SELECT * FROM faq_question_variants WHERE tenant_id = $1 AND id = $2',
      [tenantId, variantId],
    );
    return optional(rows[0], toFaqQuestionVariant);
  }

  /** @inheritdoc */
  async createFaqVariant(input: NewFaqQuestionVariant): Promise<FaqQuestionVariant | undefined> {
    if ((await this.getFaq(input.tenantId, input.faqId)) === undefined) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO faq_question_variants
         (id, tenant_id, faq_id, question_text, source, status, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'enabled', $6, $6)
       RETURNING *`,
      [
        `faq-variant-${randomUUID()}`,
        input.tenantId,
        input.faqId,
        input.questionText,
        input.source ?? 'manual',
        now,
      ],
    );
    return required(rows[0], toFaqQuestionVariant);
  }

  /** @inheritdoc */
  async updateFaqVariant(
    tenantId: string,
    variantId: string,
    patch: FaqQuestionVariantPatch,
    now?: string,
  ): Promise<FaqQuestionVariant | undefined> {
    const rows = await this.rows(
      `UPDATE faq_question_variants
          SET question_text = COALESCE($3, question_text),
              status = COALESCE($4, status),
              updated_at = $5
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        variantId,
        patch.questionText ?? null,
        patch.status ?? null,
        now ?? new Date().toISOString(),
      ],
    );
    return optional(rows[0], toFaqQuestionVariant);
  }

  // --------------------------------------------------------------------------
  // Product import batches
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async listImportBatches(
    tenantId: string,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductImportBatch>> {
    const rows = await this.rows(
      `SELECT * FROM product_import_batches
        WHERE tenant_id = $1 AND ($2::text IS NULL OR store_id = $2)
        ORDER BY created_at DESC, id`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toImportBatch);
  }

  /** @inheritdoc */
  async getImportBatch(tenantId: string, batchId: string): Promise<ProductImportBatch | undefined> {
    const rows = await this.rows(
      'SELECT * FROM product_import_batches WHERE tenant_id = $1 AND id = $2',
      [tenantId, batchId],
    );
    return optional(rows[0], toImportBatch);
  }

  /** @inheritdoc */
  async createImportBatch(input: NewProductImportBatch): Promise<ProductImportBatch> {
    const now = input.now ?? new Date().toISOString();
    const rows = await this.rows(
      `INSERT INTO product_import_batches
         (id, tenant_id, store_id, source_type, file_object_key, file_sha256, status,
          total_rows, success_rows, failed_rows, started_at, finished_at, created_by,
          updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', 0, 0, 0, NULL, NULL, $7, $8, $8)
       RETURNING *`,
      [
        `import-batch-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.sourceType,
        input.fileObjectKey ?? null,
        input.fileSha256 ?? null,
        input.createdBy ?? null,
        now,
      ],
    );
    return required(rows[0], toImportBatch);
  }

  /** @inheritdoc */
  async updateImportBatch(
    tenantId: string,
    batchId: string,
    patch: ProductImportBatchPatch,
    now?: string,
  ): Promise<ProductImportBatch | undefined> {
    const rows = await this.rows(
      `UPDATE product_import_batches
          SET status = COALESCE($3, status),
              total_rows = COALESCE($4::integer, total_rows),
              success_rows = COALESCE($5::integer, success_rows),
              failed_rows = COALESCE($6::integer, failed_rows),
              started_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE started_at END,
              finished_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE finished_at END,
              updated_at = $11
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        batchId,
        patch.status ?? null,
        patch.totalRows ?? null,
        patch.successRows ?? null,
        patch.failedRows ?? null,
        patch.startedAt !== undefined,
        patch.startedAt ?? null,
        patch.finishedAt !== undefined,
        patch.finishedAt ?? null,
        now ?? new Date().toISOString(),
      ],
    );
    return optional(rows[0], toImportBatch);
  }

  /**
   * @inheritdoc
   *
   * The batch is checked first because the composite foreign key would reject
   * the insert anyway — this just turns a constraint error into the `undefined`
   * the port promises. The ids are made here rather than by a database default,
   * matching how every other insert in this adapter names its rows and keeping
   * the schema free of a dependency on an extension.
   */
  async appendImportErrors(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId'>>;
    readonly now?: string;
  }): Promise<ReadonlyArray<ProductImportError> | undefined> {
    if ((await this.getImportBatch(input.tenantId, input.batchId)) === undefined) {
      return undefined;
    }
    if (input.errors.length === 0) {
      return [];
    }
    const rows = await this.rows(
      IMPORT_ERRORS_INSERT_SQL,
      importErrorParams(
        input.tenantId,
        input.batchId,
        input.errors,
        input.now ?? new Date().toISOString(),
      ),
    );
    return rows.map(toImportError);
  }

  /** @inheritdoc */
  async listImportErrors(
    tenantId: string,
    batchId: string,
  ): Promise<ReadonlyArray<ProductImportError>> {
    const rows = await this.rows(
      `SELECT * FROM product_import_errors
        WHERE tenant_id = $1 AND batch_id = $2
        ORDER BY row_number, id`,
      [tenantId, batchId],
    );
    return rows.map(toImportError);
  }

  /**
   * @inheritdoc
   *
   * Every statement runs on the one borrowed connection, so the products, the
   * batch and the failure list land together or not at all. That is the whole
   * point of doing this here rather than as three calls from the service: a
   * catalogue written without its batch is stock nobody can account for.
   *
   * `ON CONFLICT` on the two unique keys is not belt-and-braces. The plan was
   * computed from a snapshot read outside this transaction, so a file uploaded
   * twice at once — or a product added by hand in between — can reach the write
   * with a code that already exists. Updating is what the file asked for; letting
   * the constraint raise would fail an import over a row it was right about.
   *
   * Nothing is recomputed from the rows that were written. A batch's counts are
   * the receipt the operator was given, and a receipt that silently disagreed
   * with what happened would be worse than one that is merely wrong.
   */
  async applyProductImportBatch(
    input: ApplyProductImportBatchInput,
  ): Promise<ImportBatchWithErrors> {
    const now = input.now ?? new Date().toISOString();

    return this.transactions.run(async (client) => {
      const spuIdByCode = new Map<string, string>();

      for (const write of input.plan.spuWrites) {
        if (write.action === 'create') {
          const rows = (
            await this.statement(
              client,
              `INSERT INTO product_spus
                 (id, tenant_id, store_id, category_id, external_product_id, product_code, title,
                  subtitle, main_image_url, product_url, selling_points_json,
                  common_attributes_json, shelf_status, source_type, source_updated_at,
                  updated_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                       $13, $14, $15::timestamptz, $16, $16)
               ON CONFLICT (tenant_id, store_id, product_code) DO UPDATE
                 SET category_id = EXCLUDED.category_id,
                     external_product_id = EXCLUDED.external_product_id,
                     title = EXCLUDED.title,
                     subtitle = EXCLUDED.subtitle,
                     main_image_url = EXCLUDED.main_image_url,
                     product_url = EXCLUDED.product_url,
                     selling_points_json = EXCLUDED.selling_points_json,
                     common_attributes_json = EXCLUDED.common_attributes_json,
                     shelf_status = EXCLUDED.shelf_status,
                     source_type = EXCLUDED.source_type,
                     source_updated_at = EXCLUDED.source_updated_at,
                     updated_at = EXCLUDED.updated_at
               RETURNING *`,
              [
                `spu-${randomUUID()}`,
                input.tenantId,
                input.storeId,
                write.values.categoryId,
                write.values.externalProductId,
                write.values.productCode,
                write.values.title,
                write.values.subtitle,
                write.values.mainImageUrl,
                write.values.productUrl,
                JSON.stringify(write.values.sellingPoints),
                JSON.stringify(write.values.commonAttributes),
                write.values.shelfStatus,
                write.values.sourceType,
                write.values.sourceUpdatedAt,
                now,
              ],
            )
          ).rows;
          spuIdByCode.set(write.productCode, required(rows[0], toSpu).id);
        } else {
          const rows = (
            await this.statement(
              client,
              SPU_PATCH_SQL,
              spuPatchParams(input.tenantId, write.spuId, write.patch, now),
            )
          ).rows;
          if (rows[0] === undefined) {
            // The plan was built from this store's own rows a moment ago. Nothing
            // here can tell whether that product was deleted by someone else or
            // whether the plan is stale, and guessing would write a product over
            // a code that may now belong to a different row.
            throw new Error(
              `import plan updates product ${write.spuId} (${write.productCode}), which no longer exists`,
            );
          }
          spuIdByCode.set(write.productCode, required(rows[0], toSpu).id);
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
          await this.statement(
            client,
            `INSERT INTO product_skus
               (id, tenant_id, store_id, spu_id, external_sku_id, sku_code, variant_json,
                search_attributes_json, status, updated_at, created_at)
             VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7::jsonb, $8, $9, $9)
             ON CONFLICT (tenant_id, store_id, sku_code) DO UPDATE
               SET spu_id = EXCLUDED.spu_id,
                   variant_json = EXCLUDED.variant_json,
                   search_attributes_json = EXCLUDED.search_attributes_json,
                   status = EXCLUDED.status,
                   updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [
              `sku-${randomUUID()}`,
              input.tenantId,
              input.storeId,
              spuId,
              write.values.skuCode,
              JSON.stringify(write.values.variant),
              JSON.stringify(write.values.searchAttributes),
              write.values.status,
              now,
            ],
          );
        } else {
          const rows = (
            await this.statement(
              client,
              SKU_PATCH_SQL,
              skuPatchParams(input.tenantId, write.skuId, write.patch, now),
            )
          ).rows;
          if (rows[0] === undefined) {
            throw new Error(
              `import plan updates variant ${write.skuId} (${write.skuCode}), which no longer exists`,
            );
          }
        }
      }

      // The batch opens in the state it ends in. Its whole life happens on this
      // connection, so `uploaded` → `importing` → done would be a progress story
      // with no time passing between the steps.
      const batchRows = (
        await this.statement(
          client,
          `INSERT INTO product_import_batches
             (id, tenant_id, store_id, source_type, file_object_key, file_sha256, status,
              total_rows, success_rows, failed_rows, started_at, finished_at, created_by,
              updated_at, created_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8, $9, $9, $10, $11, $11)
           RETURNING *`,
          [
            `import-batch-${randomUUID()}`,
            input.tenantId,
            input.storeId,
            input.sourceType,
            input.status,
            input.totalRows,
            input.successRows,
            input.failedRows,
            now,
            input.createdBy ?? null,
            now,
          ],
        )
      ).rows;
      const batch = required(batchRows[0], toImportBatch);

      const errorRows =
        input.errors.length === 0
          ? []
          : (
              await this.statement(
                client,
                IMPORT_ERRORS_INSERT_SQL,
                importErrorParams(input.tenantId, batch.id, input.errors, now),
              )
            ).rows;

      return { batch, errors: errorRows.map(toImportError) };
    });
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
    // `$3` is `conversationReadAccess` (packages/core) spelled in SQL: 我的 · 没人持有的 ·
    // 我交出去的。那份规则只有一条，这里是它的第二份抄写——两边对不上就会给出一个点开
    // 反而 403 的队列行，所以 `platform-postgres.integration.spec.ts` 拿同一条矩阵把这里
    // 也钉住。改规则时两处一起改。
    const rows = await this.rows(
      `SELECT c.* FROM conversations c
        WHERE c.tenant_id = $1 AND ($2::text IS NULL OR c.store_id = $2)
          AND ($3::text IS NULL
               OR c.assigned_member_id IS NULL
               OR c.assigned_member_id = $3
               OR EXISTS (SELECT 1 FROM conversation_assignments a
                           WHERE a.tenant_id = c.tenant_id
                             AND a.conversation_id = c.id
                             AND a.from_member_id = $3
                             AND a.result = 'success'))
        ORDER BY c.last_message_at DESC, c.id DESC`,
      [tenantId, storeId ?? null, visibleToMemberId ?? null],
    );
    return rows.map(toConversation);
  }

  /** @inheritdoc */
  async getConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<Conversation | undefined> {
    const rows = await this.rows('SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      conversationId,
    ]);
    return optional(rows[0], toConversation);
  }

  /** @inheritdoc */
  async listMessages(tenantId: string, conversationId?: string): Promise<ReadonlyArray<Message>> {
    const rows = await this.rows(
      `SELECT * FROM messages
        WHERE tenant_id = $1 AND ($2::text IS NULL OR conversation_id = $2)
        ORDER BY created_at ASC, id ASC`,
      [tenantId, conversationId ?? null],
    );
    return rows.map(toMessage);
  }

  /** @inheritdoc */
  async getMessage(tenantId: string, messageId: string): Promise<Message | undefined> {
    const rows = await this.rows('SELECT * FROM messages WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      messageId,
    ]);
    return optional(rows[0], toMessage);
  }

  /** @inheritdoc */
  async attachMessageMedia(input: AttachMessageMediaInput): Promise<boolean> {
    // Not inside a transaction of its own: it is one statement, and the object
    // it points at was already written *before* this runs. A crash between the
    // two leaves a stored object nothing references — recoverable by the key's
    // own namespace — rather than a message row pointing at bytes that are not
    // there, which no reader could resolve.
    const result = await this.query(
      `UPDATE messages
          SET media_key = $3, media_mime = $4, media_bytes = $5
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.messageId, input.key, input.mimeType, input.bytes],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /** @inheritdoc */
  async claim(
    tenantId: string,
    conversationId: string,
    actorMemberId: string,
    expectedVersion: number,
    now: string,
  ): Promise<StoreConversationResult> {
    return this.transition({
      tenantId,
      conversationId,
      transitionOf: (conversation) =>
        claimConversation(conversation, expectedVersion, actorMemberId, now),
      auditAction: AUDIT_ACTIONS.conversationClaimed,
      action: 'claim',
      actorMemberId,
      toMemberId: actorMemberId,
      now,
    });
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
    return this.transition({
      tenantId,
      conversationId,
      transitionOf: (conversation) =>
        returnConversation(conversation, expectedVersion, actorMemberId, authority, now),
      auditAction: AUDIT_ACTIONS.conversationReturned,
      action: 'return',
      actorMemberId,
      toMemberId: null,
      now,
    });
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
    return this.transition({
      tenantId,
      conversationId,
      transitionOf: (conversation) =>
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
      actorMemberId,
      toMemberId,
      now,
    });
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
    return this.transition({
      tenantId,
      conversationId,
      transitionOf: (conversation) =>
        closeConversation(conversation, expectedVersion, actorMemberId, actorIsAdmin, now),
      auditAction: AUDIT_ACTIONS.conversationClosed,
      action: 'release',
      actorMemberId,
      toMemberId: null,
      now,
    });
  }

  /** @inheritdoc */
  async sendOutbound(input: OutboundMessageInput): Promise<IngestResult> {
    const now = input.now ?? new Date().toISOString();
    const dedupKey = normaliseDedupKey(input.dedupKey);
    return this.transactions.run(async (client) => {
      if (dedupKey !== null) {
        const replayed = await this.messageByDedupKey(client, input.tenantId, dedupKey);
        if (replayed !== undefined) {
          return {
            conversation: await this.replayedConversation(client, input.tenantId, replayed),
            message: replayed,
            created: false,
            reopened: false,
          };
        }
      }

      const current = await this.lockConversation(client, input.tenantId, input.conversationId);
      if (current === undefined) {
        throw new PlatformWriteError('not_found', 'conversation not found in tenant scope');
      }
      if (current.status === 'closed') {
        throw new PlatformWriteError(
          'invalid_state',
          'cannot send an outbound message to a closed conversation',
        );
      }

      const reviewEligible = isReviewEligibleSource(input.source);
      const message: Message = {
        id: `message-${randomUUID()}`,
        tenantId: current.tenantId,
        storeId: current.storeId,
        conversationId: input.conversationId,
        channel: 'internal',
        direction: 'outbound',
        source: input.source,
        messageType: 'text',
        content: input.content,
        dedupKey,
        reviewEligible,
        reviewState: reviewEligible ? 'pending' : 'none',
        candidateId: input.candidateId ?? null,
        // Nothing the platform sends through the composer carries stored media
        // yet: an outbound image would be uploaded to the provider, not kept.
        media: null,
        createdAt: now,
      };

      const inserted = await this.insertMessage(client, message);
      if (inserted === undefined) {
        // A concurrent request won the dedup race: the unique index refused
        // this insert, so the winner's message is the effect of the request.
        const winner =
          dedupKey === null
            ? undefined
            : await this.messageByDedupKey(client, input.tenantId, dedupKey);
        if (winner === undefined) {
          throw new Error('store invariant: message already exists without a dedup key');
        }
        return {
          conversation: await this.replayedConversation(client, input.tenantId, winner),
          message: winner,
          created: false,
          reopened: false,
        };
      }

      await this.touchConversation(client, input.tenantId, input.conversationId, now);
      // Only a *sent* outbound closes the first-response clock, and only the
      // first one: `recordFirstReplyAt` is guarded by `first_reply_at IS NULL`,
      // so a retry or a second reply cannot move the metric. The source check is
      // the shared rule, so an automated offline reply does not stop a clock that
      // measures how long the customer waited for a person.
      if (countsAsFirstReply(input.source)) {
        await this.recordFirstReplyAt(client, input.tenantId, input.conversationId, now);
      }
      await this.insertAudit(client, {
        tenantId: input.tenantId,
        actorMemberId: null,
        action: AUDIT_ACTIONS.outboundMessageSent,
        targetType: 'message',
        targetId: message.id,
        createdAt: now,
      });

      return {
        conversation: await this.replayedConversation(client, input.tenantId, inserted),
        message: inserted,
        created: true,
        reopened: false,
      };
    });
  }

  /** @inheritdoc */
  async ingestInbound(input: InboundMessageInput): Promise<IngestResult> {
    const now = input.now ?? new Date().toISOString();
    const dedupKey = normaliseDedupKey(input.dedupKey);
    return this.transactions.run(async (client) => {
      if (dedupKey !== null) {
        const replayed = await this.messageByDedupKey(client, input.tenantId, dedupKey);
        if (replayed !== undefined) {
          return {
            conversation: await this.replayedConversation(client, input.tenantId, replayed),
            message: replayed,
            created: false,
            reopened: false,
          };
        }
      }

      const matched = await this.lockConversationByExternal(client, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        channel: input.channel,
        externalConversationId: input.externalConversationId,
      });

      let conversation: Conversation;
      let reopened = false;
      if (matched === undefined) {
        // Built by the shared constructor rather than spelled out here, so the
        // pool schedule a new conversation starts with is the same one the
        // in-memory store and the transitions use.
        conversation = openConversationForInbound({
          id: `conversation-${randomUUID()}`,
          tenantId: input.tenantId,
          storeId: input.storeId,
          channel: input.channel,
          externalCustomerId: input.externalCustomerId,
          externalConversationId: input.externalConversationId,
          now,
        });
        await this.insertConversation(client, conversation);
      } else {
        const touched = touchConversationForInbound(matched, now);
        if (!touched.ok) {
          throw new Error(`store invariant: inbound touch failed: ${touched.reason}`);
        }
        const updated = await this.writeTransition(client, touched.conversation, matched.version);
        if (updated === undefined) {
          throw new Error('store invariant: inbound touch lost a concurrent race');
        }
        conversation = updated;
        reopened = conversation.status === 'open' && matched.status === 'closed';
      }

      const message: Message = {
        id: `message-${randomUUID()}`,
        tenantId: input.tenantId,
        storeId: input.storeId,
        conversationId: conversation.id,
        channel: input.channel,
        direction: 'inbound',
        source: null,
        messageType: input.messageType ?? 'text',
        content: input.content,
        dedupKey,
        reviewEligible: false,
        reviewState: 'none',
        candidateId: null,
        // The row is written before its media is fetched: the customer's
        // message is kept whether or not the platform comes to hold the bytes,
        // and `attachMessageMedia` fills this in afterwards.
        media: null,
        createdAt: now,
      };
      const inserted = await this.insertMessage(client, message);
      if (inserted === undefined) {
        const winner =
          dedupKey === null
            ? undefined
            : await this.messageByDedupKey(client, input.tenantId, dedupKey);
        if (winner === undefined) {
          throw new Error('store invariant: message already exists without a dedup key');
        }
        return {
          conversation: await this.replayedConversation(client, input.tenantId, winner),
          message: winner,
          created: false,
          reopened: false,
        };
      }

      await this.insertAudit(client, {
        tenantId: input.tenantId,
        actorMemberId: null,
        action: AUDIT_ACTIONS.inboundMessageIngested,
        targetType: 'message',
        targetId: inserted.id,
        createdAt: now,
      });

      return { conversation, message: inserted, created: true, reopened };
    });
  }

  // --------------------------------------------------------------------------
  // Assignment
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async setAgentPresence(input: SetAgentPresenceRecord): Promise<AgentPresence> {
    // An upsert rather than a read-then-write: the first `accepting` is what puts
    // a seat into the dispatch pool, and two concurrent first reports must not
    // both decide they are creating the row.
    //
    // `changed_at` only moves when the status actually differs, so re-reporting
    // the current status does not reset "how long has this seat been away".
    const rows = await this.rows(
      `INSERT INTO agent_presence
         (tenant_id, member_id, store_id, status, heartbeat_at, changed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (tenant_id, member_id) DO UPDATE
         SET store_id = EXCLUDED.store_id,
             status = EXCLUDED.status,
             heartbeat_at = EXCLUDED.heartbeat_at,
             changed_at = CASE
               WHEN agent_presence.status = EXCLUDED.status THEN agent_presence.changed_at
               ELSE EXCLUDED.changed_at
             END
       RETURNING *`,
      [input.tenantId, input.memberId, input.storeId, input.status, input.now],
    );
    return required(rows[0], toAgentPresence);
  }

  /** @inheritdoc */
  async getAgentPresence(tenantId: string, memberId: string): Promise<AgentPresence | undefined> {
    const rows = await this.rows(
      'SELECT * FROM agent_presence WHERE tenant_id = $1 AND member_id = $2',
      [tenantId, memberId],
    );
    return optional(rows[0], toAgentPresence);
  }

  /** @inheritdoc */
  async listTenantAgentPresence(tenantId: string): Promise<ReadonlyArray<AgentPresence>> {
    // Ordered by member id so a roster's rows do not reshuffle between polls: a
    // lamp that moves every five seconds reads as change that did not happen.
    const rows = await this.rows(
      'SELECT * FROM agent_presence WHERE tenant_id = $1 ORDER BY member_id',
      [tenantId],
    );
    return rows.map(toAgentPresence);
  }

  /** @inheritdoc */
  async heartbeatAgentPresence(
    tenantId: string,
    memberId: string,
    now: string,
  ): Promise<AgentPresence | undefined> {
    // `heartbeat_at` only, and no insert: a heartbeat must not move `changed_at`
    // and must not invent a status the agent never set.
    const rows = await this.rows(
      `UPDATE agent_presence SET heartbeat_at = $3
        WHERE tenant_id = $1 AND member_id = $2
        RETURNING *`,
      [tenantId, memberId, now],
    );
    return optional(rows[0], toAgentPresence);
  }

  /** @inheritdoc */
  async listAssignmentCandidates(
    tenantId: string,
    storeId: string | undefined,
  ): Promise<ReadonlyArray<AssignmentCandidate>> {
    return this.readCandidates(this.rows.bind(this), tenantId, storeId);
  }

  /** @inheritdoc */
  async listAssignments(
    tenantId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<ConversationAssignment>> {
    const rows = await this.rows(
      `SELECT * FROM conversation_assignments
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC, id DESC`,
      [tenantId, conversationId],
    );
    return rows.map(toAssignment);
  }

  /** @inheritdoc */
  async lastHandoverFrom(
    tenantId: string,
    conversationId: string,
    memberId: string,
  ): Promise<string | undefined> {
    const rows = await this.rows(
      `SELECT created_at FROM conversation_assignments
        WHERE tenant_id = $1 AND conversation_id = $2
          AND from_member_id = $3 AND result = 'success'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [tenantId, conversationId, memberId],
    );
    const row = rows[0];
    // `toIso`, not the raw column: the driver hands back a `Date` for a
    // `TIMESTAMPTZ`, and the contract on this method (and what the in-memory
    // adapter returns) is the ISO instant. A `Date` here compares unequal to the
    // string it prints the same as, which is a difference that only shows up in a
    // test that asserts the instant itself.
    return row === undefined ? undefined : toIso(row['created_at']);
  }

  /** @inheritdoc */
  async dispatchDue(input: DispatchDueInput): Promise<ReadonlyArray<DispatchOutcome>> {
    return this.transactions.run(async (client) => {
      // Deliberately *not* `FOR UPDATE SKIP LOCKED` and no lease: between this
      // read and the write below there is one candidate select and one sort, no
      // external call and no I/O that can hang. The arbiter is the compare-and-
      // swap in `executePlan`; a lease would only add a recovery path with
      // nowhere to recover to.
      const dueRows = (
        await this.statement(
          client,
          `SELECT * FROM conversations
            WHERE status = 'open' AND assigned_member_id IS NULL
              AND next_assignment_at IS NOT NULL AND next_assignment_at <= $1
            ORDER BY next_assignment_at, id
            LIMIT $2`,
          [input.now, input.limit],
        )
      ).rows;
      // The `WHERE` narrows the scan; the shared rule then decides. Going through
      // `isAssignmentDue` rather than trusting the SQL alone is what keeps the two
      // adapters' notion of "in the pool" from drifting apart.
      const due = dueRows.map(toConversation).filter(isAssignmentDue);

      // Candidates are read once per (tenant, store), not once per conversation:
      // a busy store would otherwise turn one sweep into a quadratic number of
      // candidate queries.
      const byScope = new Map<string, ReadonlyArray<AssignmentCandidate>>();
      for (const conversation of due) {
        const key = scopeKey(conversation.tenantId, conversation.storeId);
        if (!byScope.has(key)) {
          byScope.set(
            key,
            await this.readCandidates(
              async (text, values) => (await this.statement(client, text, values)).rows,
              conversation.tenantId,
              conversation.storeId,
            ),
          );
        }
      }

      const outcomes: DispatchOutcome[] = [];
      for (const conversation of due) {
        const candidates = byScope.get(scopeKey(conversation.tenantId, conversation.storeId)) ?? [];
        const plan = planAutoAssign({ conversation, candidates, now: input.now });
        outcomes.push(await this.executePlan(client, conversation, plan, input.now));
      }
      return outcomes;
    });
  }

  // --------------------------------------------------------------------------
  // Review
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async getReviewPolicy(): Promise<ReviewPolicy> {
    const rows = await this.rows('SELECT * FROM review_policy WHERE id = $1', [
      PLATFORM_REVIEW_POLICY_ID,
    ]);
    const row = rows[0];
    return row === undefined ? defaultReviewPolicy() : toReviewPolicy(row);
  }

  /** @inheritdoc */
  async setReviewPolicy(policy: ReviewPolicy): Promise<ReviewPolicy> {
    await this.rows(
      `INSERT INTO review_policy (id, scope, require_review, require_review_for_sources, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         require_review = EXCLUDED.require_review,
         require_review_for_sources = EXCLUDED.require_review_for_sources,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [
        policy.id,
        policy.scope,
        policy.requireReview,
        [...policy.requireReviewForSources],
        policy.updatedBy,
        policy.updatedAt,
      ],
    );
    return policy;
  }

  /** @inheritdoc */
  async listReviewQueue(tenantId: string, storeId?: string): Promise<ReadonlyArray<Message>> {
    const rows = await this.rows(
      `SELECT * FROM messages
        WHERE tenant_id = $1
          AND review_eligible
          AND review_state = 'pending'
          AND ($2::text IS NULL OR store_id = $2)
        ORDER BY created_at ASC, id ASC`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toMessage);
  }

  /** @inheritdoc */
  async approveMessage(
    tenantId: string,
    messageId: string,
    approvedBy: string,
    now: string,
  ): Promise<ApprovalResult> {
    return this.transactions.run(async (client) => {
      const current = await this.lockMessage(client, tenantId, messageId);
      if (current === undefined) {
        return { ok: false, code: 'not_found', reason: 'message not found in tenant scope' };
      }
      if (!current.reviewEligible) {
        return {
          ok: false,
          code: 'not_eligible',
          reason: 'message source is not eligible for review',
        };
      }
      if (current.reviewState === 'approved' || current.reviewState === 'rejected') {
        return {
          ok: false,
          code: 'already_reviewed',
          reason: `message is already ${current.reviewState}`,
        };
      }

      const approvedRow = (
        await this.statement(
          client,
          `UPDATE messages SET review_state = 'approved'
            WHERE tenant_id = $1 AND id = $2
              AND review_eligible
              AND review_state NOT IN ('approved', 'rejected')
            RETURNING *`,
          [tenantId, messageId],
        )
      ).rows[0];
      if (approvedRow === undefined) {
        return {
          ok: false,
          code: 'already_reviewed',
          reason: 'message was reviewed concurrently',
        };
      }
      const approved = toMessage(approvedRow);

      const phrase: ApprovedPhrase = {
        id: `phrase-${randomUUID()}`,
        tenantId,
        storeId: approved.storeId,
        phrase: approved.content,
        sourceMessageId: approved.id,
        approvedBy,
        createdAt: now,
      };
      await this.statement(
        client,
        `INSERT INTO approved_phrases (id, tenant_id, store_id, phrase, source_message_id, approved_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          phrase.id,
          phrase.tenantId,
          phrase.storeId,
          phrase.phrase,
          phrase.sourceMessageId,
          phrase.approvedBy,
          phrase.createdAt,
        ],
      );
      await this.insertAudit(client, {
        tenantId,
        actorMemberId: approvedBy,
        action: AUDIT_ACTIONS.messageApproved,
        targetType: 'message',
        targetId: approved.id,
        metadata: { phraseId: phrase.id },
        createdAt: now,
      });

      return { ok: true, message: approved, phrase };
    });
  }

  /** @inheritdoc */
  async listApprovedPhrases(tenantId: string): Promise<ReadonlyArray<ApprovedPhrase>> {
    const rows = await this.rows(
      'SELECT * FROM approved_phrases WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
      [tenantId],
    );
    return rows.map(toApprovedPhrase);
  }

  // --------------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async createSuggestionSet(input: CreateSuggestionSetRecord): Promise<SuggestionSet> {
    const now = input.now ?? new Date().toISOString();
    return this.transactions.run(async (client) => {
      const id = `suggestion-${randomUUID()}`;
      const rows = (
        await this.statement(
          client,
          `INSERT INTO suggestion_sets (id, tenant_id, store_id, conversation_id, provider, candidates, fallback_reasons, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           RETURNING *`,
          [
            id,
            input.tenantId,
            input.storeId,
            input.conversationId,
            input.provider,
            JSON.stringify(input.candidates),
            JSON.stringify(input.fallbackReasons),
            now,
          ],
        )
      ).rows;
      const set = required(rows[0], toSuggestionSet);
      await this.insertAudit(client, {
        tenantId: input.tenantId,
        actorMemberId: null,
        action: AUDIT_ACTIONS.suggestionGenerated,
        targetType: 'suggestion',
        targetId: set.id,
        metadata: { conversationId: input.conversationId, candidateCount: set.candidates.length },
        createdAt: now,
      });
      return set;
    });
  }

  /** @inheritdoc */
  async getSuggestionSet(
    tenantId: string,
    suggestionId: string,
  ): Promise<SuggestionSet | undefined> {
    const rows = await this.rows('SELECT * FROM suggestion_sets WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      suggestionId,
    ]);
    return optional(rows[0], toSuggestionSet);
  }

  /** @inheritdoc */
  async listSuggestionSets(tenantId: string): Promise<ReadonlyArray<SuggestionSet>> {
    const rows = await this.rows(
      'SELECT * FROM suggestion_sets WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
      [tenantId],
    );
    return rows.map(toSuggestionSet);
  }

  // --------------------------------------------------------------------------
  // Audit and retention
  // --------------------------------------------------------------------------

  /** @inheritdoc */
  async appendAudit(input: AppendAuditRecord): Promise<AuditEntry> {
    const entry = createAuditEntry({ id: `audit-${randomUUID()}`, ...input });
    await this.rows(
      `INSERT INTO audit_log (id, tenant_id, actor_member_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id`,
      [
        entry.id,
        entry.tenantId,
        entry.actorMemberId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.metadata),
        entry.createdAt,
      ],
    );
    return entry;
  }

  /** @inheritdoc */
  async listAudit(tenantId: string): Promise<ReadonlyArray<AuditEntry>> {
    const rows = await this.rows(
      'SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
      [tenantId],
    );
    return rows.map(toAuditEntry);
  }

  /** @inheritdoc */
  async summarizeRetention(tenantId: string, now: string): Promise<RetentionSummary> {
    const expiredCountByEntity: Record<string, number> = {};
    expiredCountByEntity['message'] = await this.countExpired(
      `SELECT count(*) AS count FROM messages
        WHERE tenant_id = $1 AND created_at <= $2`,
      tenantId,
      retentionCutoff(now, 'message'),
    );
    expiredCountByEntity['conversation'] = await this.countExpired(
      `SELECT count(*) AS count FROM conversations
        WHERE tenant_id = $1 AND status = 'closed'
          AND COALESCE(closed_at, last_message_at) <= $2`,
      tenantId,
      retentionCutoff(now, 'conversation'),
    );
    expiredCountByEntity['audit_log'] = await this.countExpired(
      `SELECT count(*) AS count FROM audit_log
        WHERE tenant_id = $1 AND created_at <= $2`,
      tenantId,
      retentionCutoff(now, 'audit_log'),
    );
    expiredCountByEntity['approved_phrase'] = await this.countExpired(
      `SELECT count(*) AS count FROM approved_phrases
        WHERE tenant_id = $1 AND created_at <= $2`,
      tenantId,
      retentionCutoff(now, 'approved_phrase'),
    );

    const totalExpired = Object.values(expiredCountByEntity).reduce((sum, value) => sum + value, 0);
    return Object.freeze({
      tenantId,
      evaluatedAt: now,
      policies: Object.freeze(tenantRetentionPolicies(tenantId)),
      expiredCountByEntity: Object.freeze(expiredCountByEntity),
      totalExpired,
    });
  }

  // --------------------------------------------------------------------------
  // Internals: reads
  // --------------------------------------------------------------------------

  /** Run one parameterised statement on the pool and return its result. */
  private async query(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<QueryResultRow>> {
    return (await this.database.pool.query(text, [...values])) as QueryResult<QueryResultRow>;
  }

  /** Run one parameterised statement on the pool and return its rows. */
  private async rows(
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<ReadonlyArray<QueryResultRow>> {
    return (await this.query(text, values)).rows;
  }

  /** Run one parameterised statement on a transaction connection. */
  private async statement(
    client: TransactionClient,
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<QueryResultRow>> {
    return (await client.query(text, [...values])) as QueryResult<QueryResultRow>;
  }

  /** Count the rows a retention cutoff query matches for one tenant. */
  private async countExpired(text: string, tenantId: string, cutoffIso: string): Promise<number> {
    const rows = await this.rows(text, [tenantId, cutoffIso]);
    const row = rows[0];
    return row === undefined ? 0 : toNumber(row['count']);
  }

  // --------------------------------------------------------------------------
  // Internals: conversation transitions
  // --------------------------------------------------------------------------

  /**
   * Apply one conversation transition inside a transaction.
   *
   * The row is locked first, so two concurrent transitions serialise on it: the
   * second one re-reads the committed row and fails its own version/state
   * predicate instead of overwriting the first. The caller's own error code is
   * preserved, which is what keeps the HTTP contract (`conflict`,
   * `not_claimed`, `invalid_state`, `not_found`) identical to the in-memory
   * adapter's.
   *
   * The state change, the assignment-history row and the audit entry are written
   * in this one transaction, so a claim can never be observable without its
   * history: a crash either commits all three or none.
   */
  private async transition(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly transitionOf: (conversation: Conversation) => ConversationTransition;
    readonly auditAction: string;
    readonly action: AssignmentAction;
    readonly actorMemberId: string;
    readonly toMemberId: string | null;
    readonly now: string;
  }): Promise<StoreConversationResult> {
    const { tenantId, conversationId, now } = input;
    return this.transactions.run(async (client) => {
      const current = await this.lockConversation(client, tenantId, conversationId);
      if (current === undefined) {
        // No history row: the conversation does not exist, and the history
        // table's foreign key would refuse a row for it. A missing conversation
        // is answered by the 404.
        return {
          ok: false,
          code: 'not_found',
          reason: 'conversation not found in tenant scope',
        } as const;
      }
      const outcome = input.transitionOf(current);
      if (!outcome.ok) {
        // A refusal is recorded as deliberately as a success — this is the row
        // that answers "who lost the race for it", which the assignee column
        // alone never could.
        await this.insertAssignment(client, {
          tenantId,
          storeId: current.storeId,
          conversationId,
          action: input.action,
          result: 'rejected',
          reasonCode: rejectionReasonCode(outcome.code),
          fromMemberId: current.assignedMemberId,
          toMemberId: input.toMemberId,
          stateVersionBefore: current.version,
          stateVersionAfter: null,
          now,
        });
        return { ok: false, code: outcome.code, reason: outcome.reason } as const;
      }
      const updated = await this.writeTransition(client, outcome.conversation, current.version);
      if (updated === undefined) {
        // The row moved between the lock being taken and the write being issued,
        // which in this transaction can only be a version that no longer matches.
        await this.insertAssignment(client, {
          tenantId,
          storeId: current.storeId,
          conversationId,
          action: input.action,
          result: 'rejected',
          reasonCode: 'cas_conflict',
          fromMemberId: current.assignedMemberId,
          toMemberId: input.toMemberId,
          stateVersionBefore: current.version,
          stateVersionAfter: null,
          now,
        });
        return {
          ok: false,
          code: 'conflict',
          reason: 'conversation changed concurrently',
        } as const;
      }
      await this.insertAssignment(client, {
        tenantId,
        storeId: current.storeId,
        conversationId,
        action: input.action,
        result: 'success',
        reasonCode: null,
        fromMemberId: current.assignedMemberId,
        toMemberId: updated.assignedMemberId,
        stateVersionBefore: current.version,
        stateVersionAfter: updated.version,
        now,
      });
      await this.insertAudit(client, {
        tenantId,
        actorMemberId: input.actorMemberId,
        action: input.auditAction,
        targetType: 'conversation',
        targetId: conversationId,
        createdAt: now,
      });
      return { ok: true, conversation: updated } as const;
    });
  }

  /** Lock one conversation row inside the tenant scope. */
  private async lockConversation(
    client: TransactionClient,
    tenantId: string,
    conversationId: string,
  ): Promise<Conversation | undefined> {
    const rows = (
      await this.statement(
        client,
        'SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [tenantId, conversationId],
      )
    ).rows;
    return optional(rows[0], toConversation);
  }

  /** Lock the conversation one external conversation id resolves to. */
  private async lockConversationByExternal(
    client: TransactionClient,
    input: {
      readonly tenantId: string;
      readonly storeId: string;
      readonly channel: string;
      readonly externalConversationId: string;
    },
  ): Promise<Conversation | undefined> {
    const rows = (
      await this.statement(
        client,
        `SELECT * FROM conversations
          WHERE tenant_id = $1 AND store_id = $2 AND channel = $3 AND external_conversation_id = $4
          ORDER BY id
          LIMIT 1
          FOR UPDATE`,
        [input.tenantId, input.storeId, input.channel, input.externalConversationId],
      )
    ).rows;
    return optional(rows[0], toConversation);
  }

  /**
   * Write the transition-mutable columns of a conversation.
   *
   * `version` is both written and matched, so a row that changed since it was
   * read is refused rather than silently overwritten.
   */
  private async writeTransition(
    client: TransactionClient,
    next: Conversation,
    expectedVersion: number,
  ): Promise<Conversation | undefined> {
    const rows = (
      await this.statement(
        client,
        `UPDATE conversations
            SET status = $3,
                assigned_member_id = $4,
                closed_at = $5,
                version = $6,
                last_message_at = $7,
                pending_since = $9,
                first_response_started_at = $10,
                next_assignment_at = $11,
                dispatch_attempts = $12,
                assigned_at = $13,
                offline_reply_at = $14,
                first_reply_at = $15
          WHERE tenant_id = $1 AND id = $2 AND version = $8
          RETURNING *`,
        [
          next.tenantId,
          next.id,
          next.status,
          next.assignedMemberId,
          next.closedAt,
          next.version,
          next.lastMessageAt,
          expectedVersion,
          next.pendingSince,
          next.firstResponseStartedAt,
          next.nextAssignmentAt,
          next.dispatchAttempts,
          next.assignedAt,
          next.offlineReplyAt,
          next.firstReplyAt,
        ],
      )
    ).rows;
    return optional(rows[0], toConversation);
  }

  /** Bump `last_message_at` without changing the optimistic version. */
  private async touchConversation(
    client: TransactionClient,
    tenantId: string,
    conversationId: string,
    now: string,
  ): Promise<void> {
    await this.statement(
      client,
      'UPDATE conversations SET last_message_at = $3 WHERE tenant_id = $1 AND id = $2',
      [tenantId, conversationId, now],
    );
  }

  /**
   * Stamp the first outbound of the current round, if it is not stamped already.
   *
   * Compare-by-empty rather than read-then-write: `first_reply_at IS NULL` is in
   * the `WHERE`, so two concurrent first replies cannot both decide they are the
   * first one. Like `touchConversation`, this deliberately does not bump
   * `version` — no client sees this column, and bumping it would make an
   * unrelated optimistic mutation fail.
   */
  private async recordFirstReplyAt(
    client: TransactionClient,
    tenantId: string,
    conversationId: string,
    now: string,
  ): Promise<void> {
    await this.statement(
      client,
      `UPDATE conversations SET first_reply_at = $3
        WHERE tenant_id = $1 AND id = $2 AND first_reply_at IS NULL`,
      [tenantId, conversationId, now],
    );
  }

  /** Insert a conversation created by a first inbound message. */
  private async insertConversation(
    client: TransactionClient,
    conversation: Conversation,
  ): Promise<void> {
    await this.statement(
      client,
      `INSERT INTO conversations (
         id, tenant_id, store_id, channel, external_customer_id, external_conversation_id,
         title, status, version, assigned_member_id, opened_at, last_message_at, closed_at, created_at,
         pending_since, first_response_started_at, next_assignment_at, dispatch_attempts,
         assigned_at, offline_reply_at, first_reply_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20, $21)`,
      [
        conversation.id,
        conversation.tenantId,
        conversation.storeId,
        conversation.channel,
        conversation.externalCustomerId,
        conversation.externalConversationId,
        conversation.title,
        conversation.status,
        conversation.version,
        conversation.assignedMemberId,
        conversation.openedAt,
        conversation.lastMessageAt,
        conversation.closedAt,
        conversation.createdAt,
        conversation.pendingSince,
        conversation.firstResponseStartedAt,
        conversation.nextAssignmentAt,
        conversation.dispatchAttempts,
        conversation.assignedAt,
        conversation.offlineReplyAt,
        conversation.firstReplyAt,
      ],
    );
  }

  // --------------------------------------------------------------------------
  // Internals: messages and audit
  // --------------------------------------------------------------------------

  /**
   * Insert a message, letting the dedup index refuse a duplicate.
   *
   * @returns The stored message, or `undefined` when a concurrent request had
   * already written the same `dedup_key` for this tenant.
   */
  private async insertMessage(
    client: TransactionClient,
    message: Message,
  ): Promise<Message | undefined> {
    const values = [
      message.id,
      message.tenantId,
      message.storeId,
      message.conversationId,
      message.channel,
      message.direction,
      message.source,
      message.messageType,
      message.content,
      message.dedupKey,
      message.reviewEligible,
      message.reviewState,
      message.candidateId,
      message.createdAt,
    ];
    const conflictClause =
      message.dedupKey === null
        ? ''
        : 'ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING';
    const rows = (
      await this.statement(
        client,
        `INSERT INTO messages (
           id, tenant_id, store_id, conversation_id, channel, direction, source, message_type,
           content, dedup_key, review_eligible, review_state, candidate_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ${conflictClause}
         RETURNING *`,
        values,
      )
    ).rows;
    return optional(rows[0], toMessage);
  }

  /** Read the message a dedup key already resolved to, if any. */
  private async messageByDedupKey(
    client: TransactionClient,
    tenantId: string,
    dedupKey: string,
  ): Promise<Message | undefined> {
    const rows = (
      await this.statement(
        client,
        'SELECT * FROM messages WHERE tenant_id = $1 AND dedup_key = $2',
        [tenantId, dedupKey],
      )
    ).rows;
    return optional(rows[0], toMessage);
  }

  /** Lock one message row inside the tenant scope. */
  private async lockMessage(
    client: TransactionClient,
    tenantId: string,
    messageId: string,
  ): Promise<Message | undefined> {
    const rows = (
      await this.statement(
        client,
        'SELECT * FROM messages WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [tenantId, messageId],
      )
    ).rows;
    return optional(rows[0], toMessage);
  }

  /** Resolve the conversation a replay must be reported against. */
  private async replayedConversation(
    client: TransactionClient,
    tenantId: string,
    message: Message,
  ): Promise<Conversation> {
    const conversation = await this.lockConversation(client, tenantId, message.conversationId);
    if (conversation === undefined) {
      throw new Error('store invariant: message references a missing conversation');
    }
    return conversation;
  }

  /**
   * Read one store's agent seats, with presence and load.
   *
   * Takes a query function so the same statement serves both the pooled read
   * (nobody has a transaction open) and the dispatcher's per-sweep read. Note
   * what it does **not** filter: `enabled` is returned as a column rather than
   * used in the `WHERE`, because eligibility is a rule in `@kefu/core` and an
   * adapter that pre-filtered would be a second copy of it, free to drift.
   *
   * `p.status` is the row's own value; a seat that has never connected joins to
   * NULL and is reported `offline`. The liveness *window* is applied by the
   * shared rule, not here.
   */
  private async readCandidates(
    query: (text: string, values: ReadonlyArray<unknown>) => Promise<ReadonlyArray<QueryResultRow>>,
    tenantId: string,
    storeId: string | undefined,
  ): Promise<ReadonlyArray<AssignmentCandidate>> {
    const rows = await query(
      `SELECT m.id, m.tenant_id, m.store_id, m.role, m.enabled,
              p.status AS presence_status, p.heartbeat_at,
              (SELECT count(*) FROM conversations c
                WHERE c.tenant_id = m.tenant_id
                  AND c.assigned_member_id = m.id
                  AND c.status = 'claimed') AS in_progress_count
         FROM members m
         LEFT JOIN agent_presence p
           ON p.tenant_id = m.tenant_id AND p.member_id = m.id
        WHERE m.tenant_id = $1
          AND ($2::text IS NULL OR m.store_id = $2)
          AND m.role = 'agent'
        ORDER BY m.id`,
      [tenantId, storeId ?? null],
    );
    return rows.map(toAssignmentCandidate);
  }

  /**
   * Execute one {@link AutoAssignPlan} verdict, reporting what it did.
   *
   * Every branch is a compare-and-swap whose `WHERE` carries the version, the
   * status and the assignee, so at most one concurrent sweep can match a given
   * conversation — the same mechanism the claim path uses, and the reason no
   * lease is needed.
   */
  private async executePlan(
    client: TransactionClient,
    conversation: Conversation,
    plan: ReturnType<typeof planAutoAssign>,
    now: string,
  ): Promise<DispatchOutcome> {
    const { tenantId, storeId, id: conversationId } = conversation;

    switch (plan.kind) {
      case 'skip':
        // `dispatchDue` only offers due conversations, so this cannot happen.
        return { kind: 'lost', conversationId };

      case 'assign': {
        const updated = (
          await this.statement(
            client,
            `UPDATE conversations
                SET status = 'claimed',
                    assigned_member_id = $3,
                    assigned_at = $4,
                    version = version + 1,
                    next_assignment_at = NULL,
                    dispatch_attempts = 0
              WHERE tenant_id = $1 AND id = $2 AND version = $5
                AND status = 'open' AND assigned_member_id IS NULL
              RETURNING version`,
            [tenantId, conversationId, plan.toMemberId, now, conversation.version],
          )
        ).rows;
        if (updated[0] === undefined) {
          // Somebody claimed it first. Writing nothing is the whole point: the
          // winner already cleared the due time, so this row has left the sweep.
          return { kind: 'lost', conversationId };
        }
        await this.insertAssignment(client, {
          tenantId,
          storeId,
          conversationId,
          action: 'auto_assign',
          result: 'success',
          reasonCode: null,
          fromMemberId: conversation.assignedMemberId,
          toMemberId: plan.toMemberId,
          stateVersionBefore: conversation.version,
          stateVersionAfter: toNumber(updated[0]['version']),
          now,
        });
        await this.insertAudit(client, {
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
        // `offline_reply_at IS NULL` is in the `WHERE`, not left to `COALESCE`:
        // two sweeps that both read a null must not both conclude they are the
        // one sending the reply. Whoever's write lands is the sender; the other
        // sees zero rows and reports `lost` without sending anything.
        //
        // `version` is deliberately untouched — bumping it would make a
        // concurrent sweep's compare-and-swap fail for no reason, and no client
        // echoes this column back. `next_assignment_at` is untouched too, so the
        // entry *stays due* and the next sweep retries: the pool is the retry.
        const updated = (
          await this.statement(
            client,
            `UPDATE conversations
                SET dispatch_attempts = dispatch_attempts + 1,
                    offline_reply_at = $4
              WHERE tenant_id = $1 AND id = $2 AND version = $3
                AND status = 'open' AND assigned_member_id IS NULL
                AND next_assignment_at = $5
                AND offline_reply_at IS NULL
              RETURNING id`,
            [tenantId, conversationId, conversation.version, now, conversation.nextAssignmentAt],
          )
        ).rows;
        if (updated[0] === undefined) {
          return { kind: 'lost', conversationId };
        }
        await this.insertAssignment(client, {
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
        await this.insertAudit(client, {
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
        // Already acknowledged and still nobody available. Writes nothing at all:
        // a conversation parked in the pool must not cost a row rewrite every
        // sweep for as long as it waits.
        return { kind: 'waiting', conversationId };
    }
  }

  /** Append one assignment-history row inside an open transaction. */
  private async insertAssignment(
    client: TransactionClient,
    input: {
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
    },
  ): Promise<void> {
    await this.statement(
      client,
      `INSERT INTO conversation_assignments (
         id, tenant_id, store_id, conversation_id, action, result, reason_code,
         from_member_id, to_member_id, state_version_before, state_version_after, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        `assignment-${randomUUID()}`,
        input.tenantId,
        input.storeId,
        input.conversationId,
        input.action,
        input.result,
        input.reasonCode,
        input.fromMemberId,
        input.toMemberId,
        input.stateVersionBefore,
        input.stateVersionAfter,
        input.now,
      ],
    );
  }

  /** Append one immutable audit entry inside an open transaction. */
  private async insertAudit(client: TransactionClient, input: AppendAuditRecord): Promise<void> {
    const entry = createAuditEntry({ id: `audit-${randomUUID()}`, ...input });
    await this.statement(
      client,
      `INSERT INTO audit_log (id, tenant_id, actor_member_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        entry.id,
        entry.tenantId,
        entry.actorMemberId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.metadata),
        entry.createdAt,
      ],
    );
  }
}

// ----------------------------------------------------------------------------
// Row mappers
// ----------------------------------------------------------------------------

/** Return the mapped first row, or `undefined` when the result was empty. */
function optional<T>(
  row: QueryResultRow | undefined,
  map: (row: QueryResultRow) => T,
): T | undefined {
  return row === undefined ? undefined : map(row);
}

/** Map a row that must exist, failing loudly when the statement returned none. */
function required<T>(row: QueryResultRow | undefined, map: (row: QueryResultRow) => T): T {
  if (row === undefined) {
    throw new Error('store invariant: statement returned no row');
  }
  return map(row);
}

function toTenant(row: QueryResultRow): Tenant {
  return {
    id: toText(row['id']),
    code: toText(row['code']),
    name: toText(row['name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toStore(row: QueryResultRow): Store {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    code: toText(row['code']),
    name: toText(row['name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toMember(row: QueryResultRow): Member {
  return {
    id: toText(row['id']),
    tenantId: toTextOrNull(row['tenant_id']),
    storeId: toTextOrNull(row['store_id']),
    role: toText(row['role']) as Member['role'],
    username: toText(row['username']),
    displayName: toText(row['display_name']),
    enabled: toBoolean(row['enabled']),
    createdAt: toIso(row['created_at']),
  };
}

function toProduct(row: QueryResultRow): Product {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    sku: toText(row['sku']),
    title: toText(row['title']),
    description: toText(row['description']),
    enabled: toBoolean(row['enabled']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toFaqItem(row: QueryResultRow): FaqItem {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    question: toText(row['question']),
    answer: toText(row['answer']),
    tags: toStringArray(row['tags']),
    enabled: toBoolean(row['enabled']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toShortcut(row: QueryResultRow): Shortcut {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    scopeType: toText(row['scope_type']) as ShortcutScopeType,
    storeId: toTextOrNull(row['store_id']),
    code: toText(row['code']),
    title: toText(row['title']),
    content: toText(row['content']),
    intentCode: toTextOrNull(row['intent_code']),
    sortOrder: toNumber(row['sort_order']),
    enabled: toBoolean(row['enabled']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toFaqQuestionVariant(row: QueryResultRow): FaqQuestionVariant {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    faqId: toText(row['faq_id']),
    questionText: toText(row['question_text']),
    source: toText(row['source']) as FaqVariantSource,
    status: toText(row['status']) as FaqVariantStatus,
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toImportBatch(row: QueryResultRow): ProductImportBatch {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    sourceType: toText(row['source_type']) as ImportSourceType,
    fileObjectKey: toTextOrNull(row['file_object_key']),
    fileSha256: toTextOrNull(row['file_sha256']),
    status: toText(row['status']) as ImportBatchStatus,
    totalRows: toNumber(row['total_rows']),
    successRows: toNumber(row['success_rows']),
    failedRows: toNumber(row['failed_rows']),
    startedAt: toIsoOrNull(row['started_at']),
    finishedAt: toIsoOrNull(row['finished_at']),
    createdBy: toTextOrNull(row['created_by']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toImportError(row: QueryResultRow): ProductImportError {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    batchId: toText(row['batch_id']),
    rowNumber: toNumber(row['row_number']),
    fieldName: toTextOrNull(row['field_name']),
    errorCode: toText(row['error_code']),
    errorMessage: toTextOrNull(row['error_message']),
    rawValueMasked: toTextOrNull(row['raw_value_masked']),
    createdAt: toIso(row['created_at']),
  };
}

function toCategory(row: QueryResultRow): ProductCategory {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    parentId: toTextOrNull(row['parent_id']),
    code: toText(row['code']),
    name: toText(row['name']),
    status: toText(row['status']) as CategoryStatus,
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toCategoryAttribute(row: QueryResultRow): CategoryAttribute {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    categoryId: toText(row['category_id']),
    attributeCode: toText(row['attribute_code']),
    attributeName: toText(row['attribute_name']),
    valueType: toText(row['value_type']) as CatalogAttributeValueType,
    isRequired: toBoolean(row['is_required']),
    isSearchable: toBoolean(row['is_searchable']),
    allowedValues: toStringArray(row['allowed_values_json']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toSpu(row: QueryResultRow): ProductSpu {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    categoryId: toTextOrNull(row['category_id']),
    externalProductId: toTextOrNull(row['external_product_id']),
    productCode: toText(row['product_code']),
    title: toText(row['title']),
    subtitle: toTextOrNull(row['subtitle']),
    mainImageUrl: toTextOrNull(row['main_image_url']),
    productUrl: toTextOrNull(row['product_url']),
    sellingPoints: toStringArray(row['selling_points_json']),
    commonAttributes: toCatalogAttributes(row['common_attributes_json']),
    shelfStatus: toText(row['shelf_status']) as SpuShelfStatus,
    sourceType: toText(row['source_type']) as SpuSourceType,
    sourceUpdatedAt: toIsoOrNull(row['source_updated_at']),
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toSku(row: QueryResultRow): ProductSku {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    spuId: toText(row['spu_id']),
    externalSkuId: toTextOrNull(row['external_sku_id']),
    skuCode: toText(row['sku_code']),
    variant: toVariantAttributes(row['variant_json']),
    searchAttributes: toVariantAttributes(row['search_attributes_json']),
    status: toText(row['status']) as SkuStatus,
    updatedAt: toIso(row['updated_at']),
    createdAt: toIso(row['created_at']),
  };
}

/** Decode a `JSONB` column holding attribute code → scalar value. */
function toCatalogAttributes(value: unknown): CatalogAttributes {
  const entries = Object.entries(toRecord(value)).filter(
    (entry): entry is [string, CatalogAttributeValue] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
  );
  return Object.fromEntries(entries);
}

/** Decode a `JSONB` column holding dimension → text value. */
function toVariantAttributes(value: unknown): VariantAttributes {
  const entries = Object.entries(toRecord(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

function toConversation(row: QueryResultRow): Conversation {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    channel: toText(row['channel']),
    externalCustomerId: toText(row['external_customer_id']),
    externalConversationId: toTextOrNull(row['external_conversation_id']),
    title: toTextOrNull(row['title']),
    status: toText(row['status']) as Conversation['status'],
    version: toNumber(row['version']),
    assignedMemberId: toTextOrNull(row['assigned_member_id']),
    openedAt: toIso(row['opened_at']),
    lastMessageAt: toIso(row['last_message_at']),
    closedAt: toIsoOrNull(row['closed_at']),
    createdAt: toIso(row['created_at']),
    pendingSince: toIsoOrNull(row['pending_since']),
    firstResponseStartedAt: toIsoOrNull(row['first_response_started_at']),
    nextAssignmentAt: toIsoOrNull(row['next_assignment_at']),
    dispatchAttempts: toNumber(row['dispatch_attempts']),
    assignedAt: toIsoOrNull(row['assigned_at']),
    offlineReplyAt: toIsoOrNull(row['offline_reply_at']),
    firstReplyAt: toIsoOrNull(row['first_reply_at']),
  };
}

function toAgentPresence(row: QueryResultRow): AgentPresence {
  return {
    tenantId: toText(row['tenant_id']),
    memberId: toText(row['member_id']),
    storeId: toText(row['store_id']),
    status: toText(row['status']) as AgentPresence['status'],
    heartbeatAt: toIso(row['heartbeat_at']),
    changedAt: toIso(row['changed_at']),
    createdAt: toIso(row['created_at']),
  };
}

function toAssignment(row: QueryResultRow): ConversationAssignment {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    conversationId: toText(row['conversation_id']),
    action: toText(row['action']) as ConversationAssignment['action'],
    result: toText(row['result']) as ConversationAssignment['result'],
    reasonCode: toTextOrNull(row['reason_code']) as ConversationAssignment['reasonCode'],
    fromMemberId: toTextOrNull(row['from_member_id']),
    toMemberId: toTextOrNull(row['to_member_id']),
    stateVersionBefore: toNumber(row['state_version_before']),
    stateVersionAfter:
      row['state_version_after'] === null ? null : toNumber(row['state_version_after']),
    createdAt: toIso(row['created_at']),
  };
}

function toAssignmentCandidate(row: QueryResultRow): AssignmentCandidate {
  return {
    memberId: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toTextOrNull(row['store_id']),
    role: toText(row['role']) as AssignmentCandidate['role'],
    enabled: toBoolean(row['enabled']),
    // The presence row's own value, or `offline` when the seat has never
    // connected. The liveness *window* is applied by the shared eligibility
    // rule, not here, so the window exists in exactly one place.
    status: (row['presence_status'] === null
      ? 'offline'
      : toText(row['presence_status'])) as AssignmentCandidate['status'],
    heartbeatAt: toIsoOrNull(row['heartbeat_at']),
    inProgressCount: toNumber(row['in_progress_count']),
  };
}

/**
 * The stored media of one message row, or `null` when it has none.
 *
 * All three columns or none: migration `0013`'s CHECK keeps a half-written
 * reference from existing, and a row that somehow carried one is read as having
 * no media rather than a partial one — the transcript's fallback is the
 * placeholder, which is the truth for a message whose bytes cannot be located.
 *
 * @param row - One `messages` row.
 * @returns The reference, or `null`.
 */
function toMessageMedia(row: QueryResultRow): MessageMedia | null {
  const key = toTextOrNull(row['media_key']);
  const mimeType = toTextOrNull(row['media_mime']);
  const bytes = toNumberOrNull(row['media_bytes']);
  if (key === null || mimeType === null || bytes === null) {
    return null;
  }
  return { key, mimeType, bytes };
}

function toMessage(row: QueryResultRow): Message {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    conversationId: toText(row['conversation_id']),
    channel: toText(row['channel']),
    direction: toText(row['direction']) as Message['direction'],
    source: toTextOrNull(row['source']) as MessageSource | null,
    messageType: toText(row['message_type']) as Message['messageType'],
    content: toText(row['content']),
    dedupKey: toTextOrNull(row['dedup_key']),
    reviewEligible: toBoolean(row['review_eligible']),
    reviewState: toText(row['review_state']) as ReviewState,
    candidateId: toTextOrNull(row['candidate_id']),
    media: toMessageMedia(row),
    createdAt: toIso(row['created_at']),
  };
}

function toSuggestionCandidate(entry: Record<string, unknown>): SuggestionCandidate {
  return {
    rank: toNumber(entry['rank']),
    kind: toText(entry['kind']) as SuggestionCandidate['kind'],
    sourceId: toText(entry['sourceId']),
    tenantId: toText(entry['tenantId']),
    storeId: toText(entry['storeId']),
    title: toText(entry['title']),
    content: toText(entry['content']),
    score: toNumber(entry['score']),
  };
}

/**
 * The `provider` column as the union it is constrained to be.
 *
 * `suggestion_sets_provider_check` already makes any other value unstorable, so
 * this cannot fail on a row this repository wrote. It exists for the case the
 * constraint is widened — a second provider added by a migration — without this
 * union being widened with it, where the alternative is a bare string flowing
 * out to a client that has no branch for it. Same reading as the source-kind
 * check the indexer's mapper makes.
 */
function toSuggestionProvider(value: unknown): SuggestionProvider {
  const provider = toText(value);
  if (provider === 'none' || provider === 'deepseek') {
    return provider;
  }
  throw new Error(`suggestion provider ${provider} is not one of the providers a set records`);
}

function toSuggestionSet(row: QueryResultRow): SuggestionSet {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toText(row['store_id']),
    conversationId: toText(row['conversation_id']),
    provider: toSuggestionProvider(row['provider']),
    candidates: Object.freeze(toRecordArray(row['candidates']).map(toSuggestionCandidate)),
    fallbackReasons: Object.freeze(toStringArray(row['fallback_reasons'])),
    createdAt: toIso(row['created_at']),
  };
}

function toApprovedPhrase(row: QueryResultRow): ApprovedPhrase {
  return {
    id: toText(row['id']),
    tenantId: toText(row['tenant_id']),
    storeId: toTextOrNull(row['store_id']),
    phrase: toText(row['phrase']),
    sourceMessageId: toText(row['source_message_id']),
    approvedBy: toText(row['approved_by']),
    createdAt: toIso(row['created_at']),
  };
}

function toAuditEntry(row: QueryResultRow): AuditEntry {
  return {
    id: toText(row['id']),
    tenantId: toTextOrNull(row['tenant_id']),
    actorMemberId: toTextOrNull(row['actor_member_id']),
    action: toText(row['action']),
    targetType: toText(row['target_type']),
    targetId: toTextOrNull(row['target_id']),
    metadata: toRecord(row['metadata']),
    createdAt: toIso(row['created_at']),
  };
}

function toReviewPolicy(row: QueryResultRow): ReviewPolicy {
  const sources = toStringArray(row['require_review_for_sources']).filter(
    (source): source is MessageSource =>
      (MESSAGE_SOURCES as ReadonlyArray<string>).includes(source),
  );
  return createReviewPolicy({
    requireReview: toBoolean(row['require_review']),
    requireReviewForSources: sources,
    updatedBy: toTextOrNull(row['updated_by']),
    updatedAt: toIsoOrNull(row['updated_at']),
  });
}
