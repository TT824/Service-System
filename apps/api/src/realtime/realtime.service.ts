import { Injectable } from '@nestjs/common';
import {
  buildRealtimeEvent,
  type AgentPresence,
  type Conversation,
  type InternalMessage,
  type Message,
  type MessageDeliveryStatus,
  type RealtimeEvent,
  type RealtimeEventPayload,
} from '@kefu/core';
import { InMemoryRealtimeBus, type RealtimeBus, type RealtimeListener } from './realtime-bus';

/** Scope one frame belongs to, taken from the row the fact was written from. */
export type RealtimeEventScope = {
  readonly tenantId: string | null;
  readonly storeId: string | null;
};

/**
 * The single publisher of realtime frames.
 *
 * Every frame is announced from here and from nowhere else, so the *when* is
 * consistently "after the write committed": call sites publish the row the
 * repository just returned, never a row they intended to write. That ordering is
 * what makes the channel safe to act on — a subscriber that re-reads REST on
 * every frame can never be sent to look for something that is not there yet.
 *
 * Nothing here filters. A frame goes to every subscriber of the bus and each SSE
 * stream applies {@link realtimeEventVisibleTo} to its own scope, so the scoping
 * rule stays in one place (`@kefu/core`) instead of being re-applied per
 * publisher.
 */
@Injectable()
export class RealtimeService {
  readonly #bus: RealtimeBus = new InMemoryRealtimeBus();
  #sequence = 0;

  /**
   * Attach a subscriber to every published frame.
   *
   * @param listener - Called for each frame while attached.
   * @returns Detaches the subscriber.
   */
  subscribe(listener: RealtimeListener): () => void {
    return this.#bus.subscribe(listener);
  }

  /**
   * Announce a fact.
   *
   * @param payload - The kind-specific payload.
   * @param scope - Tenant and store the fact belongs to.
   * @param now - Instant of the write (ISO); defaults to the current time.
   * @returns The frame as published, so a caller may log or assert on it.
   */
  publish(
    payload: RealtimeEventPayload,
    scope: RealtimeEventScope,
    now: string = new Date().toISOString(),
  ): RealtimeEvent {
    const event = buildRealtimeEvent(payload, {
      eventId: this.#nextEventId(now),
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      occurredAt: now,
    });
    this.#bus.publish(event);
    return event;
  }

  /**
   * Announce a new conversation.
   *
   * @param conversation - The conversation as committed.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  conversationOpened(conversation: Conversation, now?: string): RealtimeEvent {
    return this.publish(
      {
        event_type: 'conversation.opened',
        data: {
          conversation_id: conversation.id,
          status: conversation.status,
          assigned_member_id: conversation.assignedMemberId,
        },
      },
      conversation,
      now,
    );
  }

  /**
   * Announce a conversation that moved: claimed, returned, transferred, closed
   * or reopened by an inbound message.
   *
   * @param conversation - The conversation as committed, *after* the transition.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  conversationUpdated(conversation: Conversation, now?: string): RealtimeEvent {
    return this.publish(
      {
        event_type: 'conversation.updated',
        data: {
          conversation_id: conversation.id,
          status: conversation.status,
          assigned_member_id: conversation.assignedMemberId,
        },
      },
      conversation,
      now,
    );
  }

  /**
   * Announce an appended message.
   *
   * @param message - The message as committed.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  messageCreated(message: Message, now?: string): RealtimeEvent {
    return this.publish(
      {
        event_type: 'message.created',
        data: {
          conversation_id: message.conversationId,
          message_id: message.id,
          direction: message.direction,
          message_type: message.messageType,
        },
      },
      message,
      now,
    );
  }

  /**
   * Announce an outbound message's provider-facing outcome.
   *
   * @param input - Message identity, its scope and the new status.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  messageDeliveryUpdated(
    input: RealtimeEventScope & {
      readonly conversationId: string;
      readonly messageId: string;
      readonly status: MessageDeliveryStatus;
    },
    now?: string,
  ): RealtimeEvent {
    return this.publish(
      {
        event_type: 'message.delivery_updated',
        data: {
          conversation_id: input.conversationId,
          message_id: input.messageId,
          status: input.status,
        },
      },
      input,
      now,
    );
  }

  /**
   * Announce a seat's availability.
   *
   * @param presence - The seat as committed.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  presenceChanged(presence: AgentPresence, now?: string): RealtimeEvent {
    return this.publish(
      {
        event_type: 'presence.changed',
        data: {
          member_id: presence.memberId,
          store_id: presence.storeId,
          status: presence.status,
        },
      },
      presence,
      now,
    );
  }

  /**
   * Announce a message written in an internal (colleague-to-colleague) thread.
   *
   * Published tenant-wide, with no store: an internal thread is not a store's
   * fact, and the two participants may sit in different stores. Every seat in
   * the tenant therefore receives the nudge, and each one re-reads only its own
   * threads — so what a non-participant learns is that somebody wrote something
   * to somebody, never what. The body deliberately stays out of the frame.
   *
   * @param message - The message as committed.
   * @param now - Instant of the write (ISO).
   * @returns The published frame.
   */
  internalMessageCreated(message: InternalMessage, now?: string): RealtimeEvent {
    return this.publish(
      {
        event_type: 'internal.message.created',
        data: {
          thread_id: message.threadId,
          message_id: message.id,
          sender_member_id: message.senderMemberId,
        },
      },
      { tenantId: message.tenantId, storeId: null },
      now,
    );
  }

  /**
   * The keepalive frame of one stream.
   *
   * Built but never published: a keepalive is private to the connection it keeps
   * alive, and a tenant-wide subscriber must not be told that some other
   * connection is still open.
   *
   * @param now - Instant of the frame (ISO).
   * @returns The frame to write to the stream.
   */
  pingEvent(now: string = new Date().toISOString()): RealtimeEvent {
    return buildRealtimeEvent(
      { event_type: 'realtime.ping', data: { at: now } },
      { eventId: this.#nextEventId(now), tenantId: null, storeId: null, occurredAt: now },
    );
  }

  /**
   * The handshake frame of one stream.
   *
   * Built but never published, for the same reason as {@link pingEvent}. It
   * carries the scope the stream resolved to, so the client can confirm which
   * tenant it is attached to instead of assuming it.
   *
   * @param input - Whether this is a re-connection, and the resolved scope.
   * @returns The frame to open the stream with.
   */
  connectedEvent(
    input: RealtimeEventScope & { readonly reconnect: boolean; readonly now?: string },
  ): RealtimeEvent {
    const now = input.now ?? new Date().toISOString();
    return buildRealtimeEvent(
      { event_type: 'realtime.connected', data: { reconnect: input.reconnect } },
      {
        eventId: this.#nextEventId(now),
        tenantId: input.tenantId,
        storeId: input.storeId,
        occurredAt: now,
      },
    );
  }

  /**
   * A frame id, unique within this process.
   *
   * Ordered by construction (timestamp, then a counter), which is all a consumer
   * may rely on: the id exists to let a client drop a frame it has already
   * handled, not to be resumed from. There is no replay buffer to resume into —
   * see {@link InMemoryRealtimeBus} for why the REST re-read is the compensation
   * instead.
   *
   * @param now - Instant the frame was created at (ISO).
   * @returns The event id.
   */
  #nextEventId(now: string): string {
    this.#sequence += 1;
    return `${now}#${this.#sequence}`;
  }
}
