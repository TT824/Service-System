/**
 * The one rule about disabled knowledge: it stays, but it is not a source.
 *
 * The rule has a file of its own because it has exactly one copy. The knowledge
 * reads hand over every row of the tenant scope, 停用 rows included — the
 * management surface has to be able to find a disabled row again to undo it —
 * so if this rule were also written into a query, the platform would have two
 * answers to "may this answer a customer?".
 */

import { describe, expect, it } from 'vitest';
import { usableKnowledge } from './knowledge';

/** A knowledge row as far as this rule is concerned. */
type Row = { readonly id: string; readonly enabled: boolean };

const NO_ROWS: ReadonlyArray<Row> = [];

describe('usableKnowledge', () => {
  it('keeps the enabled rows and drops the 停用 ones', () => {
    const rows: ReadonlyArray<Row> = [
      { id: 'a', enabled: true },
      { id: 'b', enabled: false },
      { id: 'c', enabled: true },
    ];
    expect(usableKnowledge(rows).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('keeps the order it was given', () => {
    const rows: ReadonlyArray<Row> = [
      { id: 'c', enabled: true },
      { id: 'a', enabled: true },
      { id: 'b', enabled: true },
    ];
    expect(usableKnowledge(rows).map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('carries every other field of the rows it keeps', () => {
    // The rows it is handed are products, FAQs and shortcuts; only `enabled` is
    // its business, and a caller must get whole rows back, not bare ids.
    const rows = [
      { id: 'a', title: '黑色 XL 加绒卫衣', enabled: true },
      { id: 'b', title: '已停用的商品', enabled: false },
    ];
    expect(usableKnowledge(rows)).toEqual([{ id: 'a', title: '黑色 XL 加绒卫衣', enabled: true }]);
  });

  it('answers an empty list with an empty list', () => {
    expect(usableKnowledge(NO_ROWS)).toEqual([]);
  });

  it('answers nothing when every row has been taken out of service', () => {
    const rows: ReadonlyArray<Row> = [
      { id: 'a', enabled: false },
      { id: 'b', enabled: false },
    ];
    expect(usableKnowledge(rows)).toEqual([]);
  });
});
