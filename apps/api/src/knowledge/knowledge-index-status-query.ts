/**
 * The `GET /knowledge/index-status` query string, turned into a filter.
 *
 * Kept out of the controller because every decision in it is one a reader has to
 * be able to check without an HTTP stack: which parameters exist, what a
 * near-miss is refused with, and whether an absent parameter stays absent.
 *
 * Every refusal throws an **array**. `all-exceptions.filter.ts` copies a thrown
 * list into the error body's `details` and deliberately hides a thrown string, so
 * a caller that sent `indexStatus=potato` and got `details: []` has no way to
 * learn which parameter was wrong — the platform's own helpers still throw bare
 * strings in places (a known, registered problem, see 挂账 #1) and this endpoint
 * is not going to add to it.
 *
 * A parameter that is *present but empty* is refused rather than ignored:
 * `?storeId=` is a caller that meant something, and answering it with the whole
 * tenant is the one answer they cannot tell apart from a store that happens to
 * hold no slices.
 */

import { BadRequestException } from '@nestjs/common';
import {
  CHUNK_INDEX_STATUSES,
  INDEXED_SOURCE_KINDS,
  isChunkIndexStatus,
  isIndexedSourceKind,
  type KnowledgeIndexStatusFilter,
} from '@kefu/core';

/**
 * The query parameters this endpoint declares, as Nest hands them over.
 *
 * `?: … | undefined` rather than `?: …`: a `@Query()` parameter is a
 * `string | undefined` whether or not the request carried it, and under
 * `exactOptionalPropertyTypes` only the explicit `| undefined` accepts that
 * hand-over without the caller having to omit the key by hand.
 */
export type IndexStatusQuery = {
  readonly storeId?: string | undefined;
  readonly sourceKind?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly indexStatus?: string | undefined;
};

/**
 * Parse and validate the query string.
 *
 * @param query - The declared parameters; an undeclared one is never seen here.
 * @returns The filter the repository takes, holding only the parameters that
 * were actually sent — an absent parameter leaves its key off the object rather
 * than on it with `undefined`, so "not asked for" cannot be confused with
 * "asked for, empty" downstream.
 * @throws BadRequestException carrying the reasons, one per offending parameter.
 */
export function parseIndexStatusFilter(query: IndexStatusQuery): KnowledgeIndexStatusFilter {
  const storeId = present(query.storeId, 'storeId');
  const sourceId = present(query.sourceId, 'sourceId');
  const sourceKind = present(query.sourceKind, 'sourceKind');
  const indexStatus = present(query.indexStatus, 'indexStatus');

  if (sourceKind !== undefined && !isIndexedSourceKind(sourceKind)) {
    throw new BadRequestException([
      `sourceKind 只能是 ${INDEXED_SOURCE_KINDS.join(' / ')} 之一，收到 "${sourceKind}"`,
    ]);
  }
  if (indexStatus !== undefined && !isChunkIndexStatus(indexStatus)) {
    throw new BadRequestException([
      `indexStatus 只能是 ${CHUNK_INDEX_STATUSES.join(' / ')} 之一，收到 "${indexStatus}"`,
    ]);
  }

  return {
    ...(storeId === undefined ? {} : { storeId }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(indexStatus === undefined ? {} : { indexStatus }),
  };
}

/**
 * The trimmed value of one parameter, or `undefined` when it was not sent.
 *
 * @throws BadRequestException when it was sent empty, naming the parameter.
 */
function present(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException([`${name} 不能是空字符串：要么给出取值，要么整个参数省略`]);
  }
  return trimmed;
}
