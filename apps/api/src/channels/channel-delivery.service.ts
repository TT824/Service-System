/**
 * The channel delivery application service.
 *
 * It owns the message loop between the platform and a provider transport:
 *
 * - **Inbound**: verify the callback, authorize its tenant/store scope, persist
 *   the callback receipt *before* touching business data (so a replay is
 *   recognised even if the process dies half-way), create the conversation and
 *   message through the platform repository, open the reply window, and mark the
 *   receipt processed. Two authentication paths reach that one ingest core: a
 *   Mock callback that carries a platform identity and names its scope
 *   ({@link ChannelDeliveryService.ingestWebhook}), and a real provider callback
 *   whose signature is its only credential and whose scope comes from the
 *   `open_kfid` binding ({@link ChannelDeliveryService.ingestProviderWebhook}).
 * - **Outbound**: record one delivery per logical message, enqueue it in the
 *   outbox, refuse it before any adapter call when the 48-hour/five-message
 *   customer-service budget does not allow it, otherwise reserve a slot, record
 *   the provider attempt, and move the delivery to its resulting state.
 * - **Retry**: append another attempt to the *same* delivery, never a second
 *   platform message.
 * - **Status notifications**: apply a provider status callback once, idempotent
 *   by the provider's own status-event id.
 *
 * Conversation and message content keeps living in `PlatformRepository`, so the
 * channel slice adds no second storage model for business history; only the
 * provider-facing reliability trail goes to `ChannelReliabilityRepository`.
 *
 * Authorization decisions that depend on the HTTP request (which member is
 * calling, which tenant scope it resolved) stay in the controller and in
 * `AccessService`. What this service decides is whether the *provider payload*
 * fits the scope the caller was authorized for, and it returns those refusals as
 * {@link ChannelOutcome} values rather than throwing, so only the HTTP edge
 * translates them into the platform error envelope.
 *
 * The transport is always the bound {@link ChannelAdapter}; nothing here holds a
 * credential or performs a network call of its own.
 */

import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  deliveryStatusForFailure,
  describeReplyWindow,
  evaluateDeliveryWindow,
  type ChannelAdapter,
  type ChannelFailureCode,
  type ChannelOutboxRecord,
  type Conversation,
  type DeliveryAttempt,
  type Member,
  type Message,
  type MessageDelivery,
  type MessageStatusEvent,
  type MessageType,
  type ReplyWindowStatus,
  type UnifiedMessage,
} from '@kefu/core';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';
import { RealtimeService } from '../realtime/realtime.service';
import { MessageMediaService } from '../media/media.service';
import { JsonLogger } from '../logging/json-logger';
import { CHANNEL_ADAPTER } from './channel-adapter.port';
import {
  CHANNEL_RELIABILITY_REPOSITORY,
  type ChannelReliabilityRepository,
  type QuotaWindowKey,
} from './channel-reliability.repository';
import {
  channelFailure,
  channelFailureFromAdapter,
  channelFailureFromCallbackVerification,
  type ChannelFailure,
  type ChannelOutcome,
} from './channel-outcome';

/** Maximum length of a provider-authored reason kept on a delivery or receipt. */
const MAX_REASON_LENGTH = 200;

/** Delivery statuses a provider status callback may report. */
const CALLBACK_STATUSES: ReadonlyArray<MessageDelivery['status']> = ['sent', 'failed', 'unknown'];

/** Input accepted by {@link ChannelDeliveryService.ingestWebhook}. */
export type IngestWebhookInput = {
  readonly member: Member;
  /** Tenant scope the request was authorized for. */
  readonly tenantId: string;
  readonly signature: string | null;
  /**
   * `timestamp` query parameter of a real callback.
   *
   * Part of the digest a real provider signs, so it has to travel from the HTTP
   * boundary to the adapter untouched. The Mock transport ignores it.
   */
  readonly timestamp?: string | null;
  /** `nonce` query parameter of a real callback; ignored by the Mock transport. */
  readonly nonce?: string | null;
  /** Serialized callback body exactly as the provider sent it. */
  readonly rawBody: string;
};

/**
 * Input accepted by {@link ChannelDeliveryService.ingestProviderWebhook}.
 *
 * A real provider callback carries no platform session at all, so there is no
 * acting member and no caller tenant to authorize against. The signature over
 * the raw bytes authenticates the *provider*, and the scope the adapter
 * resolved the callback to is the only identity it may act through — which is
 * why this path takes neither a member nor a tenant id.
 */
export type ProviderWebhookInput = {
  readonly signature: string | null;
  /** `timestamp` query parameter of a real callback, part of its digest. */
  readonly timestamp?: string | null;
  /** `nonce` query parameter of a real callback, part of its digest. */
  readonly nonce?: string | null;
  /** Serialized callback body exactly as the provider sent it. */
  readonly rawBody: string;
};

