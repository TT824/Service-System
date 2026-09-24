/**
 * 导出任务：请求的形状、任务行的形状，以及一个任务产出的两个文件。
 *
 * 一次导出产**两个**产物，因为控制台菜单里是两个下载项，而它们是同一次读取的
 * 两种排版：`.xlsx`（给表格软件看的行列）与对话记录（给人读的逐条）。所以任务的
 * 状态、失败原因、行数都只有一份，产物是它的两个渲染结果——不是两次导出，也就不会
 * 出现「Excel 成功了、对话记录失败了」这种要让操作者猜哪个能用的局面。
 *
 * 三件事写在这里而不是 API 或 Worker 里：
 *
 * 1. **任务 ID 与状态是平台的词汇**（`pending`/`running`/`succeeded`/`failed`），
 *    与 0002 的 `jobs.status` 的 CHECK 逐字一致。控制台按这四个词显示，两处不能
 *    各存一份自己的拼法。
 * 2. **产物的文件名与类型**。下载的 `Content-Disposition` 与文件后缀是同一句话，
 *    分在两个进程里写就会漂。
 * 3. **两个渲染函数**。表格与对话记录的排版规则是可测的纯逻辑，而 Worker 的职责是
 *    取数、调用、落库——把规则留在 Worker 里，就等于要求一个真数据库才能测「表头
 *    对不对」。
 *
 * **时间的读法**：文件里的时间一律是 UTC，并在文件开头写明这一点。平台没有租户
 * 时区这个设置（控制台显示本地时间是浏览器的事），而导出文件会被转发、会被别处的
 * 表格软件打开，所以它必须自带口径；写成本地时间而不标注，就是把一个猜出来的偏移
 * 当成事实发出去。
 */

import { Workbook } from 'exceljs';
import {
  CUSTOMER_QUERY_MAX_LENGTH,
  parseCustomerFilter,
  type CustomerFilter,
  type CustomerSummary,
} from './customer-directory';

/**
 * `jobs.kind` 的取值。
 *
 * 用内核那张通用表（0002）而不是新建一张导出表：任务的四种状态、payload、结果、
 * 错误、创建时间它都有，0016 只补了两个时间戳。`kind` 让同一个 Worker 循环以后还能
 * 领别的后台活。
 */
export const EXPORT_JOB_KIND = 'export';

/** 一次导出导的是什么。 */
export type ExportScope =
  /** 一个顾客最近那条会话的对话。 */
  | 'conversation'
  /** 一段时间内（可加关键字）的所有顾客。 */
  | 'customers';

/** 一个产物。控制台菜单里的两项，也是 `job_artifacts.format` 的两个取值。 */
export type ExportArtifactFormat = 'xlsx' | 'transcript';

/** 两个产物，按控制台菜单的顺序。 */
export const EXPORT_ARTIFACT_FORMATS: ReadonlyArray<ExportArtifactFormat> = ['xlsx', 'transcript'];

/** 任务状态，与 `jobs.status` 的 CHECK 逐字一致。 */
export type ExportJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** 一次导出的请求：要么一个会话，要么一份顾客口径。 */
export type ExportRequest =
  | { readonly scope: 'conversation'; readonly conversationId: string }
  | { readonly scope: 'customers'; readonly filter: CustomerFilter };

/**
 * 任务行，已经是控制台要显示的形状。
 *
 * `label` 是「导出了什么」的人话，存在 `payload` 里而不是每次重算：一份顾客口径
 * 的说明依赖创建当时的参数，而参数以后可能被改（口径本身是数据），重算会让历史
 * 任务改口。
 */
export type ExportJobRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: ExportScope;
  /** 人话说明，例如「顾客「网页顾客-2LIX」的对话」。 */
  readonly label: string;
  readonly status: ExportJobStatus;
  readonly createdAt: string;
  /** Worker 领走的时刻；`null` 表示还没轮到。 */
  readonly startedAt: string | null;
  /** 落终态的时刻；`null` 表示还在跑。 */
  readonly finishedAt: string | null;
  /** 成败都可能有：成功的行数，或失败前已经写下的话。 */
  readonly rowCount: number | null;
  readonly error: string | null;
  /** 已经生成好的产物。未成功时为空数组，控制台据此置灰菜单。 */
  readonly artifacts: ReadonlyArray<ExportArtifactFormat>;
};

