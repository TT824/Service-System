import { describe, expect, it } from 'vitest';
import { describeBlockedContent, screenCandidates, screenContent } from './screen';
import { DEFAULT_CONTENT_SAFETY_RULES, type ContentSafetyRule } from './rules';

/** One rule, so a case can be about that rule and nothing else. */
function only(rule: ContentSafetyRule): ReadonlyArray<ContentSafetyRule> {
  return [rule];
}

describe('screenContent', () => {
  it('blocks a banned term and names the rule that caught it', () => {
    const verdict = screenContent(
      '我们是全网最低价，放心购买',
      only({ id: 'r1', category: 'ad_law_extreme', term: '全网最低' }),
    );

    expect(verdict.blocked).toBe(true);
    expect(verdict.hits).toEqual([
      { ruleId: 'r1', category: 'ad_law_extreme', term: '全网最低', index: 3 },
    ]);
    expect(verdict.terms).toEqual(['全网最低']);
  });

  it('lets text through when no rule matches', () => {
    const verdict = screenContent('您的订单今天发出，预计明天送达', DEFAULT_CONTENT_SAFETY_RULES);

    expect(verdict.blocked).toBe(false);
    expect(verdict.hits).toEqual([]);
    expect(verdict.terms).toEqual([]);
  });

  /**
   * The falsification the plan asks for, at its smallest: with the library
   * emptied, the same sentence that was blocked above must pass. If this ever
   * fails, the blocking does not come from the rule list and the library is
   * decoration.
   */
  it('stops blocking the same sentence when the rule library is emptied', () => {
    const sentence = '我们是全网最低价，放心购买';

    expect(screenContent(sentence, DEFAULT_CONTENT_SAFETY_RULES).blocked).toBe(true);
    expect(screenContent(sentence, []).blocked).toBe(false);
  });

  it('does not treat the shipped library as a rule of its own', () => {
    // Guards the default parameter: a caller that forgets to pass rules gets
    // interception, but only because the default is the library.
    expect(DEFAULT_CONTENT_SAFETY_RULES.length).toBeGreaterThan(0);
    expect(screenContent('加我微信详聊').blocked).toBe(true);
  });

  describe('exemptions', () => {
    const first = DEFAULT_CONTENT_SAFETY_RULES.find((rule) => rule.id === 'ad-law-rank-one');
    if (first === undefined) {
      throw new Error('the 第一 rule left the library; this case is now meaningless');
    }
    const rules = only(first);

    it('exempts a term that only occurs inside an exempt phrase', () => {
      expect(screenContent('我们会在第一时间回复您', rules).blocked).toBe(false);
      expect(screenContent('这是您第一次购买', rules).blocked).toBe(false);
    });

    it('still blocks the term when it stands outside the exempt phrase', () => {
      // The exempt phrase is present *and* a real claim is present: the
      // exemption must not silence the second one.
      const verdict = screenContent('我们是全国第一，会第一时间回复', rules);

      expect(verdict.blocked).toBe(true);
      expect(verdict.hits.map((hit) => hit.index)).toEqual([5]);
    });

    it('is positional, not textual', () => {
      // 时间第一 contains 第一 at the end and is not covered by 第一时间.
      expect(screenContent('本公司时间第一', rules).blocked).toBe(true);
    });
  });

  it('reports one hit per occurrence and one term per rule', () => {
    const verdict = screenContent(
      '最低价！真的最低价！',
      only({ id: 'r1', category: 'ad_law_extreme', term: '最低价' }),
    );

    expect(verdict.hits.map((hit) => hit.index)).toEqual([0, 6]);
    expect(verdict.terms).toEqual(['最低价']);
  });

  it('blocks the platform family as well as the advertising one', () => {
    const verdict = screenContent('亲，加微信下单更便宜哦', DEFAULT_CONTENT_SAFETY_RULES);

    expect(verdict.blocked).toBe(true);
    expect(verdict.terms).toContain('加微信');
    expect(verdict.hits.some((hit) => hit.category === 'platform_banned')).toBe(true);
  });

  it('accepts empty text without consulting the rules', () => {
    expect(screenContent('', DEFAULT_CONTENT_SAFETY_RULES).blocked).toBe(false);
  });

  it('describes a block in terms an operator can act on', () => {
    const verdict = screenContent('全网最低，独一无二', DEFAULT_CONTENT_SAFETY_RULES);

    expect(describeBlockedContent(verdict)).toBe('内容包含禁止用语：全网最低、独一无二');
    expect(describeBlockedContent(screenContent('正常回复', []))).toBe('');
  });
});

describe('screenCandidates', () => {
  it('keeps the clean ones, in order, and returns the blocked ones as evidence', () => {
    const candidates = [
      { rank: 1, content: '正常的第一条' },
      { rank: 2, content: '我们是全网最低价' },
      { rank: 3, content: '正常的第三条' },
      { rank: 4, content: '请加微信联系' },
    ];

    const { kept, blocked } = screenCandidates(candidates, DEFAULT_CONTENT_SAFETY_RULES);

    expect(kept.map((candidate) => candidate.rank)).toEqual([1, 3]);
    expect(blocked.map((entry) => entry.candidate.rank)).toEqual([2, 4]);
    // 全网最低价 is caught by two rules at once — 最低价 and 全网最低 — which is
    // the intended redundancy, not a double count. Asserted by membership so
    // that adding a third overlapping rule does not read as a regression.
    expect(blocked[0]?.verdict.terms).toContain('全网最低');
    expect(blocked[0]?.verdict.terms).toContain('最低价');
    expect(blocked[1]?.verdict.terms).toContain('加微信');
  });

  it('keeps everything when the library is empty', () => {
    const candidates = [{ rank: 1, content: '全网最低' }];

    expect(screenCandidates(candidates, []).kept).toHaveLength(1);
    expect(screenCandidates(candidates, []).blocked).toHaveLength(0);
  });
});
