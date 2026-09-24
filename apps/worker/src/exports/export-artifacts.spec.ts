/**
 * One job's two files, built from one read.
 *
 * The assertions are *read-backs*, not byte lengths: an xlsx is never empty as
 * long as exceljs did not throw, so "produced some bytes" would pass with the
 * wrong sheet name, the columns in the wrong order, or the message rows missing
 * entirely. The text file is checked for the lines it must contain, including the
 * UTC statement that has to survive being forwarded without the task list beside
 * it.
 */

import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_CUSTOMER_LIMIT,
  EXPORT_MESSAGE_LIMIT,
  type CustomerSummary,
} from '@kefu/core';
import { ExportTooLargeError, buildExportArtifacts, exportRowCount } from './export-artifacts';
import type { ExportSource } from './export-job-repository';

const GENERATED_AT = '2026-09-22T02:30:00.000Z';
const JOB = {
  id: 'export-9f3a1c02-aaaa-bbbb',
  label: '顾客「网页顾客-2LIX」的对话',
  createdAt: '2026-09-22T02:30:00.000Z',
} as const;

/** One conversation's source, with the two messages a transcript needs. */
function conversationSource(): ExportSource {
  return {
    scope: 'conversation',
    sections: [
      {
        heading: '网页顾客-2LIX · 企业微信',
        messages: [
          { occurredAt: '2026-09-22T01:00:00.000Z', speaker: '顾客', content: '你好' },
          { occurredAt: '2026-09-22T01:01:00.000Z', speaker: '客服', content: '你好，在的' },
        ],
      },
    ],
  };
}

/** One customer row. */
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

/** Read one sheet back, failing loudly if the sheet is not there. */
async function readSheet(bytes: Buffer, name: string): Promise<import('exceljs').Worksheet> {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet(name);
  if (sheet === undefined) {
    throw new Error(`no sheet named ${name}`);
  }
  return sheet;
}

/** The artifact of one format, or a failure naming what was produced instead. */
async function artifactOf(source: ExportSource, format: 'xlsx' | 'transcript'): Promise<Buffer> {
  const built = await buildExportArtifacts({ ...JOB, scope: source.scope }, source, GENERATED_AT);
  const artifact = built.artifacts.find((entry) => entry.format === format);
  if (artifact === undefined) {
    throw new Error(`no ${format} artifact: ${built.artifacts.map((a) => a.format).join(',')}`);
  }
  return artifact.bytes;
}

describe('exportRowCount', () => {
  it('counts the messages of a conversation', () => {
    expect(exportRowCount(conversationSource())).toBe(2);
  });

  it('counts the customers of a filter', () => {
    expect(exportRowCount({ scope: 'customers', customers: [customerOf(), customerOf()] })).toBe(2);
  });
});

describe('buildExportArtifacts for a conversation', () => {
  it('produces both files, named after the job', async () => {
    const built = await buildExportArtifacts(
      { ...JOB, scope: 'conversation' },
      conversationSource(),
      GENERATED_AT,
    );
    expect(built.artifacts.map((artifact) => artifact.fileName)).toEqual([
      'conversation-20260922-export-9.xlsx',
      'conversation-20260922-export-9.txt',
    ]);
    expect(built.artifacts.map((artifact) => artifact.contentType)).toEqual([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain; charset=utf-8',
    ]);
    expect(built.rowCount).toBe(2);
  });

  it('writes one spreadsheet row per message, from the same read as the text', async () => {
    const source = conversationSource();
    const sheet = await readSheet(await artifactOf(source, 'xlsx'), '对话记录');
    const text = (await artifactOf(source, 'transcript')).toString('utf8');

    expect(sheet.getCell('C3').value).toBe('顾客');
    expect(sheet.getCell('D3').value).toBe('你好');
    expect(sheet.getCell('C4').value).toBe('客服');
    // The two files agree because they come from one source: a second read is how
    // a spreadsheet of 500 rows and a transcript of 499 rows happen.
    expect(text).toContain('[2026-09-22T01:01:00.000Z] 客服：你好，在的');
    expect(text).toContain('消息时间均为 UTC。');
  });

  it('refuses a conversation over the message cap, naming it', async () => {
    // 一屏之外的地方悄悄截断，比一次明说失败更糟：文件看起来是完整的。
    const source: ExportSource = {
      scope: 'conversation',
      sections: [
        {
          heading: '网页顾客-2LIX · 企业微信',
          messages: Array.from({ length: EXPORT_MESSAGE_LIMIT + 1 }, (_unused, index) => ({
            occurredAt: GENERATED_AT,
            speaker: '顾客',
            content: `第 ${index} 条`,
          })),
        },
      ],
    };
    await expect(
      buildExportArtifacts({ ...JOB, scope: 'conversation' }, source, GENERATED_AT),
    ).rejects.toThrow(ExportTooLargeError);
    await expect(
      buildExportArtifacts({ ...JOB, scope: 'conversation' }, source, GENERATED_AT),
    ).rejects.toThrow(new RegExp(String(EXPORT_MESSAGE_LIMIT)));
  });

  it('accepts a conversation exactly at the cap', async () => {
    const source: ExportSource = {
      scope: 'conversation',
      sections: [
        {
          heading: '网页顾客-2LIX · 企业微信',
          messages: Array.from({ length: EXPORT_MESSAGE_LIMIT }, () => ({
            occurredAt: GENERATED_AT,
            speaker: '顾客',
            content: 'x',
          })),
        },
      ],
    };
    const built = await buildExportArtifacts({ ...JOB, scope: 'conversation' }, source, GENERATED_AT);
    expect(built.rowCount).toBe(EXPORT_MESSAGE_LIMIT);
  });
});

describe('buildExportArtifacts for a customer filter', () => {
  const source: ExportSource = { scope: 'customers', customers: [customerOf()] };

  it('produces both files, named after the scope', async () => {
    const built = await buildExportArtifacts({ ...JOB, scope: 'customers' }, source, GENERATED_AT);
    expect(built.artifacts.map((artifact) => artifact.fileName)).toEqual([
      'customers-20260922-export-9.xlsx',
      'customers-20260922-export-9.txt',
    ]);
    expect(built.rowCount).toBe(1);
  });

  it('writes the same row into both files', async () => {
    const sheet = await readSheet(await artifactOf(source, 'xlsx'), '顾客');
    const text = (await artifactOf(source, 'transcript')).toString('utf8');

    expect(sheet.getCell('A3').value).toBe('网页顾客-2LIX');
    // 电话那一列在表格里保留、在文本里不出现，两处都是「平台没有这个字段」的答案。
    expect(sheet.getCell('C3').value).toBe('');
    expect(text).toContain('[2026-09-22T01:00:00.000Z] 网页顾客-2LIX · 企业微信 · 会话 2');
  });

  it('refuses a customer list over the cap, naming it', async () => {
    const big: ExportSource = {
      scope: 'customers',
      customers: Array.from({ length: EXPORT_CUSTOMER_LIMIT + 1 }, () => customerOf()),
    };
    await expect(
      buildExportArtifacts({ ...JOB, scope: 'customers' }, big, GENERATED_AT),
    ).rejects.toThrow(new RegExp(String(EXPORT_CUSTOMER_LIMIT)));
  });
});
