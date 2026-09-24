/**
 * The banned-phrase rule library, as data.
 *
 * Two families, both required by §4.5 and UC-17: advertising-law superlatives
 * (广告法极限词) and this platform's own prohibited phrasings (平台禁用语).
 * They are one list rather than two because everything downstream treats them
 * identically — a match blocks the text — and the only thing that differs is
 * the label an operator reads back.
 *
 * ## Why a source file and not a table
 *
 * §4.5's library "来源与更新" is still an open question in the requirements,
 * and tenant-level overrides are explicitly phase 2. A table would therefore
 * have to be added by migration, and the MVP plan freezes the schema at 0 new
 * migrations. So the library ships as data in the package that consumes it,
 * and the *rules are injected* rather than imported at the call site — a
 * deployment can hand `screenContent` a different list, and the tests hand it
 * an empty one, which is how we prove the list is what blocks anything.
 *
 * ## On false positives, which are the whole difficulty here
 *
 * A substring match on 极限词 is dangerous in a customer-service reply in a way
 * it is not in an advertisement. 第一时间 ("at the earliest opportunity") and
 * 最后 ("finally") are ordinary, honest phrasing; 最好的 and 全网最低 are
 * claims. A library that cannot tell them apart gets switched off in a week,
 * so a rule may carry {@link ContentSafetyRule.exemptPhrases}: occurrences that
 * fall *inside* one of those phrases do not count. This is deliberately the
 * narrowest possible escape hatch — a phrase, not a regex, not a category — and
 * it is applied positionally, so 第一时间 is exempt while 时间第一 is not.
 *
 * The list below is a curated starter set, not a legal opinion. Its job in the
 * MVP is to prove the interception mechanism end to end and to give the
 * platform operator something concrete to edit; the authoritative, maintained
 * list is a phase-2 content problem that this file does not pretend to solve.
 */

/** Which family a rule belongs to; the operator-facing label. */
export type ContentSafetyCategory = 'ad_law_extreme' | 'platform_banned';

/** One banned phrase, with the exemptions that make it safe to match. */
export type ContentSafetyRule = {
  /** Stable identifier, recorded in the verdict so a hit is traceable to a rule. */
  readonly id: string;
  readonly category: ContentSafetyCategory;
  /** The literal matched, as a substring. Not a pattern: see the note above. */
  readonly term: string;
  /**
   * Phrases in which this term is benign. A match that falls entirely inside
   * one of these occurrences is not a hit.
   */
  readonly exemptPhrases?: ReadonlyArray<string>;
};

/** The two families, so callers can label without re-deriving from the rule. */
export const CONTENT_SAFETY_CATEGORIES = {
  adLawExtreme: 'ad_law_extreme',
  platformBanned: 'platform_banned',
} as const satisfies Record<string, ContentSafetyCategory>;

/**
 * The shipped library.
 *
 * Kept in one frozen array so a deployment can spread it and subtract, which is
 * what a tenant-level override will look like in phase 2.
 */
