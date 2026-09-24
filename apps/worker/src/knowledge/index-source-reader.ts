/**
 * The read port the index job needs: one tenant's knowledge sources.
 *
 * It is a port rather than a call to the adapter because the job above it is
 * where the write decisions live, and those are worth driving from a spec whose
 * fixture is three lists of rows — the same split `outbox-processor` uses for
 * its repository.
 *
 * **The read is a full sweep of the tenant, not a delta.** The write path
 * decides what to delete by comparing the rows a source produces now against the
 * rows stored under it, so a read that returned only what changed since the last
 * pass would report every unchanged slice as stale and delete it. Whatever
 * narrows the sweep — a cursor, an `updated_at` window — has to narrow the *work
 * per source*, never the set of sources.
 */

import type { IndexSourceInput } from '@kefu/core';

/** Reads the indexable sources of one tenant. */
export interface IndexSourceReader {
  /**
   * Every tenant whose sources are swept.
   *
   * The sweep is per-tenant because every read below is scoped by tenant, and
   * something has to enumerate them: unlike the delivery loop — which serves
   * whatever the API queued and therefore needs no list — an index pass reads a
   * table that no other process announces a change to. Disabled tenants are
   * left out; a tenant the platform does not serve is not re-indexed.
   *
   * @returns The tenant ids, in a fixed order, possibly empty.
   */
  listTenantIds(): Promise<ReadonlyArray<string>>;

  /**
   * Every indexable row of one tenant: its FAQs, their near-questions, its
   * shortcuts, its products and their variants — enabled, disabled and parked
   * alike (see the module note on `index-source`), as kernel inputs.
   *
   * @param tenantId - The tenant whose sources are read.
   * @returns One input per source row, in a fixed order, possibly empty.
   */
  listIndexSources(tenantId: string): Promise<ReadonlyArray<IndexSourceInput>>;
}
