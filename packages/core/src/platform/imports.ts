/**
 * FAQ near-questions, and the record of a product import.
 *
 * Two things a merchant's knowledge base needs in order to be trusted: the ways
 * buyers actually phrase a question (so a reply is found for 什么时候发货？ as
 * well as 发货时间), and an honest account of what happened to the file they
 * uploaded. Both are declared here once so the SQL, the in-memory store and the
 * services all agree on the vocabulary.
 *
 * `SHORTCUT_SCOPE_TYPES` lives in `./types` next to `Shortcut`, which it
 * describes.
 *
 * The apply side of an import is described here too — the input the write path
 * takes (a whole plan, its refused lines and the counts) and the receipt it
 * produces. Those are the vocabulary the service, both repository adapters and
 * the HTTP layer have to agree on, which is the same reason the read types above
 * live here.
 */

import type { ProductImportPlan } from './product-import-plan';
import type { ProductImportIssue } from './product-import-parser';

/** How a near-question came to exist. */
export const FAQ_VARIANT_SOURCES = ['manual', 'generated', 'imported'] as const;
/** One near-question origin. */
export type FaqVariantSource = (typeof FAQ_VARIANT_SOURCES)[number];

/** Whether a near-question may be used to match. Reversible, like every 停用. */
export const FAQ_VARIANT_STATUSES = ['enabled', 'disabled'] as const;
/** One near-question state. */
export type FaqVariantStatus = (typeof FAQ_VARIANT_STATUSES)[number];

/** One way a buyer asks the FAQ's question. */
export type FaqQuestionVariant = {
  readonly id: string;
  readonly tenantId: string;
  readonly faqId: string;
  readonly questionText: string;
  readonly source: FaqVariantSource;
  readonly status: FaqVariantStatus;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to add a near-question to a FAQ. */
export type NewFaqQuestionVariant = {
  readonly tenantId: string;
  readonly faqId: string;
  readonly questionText: string;
  readonly source?: FaqVariantSource | undefined;
  readonly now?: string;
};

/** The mutable fields of a near-question; omitted fields keep their value. */
export type FaqQuestionVariantPatch = {
  readonly questionText?: string | undefined;
  readonly status?: FaqVariantStatus | undefined;
};

/** Where a product import file came from. */
export const IMPORT_SOURCE_TYPES = ['csv', 'xlsx', 'internal_api'] as const;
/** One import origin. */
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

/**
 * The life of an import batch.
 *
 * `partial_failed` is a first-class outcome rather than a kind of failure: a
 * sheet where 398 of 400 rows landed is a success the operator has to review,
 * not a failure to retry from scratch.
 */
export const IMPORT_BATCH_STATUSES = [
  'uploaded',
  'validating',
  'importing',
  'completed',
  'partial_failed',
  'failed',
] as const;
/** One import batch state. */
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/** One product import attempt. */
export type ProductImportBatch = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly sourceType: ImportSourceType;
  readonly fileObjectKey: string | null;
  readonly fileSha256: string | null;
  readonly status: ImportBatchStatus;
  readonly totalRows: number;
  readonly successRows: number;
  readonly failedRows: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to open an import batch. */
export type NewProductImportBatch = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly sourceType: ImportSourceType;
  readonly fileObjectKey?: string | null | undefined;
  readonly fileSha256?: string | null | undefined;
  readonly createdBy?: string | null | undefined;
  readonly now?: string;
};

/**
 * The mutable fields of a batch.
 *
 * Only the progress and the counts move: what a batch is about — the tenant, the
 * store, the file and its hash — is what it was, and rewriting that would make
 * the record a claim about a file that may never have been read.
 */
export type ProductImportBatchPatch = {
  readonly status?: ImportBatchStatus | undefined;
  readonly totalRows?: number | undefined;
  readonly successRows?: number | undefined;
  readonly failedRows?: number | undefined;
  readonly startedAt?: string | null | undefined;
  readonly finishedAt?: string | null | undefined;
};

