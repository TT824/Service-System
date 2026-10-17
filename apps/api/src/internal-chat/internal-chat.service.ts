import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  internalMessageBody,
  internalThreadIncludes,
  type AuthRepository,
  type InternalMessage,
  type InternalMessageAttachment,
  type InternalThread,
  type Member,
} from '@kefu/core';
import { AUTH_REPOSITORY } from '../auth/auth.tokens';
import { MediaUrlService } from '../media/media-url.service';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * One message as the workspace renders it.
 *
 * The row plus exactly one thing only the API can mint: the URL the bytes are
 * read from. It is not part of the stored message because it is a credential
 * with a ten-minute life, minted per read — see {@link InternalChatService}.
 */
export type InternalMessageView = Omit<InternalMessage, 'attachment'> & {
  readonly attachment: (InternalMessageAttachment & { readonly url: string }) | null;
};

/** One colleague a seat can start an internal chat with. */
export type InternalPeer = {
  readonly memberId: string;
  readonly displayName: string;
  readonly role: Member['role'];
  readonly storeId: string | null;
  /**
   * The colleague's picture, as a base64 `data:` URL, or `null`.
   *
   * Carried here rather than fetched by the client because a picture belongs to
   * an account and only the server can follow the member-to-account link; `null`
   * means "render the initial instead", which is also what a member who has
   * never uploaded one looks like.
   */
  readonly avatarUrl: string | null;
};

/**
 * A thread as the workspace needs to render it.
 *
 * The peer and the last message are resolved here rather than by the client, so
 * the list is one request instead of one per row. That costs a member read and a
 * message read per thread — acceptable because the number of colleagues one seat
 * talks to is small and this is a denormalisation of data the caller is already
 * entitled to, not an expansion of its scope.
 */
export type InternalThreadView = {
  readonly thread: InternalThread;
  /** The other participant. Never the reader; `null` only if the row is orphaned. */
  readonly peer: InternalPeer | null;
  readonly lastMessage: InternalMessageView | null;
};

/**
 * Colleague-to-colleague messaging.
 *
 * Kept out of `ConversationsService` on purpose. A customer conversation carries
 * a channel, a customer identity, a serving store and the 48-hour reply window,
 * and it feeds the workspace queue, the response metrics and the customer-record
 * export; an internal message has none of that and must not acquire it by
 * sharing a code path. What the two do share — the tenant boundary and the
 * realtime channel — is reused, and nothing else.
 *
 * Authorization is membership of the thread, checked on every read and every
 * write. A tenant administrator gets no wider view here: reading a colleague's
 * private thread is not an administrative act.
 */
@Injectable()
export class InternalChatService {
  /**
   * @param repository - The platform business fact source.
   * @param realtime - Announcer for a committed append.
   * @param mediaUrls - Minter of the links an attachment is read through.
   * @param accounts - The account directory, read for the one fact the platform
   * facts cannot carry: a colleague's picture. A picture belongs to an account
   * and an account reaches a member through a link, so the join lives on the
   * authentication side of the platform. Read-only here — this surface never
   * writes an avatar, it only reports the one that exists.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly realtime: RealtimeService,
    private readonly mediaUrls: MediaUrlService,
    @Inject(AUTH_REPOSITORY) private readonly accounts: AuthRepository,
  ) {}

  /**
   * The colleagues this seat may open a chat with.
   *
   * Two sources, because the platform side sits outside every tenant: the
   * enabled members of the effective tenant, and the enabled platform
   * administrators, who carry no tenant at all. The second source is what makes
   * the channel two-way — a thread the platform side can open but no seat can
   * answer would be a one-way broadcast, and answering back is the whole point
   * of the surface.
   *
   * The caller is excluded from both sources, so "chat with yourself" never
   * appears as a peer. A platform administrator reading this list is a caller
   * like any other: they see the members of the tenant they are currently
   * scoped to, which is the company whose seats they are talking to.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @returns The peers, ordered by display name.
   */
  async listPeers(tenantId: string, member: Member): Promise<ReadonlyArray<InternalPeer>> {
    const [members, platformAdministrators] = await Promise.all([
      this.repository.listMembers(tenantId),
      this.repository.listPlatformAdministrators(),
    ]);
    const candidates = [...members, ...platformAdministrators].filter(
      (candidate) => candidate.id !== member.id && candidate.enabled,
    );
    // One lookup for the whole directory, after the filter so a colleague who
    // will not be rendered is not asked about. The map is keyed by member, and
    // a colleague without a picture is simply missing from it.
    const avatars = await this.accounts.listMemberAvatars(candidates.map((peer) => peer.id));
    return candidates
      .map((peer) => toPeer(peer, avatars.get(peer.id) ?? null))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
  }