/** `parseExportRequest` 的两种答案。 */
export type ExportRequestResult =
  | { readonly ok: true; readonly request: ExportRequest }
  | { readonly ok: false; readonly reason: string; readonly details: ReadonlyArray<string> };

/** 一次导出最多导多少条消息，防止一个人点一次就把 Worker 占死。 */
export const EXPORT_MESSAGE_LIMIT = 20_000;

/** 一次导出最多导多少个顾客。 */
export const EXPORT_CUSTOMER_LIMIT = 5_000;

/**
 * 校验一次导出请求。
 *
 * 只做形状校验，不做权限与存在性判断：会话属不属于这个租户、顾客 id 是否真存在，
 * 都只有读了库才知道，那是 API 的事。这里挡住的是「一个读不出所以然的 payload
 * 变成了任务行，然后在 Worker 里才炸」——那种失败对操作者表现为一个永远失败的任务。
 *
 * @param body - 请求体，任意值。
 * @returns 请求，或者拒绝理由与逐条细节。
 */
export function parseExportRequest(body: unknown): ExportRequestResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_export_request', details: ['请求体必须是一个对象'] };
  }
  const record = body as Record<string, unknown>;
  const scope = record['scope'];
  if (scope === 'conversation') {
    const conversationId = record['conversationId'];
    if (typeof conversationId !== 'string' || conversationId.trim() === '') {
      return {
        ok: false,
        reason: 'invalid_export_request',
        details: ['导出会话时必须给出 conversationId'],
      };
    }
    return { ok: true, request: { scope: 'conversation', conversationId: conversationId.trim() } };
  }
  if (scope === 'customers') {
    const parsed = parseCustomerFilter({
      q: asOptionalString(record['q']),
      from: asOptionalString(record['from']),
      to: asOptionalString(record['to']),
    });
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, details: parsed.details };
    }
    return { ok: true, request: { scope: 'customers', filter: parsed.filter } };
  }
  return {
    ok: false,
    reason: 'invalid_export_request',
    details: ['scope 必须是 conversation 或 customers'],
  };
}

/**
 * 读一个可选的字符串参数。
 *
 * 非字符串一律当没给：查询串里 `?q=a&q=b` 会解析成数组，控制台不会那样发，但
 * 「一个字数组让整次导出被拒」不是操作者能修的错。
 *
 * @param value - 原始值。
 * @returns 字符串，或 `undefined`。
 */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 一个导出任务写进 `jobs.payload` 的形状。
 *
 * 写进去的是**解析之后**的口径（`filter` 里已经是 ISO 的瞬间），不是原始查询串：
 * Worker 领到这个任务时，控制台那次请求早就结束了，没人能把参数再解析一遍。所以
 * 读写两侧都由本模块负责（{@link exportJobPayload} / {@link readExportJobPayload}），
 * 一个写、一个读，形状不会在中间漂开。
 *
 * `label` 一起存进去，而不是读的时候按 `filter` 重算：说明文字属于**当初那次请求**，
 * 口径本身是数据（以后可能改），重算会让历史任务改口。
 */
export type ExportJobPayload =
  | { readonly scope: 'conversation'; readonly label: string; readonly conversationId: string }
  | { readonly scope: 'customers'; readonly label: string; readonly filter: CustomerFilter };

/**
 * 把一个请求与它的说明写成 `jobs.payload`。
 *
 * @param request - 解析好的导出请求。
 * @param label - 人话说明。
 * @returns 可以 `JSON.stringify` 进 JSONB 的对象。
 */
export function exportJobPayload(request: ExportRequest, label: string): ExportJobPayload {
  return request.scope === 'conversation'
    ? { scope: request.scope, label, conversationId: request.conversationId }
    : { scope: request.scope, label, filter: request.filter };
}