/** One line of a failed import. */
export type ProductImportError = {
  readonly id: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly rowNumber: number;
  readonly fieldName: string | null;
  readonly errorCode: string;
  readonly errorMessage: string | null;
  readonly rawValueMasked: string | null;
  readonly createdAt: string;
};

/** Data used to record one failed line. */
export type NewProductImportError = {
  readonly tenantId: string;
  readonly batchId: string;
  readonly rowNumber: number;
  readonly errorCode: string;
  readonly fieldName?: string | null | undefined;
  readonly errorMessage?: string | null | undefined;
  readonly rawValueMasked?: string | null | undefined;
  readonly now?: string;
};

/** A batch and the lines that failed in it. */
export type ImportBatchWithErrors = {
  readonly batch: ProductImportBatch;
  readonly errors: ReadonlyArray<ProductImportError>;
};

/**
 * Data used to apply one whole import.
 *
 * The plan is the pure kernel's output: which products and variants to write,
 * and which rows it refused. The counts and the terminal status travel with it
 * rather than being derived by the adapter, because "what this batch ended as"
 * is a rule about what the operator is told, not a property of the rows being
 * written.
 *
 * `errors` arrives already in the batch's own error shape, one entry per line
 * the plan refused, so the adapter never has to interpret a rejection — it only
 * has to land the rows inside the same transaction as the writes.
 */
export type ApplyProductImportBatchInput = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly sourceType: ImportSourceType;
  readonly createdBy?: string | null | undefined;
  readonly plan: ProductImportPlan;
  readonly errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId' | 'now'>>;
  /** Terminal state of the batch; the service decides it, the adapter stores it. */
  readonly status: ImportBatchStatus;
  readonly totalRows: number;
  readonly successRows: number;
  readonly failedRows: number;
  readonly now?: string;
};

/**
 * What one applied import did, in counts an operator can read back.
 *
 * `created` and `updated` are kept apart because a file that added 40 products
 * and a file that overwrote 40 existing ones are different events, and a single
 * "imported" number would make them look the same. `totalRows` counts the data
 * rows the file had; the two failure counts are disjoint, so
 * `successRows + rejectedRowCount + unreadableRowCount = totalRows`.
 */
export type ProductImportApplySummary = {
  readonly totalRows: number;
  /** Data rows that landed (created or updated). */
  readonly successRows: number;
  /** Products this import added. */
  readonly createdSpuCount: number;
  /** Products this import overwrote. */
  readonly updatedSpuCount: number;
  /** Variants this import added. */
  readonly createdSkuCount: number;
  /** Variants this import overwrote. */
  readonly updatedSkuCount: number;
  /** Data rows the plan refused, each with a reason in `errors`. */
  readonly rejectedRowCount: number;
  /** Data rows the parser refused before the plan saw them. */
  readonly unreadableRowCount: number;
};

/**
 * The receipt of an applied import: its batch, its failed lines, its counts, and
 * what the operator should be told but no row can carry.
 *
 * `warnings` exists because `errors` cannot hold them. Every row in
 * `product_import_errors` is indexed by data-row number (the column's CHECK is
 * `>= 1`), which is what lets an operator line a failure up against the sheet.
 * A file-level warning has no such number: "这份表没有规格列，已按商品编码合成默认规格"
 * is a statement about the whole upload. Filing it as a row would mean inventing a
 * number, and inventing a number is how a receipt stops matching the file.
 *
 * So warnings are answered, not stored: this receipt and the preview's `issues`
 * are the only two places they appear, and `GET /import-batches/:id` will not
 * show them. That asymmetry is deliberate and recorded in the 二期方案 §5 — the
 * alternative is a schema change to give a batch somewhere rowless to keep them.
 *
 * The shape is deliberately the parser's own `ProductImportIssue`, so a client
 * renders a receipt warning with the very code it already uses for preview
 * issues.
 */
export type ProductImportApplyResult = {
  readonly batch: ProductImportBatch;
  readonly errors: ReadonlyArray<ProductImportError>;
  readonly warnings: ReadonlyArray<ProductImportIssue>;
  readonly summary: ProductImportApplySummary;
};
