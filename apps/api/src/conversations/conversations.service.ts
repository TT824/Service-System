import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONTENT_SAFETY_RULES,
  MESSAGE_SOURCES,
  assignmentAudience,
  channelMessagePlaceholder,
  describeBlockedContent,
  effectiveAvailabilityStatus,
  firstResponseDurationMs,
  isAdministratorRole,
  maySendToConversation,
  mayTakeOverClaim,
  outboundMedia,
  screenContent,
  transferTargetRefusal,
  type AgentAvailabilityStatus,
  type AssignmentCandidate,
  type AssignmentReasonCode,
  type ChannelFailureCode,
  type ContentSafetyRule,
  type Conversation,
  type ConversationAssignment,
  type ConversationReadAccess,
  type Member,
  type Message,
  type MessageSource,
  type OutboundMediaKind,
  type ReplyWindowStatus,
  type StoreConversationResult,
  type TakeoverAuthority,
} from '@kefu/core';
import {
  ChannelDeliveryService,
  type DeliveryDetail,
  type DispatchedMessage,
} from '../channels/channel-delivery.service';
import { channelFailureFromAdapter } from '../channels/channel-outcome';
import { decodedFileName } from '../http/uploaded-file-name';
import { IdentityService } from '../identity/identity.service';
import {
  MEDIA_STORAGE,
  outboundMediaObjectKey,
  type MediaStorage,
} from '../media/media-storage';
import { MediaUrlService } from '../media/media-url.service';
import { AccessService } from '../platform/access.service';
import {
  PLATFORM_REPOSITORY,
  PlatformWriteError,
  type PlatformRepository,
} from '../platform/platform-repository';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Conversation detail payload: the conversation plus its message history.
 *
 * `deliveries` carries the provider-facing outcome of each outbound message, so
 * one read answers both "what was said" and "what happened to it at the
 * provider" without a second round trip.
 */
export type ConversationDetail = {
  readonly conversation: Conversation;
  readonly messages: ReadonlyArray<Message>;
  readonly deliveries: ReadonlyArray<DeliveryDetail>;
  /**
   * Where each message's stored image can be read, keyed by message id.
   *
   * A side map rather than a field on {@link Message}, because a signed URL is a
   * fact about *this response* and not about the message: it expires, it is
   * minted per read, and putting it on the domain row would make the row stale
   * the moment it was written. A message with no stored media has no entry, and
   * that absence is the same fact {@link Message.media} already carries — an
   * image whose bytes the platform did not keep.
   */
  readonly mediaUrls: Readonly<Record<string, string>>;
  /**
   * Whether this reader may send a message into the conversation right now.
   *
   * The seat holding it, and anybody while it is still 待接入 (nothing has been
   * taken yet, so there is nobody to speak over). A colleague's conversation and
   * one this reader handed over answer `false`. The console hides the composer on
   * this answer, so it is the send route's own judgement
   * ({@link maySendToConversation}) rather than a second reading of who may type.
   */
  readonly canReply: boolean;
  /**
   * The customer's 48-hour reply window and how much of its five-reply budget is
   * left, as the workspace's 外发提醒 banner shows it.
   *
   * Server-side rather than counted in the console, because the console cannot
   * see the window at all — it is opened by the customer's inbound message, and
   * only the platform sees those. The prototype kept a hardcoded date and a
   * counter it decremented locally, which drifted from the rule the send path
   * enforces the moment either side moved. The numbers come from the same kernel
   * function the worker refuses sends with ({@link ReplyWindowStatus}), so the
   * banner cannot promise a reply the platform will refuse.
   *
   * It is deliberately *not* a duplicate of {@link canReply}: that one answers
   * who may type, this one answers whether the customer can still be reached.
   */
  readonly replyWindow: ReplyWindowStatus;
  /**
   * Where this reader's transcript of the conversation stops, or `null` for the
   * whole thing.
   *
   * Set for a seat that handed the conversation over: 转交 moves the conversation,
   * not the record of it, so the seat keeps what it saw while it held it and
   * nothing the next seat said. See {@link conversationReadAccess}.
   */
  readonly historyUntil: string | null;
  /**
   * Whether *this reader* may right now take the conversation off its assignee.
   *
   * The console used to offer a lifecycle action only to the assignee, which made
   * UC-08's "他人接手走退单/转接" unreachable: a conversation whose agent had gone
   * home could not be moved by anybody. The rule that decides it lives in the
   * domain ({@link mayTakeOverClaim}) and is the same one the transitions apply,
   * so this field is a reading of that rule rather than a second copy of it —
   * which is why it is computed here, where the presence facts are, and not in
   * the console, which cannot see them.
   *
   * `false` covers every reader who has no takeover to perform: the assignee
   * themselves (their actions are 释放回池 and 转移), a seat whose colleague is
   * still live, and a seat of a store the conversation does not belong to.
   */
  readonly canTakeOver: boolean;
  /**
   * Whether the reader can take it *onto themselves* — whether 接手 has anything
   * to do. Only a seat can receive a handover, and only while the dispatcher would
   * route to them (SDD-009: a transfer target must be online and accepting). A
   * same-store seat who is not accepting still has {@link canTakeOver} and still
   * has a way to move the conversation — 释放回池 — so the console keys the two
   * buttons off these two answers rather than off the reader's role.
   */
  readonly canTakeOverSelf: boolean;
};

