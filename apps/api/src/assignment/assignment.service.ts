import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertTenantAdmin,
  DEFAULT_OFFLINE_REPLY_CONTENT,
  type AccessContext,
  type AgentAvailabilityStatus,
  type AssignmentCandidate,
  type AgentPresence,
  type DispatchOutcome,
  type Member,
} from '@kefu/core';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { RealtimeService } from '../realtime/realtime.service';

/** What one sweep did, grouped so a caller can log a single line. */
export type AssignmentSweepResult = {
  /** Conversation ids handed to a seat. */
  readonly assigned: ReadonlyArray<string>;
  /** Conversation ids whose customer received the offline reply in this sweep. */
  readonly fellBack: ReadonlyArray<string>;
  /** Conversation ids that were already parked in the fallback and stayed there. */
  readonly waiting: ReadonlyArray<string>;
  /** Conversation ids another process settled first, so this sweep wrote nothing. */
  readonly lost: ReadonlyArray<string>;
  /** Conversation ids whose offline reply could not be handed to the channel. */
  readonly failed: ReadonlyArray<string>;
};

/**
 * Agent availability and automatic conversation assignment.
 *
 * Deliberately depends on nothing but the repository port. The sweep therefore
 * has no route into a feature service, which is what keeps it out of the
 * conversation service's own dependency graph and free of a module cycle.
 *
 * A sweep never decides anything itself: presence liveness, eligibility, seat
 * choice and the fallback verdict all come from `@kefu/core`, so the in-memory
 * store and the SQL adapter cannot disagree about who should take a conversation.
 */
@Injectable()
export class AssignmentService {
  /**
   * @param repository - The environment-selected platform fact source.
   * @param realtime - Announces seat availability and automatic assignments, so
   * a workbench that did not make the change still learns about it.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The acting member's own seat state.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The resolved acting member.
   * @returns The seat row, or `undefined` when this member has never reported.
   */
  async presence(tenantId: string, member: Member): Promise<AgentPresence | undefined> {
    return this.repository.getAgentPresence(tenantId, member.id);
  }

  /**
   * Every seat's presence in one tenant, for a roster's 在线/离线 lamps.
   *
   * The only read here that is about somebody other than the caller, and so the
   * only one that has to authorize: {@link presence} answers the acting member
   * about themselves, which needs no permission at all. Reading a colleague's
   * status is tenant administration, so it takes the same rule the member listing
   * takes — a platform administrator, or the tenant's own merchant administrator
   * — rather than inventing a second one.
   *
   * A seat that never reported in has no row and is **absent** from the result.
   * Deciding that absent means 离线 belongs to the caller, which is the only
   * place that knows which seats it is drawing.
   *
   * @param access - The acting administrator's access context.
   * @param tenantId - The tenant whose seats to list.
   * @returns One presence row per seat that has reported in.
   * @throws {AuthError} `access_denied` when the caller does not administer the tenant.
   */
  async tenantPresence(
    access: AccessContext,
    tenantId: string,
  ): Promise<ReadonlyArray<AgentPresence>> {
    assertTenantAdmin(access, tenantId);
    return this.repository.listTenantAgentPresence(tenantId);
  }

  /**
   * Report the acting member's availability.
   *
   * Only an agent holds a seat: an administrator has no queue to accept work from
   * and no store to be dispatched within, so the request is refused rather than
   * silently recording a row nobody reads.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The resolved acting member.
   * @param status - The availability to record.
   * @param now - ISO instant of the report.
   * @returns The stored seat state.
   * @throws {ForbiddenException} When the member is not a store-scoped agent.
   */
  async setPresence(
    tenantId: string,
    member: Member,
    status: AgentAvailabilityStatus,
    now: string,
  ): Promise<AgentPresence> {
    const storeId = this.requireSeat(member);
    const presence = await this.repository.setAgentPresence({
      tenantId,
      memberId: member.id,
      storeId,
      status,
      now,
    });
    // Announced from the stored row, so a seat that reports the status it already
    // had still produces a frame — and no harm, because the frame is only a nudge
    // to re-read. Distinguishing "changed" from "re-reported" would need the
    // pre-write row, and the re-read is cheap and idempotent.
    this.realtime.presenceChanged(presence);
    return presence;
  }

  /**
   * Refresh the acting member's liveness without moving its status.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The resolved acting member.
   * @param now - ISO instant of the heartbeat.
   * @returns The refreshed seat state.
   * @throws {NotFoundException} When the seat has never reported a status, since
   * a heartbeat must not invent one.
   * @throws {ForbiddenException} When the member is not a store-scoped agent.
   */
  async heartbeat(tenantId: string, member: Member, now: string): Promise<AgentPresence> {
    this.requireSeat(member);
    const presence = await this.repository.heartbeatAgentPresence(tenantId, member.id, now);
    if (presence === undefined) {
      throw new NotFoundException('no availability has been reported for this member');
    }
    return presence;
  }