/**
 * 从 `jobs.payload` 读回一个请求与它的说明。
 *
 * 拒绝而不是猜：`jobs` 是平台的通用工作表，别的 `kind` 的行也躺在同一张表里（哪天
 * 有人手工插一行、或者旧版本的任务换了形状），读不出形状时必须能说出「读不出来」，
 * 让调用方自己决定是把这个任务判失败还是只显示一行看不懂的说明——而不是让它拿着
 * 半个 payload 往下走。
 *
 * @param payload - JSONB 列的值，已经被驱动解析过，或任意值。
 * @returns 任务内容，或 `null`。
 */
export function readExportJobPayload(payload: unknown): ExportJobPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const label = record['label'];
  if (typeof label !== 'string') {
    return null;
  }
  if (record['scope'] === 'conversation') {
    const conversationId = record['conversationId'];
    return typeof conversationId === 'string' && conversationId !== ''
      ? { scope: 'conversation', label, conversationId }
      : null;
  }
  if (record['scope'] === 'customers') {
    const filter = readFilter(record['filter']);
    return filter === null ? null : { scope: 'customers', label, filter };
  }
  return null;
}

/**
 * 读一个 JSONB 里的筛选口径。
 *
 * @param value - `filter` 的值。
 * @returns 口径，或 `null`。
 */
function readFilter(value: unknown): CustomerFilter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const query = record['query'];
  const from = record['from'];
  const to = record['to'];
  if (!isNullableString(query) || !isNullableString(from) || !isNullableString(to)) {
    return null;
  }
  return { query, from, to };
}

/**
 * 一个「字符串或 `null`」的判定。
 *
 * @param value - 任意值。
 * @returns 是否是 `string | null`。
 */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * 一份会话导出的说明。
 *
 * @param nickname - 顾客这一行的显示名。
 * @returns 例如「顾客「网页顾客-2LIX」的对话」。
 */
export function conversationExportLabel(nickname: string): string {
  return `顾客「${nickname}」的对话`;
}

/**
 * 一份顾客口径导出的说明。
 *
 * 时间段按天写：导出的是「这个区间里的顾客」，秒不秒的不影响操作者认不认得出这是
 * 哪一次导出，而一长串 ISO 会让这一列读不成句。
 *
 * @param filter - 解析好的顾客口径。
 * @returns 例如「2026-09-01 至 2026-09-22 的顾客 · 关键字「羽绒服」」。
 */
export function customerExportLabel(filter: CustomerFilter): string {
  const range =
    filter.from === null && filter.to === null
      ? '全部顾客'
      : `${filter.from?.slice(0, 10) ?? '最早'} 至 ${filter.to?.slice(0, 10) ?? '现在'} 的顾客`;
  const keyword = filter.query === null ? '' : ` · 关键字「${filter.query}」`;
  return `${range}${keyword}`;
}

/**
 * 一个产物的下载文件名。
 *
 * 全 ASCII，且带任务 ID 的前 8 位：文件名会经过 `Content-Disposition`、经过浏览器的
 * 下载目录、经过操作者转发时的聊天工具，中文名在这条路上每一站都可能变成乱码，而
 * 下载之后认不出「这是哪个顾客的」比乱码更麻烦——所以身份靠 ID，人话说明在文件内容
 * 与任务列表里。
 *
 * @param job - 任务的 id、口径与创建时间。
 * @param format - 产物格式。
 * @returns 例如 `conversation-20260922-3f9a1c02.xlsx`。
 */
export function exportArtifactFileName(
  job: { readonly id: string; readonly scope: ExportScope; readonly createdAt: string },
  format: ExportArtifactFormat,
): string {
  const day = job.createdAt.slice(0, 10).replace(/-/g, '');
  return `${job.scope}-${day}-${job.id.slice(0, 8)}.${artifactExtension(format)}`;
}

/**
 * 一个产物在下载响应上的 MIME 类型。
 *
 * 对话记录写明 `charset=utf-8`：不写的话，一个中文对话记录在 Windows 的某些工具里
 * 会被当成 GBK 打开，而操作者看到的是乱码——那是这一行字能避免的唯一故障。
 *
 * @param format - 产物格式。
 * @returns MIME 类型。
 */
export function exportArtifactContentType(format: ExportArtifactFormat): string {
  switch (format) {
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'transcript':
      return 'text/plain; charset=utf-8';
  }
}