/** Outbound send request after body validation. */
export type SendMessageRequest = {
  readonly content: string;
  readonly source: MessageSource;
  readonly dedupKey?: string;
  readonly candidateId?: string;
};

/**
 * One file a seat picked and is sending, as the request carried it.
 *
 * Only the fields the endpoint reads off multer's file object; the rest of what
 * multer fills in is not a fact this service is allowed to trust. There is no
 * caption field on purpose: the channel's image and file messages carry no text
 * beside them, so accepting one would mean storing words that never reach the
 * customer.
 */
export type SendMediaRequest = {
  readonly file: UploadedOutboundMediaFile;
  readonly source: MessageSource;
  readonly dedupKey?: string;
};

/**
 * The fields this route uses off multer's file object.
 *
 * Declared here rather than pulled from `@types/multer`, for the reason the
 * internal-chat upload declares its own: one shape is not worth depending on,
 * and this is the shape the endpoint actually reads — the rest of what multer
 * fills in is not a fact this service is allowed to trust.
 *
 * `buffer` and not a stream, because the bytes are needed in full twice: once
 * for the platform's own copy and once for the provider's. A stream would let
 * the first reader consume what the second still needs, and multer's memory
 * storage is what makes both reads possible under the upload route's own size
 * backstop.
 */
export type UploadedOutboundMediaFile = {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
};

/**
 * One conversation waiting in the pool, with the two clocks a seat needs.
 *
 * `waitingMs` is this round's wait, so it resets when a conversation returns to
 * the pool. `firstResponseMs` is the customer's whole wait for a person, and is
 * `undefined` until somebody has actually answered, which is what makes it
 * usable as a running clock rather than a finished measurement.
 */
export type ConversationPoolEntry = {
  readonly conversation: Conversation;
  readonly waitingMs: number | undefined;
  readonly firstResponseMs: number | undefined;
  /**
   * The seats this conversation should be offered to right now.
   *
   * The set is computed and returned, not addressed: the store's pool entry is
   * announced to *every* subscriber of the store by
   * `RealtimeService.conversationOpened`, and each seat's own console decides
   * whether it is watching. So this reports who *would* be told — which is what
   * lets the pool view show an operator the pool as the dispatcher sees it —
   * rather than a per-seat delivery list.
   */
  readonly audienceMemberIds: ReadonlyArray<string>;
};

/**
 * One seat a conversation may be handed to, as the 转交 picker shows it.
 *
 * `availability` is the dispatcher's own word for the seat (`accepting`,
 * `suspended`, absent-as-offline), and `inProgressCount` is how much the seat is
 * already carrying. Both travel with the row so an operator choosing a handover
 * target can see why a colleague they expected is not on the list, instead of
 * reading an empty picker.
 */
export type TransferTarget = {
  readonly memberId: string;
  readonly displayName: string;
  readonly storeId: string | null;
  readonly availability: AgentAvailabilityStatus;
  readonly inProgressCount: number;
};

