/**
 * 导出任务的请求、说明文字与两个产物。
 *
 * 表格那两个用例是**读回**断言而不是「生成了非空字节」：一份 xlsx 只要 exceljs 没抛
 * 就永远是「非空」，而表头写错、列顺序换了、电话那一列被漏掉，都能通过读字节长度
 * 的检查。所以这里用手写夹具生成、再用 exceljs 读回来，逐格对。
 */

import { Workbook, type Worksheet } from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { CustomerSummary } from './customer-directory';
import {
  buildCustomerWorkbook,
  buildMessageWorkbook,
  channelDisplayName,
  conversationExportLabel,
  customerExportLabel,
  exportJobPayload,
  exportArtifactContentType,
  exportArtifactFileName,
  parseExportRequest,
  readExportJobPayload,
  renderCustomerList,
  renderTranscript,
  type TranscriptSection,
} from './export-job';

const GENERATED_AT = '2026-09-22T02:30:00.000Z';

/** 一行顾客，字段齐全，好让「哪一列是空的」变成断言而不是巧合。 */
function customerOf(overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return {
    customerKey: 'wecom:wm-1',
    channel: 'wecom',
    externalCustomerId: 'wm-1',
    nickname: '网页顾客-2LIX',
    phone: null,
    wechat: 'wm-1',
    conversationCount: 2,
    lastMessageAt: '2026-09-22T01:00:00.000Z',
    lastConversationId: 'conversation-1',
    ...overrides,
  };
}

/** 一段对话，用于两个渲染器。 */
function sectionOf(overrides: Partial<TranscriptSection> = {}): TranscriptSection {
  return {
    heading: '网页顾客-2LIX · 企业微信',
    messages: [
      { occurredAt: '2026-09-22T01:00:00.000Z', speaker: '顾客', content: '你好' },
      {
        occurredAt: '2026-09-22T01:01:00.000Z',
        speaker: '客服小蓝',
        content: '您好，请问有什么可以帮您？',
      },
    ],
    ...overrides,
  };
}

/**
 * 读回一份 xlsx 的某张表，让断言打在单元格上而不是字节上。
 *
 * 找不到那张表时**抛错**，而不是让 `getWorksheet` 的 `undefined` 一路往下走：
 * 拼错的表名如果只是让读到的单元格全空，断言会以「值是 undefined」失败，看起来
 * 像内容没写对，而不像测试自己写错了表名。
 */
async function readSheet(bytes: Buffer, name: string): Promise<Worksheet> {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet(name);
  if (sheet === undefined) {
    throw new Error(`工作簿里没有名为「${name}」的表`);
  }
  return sheet;
}