  /**
   * The seats of one store, including their reported availability and load.
   *
   * Unfiltered by design — eligibility is the core rule's decision, and an
   * adapter that pre-filtered would be a second copy of it.
   *
   * @param tenantId - Effective tenant scope.
   * @param storeId - Store whose seats to read.
   * @returns Every agent member of that store.
   */
  async candidates(tenantId: string, storeId: string): Promise<ReadonlyArray<AssignmentCandidate>> {
    return this.repository.listAssignmentCandidates(tenantId, storeId);
  }

  /**
   * Run one bounded dispatch sweep.
   *
   * The repository does the whole decision inside one transaction, so a
   * conversation is either assigned with its history row or untouched. Only then
   * does this method send the offline reply for a conversation the sweep decided
   * nobody could take — after the commit, on the same outbound path an agent's own
   * message takes, so the customer's delivery carries the same reliability
   * guarantee and no more.
   *
   * @param now - Instant the sweep judges presence and stamps writes at (ISO).
   * @param limit - Most conversations to consider in this sweep.
   * @returns What the sweep did, grouped by outcome.
   */
  async runOnce(now: string, limit: number): Promise<AssignmentSweepResult> {
    const outcomes = await this.repository.dispatchDue({ now, limit });
    const assigned: string[] = [];
    const fellBack: string[] = [];
    const waiting: string[] = [];
    const lost: string[] = [];
    const failed: string[] = [];
    for (const outcome of outcomes) {
      switch (outcome.kind) {
        case 'assigned':
          assigned.push(outcome.conversationId);
          // Re-read rather than reconstruct: the sweep's outcome names the seat,
          // not the row it produced, and a frame that disagreed with the stored
          // conversation would send every watching seat to look for something
          // that is not there. A conversation deleted between the commit and this
          // read simply has nothing to announce.
          await this.announceAssigned(outcome);
          break;
        case 'fallback':
          // A send that fails for one customer must not cost the rest of the
          // batch its own: the sweep is the only thing retrying anything here,
          // so an uncaught throw would strand every later conversation in this
          // pass. The conversation keeps its parked state either way.
          try {
            await this.sendOfflineReply(outcome);
            fellBack.push(outcome.conversationId);
          } catch {
            failed.push(outcome.conversationId);
          }
          break;
        case 'waiting':
          waiting.push(outcome.conversationId);
          break;
        case 'lost':
          lost.push(outcome.conversationId);
          break;
      }
    }
    return { assigned, fellBack, waiting, lost, failed };
  }

  /**
   * Send the offline reply for a conversation the sweep has just parked.
   *
   * `source: 'other'` is what marks the send as automated, which keeps it out of
   * the review queue and stops it from closing the customer's first-response
   * clock — that clock measures the wait for a person.
   *
   * The row that authorised this send is already committed, so a crash between
   * commit and send means the customer is never told. That is deliberate: the
   * alternative is a retry that cannot tell "not sent yet" from "sent, and the
   * process died before it could say so", and a customer receiving the same
   * apology twice is worse than one who receives it late or not at all.
   *
   * @param outcome - The fallback decision this send belongs to.
   */
  private async sendOfflineReply(
    outcome: Extract<DispatchOutcome, { readonly kind: 'fallback' }>,
  ): Promise<void> {
    const sent = await this.repository.sendOutbound({
      tenantId: outcome.tenantId,
      storeId: outcome.storeId,
      conversationId: outcome.conversationId,
      content: DEFAULT_OFFLINE_REPLY_CONTENT,
      source: 'other',
      dedupKey: `offline-reply:${outcome.conversationId}`,
    });
    // The automatic reply is announced like any other outbound message: a seat
    // that comes online to a parked conversation has to see what the customer
    // was already told, and a frame is the only thing that puts it there without
    // a manual refresh. Only a genuinely new row is announced — a sweep that
    // re-ran on the same conversation resolves to the message the first pass
    // wrote, and re-announcing it would be a re-read for nothing.
    if (sent.created) {
      this.realtime.messageCreated(sent.message);
    }
  }

  /**
   * Announce a conversation the sweep has just handed to a seat.
   *
   * @param outcome - The assignment decision this announcement belongs to.
   */
  private async announceAssigned(
    outcome: Extract<DispatchOutcome, { readonly kind: 'assigned' }>,
  ): Promise<void> {
    const conversation = await this.repository.getConversation(
      outcome.tenantId,
      outcome.conversationId,
    );
    if (conversation !== undefined) {
      this.realtime.conversationUpdated(conversation);
    }
  }

  /**
   * The acting member's store, or a refusal.
   *
   * @param member - The resolved acting member.
   * @returns The member's store id.
   * @throws {ForbiddenException} When the member holds no store seat.
   */
  private requireSeat(member: Member): string {
    if (member.role !== 'agent' || member.storeId === null) {
      throw new ForbiddenException('only a store-scoped agent has an availability state');
    }
    return member.storeId;
  }
}