/**
 * 一个产物的扩展名。
 *
 * @param format - 产物格式。
 * @returns 不带点的扩展名。
 */
function artifactExtension(format: ExportArtifactFormat): string {
  return format === 'xlsx' ? 'xlsx' : 'txt';
}

/**
 * 渠道标识的显示名。
 *
 * 与 `apps/web/src/labels.ts#channelLabel` 是同一张表的两份副本：控制台不能依赖
 * `@kefu/core`（它只依赖 React），而导出文件由服务端生成、读不到控制台的词表。
 * **两处必须一起改**——导出里写着「wecom」而界面上写着「企业微信」，操作者会以为
 * 是两个东西。未知渠道原样返回，让一个新渠道先看得见，而不是先消失。
 *
 * @param channel - 渠道标识。
 * @returns 显示名。
 */
export function channelDisplayName(channel: string): string {
  return channel === 'wecom' ? '企业微信' : channel;
}

/** 一次对话记录里的一条消息，已经是文件的排版单位。 */
export type TranscriptMessage = {
  readonly occurredAt: string;
  /** 谁发的：`顾客` 或客服的名字。 */
  readonly speaker: string;
  readonly content: string;
};

/** 对话记录里的一段，一段就是一次会话。 */
export type TranscriptSection = {
  /** 段标题，例如「网页顾客-2LIX · 企业微信」。 */
  readonly heading: string;
  readonly messages: ReadonlyArray<TranscriptMessage>;
};

/**
 * 渲染一份对话记录。
 *
 * 排版目标是「能被当聊天记录读」：每段一个人话标题，每条消息一行，行首是时间。
 * 消息正文里的换行会缩进两格而不是被丢弃——顾客发来的多行内容真实存在，压成一行
 * 会让引用、地址、单号这些靠换行分行的东西糊在一起。
 *
 * @param input - 口径说明、生成时刻与各段消息。
 * @returns 文本内容，行尾是 `\n`。
 */