/** Successful inbound callback ingestion. */
export type InboundIngestResult = {
  /** `duplicate` when this provider event had already been processed. */
  readonly status: 'processed' | 'duplicate';
  readonly eventId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageType: MessageType;
  /** `false` when the message already existed and was replayed, not inserted. */
  readonly created: boolean;
};

/** Input accepted by {@link ChannelDeliveryService.applyStatusCallback}. */
export type StatusCallbackInput = {
  readonly member: Member;
  readonly tenantId: string;
  readonly signature: string | null;
  /** `timestamp` query parameter of a real callback; ignored by the Mock transport. */
  readonly timestamp?: string | null;
  /** `nonce` query parameter of a real callback; ignored by the Mock transport. */
  readonly nonce?: string | null;
  readonly rawBody: string;
};

/**
 * Successful provider status callback application.
 *
 * `recorded` and `applied` answer two different questions: whether the provider
 * event id was new, and whether the delivery state actually moved. A duplicate
 * is neither; a genuine but stale or post-`sent` event is recorded without
 * moving anything.
 */
export type StatusCallbackResult = {
  readonly eventId: string;
  /** `false` when this status event had already been recorded. */
  readonly recorded: boolean;
  /** `true` when the delivery state advanced because of this event. */
  readonly applied: boolean;
  readonly delivery: MessageDelivery;
};

/** One delivery with its full provider-facing history. */
export type DeliveryDetail = {
  readonly delivery: MessageDelivery;
  readonly attempts: ReadonlyArray<DeliveryAttempt>;
  readonly statusEvents: ReadonlyArray<MessageStatusEvent>;
  readonly outbox: ChannelOutboxRecord | null;
};

/** An outbound message with the delivery it produced. */
export type DispatchedMessage = {
  readonly message: Message;
  readonly delivery: MessageDelivery;
};

/** Internal classification of one provider send result. */
type SendOutcome =
  | { readonly kind: 'ok'; readonly externalMessageId: string }
  | {
      readonly kind: 'failed' | 'unknown';
      readonly code: ChannelFailureCode;
      readonly reason: string;
      readonly retryable: boolean;
    };

/**
 * Channel delivery behavior for the Mock WeCom transport.
 *
 * The service is bound to whichever {@link ChannelAdapter} the environment
 * provides; nothing in it is WeCom-specific beyond the payload shapes the
 * adapter itself parses.
 */
