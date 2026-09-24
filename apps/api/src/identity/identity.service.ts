import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLATFORM_ADMIN_MEMBER_ID,
  type AppConfig,
  type Member,
  type ReviewPolicy,
  type Store,
  type Tenant,
} from '@kefu/core';
import type { WecomCredentialReader } from '@kefu/wecom';
import { APP_CONFIG } from '../config/app-config.module';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { describeWecomTransport, type WecomTransportStatus } from '../channels/wecom-transport';
import { WECOM_CREDENTIAL_READER } from '../channels/wecom-credential.source';

/** Public account status payload for the access view. */
export type AccountStatusPayload = {
  readonly member: Member;
  readonly tenant: Tenant | null;
  readonly stores: ReadonlyArray<Store>;
  readonly members: ReadonlyArray<Member>;
  /**
   * The same channel description `GET /channels` reports, so the account page
   * cannot call the channel disabled while the channel page calls it
   * operational, and neither claims a real connection or credentials that were
   * not actually checked.
   */
  readonly wecom: WecomTransportStatus;
  readonly reviewPolicy: ReviewPolicy;
};

/** One tenant shown in the directory with its stores and members. */
export type TenantDirectoryEntry = {
  readonly tenant: Tenant;
  readonly stores: ReadonlyArray<Store>;
  readonly members: ReadonlyArray<Member>;
};

/**
 * Identity and directory behavior for the internal MVP.
 *
 * Account status and tenant/store/member configuration are read-only HTTP
 * surfaces used by the account center and configuration views. Every read goes
 * through the platform repository, so the directory a caller sees is the same
 * one requests are authorized against, and it survives a process restart.
 */
@Injectable()
export class IdentityService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    @Inject(WECOM_CREDENTIAL_READER) private readonly credentials: WecomCredentialReader,
  ) {}

  /** Build the account status for the acting member. */
  async accountStatus(member: Member): Promise<AccountStatusPayload> {
    const tenantId = member.tenantId;
    const tenant = tenantId === null ? null : ((await this.repository.getTenant(tenantId)) ?? null);
    const stores = tenantId === null ? [] : await this.repository.listStores(tenantId);
    const members = tenantId === null ? [] : await this.repository.listMembers(tenantId);

    return {
      member,
      tenant,
      stores,
      members,
      // Resolved here for the same reason the channel page resolves it: the
      // status has to describe the credentials that are configured *now*, so a
      // value stored from the console is reflected on both surfaces at once.
      wecom: describeWecomTransport(this.config, await this.credentials()),
      reviewPolicy: await this.repository.getReviewPolicy(),
    };
  }

  /** List tenants the acting member is allowed to see. */
  async listAccessibleTenants(member: Member): Promise<ReadonlyArray<TenantDirectoryEntry>> {
    const tenantIds =
      member.tenantId === null
        ? (await this.repository.listTenants()).map((tenant) => tenant.id)
        : [member.tenantId];
    const entries = await Promise.all(
      tenantIds.map((tenantId) => this.buildDirectoryEntry(tenantId)),
    );
    return entries.filter((entry): entry is TenantDirectoryEntry => entry !== undefined);
  }

  /** Return the directory entry for one tenant (authorized). */
  async getDirectoryEntry(member: Member, tenantId: string): Promise<TenantDirectoryEntry> {
    if (member.tenantId !== null && member.tenantId !== tenantId) {
      throw new ForbiddenException('tenant is outside the member scope');
    }
    const entry = await this.buildDirectoryEntry(tenantId);
    if (entry === undefined) {
      throw new NotFoundException('tenant not found');
    }
    return entry;
  }

  /** Resolve a member id that must exist (used by transfer targets). */
  async requireMember(memberId: string): Promise<Member> {
    if (memberId === PLATFORM_ADMIN_MEMBER_ID) {
      // A platform administrator can never be a conversation assignee.
      throw new BadRequestException('platform administrators cannot be conversation assignees');
    }
    const member = await this.repository.getMember(memberId);
    if (member === undefined || !member.enabled) {
      throw new NotFoundException('target member not found');
    }
    return member;
  }

  private async buildDirectoryEntry(tenantId: string): Promise<TenantDirectoryEntry | undefined> {
    const tenant = await this.repository.getTenant(tenantId);
    if (tenant === undefined) {
      return undefined;
    }
    return {
      tenant,
      stores: await this.repository.listStores(tenantId),
      members: await this.repository.listMembers(tenantId),
    };
  }
}
