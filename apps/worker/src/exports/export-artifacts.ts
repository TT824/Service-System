/**
 * Turning one job's source into the two files the console offers.
 *
 * This is the whole of the worker's rendering, and it is pure: rows in, buffers
 * out. The layout rules themselves are `@kefu/core`'s (`buildCustomerWorkbook`,
 * `buildMessageWorkbook`, `renderTranscript`, `renderCustomerList`) — what is left
 * here is the two decisions that depend on *which* job this is:
 *
 *   * **Both files come from one read.** `xlsx` and the text rendering are two
 *     layouts of the same rows, so a job either succeeds with both or fails
 *     without either. Two reads would let an export answer with a spreadsheet of
 *     five hundred customers and a transcript of four hundred and ninety-nine,
 *     and nothing in either file would say which one the operator should believe.
 *   * **Over the cap, refuse — do not truncate.** `EXPORT_MESSAGE_LIMIT` and
 *     `EXPORT_CUSTOMER_LIMIT` exist so one click cannot occupy the Worker; the
 *     reader is one row over the limit precisely so that this function can tell
 *     "exactly at the cap" from "over it" and fail the job with a reason. A
 *     truncated export is worse than a failed one: the file looks complete, and
 *     the person reading it has no way to know that it is not.
 */

import {
  EXPORT_ARTIFACT_FORMATS,
  EXPORT_CUSTOMER_LIMIT,
  EXPORT_MESSAGE_LIMIT,
  buildCustomerWorkbook,
  buildMessageWorkbook,
  exportArtifactContentType,
  exportArtifactFileName,
  renderCustomerList,
  renderTranscript,
  type ExportArtifactFormat,
  type ExportScope,
} from '@kefu/core';
import type { ArtifactWrite, ExportSource } from './export-job-repository';

/**
 * An export that is larger than one job may produce.
 *
 * Its `message` is what the operator reads in the task list, so it says which cap
 * was hit and what to do about it — a bare "failed" would send them to support
 * with nothing to say.
 */
export class ExportTooLargeError extends Error {
  /**
   * @param message - The reason, phrased for the task list.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ExportTooLargeError';
  }
}

/** How many rows went into one job's files, for the console's reading. */
export function exportRowCount(source: ExportSource): number {
  return source.scope === 'conversation'
    ? source.sections.reduce((total, section) => total + section.messages.length, 0)
    : source.customers.length;
}

/**
 * Build a job's two files.
 *
 * @param job - The job's identity: its id, scope, label and creation instant.
 *   The creation instant is what the file name's day comes from — the file
 *   identifies the job, so it carries the job's own date rather than the instant
 *   a Worker happened to pick it up.
 * @param source - What the job exports.
 * @param generatedAt - The instant written into both files.
 * @returns The files and the row count.
 * @throws {ExportTooLargeError} When the source is over this job's cap.
 */
export async function buildExportArtifacts(
  job: {
    readonly id: string;
    readonly scope: ExportScope;
    readonly label: string;
    readonly createdAt: string;
  },
  source: ExportSource,
  generatedAt: string,
): Promise<{ readonly rowCount: number; readonly artifacts: ReadonlyArray<ArtifactWrite> }> {
  const rowCount = exportRowCount(source);
  assertWithinLimit(source, rowCount);

  const nameFor = (
    format: ExportArtifactFormat,
  ): { readonly fileName: string; readonly contentType: string } => ({
    fileName: exportArtifactFileName(job, format),
    contentType: exportArtifactContentType(format),
  });

  const artifacts: Array<ArtifactWrite> = [];
  for (const format of EXPORT_ARTIFACT_FORMATS) {
    const bytes =
      source.scope === 'conversation'
        ? format === 'xlsx'
          ? await buildMessageWorkbook(source.sections, generatedAt)
          : Buffer.from(
              renderTranscript({
                label: job.label,
                generatedAt,
                sections: source.sections,
              }),
              'utf8',
            )
        : format === 'xlsx'
          ? await buildCustomerWorkbook(source.customers, generatedAt)
          : Buffer.from(
              renderCustomerList(source.customers, { label: job.label, generatedAt }),
              'utf8',
            );
    artifacts.push({ format, ...nameFor(format), bytes });
  }
  return { rowCount, artifacts };
}

/**
 * Refuse a source that is over this job's cap.
 *
 * @param source - What the job exports.
 * @param rowCount - Its size.
 * @throws {ExportTooLargeError} When it is over the cap.
 */
function assertWithinLimit(source: ExportSource, rowCount: number): void {
  const limit = source.scope === 'conversation' ? EXPORT_MESSAGE_LIMIT : EXPORT_CUSTOMER_LIMIT;
  if (rowCount > limit) {
    throw new ExportTooLargeError(
      source.scope === 'conversation'
        ? `这条会话的消息超过 ${limit} 条，导出被拒绝：请改用顾客列表按时间段导出`
        : `符合条件的顾客超过 ${limit} 位，导出被拒绝：请缩小时间范围或加上关键字`,
    );
  }
}
