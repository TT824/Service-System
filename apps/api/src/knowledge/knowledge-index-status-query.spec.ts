/**
 * What the index-status query string admits, and what it refuses.
 *
 * The two failure modes this spec exists for are both silent:
 *
 * - **A parameter that was not sent must not arrive as `undefined`.** With
 *   `exactOptionalPropertyTypes` in force the difference is a type error at the
 *   boundary — but only if the key is genuinely absent, so the case below asserts
 *   the key list rather than the values, and a future `{ storeId: undefined }`
 *   would pass a value assertion while breaking every consumer that tests
 *   `'storeId' in filter`.
 * - **A near-miss must be refused, not coerced.** `indexStatus=Indexed` or
 *   `sourceKind=product` (a kind `0011` accepts and the kernel does not index)
 *   would otherwise narrow the read to nothing and answer `total: 0` — a
 *   plausible-looking answer that hides a typo.
 *
 * The shape of the refusal is asserted here too: `details` is only ever non-empty
 * when what was thrown is an array, so the array-ness is part of the contract,
 * not an implementation detail.
 */

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CHUNK_INDEX_STATUSES, INDEXED_SOURCE_KINDS } from '@kefu/core';
import { parseIndexStatusFilter } from './knowledge-index-status-query';

/**
 * The reasons one refusal carries, or a failure naming what it threw instead.
 *
 * Nest normalises `new BadRequestException(['…'])` into
 * `{ statusCode, error, message: ['…'] }`, and `all-exceptions.filter.ts:88` reads
 * the list back off that `message` key — so the lookup below is the same step the
 * filter takes, not a second opinion about it. A thrown *string* normalises to
 * `message: '…'`, which is the shape that reaches the caller as `details: []`, and
 * is refused here by name so that the failure says which of the two happened.
 */
function refusalsOf(query: Parameters<typeof parseIndexStatusFilter>[0]): ReadonlyArray<string> {
  try {
    parseIndexStatusFilter(query);
  } catch (error) {
    if (!(error instanceof BadRequestException)) {
      throw error;
    }
    const { message } = error.getResponse() as { message?: unknown };
    if (!Array.isArray(message)) {
      throw new Error(
        `a refusal must carry a list of reasons, got ${typeof message}: ` +
          'the error body would reach the caller as details: []',
      );
    }
    return message as ReadonlyArray<string>;
  }
  throw new Error('the query was accepted');
}

describe('parseIndexStatusFilter', () => {
  it('leaves an unsent parameter off the filter entirely', () => {
    const filter = parseIndexStatusFilter({});

    // The keys, not the values: `{ storeId: undefined }` would satisfy a value
    // assertion and still mean something different downstream.
    expect(Object.keys(filter)).toEqual([]);
  });

  it('carries each sent parameter through, trimmed', () => {
    const filter = parseIndexStatusFilter({
      storeId: ' store-acme-flagship ',
      sourceKind: 'faq',
      sourceId: ' faq-42 ',
      indexStatus: 'failed',
    });

    expect(filter).toEqual({
      storeId: 'store-acme-flagship',
      sourceKind: 'faq',
      sourceId: 'faq-42',
      indexStatus: 'failed',
    });
  });

  it('accepts every state the column allows and every kind the kernel indexes', () => {
    for (const indexStatus of CHUNK_INDEX_STATUSES) {
      expect(parseIndexStatusFilter({ indexStatus }).indexStatus).toBe(indexStatus);
    }
    for (const sourceKind of INDEXED_SOURCE_KINDS) {
      expect(parseIndexStatusFilter({ sourceKind }).sourceKind).toBe(sourceKind);
    }
  });

  it('refuses an empty parameter instead of reading it as absent', () => {
    expect(refusalsOf({ storeId: '   ' })).toEqual([
      'storeId 不能是空字符串：要么给出取值，要么整个参数省略',
    ]);
  });

  it('refuses a state that is not one of the four, naming the ones that are', () => {
    // Case matters: the value comes from a URL, where `Indexed` is a typo that a
    // lower-casing layer somewhere else in the stack would otherwise absorb.
    expect(refusalsOf({ indexStatus: 'Indexed' })).toEqual([
      'indexStatus 只能是 pending / indexed / failed / skipped 之一，收到 "Indexed"',
    ]);
  });

  it('refuses a source kind neither the migration nor the kernel names', () => {
    // This test used to be "a kind the migration knows and the kernel does not",
    // and `product` was the example — back when the indexer had three kinds and
    // `0011` had five. The two hold the same five now, so the near-miss has to
    // come from outside both. It still has to be refused: answering `total: 0`
    // for a kind no slice can carry is indistinguishable from a tenant that has
    // none, which is the reading this refusal exists to prevent.
    expect(refusalsOf({ sourceKind: 'sku' })).toEqual([
      'sourceKind 只能是 faq / faq_variant / shortcut / product / product_sku 之一，收到 "sku"',
    ]);
  });

  it('refuses with a list, so the error body carries reasons rather than an empty details', () => {
    const reasons = refusalsOf({ indexStatus: 'potato' });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('potato');
  });
});
