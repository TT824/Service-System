/**
 * 顾客列表：把会话聚合成「一个顾客一行」，以及这件事的筛选口径。
 *
 * 平台里**没有顾客档案**。顾客的身份只存在于会话行上（`conversations.channel`
 * ＋ `external_customer_id`，加一个可能是昵称的 `title`），所以这一页列的不是
 * 「注册过的顾客」，而是「有过来往的人」——同一对 (渠道, 外部顾客 id) 的会话聚成
 * 一行。这个选择决定了下面几件事，它们都是事实而不是待办：
 *
 * - **姓名字段来自会话标题。** 渠道推过来的显示名、或者平台自己拼的
 *   `网页顾客-2LIX`，都落在 `title` 上；没有标题就退回外部 id，因为一行没有名字的
 *   记录比一行写着 id 的记录更难查。这不是「顾客姓名」，是「这条来往怎么称呼」。
 * - **电话永远是 `null`。** 平台没有任何地方收过顾客的电话：会话不存、渠道回调
 *   里没有、导入的表单也不收（0010 的注释专门写过别把顾客手机号当商品字段导）。
 *   所以这一列在界面上是空列，不是「查不到」——`CustomerSummary.phone` 的类型就是
 *   `null`，让调用方无法假装它有值。
 * - **微信是外部顾客 id。** 企业微信的 external userid 是平台唯一拿得到的微信侧
 *   标识；换个渠道它就不是微信了，所以字段名是 `wechat` 而来源写在这里。
 *
 * 本模块只做两件事：定义这一行的形状，以及把查询参数解析成一个明确的筛选口径。
 * 聚合本身是 SQL 的事（`WHERE tenant_id = $1 GROUP BY channel, external_customer_id`），
 * 不在这里重复一遍。
 */

/**
 * 顾客列表上的一行。
 *
 * 四列（姓名、渠道来源、电话、微信）按需求文档的写法命名，其余字段是这一页自己
 * 需要的：一行代表几条会话、最后一次是什么时候、以及「这个顾客最近的那条会话」
 * 是哪一个 —— 导出对话要的就是它。
 */
export type CustomerSummary = {
  /** 稳定的行标识：`<channel>:<externalCustomerId>`，跨会话不变。 */
  readonly customerKey: string;
  /** 渠道标识（`wecom` 等）。显示名由控制台的文案表决定。 */
  readonly channel: string;
  readonly externalCustomerId: string;
  /** 姓名/昵称：最近一条会话的标题，没有标题就是外部 id。 */
  readonly nickname: string;
  /** 电话：平台不存，恒为 `null`。见模块注释。 */
  readonly phone: null;
  /** 微信（企业微信 external userid）；非微信渠道为 `null`。 */
  readonly wechat: string | null;
  /** 这个顾客在这个租户下的会话数。 */
  readonly conversationCount: number;
  /** 最后一次会话活动时间，ISO 8601。 */
  readonly lastMessageAt: string;
  /** 最近一条会话的 id —— 「导出这个顾客的对话」导的就是它。 */
  readonly lastConversationId: string;
};

/** 一次顾客查询的口径：先按关键字，再按时间段。 */
export type CustomerFilter = {
  /** 关键字，匹配外部顾客 id 或会话标题；`null` 表示不筛。 */
  readonly query: string | null;
  /** 时间段起点（含），ISO 8601；`null` 表示不限。 */
  readonly from: string | null;
  /** 时间段终点（含），ISO 8601；`null` 表示不限。 */
  readonly to: string | null;
};

/** 解析结果：要么是一份能用的筛选口径，要么是拒绝的理由。 */
export type CustomerFilterResult =
  | { readonly ok: true; readonly filter: CustomerFilter }
  | { readonly ok: false; readonly reason: string; readonly details: ReadonlyArray<string> };

/** 关键字最长长度：够长到能贴一个完整的外部 id，短到不让它变成全文检索。 */
export const CUSTOMER_QUERY_MAX_LENGTH = 120;

/** 一页最多返回多少个顾客。导出不受这个上限约束，列表受。 */
export const CUSTOMER_PAGE_LIMIT = 200;

/**
 * 一行顾客的稳定标识。
 *
 * 渠道进 key 是因为企业微信和一个未来的渠道完全可能给出同一个 id 字符串，而那是
 * 两个不同的人；`customerKey` 拿去当列表的 React key、也拿去当「导出这位顾客」的
 * 参数，所以它必须和聚合的分组键逐字一致。
 *
 * @param channel - 渠道标识。
 * @param externalCustomerId - 渠道侧给的顾客 id。
 * @returns `<channel>:<externalCustomerId>`。
 */
export function customerKey(channel: string, externalCustomerId: string): string {
  return `${channel}:${externalCustomerId}`;
}

/**
 * 一行的显示名。
 *
 * 空标题与纯空白标题都当没有标题处理：数据库中 `title` 可空，而一个全空格的标题
 * 渲染出来是一行看起来没加载出来的空白。
 *
 * @param title - 会话标题，可能为 `null`。
 * @param externalCustomerId - 渠道侧给的顾客 id。
 * @returns 标题，或者外部 id。
 */
export function customerNickname(title: string | null, externalCustomerId: string): string {
  const trimmed = title?.trim() ?? '';
  return trimmed === '' ? externalCustomerId : trimmed;
}

/**
 * 解析一次顾客查询。
 *
 * 拒绝而不是纠正：一个写错的日期如果被当成「不限时间」，操作者拿到的是一份比他
 * 以为的长得多的列表，而列表不会告诉他这件事。所以只有当参数确实没法读时才报错，
 * 且细节逐条给出（`details`），控制台按条显示。
 *
 * @param input - 原始查询参数，值可能缺失或是任意字符串。
 * @returns 筛选口径，或者拒绝理由。
 */