/**
 * Conversation lifecycle behavior: claim/return/transfer/close with optimistic
 * version checking, and outbound message sending with idempotency keys.
 *
 * Authorization is decided here, before the repository is called: the actor's
 * tenant scope comes from {@link AccessService} and a conversation outside the
 * member's store scope is refused with a 403 even though it exists. The
 * repository then applies the transition inside a transaction, so the version
 * check and the write it guards cannot be interleaved by a concurrent request.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly identity: IdentityService,
    private readonly access: AccessService,
    private readonly delivery: ChannelDeliveryService,
    private readonly realtime: RealtimeService,
    /** The banned-phrase library (§4.5, UC-17); see the send gate below. */
    @Inject(CONTENT_SAFETY_RULES) private readonly safetyRules: ReadonlyArray<ContentSafetyRule>,
    /** Signs the URLs a transcript's stored images are read from. */
    private readonly mediaUrls: MediaUrlService,
    /**
     * Where the platform's own copy of a seat's file is kept.
     *
     * A copy, not the original: the file has already gone to the customer by the
     * time the row exists, and this one is only so the transcript can still show
     * what was said a week later. The internal-chat module writes to the same
     * store for the opposite reason — there, the platform's copy *is* the only
     * copy.
     */
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}
  async list(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<Conversation>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listConversations(tenantId, scope, this.visibilityFilter(member));
  }

  /**
   * The member whose conversations the queue may contain, or `undefined` for a
   * reader whose queue is the whole tenant.
   *
   * Only seats are narrowed. A conversation another seat is handling is not one
   * this seat may read, so listing it would only offer a row that opens onto a
   * refusal; the requirement's shared pool is the pool, not everybody's desk.
   * Administrators keep the tenant-wide list — they are the fallback for a
   * conversation nobody is left to answer.
   *
   * @param member - The reader.
   * @returns The member id to narrow to, or `undefined` for no narrowing.
   */
  private visibilityFilter(member: Member): string | undefined {
    return isAdministratorRole(member.role) ? undefined : member.id;
  }

  async detail(
    tenantId: string,
    member: Member,
    conversationId: string,
  ): Promise<ConversationDetail> {
    const { conversation, access } = await this.requireReadable(tenantId, conversationId, member);
    const stored = await this.repository.listMessages(tenantId, conversationId);
    // 只读历史的那位读者：转交那一刻之后的记录（别人的消息、顾客的新话）不再下发。
    // 过滤在这里而不是查询里，因为一条会话的报文本来就已经取出来了。
    const messages =
      access.kind === 'full'
        ? stored
        : stored.filter((message) => message.createdAt < access.until);
    const visibleIds = new Set(messages.map((message) => message.id));
    const deliveries = (
      await this.delivery.conversationDeliveryDetail(tenantId, conversationId)
    ).filter((detail) => visibleIds.has(detail.delivery.messageId));
    const canTakeOver = await this.canTakeOver(tenantId, conversation, member);
    return {
      conversation,
      messages,
      deliveries,
      mediaUrls: this.#mediaUrlsFor(tenantId, messages),
      canReply: maySendToConversation({ conversation, memberId: member.id }),
      replyWindow: await this.delivery.replyWindow(conversation),
      historyUntil: access.kind === 'full' ? null : access.until,
      canTakeOver,
      canTakeOverSelf: canTakeOver && (await this.mayReceiveHandover(tenantId, member)),
    };
  }

  /**
   * Load a conversation this member may read, with the reach of that read.
   *
   * A conversation the member may not read is refused as forbidden, the same
   * answer an out-of-scope conversation gets: a distinct "not found" here would
   * make the route a way to probe which conversations exist.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - The conversation being read.
   * @param member - The reader.
   * @returns The conversation and the reader's access to it.
   * @throws {NotFoundException} When the tenant scope has no such conversation.
   * @throws {ForbiddenException} When the reader may not read it.
   */
  private async requireReadable(
    tenantId: string,
    conversationId: string,
    member: Member,
  ): Promise<{ readonly conversation: Conversation; readonly access: ConversationReadAccess }> {
    const conversation = await this.requireConversation(tenantId, conversationId, member);
    const access = await this.access.conversationReadAccess(tenantId, conversation, member);
    if (access === undefined) {
      throw new ForbiddenException('conversation is not assigned to this member');
    }
    return { conversation, access };
  }

  /**
   * Whether a transfer *to this member* would survive the dispatcher's checks.
   *
   * The same shared rule the transfer route uses, asked on the reader's own
   * behalf: the console cannot see the availability table, so a 接手 button that
   * the route would refuse has to be visible as `false` here instead of as a 409
   * whose message the error filter flattens to the status text.
   *
   * @param tenantId - The reader's tenant scope.
   * @param member - The reader, as the prospective target.
   * @returns `true` when the conversation could be handed to this member now.
   */
  private async mayReceiveHandover(tenantId: string, member: Member): Promise<boolean> {
    if (member.role !== 'agent') {
      return false;
    }
    const candidates = await this.repository.listAssignmentCandidates(tenantId, undefined);
    return this.transferRefusal(candidates, member.id, undefined) === undefined;
  }

  /**
   * Whether this member may take the conversation off whoever holds it.
   *
   * Deliberately *not* the raw {@link mayTakeOverClaim} verdict: that function
   * answers "may this actor act on this conversation", which is true for the
   * assignee too. The console asks a narrower question — is there a handover to
   * perform — so the assignee's own conversations, and pooled ones with nobody to
   * take from, both answer `false`.
   *
   * @param tenantId - The reader's tenant scope.
   * @param conversation - The conversation the reader is looking at.
   * @param member - The reader.
   * @returns `true` when the console should offer 接手.
   */
  private async canTakeOver(
    tenantId: string,
    conversation: Conversation,
    member: Member,
  ): Promise<boolean> {
    const assigneeId = conversation.assignedMemberId;
    if (conversation.status !== 'claimed' || assigneeId === null || assigneeId === member.id) {
      return false;
    }
    const now = new Date().toISOString();
    return mayTakeOverClaim({
      conversation,
      actorMemberId: member.id,
      authority: await this.takeoverAuthority(tenantId, conversation, member, now),
    });
  }

  /**
   * Mint a read URL for every message of one transcript that has stored media.
   *
   * Minted here rather than stored because the link is a bearer credential with
   * a short life: a URL written into a row, or cached by a client that keeps the
   * transcript open, would be a credential kept past its expiry.
   *
   * @param tenantId - The tenant the transcript was read for.
   * @param messages - The transcript, as the repository returned it.
   * @returns URLs by message id, with no entry for a message without media.
   */
  #mediaUrlsFor(
    tenantId: string,
    messages: ReadonlyArray<Message>,
  ): Readonly<Record<string, string>> {
    const entries = messages
      .filter((message) => message.media !== null)
      .map((message) => [message.id, this.mediaUrls.url({ tenantId, messageId: message.id })]);
    return Object.fromEntries(entries);
  }

  /**
   * The conversations waiting to be served, across the tenant.
   *
   * "Waiting to be served" is `open` with no assignee. A conversation an agent
   * has claimed is not here even if that agent has since gone offline, because
   * dropping a seat does not silently take its work away — that is what the
   * explicit return and transfer paths are for.
   *
   * The audience reported for each entry is tenant-wide for the same reason the
   * pool is: any seat may take any conversation, so telling the pool view that
   * only one store's seats would be told would be a lie about a set the
   * announcement does not narrow either.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The resolved acting member.
   * @param storeId - Optional store filter within the tenant scope.
   * @returns The pool, oldest wait first.
   */
  async pool(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<ConversationPoolEntry>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    const now = new Date().toISOString();
    const conversations = await this.repository.listConversations(tenantId, scope);
    const pooled = conversations.filter(
      (conversation) => conversation.status === 'open' && conversation.assignedMemberId === null,
    );
    const entries: ConversationPoolEntry[] = [];
    for (const conversation of pooled) {
      // No store filter, here or in the audience: the store is not what decides
      // who may take this conversation.
      const candidates = await this.repository.listAssignmentCandidates(tenantId, undefined);
      entries.push({
        conversation,
        waitingMs:
          conversation.pendingSince === null
            ? undefined
            : Date.parse(now) - Date.parse(conversation.pendingSince),
        firstResponseMs: firstResponseDurationMs(
          conversation.firstResponseStartedAt,
          conversation.firstReplyAt,
        ),
        audienceMemberIds: assignmentAudience(candidates, undefined, now),
      });
    }
    return entries;
  }

  /**
   * The assignment history of one conversation, newest first.
   *
   * Reading it goes through {@link requireConversation} first, so this inherits
   * the existing 404 and cross-store 403 boundary rather than re-deriving it.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - Conversation whose history to read.
   * @param member - The resolved acting member.
   * @returns Every attempt, including the ones that were refused.
   */
  async assignments(
    tenantId: string,
    conversationId: string,
    member: Member,
  ): Promise<ReadonlyArray<ConversationAssignment>> {
    await this.requireReadable(tenantId, conversationId, member);
    return this.repository.listAssignments(tenantId, conversationId);
  }


  async claim(
    tenantId: string,
    conversationId: string,
    member: Member,
    expectedVersion: number,
  ): Promise<Conversation> {
    await this.requireConversation(tenantId, conversationId, member);
    const result = await this.repository.claim(
      tenantId,
      conversationId,
      member.id,
      expectedVersion,
      new Date().toISOString(),
    );
    if (!result.ok) {
      this.throwFor(result);
    }
    return this.announceTransition(result.conversation);
  }

  async returnToPool(
    tenantId: string,
    conversationId: string,
    member: Member,
    expectedVersion: number,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(tenantId, conversationId, member);
    if (conversation.status !== 'claimed') {
      throw new ConflictException('only a claimed conversation can be returned');
    }
    const now = new Date().toISOString();
    const result = await this.repository.returnToPool(
      tenantId,
      conversationId,
      member.id,
      await this.takeoverAuthority(tenantId, conversation, member, now),
      expectedVersion,
      now,
    );
    if (!result.ok) {
      this.throwFor(result);
    }
    return this.announceTransition(result.conversation);
  }

  /**
   * The seats this conversation may be handed to right now.
   *
   * The same rule {@link transfer} enforces, asked for the whole roster instead
   * of one seat at a time: the console cannot read the presence table, so without
   * this list a 转交 control could only offer names the route then refuses — and
   * the refusal reaches the caller as a plain 409, because the error filter
   * flattens the reason code to the status text. Returning the eligible set is
   * what keeps the offered targets and the accepted ones the same set.
   *
   * The acting member is excluded: handing a conversation to whoever already
   * holds it is not a transfer, and the rule has no reason to refuse it.
   *
   * The read goes through {@link requireConversation}, the same gate the transfer
   * route uses, so a caller who may not transfer cannot enumerate the roster
   * either. Names come from the tenant directory, which the same member may
   * already read in the account center, and a seat missing from it falls back to
   * its member id rather than to a blank row.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - Conversation being handed over.
   * @param member - The resolved acting member.
   * @returns Eligible seats in the dispatcher's own order, each with the
   * availability it was judged by.
   */
  async transferTargets(
    tenantId: string,
    conversationId: string,
    member: Member,
  ): Promise<ReadonlyArray<TransferTarget>> {
    await this.requireConversation(tenantId, conversationId, member);
    const candidates = await this.repository.listAssignmentCandidates(tenantId, undefined);
    const now = new Date().toISOString();
    const directory = await this.identity.getDirectoryEntry(member, tenantId);
    const names = new Map(directory.members.map((entry) => [entry.id, entry.displayName]));
    return candidates
      .filter((candidate) => candidate.memberId !== member.id)
      .filter(
        (candidate) =>
          transferTargetRefusal({ target: candidate, conversationStoreId: undefined, now }) ===
          undefined,
      )
      .map((candidate) => ({
        memberId: candidate.memberId,
        displayName: names.get(candidate.memberId) ?? candidate.memberId,
        storeId: candidate.storeId,
        availability: candidate.status,
        inProgressCount: candidate.inProgressCount,
      }));
  }

  async transfer(
    tenantId: string,
    conversationId: string,
    member: Member,
    expectedVersion: number,
    toMemberId: string,
  ): Promise<Conversation> {
    // The read is the gate: a conversation outside the tenant scope is a 404.
    const conversation = await this.requireConversation(tenantId, conversationId, member);
    const target = await this.identity.requireMember(toMemberId);
    if (target.tenantId !== tenantId) {
      throw new BadRequestException('transfer target must belong to the same tenant');
    }
    if (target.role === 'merchant_admin' || target.role === 'platform_admin') {
      throw new BadRequestException('transfer target must be an agent');
    }
    // No store check between the conversation and the target: a seat is not
    // pinned to a store, so handing work across them is not a scope violation.
    // SDD-009 requires the target be an agent who is *online and accepting*. The
    // read is of the seats the tenant exposes, so the verdict comes from the same
    // shared rule the dispatcher uses rather than a second copy here.
    const candidates = await this.repository.listAssignmentCandidates(tenantId, undefined);
    const refusal = this.transferRefusal(candidates, toMemberId, undefined);
    if (refusal !== undefined) {
      // The reason code rides in `code`, but the error filter only publishes codes
      // from its documented set and replaces the message with the status text, so
      // a caller receives a plain `409 conflict`. The code stays here because it is
      // the refusal's own name and the contract may widen; today the caller learns
      // *that* the target is unavailable, not which way.
      throw new ConflictException({ code: refusal, message: `transfer target ${refusal}` });
    }
    const now = new Date().toISOString();
    const result = await this.repository.transfer(
      tenantId,
      conversationId,
      member.id,
      await this.takeoverAuthority(tenantId, conversation, member, now),
      toMemberId,
      expectedVersion,
      now,
    );
    if (!result.ok) {
      this.throwFor(result);
    }
    return this.announceTransition(result.conversation);
  }

  async close(
    tenantId: string,
    conversationId: string,
    member: Member,
    expectedVersion: number,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(tenantId, conversationId, member);
    if (conversation.status === 'closed') {
      throw new ConflictException('conversation is already closed');
    }
    const actorIsAdmin = isAdministratorRole(member.role);
    const result = await this.repository.close(
      tenantId,
      conversationId,
      member.id,
      actorIsAdmin,
      expectedVersion,
      new Date().toISOString(),
    );
    if (!result.ok) {
      this.throwFor(result);
    }
    return this.announceTransition(result.conversation);
  }

  /**
   * Announce a committed lifecycle transition and return the row.
   *
   * Every transition goes through here rather than publishing at each call site,
   * so a new transition cannot be added that moves a conversation without telling
   * the seats watching it. The row published is the repository's post-transition
   * row, never the pre-read one, because a subscriber's next act is to re-read
   * REST and it must find what the frame described.
   *
   * @param conversation - The conversation as committed.
   * @returns The same conversation, so call sites read `return this.announce…`.
   */
  private announceTransition(conversation: Conversation): Conversation {
    this.realtime.conversationUpdated(conversation);
    return conversation;
  }

  /**
   * Record an outbound message and dispatch its delivery.
   *
   * The platform message is written first, so a delivery always has a message to
   * point at. The delivery then carries the provider-facing outcome: whether the
   * reply window allowed the send, how many attempts were made, and what the
   * provider answered. A refused send is still a recorded message with a
   * degraded delivery — the workspace stays usable, and the reason is visible
   * rather than raised as an error.
   */
  async sendMessage(
    tenantId: string,
    conversationId: string,
    member: Member,
    input: SendMessageRequest,
  ): Promise<DispatchedMessage> {
    const conversation = await this.replyTarget(tenantId, conversationId, member);
    if (!MESSAGE_SOURCES.includes(input.source)) {
      throw new BadRequestException(`source must be one of ${MESSAGE_SOURCES.join(', ')}`);
    }
    // §4.5 / UC-17's second gate, and the one that actually holds. The first
    // gate screens generated candidates, so a seat who never sees a banned
    // phrase never sends one — but a seat can also type one, and a candidate
    // generated before a rule was added is still sitting in a workspace. Both
    // gates are needed and neither is the other's backup: this one is the only
    // one that sees text a person wrote.
    //
    // Refused before the write rather than recorded-then-blocked, because the
    // review queue is derived from `messages` rows: a message persisted here
    // enters that queue when its source is review-eligible, and a blocked
    // phrase must not be in it to be reviewed.
    const verdict = screenContent(input.content, this.safetyRules);
    if (verdict.blocked) {
      // The phrase travels in the `details` array rather than as the exception's
      // message. `toErrorBody` replaces every message with the status's own
      // text and keeps only an array payload, so a plain string here would be
      // dropped and a seat would be told "Bad Request" and nothing else — which
      // is not what UC-17's "拦截结果提示客服" asks for. An array is the shape
      // the exception filter already forwards, and the shape the import
      // endpoints already use to return a reason.
      throw new BadRequestException({ message: [describeBlockedContent(verdict)] });
    }
    try {
      const result = await this.repository.sendOutbound({
        tenantId,
        storeId: conversation.storeId,
        conversationId,
        content: input.content,
        source: input.source,
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
        ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
      });
      // Announced *after* the delivery is durable, not immediately after the
      // message: a subscriber's answer to this frame is to re-read the
      // conversation, and the outbound message and its delivery are one fact to
      // that reader. Announcing first would race the dispatch and hand every
      // watching seat a transcript row with no delivery state beside it.
      //
      // A replayed `dedupKey` resolves to the message the first attempt already
      // wrote, so there is nothing new to announce then — and announcing it would
      // send every watching seat to re-read a transcript that has not changed.
      const dispatched: DispatchedMessage = {
        message: result.message,
        delivery: await this.delivery.dispatch(conversation, result.message),
      };
      if (result.created) {
        this.realtime.messageCreated(result.message);
      }
      return dispatched;
    } catch (error) {
      this.throwWriteRefusal(error);
    }
  }

  /**
   * Send a customer a picture, a clip or a document.
   *
   * The same authorization, the same safety gate and the same announcement as
   * {@link sendMessage}, because a file is not a second kind of permission: it
   * is the same act with something attached. What differs is the order, and the
   * order is the whole of this method.
   *
   * The provider will not accept a message naming a `media_id` it was never
   * given, so the upload has to happen *before* the message exists — and the
   * provider's copy is temporary, so it cannot happen long before. Everything is
   * therefore done inside this one request: validate, keep our own copy of the
   * bytes, hand the provider its copy, and only then write the row that names
   * both. By the time a message saying "this is a document" exists, both copies
   * are real; there is no interval in which the transcript promises a file
   * nobody has.
   *
   * Nothing here is retried. A failed upload is answered to the seat who is
   * still looking at the picker, which is a better answer than a bubble that
   * appears to have been sent and is quietly waiting on a worker.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - The conversation being replied to.
   * @param member - The acting seat, already authorized.
   * @param input - The file as multer handed it over, and the message source.
   * @returns The recorded message and its delivery projection, exactly as a text
   *   send answers.
   * @throws {NotFoundException} When the conversation is not in this tenant.
   * @throws {ForbiddenException} When the seat is not the one handling it.
   * @throws {ConflictException} When the conversation is closed.
   * @throws {BadRequestException} When the file is unusable, or its name is
   *   blocked by the banned-phrase library.
   * @throws {HttpException} `503` when object storage refuses the write, `502`
   *   when the provider refuses the upload.
   */
  async sendMediaMessage(
    tenantId: string,
    conversationId: string,
    member: Member,
    input: SendMediaRequest,
  ): Promise<DispatchedMessage> {
    const conversation = await this.replyTarget(tenantId, conversationId, member);

    // The one gate on what may be sent, and it runs before anything leaves this
    // process. The body of the thrown error is an array because that is the only
    // shape `AllExceptionsFilter` forwards: a plain string here reaches the seat
    // as "Bad Request" and nothing else, and "文件太大" is the whole of what the
    // seat needs to know.
    let file: ReturnType<typeof outboundMedia>;
    try {
      file = outboundMedia({
        // Decoded before it is cleaned, because multer hands over busboy's
        // latin1 reading of a UTF-8 header: without this a document reaches the
        // customer named `æ¥ä»·å.pdf`. The name is also what the *content*
        // of a document message becomes, so an undecoded name is stored, shown
        // and sent as noise.
        fileName: decodedFileName(input.file.originalname),
        mimeType: input.file.mimetype,
        byteSize: input.file.size,
      });
    } catch (error) {
      throw new BadRequestException([
        error instanceof Error ? error.message : 'the file cannot be sent',
      ]);
    }

    // What the bubble says. A document's name is most of the message and is what
    // the customer sees on it, so it *is* the content; a picture's name is noise
    // nobody needs to read, and `[图片]` is what the transcript falls back to if
    // the media cannot be shown at all.
    const content = mediaMessageContent(file.kind, file.fileName);
    const verdict = screenContent(content, this.safetyRules);
    if (verdict.blocked) {
      throw new BadRequestException({ message: [describeBlockedContent(verdict)] });
    }

    // Our copy first. An object nothing references is recoverable — the bucket's
    // key namespace enumerates it — while a row pointing at bytes that were
    // never written is not, and this is the same order the internal-chat upload
    // takes for the same reason.
    const mediaId = `outbound-media-${randomUUID()}`;
    const objectKey = outboundMediaObjectKey(tenantId, mediaId);
    const stored = await this.storage.put({
      key: objectKey,
      mimeType: file.mimeType,
      bytes: input.file.buffer,
    });
    if (!stored.ok) {
      throw new HttpException(
        {
          code: 'service_unavailable',
          message: ['附件存储暂时不可用，请稍后再试'],
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Then the provider's copy, which is what makes the message sendable at all.
    const uploaded = await this.delivery.uploadMedia({
      tenantId,
      storeId: conversation.storeId,
      kind: file.kind,
      mimeType: file.mimeType,
      bytes: input.file.buffer,
      fileName: file.fileName,
    });
    if (!uploaded.ok) {
      // The status and the stable code come from the one table that maps an
      // adapter refusal onto the HTTP edge, so a provider outage is answered
      // here exactly as it is on the send the retries carry. Only the wording
      // is this method's: a seat who just picked a file is told about the
      // channel, not handed the provider's own sentence.
      const refusal = channelFailureFromAdapter(uploaded);
      throw new HttpException(
        { code: refusal.code, message: [uploadRefusalReason(uploaded.code)] },
        refusal.status,
      );
    }

    try {
      const result = await this.repository.sendOutbound({
        tenantId,
        storeId: conversation.storeId,
        conversationId,
        content,
        source: input.source,
        messageType: file.kind,
        media: {
          key: objectKey,
          mimeType: file.mimeType,
          bytes: file.byteSize,
          name: file.fileName,
          providerMediaId: uploaded.value.mediaId,
        },
        ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
      });
      const dispatched: DispatchedMessage = {
        message: result.message,
        delivery: await this.delivery.dispatch(conversation, result.message),
      };
      if (result.created) {
        this.realtime.messageCreated(result.message);
      }
      return dispatched;
    } catch (error) {
      this.throwWriteRefusal(error);
    }
  }

  /**
   * Load the conversation a reply is about to be sent to, and refuse the reply
   * if it may not be sent.
   *
   * One method for both send paths, because a file is not a second kind of
   * permission: the media route checks exactly what the text route checks, and
   * two copies of that prologue would be two answers to "may this seat answer
   * this customer" the first time one of them was edited.
   *
   * 「已结束」先答，因为它是一条关于会话的事实，和谁在问无关——换句话说，这个读者
   * 本来就读得到这条已结束的会话（结束的会话没有受理人）。然后是「这单是不是你的」：
   * 同事的会话不是可以插话的群聊，转交出去之后原受理人也已经说完了。池子里的单没人
   * 接走，这条对它不成立（见 core 的判据）。
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - The conversation being replied to.
   * @param member - The acting seat.
   * @returns The conversation, safe to reply to.
   * @throws {NotFoundException} When it is not in this tenant.
   * @throws {ConflictException} When it is closed.
   * @throws {ForbiddenException} When the seat is not the one handling it.
   */
  private async replyTarget(
    tenantId: string,
    conversationId: string,
    member: Member,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(tenantId, conversationId, member);
    if (conversation.status === 'closed') {
      throw new ConflictException('cannot send an outbound message to a closed conversation');
    }
    if (!maySendToConversation({ conversation, memberId: member.id })) {
      throw new ForbiddenException('only the assigned seat may reply to this conversation');
    }
    return conversation;
  }

  /**
   * Report a durable adapter's write refusal with the status this route would
   * have produced.
   *
   * A durable adapter re-validates the conversation inside its own transaction,
   * so a conversation that closed between the check above and the write is
   * refused *there*, as a value rather than as an HTTP status. Both send paths
   * answer that with the same status their own pre-checks would have: an
   * `invalid_state` write refusal is the same fact as a closed conversation, and
   * reporting it as an internal error would describe a race the seat cannot act
   * on.
   *
   * @param error - Whatever the repository threw.
   * @throws {NotFoundException} When the message's conversation was not found.
   * @throws {ConflictException} When it closed before the write landed.
   */
  private throwWriteRefusal(error: unknown): never {
    if (error instanceof PlatformWriteError) {
      switch (error.code) {
        case 'not_found':
          throw new NotFoundException('conversation not found in tenant scope');
        case 'invalid_state':
          throw new ConflictException('cannot send an outbound message to a closed conversation');
      }
    }
    throw error;
  }

  /**
   * Load a conversation in the tenant scope, or fail as if it were not there.
   *
   * There is no store check: a seat reaches every conversation of its tenant, so
   * "outside the member store scope" is no longer a refusal this system has.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversationId - The conversation to load.
   * @param _member - The resolved acting member. Kept for the call sites; the
   * store it carries no longer narrows the read.
   * @returns The conversation.
   * @throws {NotFoundException} When the tenant scope has no such conversation.
   */
  private async requireConversation(
    tenantId: string,
    conversationId: string,
    _member: Member,
  ): Promise<Conversation> {
    const conversation = await this.repository.getConversation(tenantId, conversationId);
    if (conversation === undefined) {
      throw new NotFoundException('conversation not found in tenant scope');
    }
    return conversation;
  }

  /**
   * Resolve whether the acting member may act on a conversation it does not hold.
   *
   * The requirement keeps a dropped seat's conversations with that seat and
   * hands the customer over "走退单/转接" — which the assignee can only do while
   * it is still connected, so the hand-over has to be open to somebody else once
   * it is gone. Without this, a conversation whose assignee logged off is one
   * nobody can move and a customer nobody answers.
   *
   * The *rule* is core's (`mayTakeOverClaim`); this resolves the facts it needs:
   * the actor's role and store, and whether the assignee is still live by the
   * same 60-second TTL the dispatcher uses. The presence read is skipped when
   * there is nothing to take over, so the ordinary case costs no extra query.
   *
   * @param tenantId - Effective tenant scope.
   * @param conversation - The conversation being acted on.
   * @param member - The resolved acting member.
   * @param now - Instant to judge the assignee's liveness at (ISO).
   * @returns The authority to hand to the repository.
   */
  private async takeoverAuthority(
    tenantId: string,
    conversation: Conversation,
    member: Member,
    now: string,
  ): Promise<TakeoverAuthority> {
    const actorIsAdmin = isAdministratorRole(member.role);
    const assigneeId = conversation.assignedMemberId;
    if (assigneeId === null || assigneeId === member.id) {
      // Nothing to take over: the actor holds it, or the pool does.
      return { actorIsAdmin, actorStoreId: member.storeId, assigneeLive: true };
    }
    const presence = await this.repository.getAgentPresence(tenantId, assigneeId);
    return {
      actorIsAdmin,
      actorStoreId: member.storeId,
      assigneeLive: effectiveAvailabilityStatus(presence, now) !== 'offline',
    };
  }

  /**
   * Why the named seat cannot take this conversation, if it cannot.
   *
   * A seat that is absent from the candidate list is reported as offline rather
   * than as a missing member: the list already contains every agent of the store,
   * so absence means the member is not an agent of this store — which the checks
   * above have ruled out — and the honest reading is a seat that has never
   * reported itself available.
   *
   * @param candidates - Every seat that could take the conversation.
   * @param toMemberId - The member the caller asked to transfer to.
   * @param conversationStoreId - Store the conversation belongs to, or
   * `undefined` when the store decides nothing.
   * @returns A reason code, or `undefined` when the transfer may proceed.
   */
  private transferRefusal(
    candidates: ReadonlyArray<AssignmentCandidate>,
    toMemberId: string,
    conversationStoreId: string | undefined,
  ): AssignmentReasonCode | undefined {
    const target = candidates.find((candidate) => candidate.memberId === toMemberId);
    if (target === undefined) {
      return 'target_offline';
    }
    return transferTargetRefusal({
      target,
      conversationStoreId,
      now: new Date().toISOString(),
    });
  }

  private throwFor(result: Extract<StoreConversationResult, { readonly ok: false }>): never {
    switch (result.code) {
      case 'not_found':
        throw new NotFoundException(result.reason);
      case 'not_claimed':
        throw new ForbiddenException(result.reason);
      case 'conflict':
      case 'invalid_state':
        throw new ConflictException(result.reason);
    }
  }
}

/**
 * What an outbound media message's content says.
 *
 * The content is derived here rather than taken from the request, because a
 * client-supplied caption would be stored and then never reach the customer:
 * the channel's picture, clip and document messages carry no text field at all,
 * so anything a seat typed beside the file would be a promise the bubble cannot
 * keep. What the customer reads underneath a document is its name, and the
 * name the platform kept is the cleaned one, so that is the content.
 *
 * A picture or a clip has no such text — the name is `IMG_20261006_3x.jpg`,
 * which tells the customer nothing — so its content is the platform's own
 * placeholder. That is also what the transcript falls back to when the media
 * itself cannot be shown, which keeps one string answering both questions.
 *
 * @param kind - Which of the three media kinds was validated.
 * @param fileName - The cleaned file name.
 * @returns The content to store on the message.
 */
function mediaMessageContent(kind: OutboundMediaKind, fileName: string): string {
  return kind === 'file' ? fileName : channelMessagePlaceholder(kind);
}

/**
 * One sentence for a seat about why the channel would not take their file.
 *
 * The seat is standing at the picker with the file still in hand, so the
 * sentence has to say what to do next: configure the channel, pick a different
 * file, or simply try again. The provider's own message says none of that, and
 * it is not what `details` is for.
 *
 * @param code - The adapter's stable refusal code.
 * @returns A sentence naming the next step.
 */
function uploadRefusalReason(code: ChannelFailureCode): string {
  switch (code) {
    case 'channel_not_configured':
      return '尚未配置企业微信渠道，暂时无法发送附件';
    case 'channel_disabled':
      return '企业微信渠道已停用，暂时无法发送附件';
    case 'channel_invalid_request':
      return '附件不符合渠道要求，请换一个文件后重试';
    case 'channel_provider_error':
    case 'channel_delivery_unknown':
      return '企业微信暂时无法接收附件，请稍后再试';
  }
}

