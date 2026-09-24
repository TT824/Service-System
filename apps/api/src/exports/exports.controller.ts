import { Controller, Get, NotFoundException, Param, Post, Body, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseExportRequest, type ExportJobRecord } from '@kefu/core';
import { queryString } from '../http/query-param';
import { AccessService } from '../platform/access.service';
import {
  EXPORT_JOB_PAGE_LIMIT,
  ExportsService,
  isArtifactFormat,
  refuseWithDetails,
} from './exports.service';

/**
 * Export jobs: the queue, and the two files a finished job produces.
 *
 * A job is created here and rendered by the worker — a different process with
 * its own database reader — so this controller never renders anything. What it
 * answers with is the job's *state* (the console's five columns: id, status,
 * created, started, finished) and, once the worker has written them, the bytes.
 *
 * The files live in `job_artifacts` rather than on disk because the two
 * processes share exactly one thing, and it is the database; writing them to a
 * directory would make "can I download this" depend on a shared filesystem that
 * nothing else in the platform requires.
 */
@Controller('exports')
export class ExportsController {
  /**
   * @param access - Resolves the acting member and the tenant scope.
   * @param exports - Job queue and artifact storage.
   */
  constructor(
    private readonly access: AccessService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * Queue an export.
   *
   * The body carries either a conversation or a customer filter, and its shape
   * is `@kefu/core`'s (`parseExportRequest`) — the same parser the console's
   * request is written against, so a body the console can build is a body this
   * route accepts, and one it cannot is refused with the reason named.
   *
   * @param req - The incoming request.
   * @param body - The export request.
   * @returns The queued job.
   */
  @Post()
  async create(@Req() req: Request, @Body() body: unknown): Promise<ExportJobRecord> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);

    const parsed = parseExportRequest(body);
    if (!parsed.ok) {
      refuseWithDetails(parsed.details);
    }
    return this.exports.createJob(tenantId, parsed.request);
  }

  /**
   * This tenant's export tasks, newest first.
   *
   * @param req - The incoming request.
   * @param query - Raw query parameters; `limit` is optional.
   * @returns The jobs.
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: Readonly<Record<string, unknown>>,
  ): Promise<ReadonlyArray<ExportJobRecord>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.exports.listJobs(tenantId, readLimit(queryString(query, 'limit')));
  }

  /**
   * Download one of a finished job's two files.
   *
   * The response is written directly rather than returned, because the body is
   * the file itself and not the `{ request_id, data, meta }` envelope — wrapping
   * an xlsx in JSON would corrupt it. Same reasoning as `MediaController`.
   *
   * Three answers, deliberately distinct:
   *
   * - **Unknown format** → `400 bad_request`, listing the two that exist. A
   *   path segment is not a place to guess.
   * - **No such artifact for this tenant** → `404 not_found`. That covers all
   *   three ways of getting here: a job that does not exist, a job of another
   *   tenant, and a job that has not finished rendering yet. They are one answer
   *   because distinguishing them would let an id be probed for existence.
   * - **Found** → the bytes, as an attachment.
   *
   * @param req - The incoming request.
   * @param jobId - The job the file belongs to.
   * @param format - `xlsx` or `transcript`.
   * @param res - The raw response, written rather than returned.
   */
  @Get(':jobId/download/:format')
  async download(
    @Req() req: Request,
    @Param('jobId') jobId: string,
    @Param('format') format: string,
    @Res() res: Response,
  ): Promise<void> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);

    if (!isArtifactFormat(format)) {
      refuseWithDetails([`下载格式必须是 xlsx 或 transcript，收到「${format}」`]);
    }

    const artifact = await this.exports.readArtifact(tenantId, jobId, format);
    if (artifact === null) {
      throw new NotFoundException('no such export artifact');
    }

    res
      .type(artifact.contentType)
      // The file name is ASCII by construction (`exportArtifactFileName`), so it
      // can go in a plain `filename=` without RFC 5987 encoding — and it is read
      // back from the row rather than re-derived, so what the console sees in the
      // download shelf is what the worker actually wrote.
      .setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`)
      // Private and never stored: this is one tenant's customers, and a shared
      // cache holding it would hand it to the next reader of the same URL.
      .setHeader('Cache-Control', 'private, no-store')
      .send(artifact.bytes);
  }
}

/**
 * Read the `limit` query parameter.
 *
 * An unreadable limit is read as "the default page", not as an error: it is a
 * page size, and refusing the whole list because a stray character rode along in
 * the URL would be the wrong trade.
 *
 * @param raw - The parameter, if present.
 * @returns A positive page size.
 */
function readLimit(raw: string | null): number {
  if (raw === null) {
    return EXPORT_JOB_PAGE_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return EXPORT_JOB_PAGE_LIMIT;
  }
  return Math.min(parsed, EXPORT_JOB_PAGE_LIMIT);
}
