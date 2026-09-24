import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { parseCustomerFilter, type CustomerSummary } from '@kefu/core';
import { queryString } from '../http/query-param';
import { AccessService } from '../platform/access.service';
import { ExportsService, refuseWithDetails } from './exports.service';

/**
 * The customer list: one row per person who has ever written in.
 *
 * Reads the tenant's conversations rather than a customer table, because there
 * is no customer table — see `@kefu/core`'s `customer-directory` for why that
 * makes "姓名" the conversation's title and "电话" structurally empty.
 *
 * No role gate beyond the tenant scope. This page lists what an agent can
 * already reach in the workspace (the tenant's conversations, narrowed by the
 * same `resolveStoreScope` rule that no longer narrows anyone), so an extra gate
 * here would be a permission that hides data rather than one that protects it.
 */
@Controller('customers')
export class CustomersController {
  /**
   * @param access - Resolves the acting member and the tenant scope.
   * @param exports - The customer aggregate.
   */
  constructor(
    private readonly access: AccessService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The customer page.
   *
   * The filter is parsed by `@kefu/core` rather than by the query bag: an
   * unreadable date has to be refused with the reason quoted back, because
   * treating it as "no range" would hand the operator a longer list than they
   * asked for and nothing on the page would say so.
   *
   * @param req - The incoming request.
   * @param query - Raw query parameters: `q`, `from`, `to`.
   * @returns The matching customers, most recently active first.
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: Readonly<Record<string, unknown>>,
  ): Promise<ReadonlyArray<CustomerSummary>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);

    const parsed = parseCustomerFilter({
      q: queryString(query, 'q') ?? undefined,
      from: queryString(query, 'from') ?? undefined,
      to: queryString(query, 'to') ?? undefined,
    });
    if (!parsed.ok) {
      refuseWithDetails(parsed.details);
    }
    return this.exports.listCustomers(tenantId, parsed.filter);
  }
}