  /**
   * The caller's threads, most recently active first.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @returns The threads the member takes part in.
   */
  async listThreads(tenantId: string, member: Member): Promise<ReadonlyArray<InternalThreadView>> {
    const threads = await this.repository.listInternalThreads(tenantId, member.id);
    return Promise.all(threads.map((thread) => this.#viewOf(tenantId, member, thread)));
  }

  /**
   * Open (or find) the one-to-one thread with a colleague.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @param peerMemberId - The colleague to talk to.
   * @returns The thread, with its peer and current last message.
   * @throws {BadRequestException} When the peer is the caller.
   * @throws {NotFoundException} When the peer is not a colleague in this tenant.
   */
  async openDirectThread(
    tenantId: string,
    member: Member,
    peerMemberId: string,
  ): Promise<InternalThreadView> {
    if (peerMemberId === member.id) {
      throw new BadRequestException('cannot open an internal chat with yourself');
    }
    const peer = await this.repository.getMember(peerMemberId);
    // Deliberately the same answer for "no such member", "another tenant" and
    // "disabled": the caller may not learn which, because that would turn this
    // endpoint into a directory probe for members it cannot otherwise see.
    //
    // Two kinds of peer are reachable, and only two: a colleague of the
    // effective tenant, and a platform administrator, who belongs to no tenant
    // and is therefore reachable from every tenant. The thread is still written
    // into the effective tenant — the tenant of the seat being talked to — so
    // the read path's tenant boundary does not move: both sides reach the thread
    // by naming that same tenant.
    const reachable =
      peer !== undefined &&
      peer.enabled &&
      (peer.tenantId === tenantId || (peer.tenantId === null && peer.role === 'platform_admin'));
    if (!reachable) {
      throw new NotFoundException('no such colleague in this tenant');
    }

    const thread = await this.repository.ensureDirectInternalThread({
      tenantId,
      memberIdA: member.id,
      memberIdB: peerMemberId,
      now: new Date().toISOString(),
    });
    return this.#viewOf(tenantId, member, thread);
  }

  /**
   * The messages of one thread, oldest first.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @param threadId - Thread to read.
   * @returns The messages.
   * @throws {NotFoundException} When the thread is not in this tenant.
   * @throws {ForbiddenException} When the caller is not a participant.
   */
  async messages(
    tenantId: string,
    member: Member,
    threadId: string,
  ): Promise<ReadonlyArray<InternalMessageView>> {
    await this.requireParticipation(tenantId, member, threadId);
    const messages = await this.repository.listInternalMessages(tenantId, threadId);
    return messages.map((message) => this.#messageView(tenantId, message));
  }

  /**
   * Append one message to a thread the caller takes part in.
   *
   * At least one of the two has to be there, and either alone is a message: text
   * with no file, a file with no text. Sending a draft that the sender has
   * already removed, or one that another message claimed, is refused here — the
   * repository's claim is what decides, and this method is what turns its
   * silence into an answer.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @param threadId - Thread to write to.
   * @param input - Raw body from the request: the text, and the draft to attach.
   * @returns The appended message, with its attachment's URL minted.
   * @throws {BadRequestException} When there is neither text nor attachment, when
   *   the text is too long, or when the named draft could not be claimed.
   * @throws {NotFoundException} When the thread is not in this tenant.
   * @throws {ForbiddenException} When the caller is not a participant.
   */
  async send(
    tenantId: string,
    member: Member,
    threadId: string,
    input: { readonly content: string | undefined; readonly attachmentId: string | undefined },
  ): Promise<InternalMessageView> {
    await this.requireParticipation(tenantId, member, threadId);

    const attachmentId = input.attachmentId ?? null;
    let content: string;
    try {
      content = internalMessageBody(input.content, attachmentId !== null);
    } catch (error) {
      throw new BadRequestException([
        error instanceof Error ? error.message : 'invalid message content',
      ]);
    }

    const message = await this.repository.appendInternalMessage({
      tenantId,
      threadId,
      senderMemberId: member.id,
      body: content,
      attachmentId,
      createdAt: new Date().toISOString(),
    });
    if (message === undefined) {
      // The claim matched nothing: the draft is not this sender's, is not in
      // this thread, or has already been sent. One answer for all three, because
      // telling them apart would describe rows the caller cannot see.
      throw new BadRequestException(['附件不存在或已发送，请重新选择文件']);
    }
    // Published after the write committed, and carrying no body: the frame only
    // tells a seat to re-read, and the re-read is what applies the membership
    // rule. See `@kefu/core`'s realtime contract.
    this.realtime.internalMessageCreated(message);
    return this.#messageView(tenantId, message);
  }

  /**
   * Assemble one thread view.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The reader, used to pick the *other* participant.
   * @param thread - The thread row.
   * @returns The view.
   */
  async #viewOf(
    tenantId: string,
    member: Member,
    thread: InternalThread,
  ): Promise<InternalThreadView> {
    const peerId = thread.participantMemberIds.find((id) => id !== member.id);
    // The avatar rides along in the same round as the peer read: a thread whose
    // peer is missing needs no avatar, and `[]` says so without a branch.
    const [peer, messages, avatars] = await Promise.all([
      peerId === undefined ? Promise.resolve(undefined) : this.repository.getMember(peerId),
      this.repository.listInternalMessages(tenantId, thread.id),
      this.accounts.listMemberAvatars(peerId === undefined ? [] : [peerId]),
    ]);
    const last = messages[messages.length - 1];
    return {
      thread,
      peer: peer === undefined ? null : toPeer(peer, avatars.get(peer.id) ?? null),
      lastMessage: last === undefined ? null : this.#messageView(tenantId, last),
    };
  }

  /**
   * One message as the workspace receives it.
   *
   * The attachment's URL is minted here rather than stored with the message, for
   * the same reason the customer transcript mints its own: the link is a bearer
   * credential with a ten-minute life, so a URL kept in a row — or cached by a
   * client holding a thread open — would be a credential kept past its expiry.
   *
   * @param tenantId - The tenant the transcript was read for.
   * @param message - The stored message.
   * @returns The message, with the URL if it carries a file.
   */
  #messageView(tenantId: string, message: InternalMessage): InternalMessageView {
    const attachment = message.attachment;
    if (attachment === null) {
      return { ...message, attachment: null };
    }
    return {
      ...message,
      attachment: {
        ...attachment,
        url: this.mediaUrls.url({
          tenantId,
          messageId: message.id,
          purpose: 'internal-attachment',
        }),
      },
    };
  }

  /**
   * Throw unless the caller is a participant of the thread.
   *
   * The tenant and the membership are checked together, and the refusal is a
   * `404` when the thread is simply not here: a `403` for a thread that exists
   * in another tenant would confirm its existence.
   *
   * Public rather than private because uploading a file into a thread is the
   * same authority as writing to it, and the attachment service must not be able
   * to disagree with this one about who may speak: one check, one answer.
   *
   * @param tenantId - Effective tenant scope.
   * @param member - The acting member.
   * @param threadId - Thread being read, written or uploaded into.
   * @returns Resolves when the caller may proceed.
   */
  async requireParticipation(
    tenantId: string,
    member: Member,
    threadId: string,
  ): Promise<void> {
    const thread = await this.repository.getInternalThread(tenantId, threadId);
    if (thread === undefined) {
      throw new NotFoundException('internal thread not found');
    }
    if (!internalThreadIncludes(thread, member.id)) {
      throw new ForbiddenException('this internal thread is not yours');
    }
  }
}

/**
 * Project a member onto the peer shape the workspace renders.
 *
 * @param member - The colleague.
 * @param avatarUrl - The colleague's picture, or `null` when there is none.
 * @returns The peer entry.
 */
function toPeer(member: Member, avatarUrl: string | null): InternalPeer {
  return {
    memberId: member.id,
    displayName: member.displayName,
    role: member.role,
    storeId: member.storeId,
    avatarUrl,
  };
}