export function parseCustomerFilter(input: {
  readonly q?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): CustomerFilterResult {
  const details: Array<string> = [];

  const rawQuery = input.q?.trim() ?? '';
  const query = rawQuery === '' ? null : rawQuery;
  if (query !== null && query.length > CUSTOMER_QUERY_MAX_LENGTH) {
    details.push(`关键字太长（最多 ${CUSTOMER_QUERY_MAX_LENGTH} 个字符）`);
  }

  const from = parseInstant(input.from, '起始时间', details);
  const to = parseInstant(input.to, '结束时间', details);
  if (from !== null && to !== null && from > to) {
    details.push('起始时间晚于结束时间');
  }

  if (details.length > 0) {
    return { ok: false, reason: 'invalid_customer_filter', details };
  }
  return { ok: true, filter: { query, from, to } };
}

/**
 * 读一个时间参数。
 *
 * 只认 ISO 8601 的字面形状（`2026-09-22` 或 `2026-09-22T10:00:00Z` 这一类），因为
 * `Date.parse` 连 `Sep 22 2026` 和 `09/22/2026` 都收——而 `09/22/2026` 在写它的人
 * 心里是几月几日，取决于他在哪个国家，平台不该替他猜。值本身不在这里补时区：控制台
 * 发的是它自己算好的整日边界（本地 00:00:00 与 23:59:59.999），带到这一刻的瞬间，
 * 「筛一整天」才是操作者以为的那一天。
 *
 * @param value - 原始字符串。
 * @param label - 出现在 `details` 里的中文名。
 * @param details - 收集问题的地方，就地追加。
 * @returns 规范化后的 ISO 字符串，或 `null`（未给或无法解析）。
 */
function parseInstant(
  value: string | undefined,
  label: string,
  details: Array<string>,
): string | null {
  const raw = value?.trim() ?? '';
  if (raw === '') {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    details.push(`${label}格式无法识别（需要 ISO 8601）`);
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || !hasRealCalendarDay(raw)) {
    details.push(`${label}不是有效日期`);
    return null;
  }
  return parsed.toISOString();
}

/**
 * 聚合查询读回来的一行。
 *
 * 列名就是 SQL 里 `SELECT` 的名字，两个进程（API 的列表、Worker 的导出）都按这一份
 * 读，所以它不是「某一边的查询类型」而是这份聚合的结果类型。时间列收 `Date | string`：
 * 真库返回 `Date`，而上层为了不改 SQL 就能测，用字面量喂同一段映射。
 */
export type CustomerRow = {
  readonly channel: string;
  readonly external_customer_id: string;
  readonly title: string | null;
  readonly last_message_at: Date | string;
  readonly last_conversation_id: string;
  readonly conversation_count: number | string;
};

/**
 * 把一次聚合读成一行 `CustomerSummary`。
 *
 * 放在这里而不是 API 与 Worker 各写一份，是因为这一行里有三条**语义**判断：微信只在
 * 企业微信渠道上是微信、电话永远是 `null`、`count(*)` 要以数字出现——两份副本漂开
 * 时不会有任何测试变红，只会让导出的表格和屏幕上的列表对不上。
 *
 * `count(*)` 从 PostgreSQL 回来是字符串（`bigint` 不会被 `pg` 自作主张收窄成
 * JavaScript 数字），所以在这里收窄：一列数字里混进一个 `"3"` 就是这么来的。
 *
 * @param row - 聚合行。
 * @returns 顾客行。
 */
export function toCustomerSummary(row: CustomerRow): CustomerSummary {
  return {
    customerKey: customerKey(row.channel, row.external_customer_id),
    channel: row.channel,
    externalCustomerId: row.external_customer_id,
    nickname: customerNickname(row.title, row.external_customer_id),
    phone: null,
    // 企业微信的 external userid 是平台唯一拿得到的微信侧标识；换个渠道它就不是
    // 微信了，所以这里按渠道判定，而不是按「有没有这个值」判定。
    wechat: row.channel === 'wecom' ? row.external_customer_id : null,
    conversationCount: Number(row.conversation_count),
    lastMessageAt: instant(row.last_message_at),
    lastConversationId: row.last_conversation_id,
  };
}

/**
 * 把关键字转成 `LIKE`/`ILIKE` 的 `%…%` 模式，并转义其中的通配符。
 *
 * 关键字是数据，不是模式：企业微信的 external userid 里 `_` 是普通字符，不转义就会
 * 匹配到所有同长度的 id；一个 `%` 会匹配整个租户。反斜杠**先**转义——放在最后会把
 * 为 `%`/`_` 加的转义符再转一遍，结果反而匹配到数据里真的反斜杠。SQL 那侧要写
 * `ESCAPE '\'`。
 *
 * @param query - 操作者输入的关键字。
 * @returns `%关键字%`。
 */
export function likeContainsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * 读一个时间列。
 *
 * @param value - 时间列。
 * @returns ISO 8601。
 */
function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 这一天在日历上真的存在吗。
 *
 * `new Date('2026-02-31')` 不返回无效时间，它把日期滚成 3 月 3 日——于是「2 月 31 日
 * 到 3 月 1 日」这种区间会被平台安静地收下，而操作者以为自己在筛两天。只按字面校验
 * 年月日（不经过时区）：`2026-09-22T01:00:00+08:00` 换算成 UTC 是前一天，那是合法的
 * 输入，拿换算结果去比日期反而会把对的说成错的。
 *
 * @param raw - 已经确认是 ISO 形状的字符串。
 * @returns 字面上的年月日是否是日历中的一天。
 */
function hasRealCalendarDay(raw: string): boolean {
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return roundTrip.getUTCMonth() === month - 1 && roundTrip.getUTCDate() === day;
}