export function renderTranscript(input: {
  readonly label: string;
  readonly generatedAt: string;
  readonly sections: ReadonlyArray<TranscriptSection>;
}): string {
  const lines: Array<string> = [
    `导出内容：${input.label}`,
    `导出时间：${input.generatedAt}`,
    '消息时间均为 UTC。',
    '',
  ];
  for (const section of input.sections) {
    lines.push(`【${section.heading}】`);
    if (section.messages.length === 0) {
      lines.push('（无消息）', '');
      continue;
    }
    for (const message of section.messages) {
      const body = message.content.replace(/\r?\n/g, '\n  ');
      lines.push(`[${message.occurredAt}] ${message.speaker}：${body}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 渲染一份顾客列表的文本。
 *
 * 一份顾客口径的导出没有「对话记录」可写：它导的是人，不是说的话。所以第二个
 * 产物是这份名单的文本版——同一份读取的两种排版，而不是两次查询——一行一个顾客，
 * 行首是最后活动时间，让文件能按时间读。**电话不进这一行**：它在每一行都是空的，
 * 而一列恒空的值写进文本只是噪声（表格里保留那一列是因为表头能说明它的空）。
 *
 * @param rows - 顾客行。
 * @param input - 口径说明与生成时刻。
 * @returns 文本内容，行尾是 `\n`。
 */
export function renderCustomerList(
  rows: ReadonlyArray<CustomerSummary>,
  input: { readonly label: string; readonly generatedAt: string },
): string {
  const lines: Array<string> = [
    `导出内容：${input.label}`,
    `导出时间：${input.generatedAt}`,
    '消息时间均为 UTC。',
    '',
  ];
  if (rows.length === 0) {
    lines.push('（没有匹配的顾客）', '');
    return lines.join('\n');
  }
  for (const row of rows) {
    const wechat = row.wechat === null ? '' : ` · 微信 ${row.wechat}`;
    lines.push(
      `[${row.lastMessageAt}] ${row.nickname} · ${channelDisplayName(row.channel)}` +
        ` · 会话 ${row.conversationCount}${wechat}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 把一次导出渲染成表格。
 *
 * 表头与列顺序同控制台顾客列表的四列（姓名、渠道来源、电话、微信）——导出与屏幕
 * 上看到的是同一份东西，操作者才不用对两遍；电话那一列会整列是空的，因为平台确实
 * 没存（见 `customer-directory`）。
 *
 * @param rows - 顾客行。
 * @param generatedAt - 生成时刻，写进首行说明。
 * @returns xlsx 字节。
 */
export async function buildCustomerWorkbook(
  rows: ReadonlyArray<CustomerSummary>,
  generatedAt: string,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.created = new Date(generatedAt);
  const sheet = workbook.addWorksheet('顾客');
  addTitleRow(sheet, `顾客列表（导出时间 ${generatedAt}，时间均为 UTC）`, 6);
  sheet.addRow(['姓名', '渠道来源', '电话', '微信', '会话数', '最后消息时间']);
  sheet.getRow(sheet.rowCount).font = { bold: true };
  for (const row of rows) {
    sheet.addRow([
      row.nickname,
      channelDisplayName(row.channel),
      // 空列也是有意义的答案：平台没有这个字段，不是这次没查出来。
      '',
      row.wechat ?? '',
      row.conversationCount,
      row.lastMessageAt,
    ]);
  }
  applyWidths(sheet, [28, 14, 18, 32, 10, 26]);
  return writeWorkbook(workbook);
}

/**
 * 把对话记录渲染成表格。
 *
 * 与控制台的列表不同，这张表的每一行是一条消息，而且带上所属会话：一份导出可能
 * 覆盖多个会话，行里不写会话就分不出两段对话的边界。
 *
 * @param sections - 各段消息。
 * @param generatedAt - 生成时刻，写进首行说明。
 * @returns xlsx 字节。
 */
export async function buildMessageWorkbook(
  sections: ReadonlyArray<TranscriptSection>,
  generatedAt: string,
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.created = new Date(generatedAt);
  const sheet = workbook.addWorksheet('对话记录');
  addTitleRow(sheet, `对话记录（导出时间 ${generatedAt}，时间均为 UTC）`, 4);
  sheet.addRow(['时间', '会话', '发送方', '内容']);
  sheet.getRow(sheet.rowCount).font = { bold: true };
  for (const section of sections) {
    for (const message of section.messages) {
      sheet.addRow([message.occurredAt, section.heading, message.speaker, message.content]);
    }
  }
  applyWidths(sheet, [26, 32, 16, 72]);
  return writeWorkbook(workbook);
}

/**
 * 在第一行写一句说明并合并单元格。
 *
 * 说明写在表里而不是只写在文件名上：文件一旦被转发，文件名是最先被改掉的东西，
 * 而「时间都是 UTC」这句话必须在文件里，否则读的人只能猜。
 *
 * @param sheet - 工作表。
 * @param text - 说明文字。
 * @param span - 合并几列。
 */
function addTitleRow(sheet: import('exceljs').Worksheet, text: string, span: number): void {
  sheet.addRow([text]);
  sheet.mergeCells(sheet.rowCount, 1, sheet.rowCount, span);
  sheet.getRow(sheet.rowCount).font = { italic: true, size: 10 };
}

/**
 * 设定列宽。
 *
 * @param sheet - 工作表。
 * @param widths - 各列宽度，按列顺序。
 */
function applyWidths(sheet: import('exceljs').Worksheet, widths: ReadonlyArray<number>): void {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}

/**
 * 生成 xlsx 字节。
 *
 * `Workbook.xlsx.writeBuffer` 在 exceljs 的类型里是 `Promise<Buffer>`，但它的返回
 * 类型在浏览器构建下是 `ArrayBuffer`——这里收窄成 `Buffer`，让调用方（Worker 写
 * bytea、API 写响应）不必各自再判一次。
 *
 * @param workbook - 填好的工作簿。
 * @returns 字节。
 */
async function writeWorkbook(workbook: Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 关键字长度上限的再导出，供 API 的查询串校验与控制台的输入框共用一个数。 */
export const EXPORT_QUERY_MAX_LENGTH = CUSTOMER_QUERY_MAX_LENGTH;
