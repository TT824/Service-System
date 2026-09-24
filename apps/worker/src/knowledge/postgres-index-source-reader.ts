/**
 * Durable {@link IndexSourceReader} over the three tables `0002` and `0010`
 * declare.
 *
 * The adapter owns exactly one decision — *which rows* are read — and states it
 * three times, once per `WHERE`:
 *
 * - **`tenant_id = $1` is the only filter.** No `enabled`, no `status`, no
 *   `updated_at` window. The first two are what `0011` requires: the copied
 *   usability flag on a chunk is corrected by the next index pass, and a pass
 *   that stopped reading switched-off sources would never correct it. The third
 *   is broader than this table: a delta read would make the write path's
 *   staleness comparison meaningless (see `index-source-reader`).
 * - **`ORDER BY id` on each read.** The job's inputs then arrive in one fixed
 *   order, so two passes over an unchanged tenant compare alike and a failure
 *   reproduces.
 *
 * Each statement is one round trip and reads one table — the variant read joins
 * its FAQ, which is where a near-question's store and its FAQ's state come from
 * (`index-source` maps both). Nothing here writes, and nothing here decides
 * usability: the rows leave this adapter exactly as the database holds them.
 */

import type { IndexSourceInput } from '@kefu/core';
import { WorkerDatabase } from '../database/worker-database';
import { toText } from '../database/row-values';
import { toIndexSources } from './index-source';
import type { IndexSourceReader } from './index-source-reader';

/** Every FAQ of one tenant. */
const FAQS_SQL = `SELECT * FROM faqs WHERE tenant_id = $1 ORDER BY id`;

/**
 * Every near-question of one tenant, with the two columns it does not own.
 *
 * The join is on `(tenant_id, id)`, the pair the platform scopes every
 * cross-table read by, and the aliases are the names `faqVariantIndexSource`
 * reads. An inner join is deliberate — see that mapper.
 */
const FAQ_VARIANTS_SQL = `
  SELECT v.*, f.store_id AS faq_store_id, f.enabled AS faq_enabled
    FROM faq_question_variants v
    JOIN faqs f ON f.tenant_id = v.tenant_id AND f.id = v.faq_id
   WHERE v.tenant_id = $1
   ORDER BY v.id`;

/** Every shortcut of one tenant, store-level and merchant-level alike. */
const SHORTCUTS_SQL = `SELECT * FROM shortcuts WHERE tenant_id = $1 ORDER BY id`;

/**
 * Every enabled tenant.
 *
 * `enabled` is the whole filter, and no other table is consulted: a tenant that
 * is switched off is not served, so re-indexing its catalogue would be work done
 * on behalf of nobody. Nothing here reads `stores` — a tenant with no store
 * still sweeps to an empty list.
 */
const TENANTS_SQL = `SELECT id FROM tenants WHERE enabled ORDER BY id`;

/** Every product of one tenant. */
const PRODUCT_SPUS_SQL = `SELECT * FROM product_spus WHERE tenant_id = $1 ORDER BY id`;

/**
 * Every variant of one tenant, with the two columns it does not own.
 *
 * The join is on `(tenant_id, id)` — the pair the platform scopes every
 * cross-table read by — and the aliases are the names `productSkuIndexSource`
 * reads. It carries the product's `shelf_status` because a variant of an off-shelf
 * product must not be answerable either, and its `title` because the slice text has
 * to name the product a colour belongs to (see `productSkuValues`): dropping
 * either alias here costs recall without raising anything. An inner join is
 * deliberate: the foreign key cascades, so an orphan variant cannot exist, and if
 * one somehow did, dropping it is better than indexing a variant whose product
 * nobody can look up.
 */
const PRODUCT_SKUS_SQL = `
  SELECT s.*, p.shelf_status AS spu_shelf_status, p.title AS spu_title
    FROM product_skus s
    JOIN product_spus p ON p.tenant_id = s.tenant_id AND p.id = s.spu_id
   WHERE s.tenant_id = $1
   ORDER BY s.id`;

/** The three source tables, read through the Worker's own pool. */
export class PostgresIndexSourceReader implements IndexSourceReader {
  /**
   * @param database - The Worker-owned connection pool.
   */
  constructor(private readonly database: WorkerDatabase) {}

  /** @inheritdoc */
  async listTenantIds(): Promise<ReadonlyArray<string>> {
    const rows = await this.database.rows(TENANTS_SQL);
    return rows.map((row) => toText(row['id']));
  }

  /** @inheritdoc */
  async listIndexSources(tenantId: string): Promise<ReadonlyArray<IndexSourceInput>> {
    // Five independent reads of one tenant, issued together: the pool is what
    // the concurrency is for, and the job above is a background sweep with no
    // latency budget to protect.
    const [faqs, faqVariants, shortcuts, products, productSkus] = await Promise.all([
      this.database.rows(FAQS_SQL, [tenantId]),
      this.database.rows(FAQ_VARIANTS_SQL, [tenantId]),
      this.database.rows(SHORTCUTS_SQL, [tenantId]),
      this.database.rows(PRODUCT_SPUS_SQL, [tenantId]),
      this.database.rows(PRODUCT_SKUS_SQL, [tenantId]),
    ]);
    return toIndexSources({ faqs, faqVariants, shortcuts, products, productSkus });
  }
}