describe('parseExportRequest', () => {
  it('accepts a conversation request and trims the id', () => {
    expect(
      parseExportRequest({ scope: 'conversation', conversationId: ' conversation-1 ' }),
    ).toEqual({
      ok: true,
      request: { scope: 'conversation', conversationId: 'conversation-1' },
    });
  });

  it('refuses a conversation request with no id', () => {
    const parsed = parseExportRequest({ scope: 'conversation' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.details.join(' ')).toContain('conversationId');
  });

  it('accepts a customer request and carries the parsed filter', () => {
    const parsed = parseExportRequest({ scope: 'customers', q: ' 羽绒服 ', from: '2026-09-01' });
    expect(parsed).toEqual({
      ok: true,
      request: {
        scope: 'customers',
        filter: { query: '羽绒服', from: '2026-09-01T00:00:00.000Z', to: null },
      },
    });
  });

  it('refuses a customer request whose range cannot be read', () => {
    // 拒绝的理由要能传到操作者眼前：一个坏参数变成任务行、再在 Worker 里失败，
    // 表现出来是一个「永远失败的任务」。
    const parsed = parseExportRequest({ scope: 'customers', from: '昨天' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid_customer_filter');
  });

  it('refuses a body that is not an object, or names no scope', () => {
    for (const body of [null, 42, 'customers', [], { scope: 'everything' }]) {
      expect(parseExportRequest(body).ok).toBe(false);
    }
  });

  it('ignores a repeated query parameter instead of refusing the whole export', () => {
    // `?q=a&q=b` 解析成数组。控制台不会这样发，而「一个字数组让整次导出被拒」不是
    // 操作者能修的错，所以非字符串按「没给」处理。
    expect(parseExportRequest({ scope: 'customers', q: ['a', 'b'] })).toEqual({
      ok: true,
      request: { scope: 'customers', filter: { query: null, from: null, to: null } },
    });
  });
});

describe('the job label', () => {
  it('names the customer of a conversation export', () => {
    expect(conversationExportLabel('网页顾客-2LIX')).toBe('顾客「网页顾客-2LIX」的对话');
  });

  it('describes an unbounded customer filter as everything', () => {
    expect(customerExportLabel({ query: null, from: null, to: null })).toBe('全部顾客');
  });

  it('describes each half of a range, and both', () => {
    const day = (iso: string): string => iso;
    expect(
      customerExportLabel({ query: null, from: `${day('2026-09-01')}T00:00:00.000Z`, to: null }),
    ).toBe('2026-09-01 至 现在 的顾客');
    expect(customerExportLabel({ query: null, from: null, to: '2026-09-22T00:00:00.000Z' })).toBe(
      '最早 至 2026-09-22 的顾客',
    );
    expect(
      customerExportLabel({
        query: '羽绒服',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-22T00:00:00.000Z',
      }),
    ).toBe('2026-09-01 至 2026-09-22 的顾客 · 关键字「羽绒服」');
  });
});

describe('artifact naming', () => {
  const job = {
    id: '0f3a9c21-aaaa-bbbb-cccc-ddddeeeeffff',
    scope: 'conversation' as const,
    createdAt: '2026-09-22T02:30:00.000Z',
  };

  it('names the file after the scope, the day and the job', () => {
    // 全 ASCII：文件名要走 Content-Disposition、下载目录和别人的聊天工具，中文名
    // 在这一路上每一站都可能变成乱码。
    expect(exportArtifactFileName(job, 'xlsx')).toBe('conversation-20260922-0f3a9c21.xlsx');
    expect(exportArtifactFileName(job, 'transcript')).toBe('conversation-20260922-0f3a9c21.txt');
    expect(exportArtifactFileName({ ...job, scope: 'customers' }, 'xlsx')).toBe(
      'customers-20260922-0f3a9c21.xlsx',
    );
  });

  it('declares the transcript as UTF-8', () => {
    // 不写 charset，中文对话记录在 Windows 的某些工具里会被按 GBK 打开。
    expect(exportArtifactContentType('transcript')).toContain('charset=utf-8');
    expect(exportArtifactContentType('xlsx')).toContain('spreadsheetml');
  });
});

describe('channelDisplayName', () => {
  it('names the channel the way the console does', () => {
    expect(channelDisplayName('wecom')).toBe('企业微信');
  });

  it('shows an unknown channel as itself rather than hiding it', () => {
    expect(channelDisplayName('douyin')).toBe('douyin');
  });
});

describe('renderTranscript', () => {
  it('states what it is, when it was made, and that the times are UTC', () => {
    const text = renderTranscript({
      label: '顾客「网页顾客-2LIX」的对话',
      generatedAt: GENERATED_AT,
      sections: [],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('导出内容：顾客「网页顾客-2LIX」的对话');
    expect(lines[1]).toBe(`导出时间：${GENERATED_AT}`);
    // 文件一旦被转发，文件名是最先被改掉的东西，所以口径必须在文件里。
    expect(lines[2]).toBe('消息时间均为 UTC。');
  });

  it('writes one line per message, each starting with its time', () => {
    const text = renderTranscript({
      label: 'x',
      generatedAt: GENERATED_AT,
      sections: [sectionOf()],
    });
    expect(text).toContain('【网页顾客-2LIX · 企业微信】');
    expect(text).toContain('[2026-09-22T01:00:00.000Z] 顾客：你好');
    expect(text).toContain('[2026-09-22T01:01:00.000Z] 客服小蓝：您好，请问有什么可以帮您？');
  });

  it('indents a multi-line message instead of flattening it', () => {
    // 顾客发来的多行内容真实存在：压成一行会让引用、地址、单号糊在一起。
    const text = renderTranscript({
      label: 'x',
      generatedAt: GENERATED_AT,
      sections: [
        sectionOf({
          messages: [{ occurredAt: GENERATED_AT, speaker: '顾客', content: '第一行\n第二行' }],
        }),
      ],
    });
    expect(text).toContain('顾客：第一行\n  第二行');
  });

  it('says so when a section has no messages', () => {
    const text = renderTranscript({
      label: 'x',
      generatedAt: GENERATED_AT,
      sections: [sectionOf({ messages: [] })],
    });
    expect(text).toContain('（无消息）');
  });
});

describe('buildCustomerWorkbook', () => {
  it('writes the console’s four columns, in that order, plus the two readings', async () => {
    const bytes = await buildCustomerWorkbook([customerOf()], GENERATED_AT);
    const sheet = await readSheet(bytes, '顾客');

    expect(sheet.getCell('A1').value).toContain('导出时间 2026-09-22T02:30:00.000Z');
    expect(sheet.getCell('A2').value).toBe('姓名');
    expect(sheet.getCell('B2').value).toBe('渠道来源');
    expect(sheet.getCell('C2').value).toBe('电话');
    expect(sheet.getCell('D2').value).toBe('微信');
    expect(sheet.getCell('A3').value).toBe('网页顾客-2LIX');
    expect(sheet.getCell('B3').value).toBe('企业微信');
    expect(sheet.getCell('D3').value).toBe('wm-1');
    expect(sheet.getCell('E3').value).toBe(2);
    expect(sheet.getCell('F3').value).toBe('2026-09-22T01:00:00.000Z');
  });

  it('keeps the phone column, empty, rather than dropping it', async () => {
    // 空列是有意义的答案：平台没有这个字段，不是这次没查出来。少一列就变成
    // 「导出的表里没有电话」——那和「电话是空的」是两件事。
    const sheet = await readSheet(
      await buildCustomerWorkbook([customerOf()], GENERATED_AT),
      '顾客',
    );
    expect(sheet.getCell('C2').value).toBe('电话');
    expect(sheet.getCell('C3').value).toBe('');
  });

  it('writes one row per customer', async () => {
    const bytes = await buildCustomerWorkbook(
      [customerOf(), customerOf({ customerKey: 'wecom:wm-2', nickname: '网页顾客-9ZZZ' })],
      GENERATED_AT,
    );
    const sheet = await readSheet(bytes, '顾客');
    expect(sheet.getCell('A4').value).toBe('网页顾客-9ZZZ');
    expect(sheet.getCell('A5').value).toBeNull();
  });
});

describe('buildMessageWorkbook', () => {
  it('writes one row per message, naming the conversation it came from', async () => {
    const bytes = await buildMessageWorkbook([sectionOf()], GENERATED_AT);
    const sheet = await readSheet(bytes, '对话记录');

    expect(sheet.getCell('A1').value).toContain('时间均为 UTC');
    expect([
      sheet.getCell('A2').value,
      sheet.getCell('B2').value,
      sheet.getCell('C2').value,
      sheet.getCell('D2').value,
    ]).toEqual(['时间', '会话', '发送方', '内容']);
    expect(sheet.getCell('B3').value).toBe('网页顾客-2LIX · 企业微信');
    expect(sheet.getCell('C3').value).toBe('顾客');
    expect(sheet.getCell('D3').value).toBe('你好');
    expect(sheet.getCell('C4').value).toBe('客服小蓝');
  });

  it('keeps two conversations apart in one export', async () => {
    // 一份导出可能覆盖多个会话，行里不写会话就分不出两段对话的边界：第一段的
    // 两条都写第一段的名字，第二段从下一条开始换名。
    const bytes = await buildMessageWorkbook(
      [
        sectionOf(),
        sectionOf({
          heading: '网页顾客-9ZZZ · 企业微信',
          messages: [{ occurredAt: GENERATED_AT, speaker: '顾客', content: '在吗' }],
        }),
      ],
      GENERATED_AT,
    );
    const sheet = await readSheet(bytes, '对话记录');
    expect(sheet.getCell('B3').value).toBe('网页顾客-2LIX · 企业微信');
    expect(sheet.getCell('B4').value).toBe('网页顾客-2LIX · 企业微信');
    expect(sheet.getCell('B5').value).toBe('网页顾客-9ZZZ · 企业微信');
    expect(sheet.getCell('D5').value).toBe('在吗');
  });
});

describe('renderCustomerList', () => {
  it('carries the same three opening lines, then one line per customer', () => {
    const text = renderCustomerList([customerOf()], {
      label: '全部顾客',
      generatedAt: GENERATED_AT,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('导出内容：全部顾客');
    expect(lines[1]).toBe(`导出时间：${GENERATED_AT}`);
    // 名单里没有消息：抬头不能说「消息时间」。
    expect(lines[2]).toBe('时间均为 UTC。');
    expect(lines[4]).toBe('[2026-09-22T01:00:00.000Z] 网页顾客-2LIX · 企业微信 · 会话 2 · 微信 wm-1');
  });

  it('leaves the WeChat half out rather than writing an empty one', () => {
    // 电话那一列在表格里有表头可解释自己的空，文本里没有表头——一个「微信：」
    // 后面什么都没有，读的人只会以为导出坏了。
    const text = renderCustomerList([customerOf({ channel: 'other', wechat: null })], {
      label: 'x',
      generatedAt: GENERATED_AT,
    });
    expect(text).toContain('· 会话 2\n');
    expect(text).not.toContain('微信');
  });

  it('says so when nothing matched', () => {
    const text = renderCustomerList([], { label: '全部顾客', generatedAt: GENERATED_AT });
    expect(text).toContain('（没有匹配的顾客）');
  });
});

describe('the stored payload', () => {
  it('round-trips a conversation request', () => {
    const request = { scope: 'conversation' as const, conversationId: 'conversation-1' };
    expect(readExportJobPayload(exportJobPayload(request, '顾客「小明」的对话'))).toEqual({
      scope: 'conversation',
      label: '顾客「小明」的对话',
      conversationId: 'conversation-1',
    });
  });

  it('round-trips a customer filter instant by instant', () => {
    // 存进去的是解析之后的口径：Worker 领到任务时那次请求早结束了，没人能再解析一遍。
    const request = {
      scope: 'customers' as const,
      filter: { query: '羽绒服', from: '2026-09-01T00:00:00.000Z', to: null },
    };
    const payload = exportJobPayload(request, '全部顾客');
    expect(readExportJobPayload(JSON.parse(JSON.stringify(payload)))).toEqual({
      scope: 'customers',
      label: '全部顾客',
      filter: { query: '羽绒服', from: '2026-09-01T00:00:00.000Z', to: null },
    });
  });

  it('refuses a payload it cannot read rather than half-reading one', () => {
    // `jobs` 里还躺着别的 kind 的行，读不出形状必须能说出来。
    for (const payload of [
      null,
      42,
      [],
      {},
      { scope: 'conversation', label: 'x' },
      { scope: 'everything', label: 'x' },
      { scope: 'customers', label: 'x', filter: { query: 5, from: null, to: null } },
      { scope: 'customers', label: 'x' },
      { scope: 'customers', filter: { query: null, from: null, to: null } },
    ]) {
      expect(readExportJobPayload(payload)).toBeNull();
    }
  });
});