@Injectable()
export class ChannelDeliveryService {
  /**
   * @param platform - The platform business repository: conversations and
   * messages keep living there, so the channel slice adds no second storage
   * model for business history.
   * @param reliability - The provider-facing reliability store: callback
   * receipts, deliveries, attempts, status events, reply windows and outbox.
   * @param adapter - The bound transport adapter.
   * @param realtime - Announces committed changes to the seats watching them.
   * @param media - Keeps a customer's picture, when there is one.
   * @param logger - Where a media failure that is not a value explains itself.
   */
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly platform: PlatformRepository,
    @Inject(CHANNEL_RELIABILITY_REPOSITORY)
    private readonly reliability: ChannelReliabilityRepository,
    @Inject(CHANNEL_ADAPTER) private readonly adapter: ChannelAdapter,
    private readonly realtime: RealtimeService,
    private readonly media: MessageMediaService,
    private readonly logger: JsonLogger,
  ) {}

  // --------------------------------------------------------------------------
  // Inbound
  // --------------------------------------------------------------------------

  /**
   * Ingest one provider callback.
   *
   * The callback receipt is written first, so replaying the same provider event
   * returns the original business result and creates neither a second callback
   * record nor a second message. The scope the payload names must fit the scope
   * the caller was authorized for, otherwise nothing is written.
   *
   * @param input - Callback body, signature and authorized scope.
   * @returns The ingestion result, or a stable refusal value.
   */
  async ingestWebhook(input: IngestWebhookInput): Promise<ChannelOutcome<InboundIngestResult>> {
    const rejection = await this.verifyAndParse(
      input.signature,
      input.timestamp ?? null,
      input.nonce ?? null,
      input.rawBody,
    );
    if (!rejection.ok) {
      return rejection;
    }
    const message = rejection.value;

    const scopeRefusal = await this.authorizePayload(input.member, input.tenantId, message);
    if (scopeRefusal !== null) {
      return scopeRefusal;
    }

    return this.recordInbound(message, input.rawBody);
  }

  /**
   * Ingest one callback the provider authenticated on its own.
   *
   * This is the path a real transport takes. A WeCom server has no platform
   * session, so the only authentication a callback can carry is the provider's
   * own signature over the raw bytes, and the only identity it may act through
   * is the tenant/store the bound {@link WecomScopeResolver} resolves
   * `open_kfid` to. Nothing here reads a member, an `x-member-id` header or the
   * default platform administrator, so a callback cannot name the tenant it
   * writes to.
   *
   * The order is deliberate and every step is a refusal, never a write:
   *
   * 1. the signature decides whether the bytes are the provider's at all;
   * 2. the adapter decrypts them and refuses an unbound account rather than
   *    inventing a tenant;
   * 3. the resolved tenant and store are re-checked against platform storage,
   *    so a binding that names something the platform does not know is refused
   *    before any receipt or message exists.
   *
   * @param input - Callback body, signature and authorized scope.
   * @returns The ingestion result, or a stable refusal value.
   */
  async ingestProviderWebhook(
    input: ProviderWebhookInput,
  ): Promise<ChannelOutcome<InboundIngestResult>> {
    const rejection = await this.verifySignature(
      input.signature,
      input.timestamp ?? null,
      input.nonce ?? null,
      input.rawBody,
    );
    if (rejection !== null) {
      return rejection;
    }
    const parsed = await this.adapter.parseInboundMessage({ rawBody: input.rawBody });
    if (!parsed.ok) {
      return channelFailureFromAdapter(parsed);
    }
    return this.ingestProviderMessage(parsed.value, input.rawBody);
  }

  /**
   * Ingest one provider message the transport already authenticated and mapped.
   *
   * Used by the `kf/sync_msg` pull: WeCom announces a backlog with a
   * notification instead of delivering the messages themselves, so the transport
   * authenticates the notification and maps each pulled record, and this is the
   * one place that decides whether the resolved scope exists in platform storage
   * and writes the message. Both provider paths share it, so a pulled message and
   * a pushed callback cannot be authorized or de-duplicated differently.
   *
   * @param message - The mapped message, carrying the scope it resolved to.
   * @param payload - Text identifying the payload for the receipt's diagnostic
   *   digest. Hashed, never stored or logged verbatim.
   * @returns The ingestion result, or a stable refusal value.
   */
  async ingestProviderMessage(
    message: UnifiedMessage,
    payload: string,
  ): Promise<ChannelOutcome<InboundIngestResult>> {
    const scopeRefusal = await this.verifyResolvedScope(message);
    if (scopeRefusal !== null) {
      return scopeRefusal;
    }
    return this.recordInbound(message, payload);
  }

  /**
   * Re-check the scope a callback resolved to against platform storage.
   *
   * The adapter resolved the scope from `open_kfid`, which makes this the
   * second half of the binding: the resolver answers "which tenant does this
   * account belong to" and the platform directory answers "does that tenant and
   * store exist here". A scope the platform does not know is a channel that is
   * not configured — not a caller mistake — so it is refused as one, and no
   * receipt, conversation or message is written.
   *
   * @param message - The decrypted callback mapped to its resolved scope.
   * @returns The refusal, or `null` when the scope exists in platform storage.
   */
  private async verifyResolvedScope(message: UnifiedMessage): Promise<ChannelFailure | null> {
    if ((await this.platform.getTenant(message.tenantId)) === undefined) {
      return channelFailureFromAdapter({
        code: 'channel_not_configured',
        message: 'the callback resolved to a tenant outside the platform directory',
      });
    }
    if ((await this.platform.getStore(message.tenantId, message.storeId)) === undefined) {
      return channelFailureFromAdapter({
        code: 'channel_not_configured',
        message: 'the callback resolved to a store outside the platform directory',
      });
    }
    return null;
  }

  /**
   * Persist one authenticated, scope-checked callback.
   *
   * Shared by both transports, so the idempotency contract cannot differ
   * between them: the receipt is written before the business data, a replay
   * returns the original result, and the message dedup key makes a concurrent
   * second callback safe.
   *
   * @param message - The mapped callback, already authorized for its scope.
   * @param rawBody - The exact bytes the callback was authenticated over.
   * @returns The ingestion result.
   */
  private async recordInbound(
    message: UnifiedMessage,
    rawBody: string,
  ): Promise<ChannelOutcome<InboundIngestResult>> {
    const tenantId = message.tenantId;
    const replay = await this.replayInbound(tenantId, message);
    if (replay !== null) {
      return { ok: true, value: replay };
    }

    const now = new Date().toISOString();
    const event = await this.reliability.recordInboundEvent({
      tenantId,
      storeId: message.storeId,
      channel: this.adapter.channel,
      externalEventId: message.externalEventId,
      payloadHash: payloadHash(rawBody),
      now,
    });
    if (!event.created) {
      // The receipt exists but was never completed: an earlier attempt failed
      // mid-way, or two identical callbacks raced. Re-ingesting is still safe —
      // the message dedup key makes the business write idempotent — so the
      // receipt is left to be completed by this attempt.
      await this.reliability.failInboundEvent(
        tenantId,
        message.externalEventId,
        'superseded by an identical callback while the first receipt was incomplete',
        now,
      );
    }

    try {
      const ingested = await this.platform.ingestInbound({
        tenantId,
        storeId: message.storeId,
        channel: this.adapter.channel,
        externalCustomerId: message.externalCustomerId,
        externalConversationId: message.externalConversationId,
        externalMessageId: message.externalMessageId,
        messageType: message.messageType,
        content: message.content,
        dedupKey: message.dedupKey,
        now: message.receivedAt,
      });
      await this.reliability.openQuotaWindow(
        this.windowKey(tenantId, message.storeId, message.externalCustomerId),
        message.receivedAt,
      );
      await this.reliability.completeInboundEvent(
        tenantId,
        message.externalEventId,
        ingested.message.id,
        now,
      );
      if (ingested.created) {
        // The picture is fetched before the announcement, so the frame telling a
        // seat its transcript grew is only sent once the image in it can be read.
        // A message that already existed is never re-captured: its media was
        // either kept when it first arrived or deliberately not kept at all.
        await this.captureMedia(message, ingested.message.id);
        // Announced last, and only once the receipt is marked processed — the
        // point after which a replay takes the early-return path above and never
        // reaches here, so a provider retrying the same callback does not cost
        // every watching seat a second re-read.
        this.announceInbound(ingested.conversation, ingested.message);
      }
      return {
        ok: true,
        value: {
          status: 'processed',
          eventId: message.externalEventId,
          conversationId: ingested.conversation.id,
          messageId: ingested.message.id,
          messageType: ingested.message.messageType,
          created: ingested.created,
        },
      };
    } catch (error) {
      await this.reliability.failInboundEvent(
        tenantId,
        message.externalEventId,
        bounded(error instanceof Error ? error.message : null, 'inbound ingestion failed'),
        now,
      );
      throw error;
    }
  }

  /**
   * Fetch and keep the media of a message that just arrived.
   *
   * A second write, deliberately outside the repository's own transaction: the
   * message is the customer's whether or not its picture is kept, and holding a
   * database transaction open across a provider download and an object store
   * write would make a slow picture everyone else's problem.
   *
   * Nothing here may fail the callback. The message is already durable and the
   * receipt already processed, so a throw from this point would turn an accepted
   * message into a provider retry for a picture that may simply not exist.
   * {@link MessageMediaService.capture} answers with a value rather than
   * throwing by construction; the guard is the belt that keeps a later edit from
   * quietly changing that, since the cost of being wrong is already-paid work
   * being redone.
   *
   * @param message - The authenticated callback, which carries the provider's
   * reference to the media.
   * @param messageId - The message row the media belongs to.
   */
  private async captureMedia(message: UnifiedMessage, messageId: string): Promise<void> {
    if (message.media === null) {
      return;
    }
    try {
      await this.media.capture({
        tenantId: message.tenantId,
        messageId,
        messageType: message.messageType,
        media: message.media,
        // Only the fetch: keeping bytes is this slice's job, and the adapter's
        // contract for a provider download is all it needs from the transport.
        channel: this.adapter,
      });
    } catch (error: unknown) {
      // Only the error's name: a provider failure can carry a request URL with a
      // media id, and that is a handle into a customer's picture.
      this.logger.logStructured(
        'error',
        'keeping customer media failed',
        {
          tenant: message.tenantId,
          message: messageId,
          error: error instanceof Error ? error.name : typeof error,
        },
        ChannelDeliveryService.name,
      );
    }
  }

  /**
   * Announce a newly ingested inbound message.
   *
   * Two frames, because they answer two different questions a workspace asks:
   * the conversation frame tells the queue list that a conversation moved — and
   * whether it is one the caller has never seen — while the message frame tells
   * whichever seat has that conversation open that its transcript grew.
   *
   * "Brand new" is read from the write rather than guessed at: the first message
   * of a conversation is stamped at the instant that conversation opened, so the
   * two timestamps are equal for exactly that message and for no later one. Both
   * come from the row the repository just returned, so this costs no extra read
   * and cannot disagree with what was stored.
   *
   * @param conversation - The conversation as committed.
   * @param message - The message as committed.
   */
  private announceInbound(conversation: Conversation, message: Message): void {
    if (conversation.openedAt === message.createdAt) {
      this.realtime.conversationOpened(conversation);
    } else {
      this.realtime.conversationUpdated(conversation);
    }
    this.realtime.messageCreated(message);
  }

  /**
   * Announce a delivery whose provider-facing status just moved.
   *
   * The status announced is the row the repository returned, so a subscriber's
   * re-read finds exactly what the frame described. The delivery carries its own
   * tenant, store and message identity, which is why no scope is passed in.
   *
   * @param delivery - The delivery as committed.
   * @returns The same delivery, so call sites read `return this.announce…`.
   */
  private announceDelivery(delivery: MessageDelivery): MessageDelivery {
    this.realtime.messageDeliveryUpdated(delivery);
    return delivery;
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  /**
   * Record and dispatch the delivery of one logical outbound message.
   *
   * Called after the platform message is durable, so a delivery always has a
   * message to point at. A replayed logical message returns its existing
   * delivery untouched: the platform never records a second delivery or a
   * second provider attempt for the same message.
   *
   * @param conversation - Authorized conversation the message belongs to.
   * @param message - The platform message that was just recorded.
   * @returns The latest delivery projection.
   */
  async dispatch(conversation: Conversation, message: Message): Promise<MessageDelivery> {
    const now = new Date().toISOString();
    const record = await this.reliability.createDelivery({
      tenantId: conversation.tenantId,
      storeId: conversation.storeId,
      conversationId: conversation.id,
      messageId: message.id,
      channel: this.adapter.channel,
      externalCustomerId: conversation.externalCustomerId,
      externalConversationId: conversation.externalConversationId ?? conversation.id,
      now,
    });
    if (!record.created) {
      return record.delivery;
    }
    const outbox = await this.reliability.enqueueOutbox({
      tenantId: conversation.tenantId,
      storeId: conversation.storeId,
      deliveryId: record.delivery.id,
      messageId: message.id,
      now,
    });
    return this.attemptDelivery(record.delivery, outbox, message, now);
  }

  /**
   * Retry one delivery explicitly.
   *
   * Idempotent at the logical message level: the attempt is appended to the
   * existing delivery and the existing outbox entry is reused, so a retry can
   * never create a second platform message.
   *
   * The endpoint enforces the delivery's own `retryable` flag — the same flag
   * the status callback sets — so a terminal `sent` delivery, or a late callback
   * that tried to fail one, is refused with a stable `409` instead of producing
   * another adapter attempt. That refusal is returned as a value, never thrown,
   * and it is not a server error.
   *
   * @param tenantId - Authorized tenant scope.
   * @param member - Acting member, used for the store-scope check.
   * @param deliveryId - Delivery to retry.
   * @returns The latest delivery projection, or a stable refusal value.
   */
  async retryDelivery(
    tenantId: string,
    member: Member,
    deliveryId: string,
  ): Promise<ChannelOutcome<MessageDelivery>> {
    const delivery = await this.reliability.getDelivery(tenantId, deliveryId);
    if (delivery === undefined) {
      return channelFailure(
        HttpStatus.NOT_FOUND,
        'not_found',
        'delivery not found in tenant scope',
      );
    }
    const storeRefusal = this.authorizeStore(member, delivery.storeId);
    if (storeRefusal !== null) {
      return storeRefusal;
    }
    if (!delivery.retryable) {
      // The delivery reached a terminal state (`sent`, or a failure this
      // transport will not retry). Refuse with the same stable conflict the
      // callback contract uses, so the endpoint and the retryability flag never
      // disagree, and no adapter attempt is made.
      return channelFailure(
        HttpStatus.CONFLICT,
        'conflict',
        `delivery is not retryable in status '${delivery.status}'`,
      );
    }
    const conversation = await this.platform.getConversation(tenantId, delivery.conversationId);
    const message = await this.platform.getMessage(tenantId, delivery.messageId);
    if (conversation === undefined || message === undefined) {
      return channelFailure(
        HttpStatus.NOT_FOUND,
        'not_found',
        'the delivery no longer resolves to a message in this tenant',
      );
    }
    const now = new Date().toISOString();
    const outbox = await this.reliability.enqueueOutbox({
      tenantId,
      storeId: delivery.storeId,
      deliveryId: delivery.id,
      messageId: delivery.messageId,
      now,
    });
    return {
      ok: true,
      value: this.announceDelivery(await this.attemptDelivery(delivery, outbox, message, now)),
    };
  }

  /**
   * Load one delivery with its attempts, status events and outbox entry.
   *
   * @param tenantId - Authorized tenant scope.
   * @param member - Acting member, used for the store-scope check.
   * @param deliveryId - Delivery to load.
   * @returns The delivery detail, or a stable refusal value.
   */
  async deliveryDetail(
    tenantId: string,
    member: Member,
    deliveryId: string,
  ): Promise<ChannelOutcome<DeliveryDetail>> {
    const delivery = await this.reliability.getDelivery(tenantId, deliveryId);
    if (delivery === undefined) {
      return channelFailure(
        HttpStatus.NOT_FOUND,
        'not_found',
        'delivery not found in tenant scope',
      );
    }
    const storeRefusal = this.authorizeStore(member, delivery.storeId);
    if (storeRefusal !== null) {
      return storeRefusal;
    }
    return { ok: true, value: await this.buildDetail(delivery) };
  }

  /**
   * Delivery detail for every message of one conversation, oldest first.
   *
   * Used by the conversation detail projection so one read answers both "what
   * was said" and "what happened to it at the provider".
   *
   * @param tenantId - Authorized tenant scope.
   * @param conversationId - Conversation whose deliveries are read.
   * @returns One detail per recorded delivery.
   */
  async conversationDeliveryDetail(
    tenantId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<DeliveryDetail>> {
    const deliveries = await this.reliability.listDeliveries(tenantId, conversationId);
    const details: DeliveryDetail[] = [];
    for (const delivery of deliveries) {
      details.push(await this.buildDetail(delivery));
    }
    return details;
  }

  /**
   * The customer's current reply window, as the console renders it.
   *
   * The window is keyed by the customer rather than by the conversation, because
   * the *customer-service rule* is about the customer: the same 48 hours and the
   * same five replies follow them from one conversation to the next. The key is
   * therefore built here, from the conversation's own channel/store/customer
   * triple — the same helper the send path uses, so a console reading this and a
   * send being refused cannot be looking at two different windows.
   *
   * No refusal is raised for a missing window: "the customer has not written yet"
   * is an answer a console shows, not an error.
   *
   * @param conversation - Conversation whose customer's window is read.
   * @returns The deadline and slots left, plus whether a reply may be sent now.
   */
  async replyWindow(conversation: Conversation): Promise<ReplyWindowStatus> {
    const key = this.windowKey(
      conversation.tenantId,
      conversation.storeId,
      conversation.externalCustomerId,
    );
    return describeReplyWindow(await this.reliability.getQuotaWindow(key), new Date().toISOString());
  }

  // --------------------------------------------------------------------------
  // Provider status notifications
  // --------------------------------------------------------------------------

  /**
   * Apply one provider status notification.
   *
   * Idempotent by the provider's own status-event id and monotonic in state: a
   * replay is not recorded twice, and a late or stale notification can never
   * move a delivery backwards. A `sent` delivery stays `sent` and stays
   * non-retryable whatever a later callback claims, so the callback contract and
   * the retry endpoint cannot disagree. Only a delivery in the authorized tenant
   * (and, for an agent, in the agent's store) is updated.
   *
   * @param input - Status callback body, signature and authorized scope.
   * @returns The applied result, or a stable refusal value.
   */
  async applyStatusCallback(
    input: StatusCallbackInput,
  ): Promise<ChannelOutcome<StatusCallbackResult>> {
    const rejection = await this.verifySignature(
      input.signature,
      input.timestamp ?? null,
      input.nonce ?? null,
      input.rawBody,
    );
    if (rejection !== null) {
      return rejection;
    }
    const parsed = parseStatusPayload(input.rawBody);
    if (!parsed.ok) {
      return parsed;
    }
    const delivery = await this.reliability.getDelivery(input.tenantId, parsed.value.deliveryId);
    if (delivery === undefined) {
      return channelFailure(
        HttpStatus.NOT_FOUND,
        'not_found',
        'status callback targets a delivery outside the authorized tenant',
      );
    }
    const storeRefusal = this.authorizeStore(input.member, delivery.storeId);
    if (storeRefusal !== null) {
      return storeRefusal;
    }
    const now = new Date().toISOString();
    const record = await this.reliability.recordStatusEvent({
      tenantId: input.tenantId,
      deliveryId: delivery.id,
      externalEventId: parsed.value.eventId,
      status: parsed.value.status,
      reason: parsed.value.reason,
      occurredAt: parsed.value.occurredAt ?? now,
      now,
    });
    const current = await this.reliability.getDelivery(input.tenantId, delivery.id);
    // Only an *applied* callback is a change: a status event that arrived after
    // the delivery had already moved past it (a late `failed` for a `sent`
    // message) is recorded for the audit trail but is not news to anyone, and
    // announcing it would contradict the status the re-read then returns.
    if (record.applied) {
      this.realtime.messageDeliveryUpdated(current ?? delivery);
    }
    return {
      ok: true,
      value: {
        eventId: parsed.value.eventId,
        recorded: record.created,
        applied: record.applied,
        delivery: current ?? delivery,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Run one provider attempt and move the delivery to its resulting state.
   *
   * The reply-window/quota gate runs *before* the adapter is called, so a
   * message that is not allowed to be sent can never reach a real customer. A
   * definite failure releases the reserved slot; an unknown outcome keeps it,
   * because the provider may have accepted the message after all.
   *
   * A refused or failed attempt leaves the outbox entry `pending`, which is what
   * lets a later retry reuse the same delivery and the same outbox entry instead
   * of creating new ones.
   */
  private async attemptDelivery(
    delivery: MessageDelivery,
    outbox: ChannelOutboxRecord,
    message: Message,
    now: string,
  ): Promise<MessageDelivery> {
    const key = this.windowKey(delivery.tenantId, delivery.storeId, delivery.externalCustomerId);
    const decision = evaluateDeliveryWindow(await this.reliability.getQuotaWindow(key), now);
    if (!decision.allowed) {
      return this.reliability.recordDegradation({
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
        failureCode: decision.code,
        failureReason: decision.reason,
        retryable: true,
        now,
      });
    }
    const reservation = await this.reliability.reserveQuotaSlot(key, now);
    if (!reservation.ok) {
      return this.reliability.recordDegradation({
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
        failureCode: reservation.code,
        failureReason: reservation.reason,
        retryable: true,
        now,
      });
    }

    const outcome = await this.sendToProvider(delivery, message);
    if (outcome.kind === 'failed') {
      await this.reliability.releaseQuotaSlot(key, now);
    }
    // Every outcome that reached the adapter counts as one outbox attempt, so
    // the outbox counter and the delivery attempt history stay equal no matter
    // which path the send took. Only a send the provider took stays
    // `dispatched`; a failure or an unknown outcome keeps the entry `pending`,
    // which is what allows a retry to reuse this same delivery and outbox row.
    await this.reliability.saveOutboxState({
      tenantId: delivery.tenantId,
      outboxId: outbox.id,
      status: outcome.kind === 'ok' ? 'dispatched' : 'pending',
      attemptCount: outbox.attemptCount + 1,
      now,
    });
    const recorded = await this.reliability.appendAttempt({
      tenantId: delivery.tenantId,
      deliveryId: delivery.id,
      status:
        outcome.kind === 'ok'
          ? 'sent'
          : deliveryStatusForFailure({
              code: outcome.code,
              deliveryUnknown: outcome.kind === 'unknown',
            }),
      externalMessageId: outcome.kind === 'ok' ? outcome.externalMessageId : null,
      failureCode: outcome.kind === 'ok' ? null : outcome.code,
      failureReason: outcome.kind === 'ok' ? null : outcome.reason,
      retryable: outcome.kind === 'ok' ? false : outcome.retryable,
      now,
    });
    return recorded.delivery;
  }

  /** Hand one message to the adapter, classifying every possible outcome. */
  private async sendToProvider(delivery: MessageDelivery, message: Message): Promise<SendOutcome> {
    try {
      const result = await this.adapter.sendMessage({
        tenantId: delivery.tenantId,
        storeId: delivery.storeId,
        externalCustomerId: delivery.externalCustomerId,
        externalConversationId: delivery.externalConversationId,
        messageType: message.messageType,
        content: message.content,
        media: null,
        correlationId: delivery.id,
      });
      if (result.ok) {
        return { kind: 'ok', externalMessageId: result.value.externalMessageId };
      }
      const retryable = result.retryable ?? true;
      if (result.deliveryUnknown === true) {
        return {
          kind: 'unknown',
          code: result.code,
          reason: bounded(result.message, 'provider response was lost'),
          retryable,
        };
      }
      return {
        kind: 'failed',
        code: result.code,
        reason: bounded(result.message, 'provider rejected the message'),
        retryable,
      };
    } catch {
      // A throwing adapter cannot say whether the provider accepted the message,
      // so the conservative reading is "possibly delivered": the delivery keeps
      // its reserved slot, is marked unknown, and is never silently treated as a
      // definite failure.
      return {
        kind: 'unknown',
        code: 'channel_delivery_unknown',
        reason: 'provider adapter threw before reporting an outcome',
        retryable: true,
      };
    }
  }

  /**
   * Verify a callback signature and parse it as an inbound message.
   *
   * An adapter failure is projected with {@link channelFailureFromAdapter}, so
   * "this payload is malformed" and "this transport is not configured to accept
   * it" cannot both answer as a caller mistake: the first is a `400`, the second
   * the same `503` the callback URL handshake already answers with.
   */
  private async verifyAndParse(
    signature: string | null,
    timestamp: string | null,
    nonce: string | null,
    rawBody: string,
  ): Promise<ChannelOutcome<UnifiedMessage>> {
    const rejection = await this.verifySignature(signature, timestamp, nonce, rawBody);
    if (rejection !== null) {
      return rejection;
    }
    const parsed = await this.adapter.parseInboundMessage({ rawBody });
    if (!parsed.ok) {
      return channelFailureFromAdapter(parsed);
    }
    return { ok: true, value: parsed.value };
  }

  /**
   * Run the adapter's webhook verification; `null` means the callback is authentic.
   *
   * The full signature triple and the raw bytes are handed to the adapter
   * untouched. A real provider signs all of them together, so a layer that
   * substituted `null` for `timestamp`/`nonce` would make every real callback
   * unverifiable; the Mock transport reads only the signature and is unaffected.
   */
  private async verifySignature(
    signature: string | null,
    timestamp: string | null,
    nonce: string | null,
    rawBody: string,
  ): Promise<ChannelFailure | null> {
    const result = await this.adapter.verifyWebhook({
      channel: this.adapter.channel,
      signature,
      timestamp,
      nonce,
      rawBody,
    });
    if (!result.ok) {
      // The same projection the callback URL handshake answers with: a refused
      // signature is the caller failing to authenticate, while a transport that
      // is not configured is the platform's own gap.
      return channelFailureFromCallbackVerification(result);
    }
    return null;
  }

  /** Refuse a callback whose payload names a tenant/store outside the authorized scope. */
  private async authorizePayload(
    member: Member,
    tenantId: string,
    message: UnifiedMessage,
  ): Promise<ChannelFailure | null> {
    if (message.tenantId !== tenantId) {
      return channelFailure(
        HttpStatus.FORBIDDEN,
        'forbidden',
        'the callback tenant is outside the authorized tenant scope',
      );
    }
    if ((await this.platform.getStore(message.tenantId, message.storeId)) === undefined) {
      return channelFailure(
        HttpStatus.BAD_REQUEST,
        'bad_request',
        'the callback store is not part of the tenant scope',
      );
    }
    return this.authorizeStore(member, message.storeId);
  }

  /** Refuse an operation on a store outside an agent's assigned store. */
  private authorizeStore(member: Member, storeId: string): ChannelFailure | null {
    if (member.role === 'agent' && member.storeId !== null && member.storeId !== storeId) {
      return channelFailure(
        HttpStatus.FORBIDDEN,
        'forbidden',
        'the store is outside the member store scope',
      );
    }
    return null;
  }

  /** Return the business result of an already-processed provider event. */
  private async replayInbound(
    tenantId: string,
    message: UnifiedMessage,
  ): Promise<InboundIngestResult | null> {
    const existing = await this.reliability.getInboundEvent(tenantId, message.externalEventId);
    const messageId = existing?.messageId ?? null;
    if (existing === undefined || existing.status !== 'processed' || messageId === null) {
      return null;
    }
    const stored = await this.platform.getMessage(tenantId, messageId);
    if (stored === undefined) {
      return null;
    }
    return {
      status: 'duplicate',
      eventId: message.externalEventId,
      conversationId: stored.conversationId,
      messageId: stored.id,
      messageType: stored.messageType,
      created: false,
    };
  }

  /** Load a delivery's attempts, status events and outbox entry. */
  private async buildDetail(delivery: MessageDelivery): Promise<DeliveryDetail> {
    return {
      delivery,
      attempts: await this.reliability.listAttempts(delivery.tenantId, delivery.id),
      statusEvents: await this.reliability.listStatusEvents(delivery.tenantId, delivery.id),
      outbox: (await this.reliability.getOutboxByDelivery(delivery.tenantId, delivery.id)) ?? null,
    };
  }

  /** Build the reply-window key one delivery is gated by. */
  private windowKey(tenantId: string, storeId: string, externalCustomerId: string): QuotaWindowKey {
    return { tenantId, storeId, channel: this.adapter.channel, externalCustomerId };
  }
}

/** Stable digest of a callback payload, kept for diagnostics only. */
function payloadHash(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
}

/** Bound provider-authored text before it is persisted. */
function bounded(text: string | null | undefined, fallback: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.length <= MAX_REASON_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_REASON_LENGTH)}...`;
}

/** Parsed provider status callback payload. */
type ParsedStatusPayload = {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly status: MessageDelivery['status'];
  readonly reason: string | null;
  readonly occurredAt: string | null;
};

/** Parse and validate one provider status callback body. */
function parseStatusPayload(rawBody: string): ChannelOutcome<ParsedStatusPayload> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return channelFailure(
      HttpStatus.BAD_REQUEST,
      'bad_request',
      'status callback must be valid JSON',
    );
  }
  if (!isRecord(value)) {
    return channelFailure(
      HttpStatus.BAD_REQUEST,
      'bad_request',
      'status callback must be a JSON object',
    );
  }
  const eventId = textOf(value['eventId']);
  const deliveryId = textOf(value['deliveryId']);
  const status = textOf(value['status']);
  if (eventId === null || deliveryId === null || status === null) {
    return channelFailure(
      HttpStatus.BAD_REQUEST,
      'bad_request',
      'status callback requires eventId, deliveryId and status',
    );
  }
  if (!isCallbackStatus(status)) {
    return channelFailure(
      HttpStatus.BAD_REQUEST,
      'bad_request',
      `status must be one of ${CALLBACK_STATUSES.join(', ')}`,
    );
  }
  return {
    ok: true,
    value: {
      eventId,
      deliveryId,
      status,
      reason: textOf(value['reason']),
      occurredAt: textOf(value['occurredAt']),
    },
  };
}

/** Narrow an unknown JSON value to a non-array object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow a string to a delivery status a status callback may report. */
function isCallbackStatus(value: string): value is MessageDelivery['status'] {
  return CALLBACK_STATUSES.some((candidate) => candidate === value);
}

/** Read a non-empty trimmed string field, or `null`. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
