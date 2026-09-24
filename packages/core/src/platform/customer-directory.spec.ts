/**
 * 顾客列表的筛选口径与显示名。
 *
 * 这一层是纯的：聚合在 SQL 里，而「什么样的参数算能读」和「一行该显示成什么名字」
 * 是不需要数据库就能定的规则。它们值得单独钉死，因为两者的坏法都很安静——把一个
 * 写错的日期当成「不限时间」，操作者拿到一份比他以为的长得多的列表，而列表本身
 * 不会告诉他这件事。
 */

import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_QUERY_MAX_LENGTH,
  customerKey,
  customerNickname,
  likeContainsPattern,
  parseCustomerFilter,
  toCustomerSummary,
  type CustomerRow,
} from './customer-directory';

describe('customerKey', () => {
  it('namespaces the id by channel', () => {
    // 两个渠道完全可能给出同一个 id 字符串，而那是两个不同的人。
    expect(customerKey('wecom', 'wm-1')).toBe('wecom:wm-1');
    expect(customerKey('wecom', 'x')).not.toBe(customerKey('other', 'x'));
  });
});

describe('customerNickname', () => {
  it('prefers the conversation title', () => {
    expect(customerNickname('网页顾客-2LIX', 'wm-1')).toBe('网页顾客-2LIX');
  });

  it('falls back to the external id when there is no title', () => {
    // 一行没有名字的记录比一行写着 id 的记录更难查：id 至少能拿去搜。
    expect(customerNickname(null, 'wm-1')).toBe('wm-1');
    expect(customerNickname('   ', 'wm-1')).toBe('wm-1');
  });

  it('trims a title that only has padding around it', () => {
    expect(customerNickname('  网页顾客-2LIX ', 'wm-1')).toBe('网页顾客-2LIX');
  });
});

describe('parseCustomerFilter', () => {
  it('reads an empty query as "everything"', () => {
    const parsed = parseCustomerFilter({});
    expect(parsed).toEqual({
      ok: true,
      filter: { query: null, from: null, to: null },
    });
  });

  it('trims the keyword and treats a whitespace-only one as absent', () => {
    expect(parseCustomerFilter({ q: '  羽绒服  ' })).toEqual({
      ok: true,
      filter: { query: '羽绒服', from: null, to: null },
    });
    expect(parseCustomerFilter({ q: '   ' })).toEqual({
      ok: true,
      filter: { query: null, from: null, to: null },
    });
  });

  it('normalises an instant to ISO', () => {
    const parsed = parseCustomerFilter({ from: '2026-09-01', to: '2026-09-22T18:00:00+08:00' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter.from).toBe('2026-09-01T00:00:00.000Z');
    expect(parsed.filter.to).toBe('2026-09-22T10:00:00.000Z');
  });

  it('refuses an instant it cannot read, rather than silently widening the range', () => {
    // 这是本套最重要的一个用例：`Sep 22 2026` 与 `09/22/2026` 都能被 `Date.parse`
    // 收下，而后者在写它的人心里是几月几日取决于他在哪个国家。宁可拒绝。
    const parsed = parseCustomerFilter({ from: '09/22/2026' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid_customer_filter');
    expect(parsed.details.join(' ')).toContain('起始时间');
  });

  it('refuses a calendar-invalid ISO date', () => {
    const parsed = parseCustomerFilter({ to: '2026-02-31' });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a range whose start is after its end', () => {
    const parsed = parseCustomerFilter({ from: '2026-09-22', to: '2026-09-01' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.details.join(' ')).toContain('起始时间晚于结束时间');
  });

  it('refuses a keyword longer than the cap, naming the cap', () => {
    const parsed = parseCustomerFilter({ q: 'x'.repeat(CUSTOMER_QUERY_MAX_LENGTH + 1) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.details.join(' ')).toContain(String(CUSTOMER_QUERY_MAX_LENGTH));
  });

  it('accepts a keyword exactly at the cap', () => {
    expect(parseCustomerFilter({ q: 'x'.repeat(CUSTOMER_QUERY_MAX_LENGTH) }).ok).toBe(true);
  });

  it('reports every problem at once', () => {
    // 逐条给细节是为了让控制台一次把话说完：一次只修一个错，操作者要点三遍。
    const parsed = parseCustomerFilter({
      q: 'x'.repeat(CUSTOMER_QUERY_MAX_LENGTH + 1),
      from: 'nope',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.details).toHaveLength(2);
  });
});

/** 一行聚合结果，用 `pg` 的原样类型：`bigint` 是字符串，时间戳是 `Date`。 */
function customerRowOf(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    channel: 'wecom',
    external_customer_id: 'wm-1',
    title: '网页顾客-2LIX',
    last_message_at: new Date('2026-09-22T01:00:00.000Z'),
    last_conversation_id: 'conversation-1',
    conversation_count: '2',
    ...overrides,
  };
}

describe('toCustomerSummary', () => {
  it('reads a row into the shape both processes render', () => {
    expect(toCustomerSummary(customerRowOf())).toEqual({
      customerKey: 'wecom:wm-1',
      channel: 'wecom',
      externalCustomerId: 'wm-1',
      nickname: '网页顾客-2LIX',
      phone: null,
      wechat: 'wm-1',
      conversationCount: 2,
      lastMessageAt: '2026-09-22T01:00:00.000Z',
      lastConversationId: 'conversation-1',
    });
  });

  it('narrows the count out of bigint', () => {
    // `count(*)` 回来是字符串；不在这里收窄，导出的表格里就会在数字列中出现 `"3"`。
    expect(toCustomerSummary(customerRowOf({ conversation_count: '3' })).conversationCount).toBe(3);
  });

  it('names the row after the external id when the conversation has no title', () => {
    expect(toCustomerSummary(customerRowOf({ title: null })).nickname).toBe('wm-1');
  });

  it('calls the external id a WeChat id only on WeCom', () => {
    // 按渠道判定而不是按「有没有值」判定：别的渠道给出同一个字符串时它不是微信。
    expect(toCustomerSummary(customerRowOf({ channel: 'other' })).wechat).toBeNull();
  });

  it('reports the phone column as empty, always', () => {
    // 不是「这次没查出来」：平台任何地方都不存顾客电话，所以这一列对所有的行都是空的。
    expect(toCustomerSummary(customerRowOf()).phone).toBeNull();
  });
});

describe('likeContainsPattern', () => {
  it('wraps an ordinary keyword in wildcards', () => {
    expect(likeContainsPattern('羽绒服')).toBe('%羽绒服%');
  });

  it('makes the wildcards inside a keyword literal', () => {
    // `_` 在企业微信的 external userid 里是普通字符；不转义就会匹配到所有同长度的 id。
    expect(likeContainsPattern('wm_1')).toBe('%wm\\_1%');
    expect(likeContainsPattern('50%')).toBe('%50\\%%');
  });

  it('escapes a backslash once, not twice', () => {
    // 顺序要紧：反斜杠如果最后才转义，加在 `_` 前面的那个转义符会被再转一遍，
    // 变成匹配数据里真的反斜杠。
    expect(likeContainsPattern('a\\b')).toBe('%a\\\\b%');
  });
});