export const DEFAULT_CONTENT_SAFETY_RULES: ReadonlyArray<ContentSafetyRule> = Object.freeze([
  // ---- 广告法极限词 (advertising-law superlatives) ------------------------
  // The "最" family. Bare 最 is excluded on purpose: 最近 ("recently") and 最后
  // are not claims, and matching a single character this common would block
  // ordinary sentences. Each entry is a claim-shaped compound instead.
  rule('ad-law-best', 'ad_law_extreme', '最好', ['最好别', '最好是']),
  rule('ad-law-optimal', 'ad_law_extreme', '最佳'),
  rule('ad-law-optimum', 'ad_law_extreme', '最优', ['最优解']),
  rule('ad-law-most-advanced', 'ad_law_extreme', '最先进'),
  rule('ad-law-cheapest', 'ad_law_extreme', '最便宜'),
  rule('ad-law-lowest-price', 'ad_law_extreme', '最低价', ['不是最低价', '非最低价']),
  rule('ad-law-highest-grade', 'ad_law_extreme', '最高级'),
  rule('ad-law-highest-tier', 'ad_law_extreme', '最高档'),
  rule('ad-law-most-popular', 'ad_law_extreme', '最受欢迎', ['不是最受欢迎']),
  rule('ad-law-most-fashionable', 'ad_law_extreme', '最时尚'),
  rule('ad-law-greatest-degree', 'ad_law_extreme', '最大程度'),
  rule('ad-law-all-time-low', 'ad_law_extreme', '史上最低'),
  rule('ad-law-sitewide-lowest', 'ad_law_extreme', '全网最低'),

  // The "第一" family. Bare 第一 is excluded for the same reason as 最 — it is
  // 第一时间 far more often than it is a ranking claim.
  rule('ad-law-rank-one', 'ad_law_extreme', '第一', [
    '第一时间',
    '第一单',
    '第一位',
    '第一次',
    '第一批',
    '第一步',
    '第一件',
    '第一条',
    '第一项',
  ]),
  rule('ad-law-nationwide-first', 'ad_law_extreme', '全国第一'),
  rule('ad-law-worldwide-first', 'ad_law_extreme', '全球第一'),
  rule('ad-law-industry-first', 'ad_law_extreme', '行业第一'),
  rule('ad-law-world-class', 'ad_law_extreme', '世界级'),
  rule('ad-law-national-class', 'ad_law_extreme', '国家级', ['国家级非遗']),

  // Uniqueness and absoluteness claims.
  rule('ad-law-unique', 'ad_law_extreme', '独一无二'),
  rule('ad-law-unprecedented', 'ad_law_extreme', '史无前例'),
  rule('ad-law-top-grade', 'ad_law_extreme', '顶级'),
  rule('ad-law-finest', 'ad_law_extreme', '极品'),
  rule('ad-law-only-one', 'ad_law_extreme', '绝无仅有'),
  rule('ad-law-absolute-genuine', 'ad_law_extreme', '绝对正品'),
  rule('ad-law-absolute-genuine-alt', 'ad_law_extreme', '正品保证', ['不是正品保证']),

  // Unsupported authority and privilege claims.
  rule('ad-law-exempt-inspection', 'ad_law_extreme', '国家免检'),
  rule('ad-law-quality-exempt', 'ad_law_extreme', '质量免检'),
  rule('ad-law-well-known-mark', 'ad_law_extreme', '驰名商标'),
  rule('ad-law-cctv-brand', 'ad_law_extreme', '央视上榜'),
  rule('ad-law-special-supply', 'ad_law_extreme', '特供', ['特供装']),
  rule('ad-law-special-supply-alt', 'ad_law_extreme', '专供'),

  // ---- 平台禁用语 (phrases this platform forbids its seats) ---------------
  // These are not illegal to say. They are forbidden *here* because they move
  // the transaction off the platform, which forfeits the buyer protection the
  // platform is selling — so they are blocked at the same gate.
  // Every variant is listed, because these are literal matches: 加我微信 does
  // not contain 加微信, and a library that only held the shortest form would
  // miss the phrasing a seat actually types. This is the cost of terms over
  // patterns, and it is paid deliberately — see the module note.
  rule('platform-wechat', 'platform_banned', '加微信'),
  rule('platform-wechat-me', 'platform_banned', '加我微信'),
  rule('platform-wechat-one', 'platform_banned', '加个微信'),
  rule('platform-wechat-moment', 'platform_banned', '加一下微信'),
  rule('platform-wechat-mine', 'platform_banned', '我的微信'),
  rule('platform-wechat-alt', 'platform_banned', '微信号', ['举报微信号', '微信客服']),
  rule('platform-wechat-same', 'platform_banned', '微信同号'),
  rule('platform-wechat-contact', 'platform_banned', '微信联系'),
  rule('platform-qq', 'platform_banned', '加QQ'),
  rule('platform-qq-alt', 'platform_banned', '加qq'),
  rule('platform-qq-number', 'platform_banned', 'QQ号'),
  rule('platform-private-chat', 'platform_banned', '私聊'),
  rule('platform-private-contact', 'platform_banned', '私下联系'),
  rule('platform-private-phone', 'platform_banned', '私人电话'),
  rule('platform-my-phone', 'platform_banned', '我的电话'),
  rule('platform-scan-code', 'platform_banned', '扫码加'),
  rule('platform-off-platform-deal', 'platform_banned', '私下交易'),
  rule('platform-direct-transfer', 'platform_banned', '私下转账'),
  rule('platform-transfer-direct', 'platform_banned', '直接转账', ['不要直接转账']),
  rule('platform-offline-payment', 'platform_banned', '线下付款'),
  rule('platform-bypass', 'platform_banned', '绕过平台'),
  rule('platform-not-through', 'platform_banned', '不走平台'),
  // A seat has no reason to write either of these; a customer's message is
  // never screened by this library, so asking for them is the only reading.
  rule('platform-bank-card', 'platform_banned', '银行卡号'),
  rule('platform-id-number', 'platform_banned', '身份证号', ['不要提供身份证号']),
]);

/** Terse builder, so the table above reads as a table. */
function rule(
  id: string,
  category: ContentSafetyCategory,
  term: string,
  exemptPhrases?: ReadonlyArray<string>,
): ContentSafetyRule {
  return Object.freeze(
    exemptPhrases === undefined
      ? { id, category, term }
      : { id, category, term, exemptPhrases: Object.freeze([...exemptPhrases]) },
  );
}
