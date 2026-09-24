import type { RealtimeEvent } from '@kefu/core';

/** Receives every frame published while it is subscribed. */
export type RealtimeListener = (event: RealtimeEvent) => void;

/**
 * Fan-out port for realtime frames.
 *
 * A port rather than a concrete class so the transport can change without any
 * publisher knowing: call sites only ever say "this fact happened".
 */
export interface RealtimeBus {
  /** Deliver one frame to every current subscriber. */
  publish(event: RealtimeEvent): void;
  /**
   * Attach a subscriber.
   *
   * @param listener - Called for every frame published while attached.
   * @returns Detaches the subscriber. Idempotent.
   */
  subscribe(listener: RealtimeListener): () => void;
}

/**
 * In-process fan-out.
 *
 * One process is the right scope for this bus, and that is a decision rather
 * than a shortcut. Every fact the workspace must see is written by *this*
 * process: an agent's own action, an inbound channel webhook, and the assignment
 * sweep all run here. The one fact written elsewhere — the worker's outbox
 * delivery outcome — is deliberately not broadcast, and does not need to be,
 * because a subscriber's response to any frame is to re-read REST state: the
 * delivery row the worker wrote is already visible to that read. Adding a
 * cross-process transport (Redis pub/sub) would buy no observable behaviour and
 * would make the realtime surface fail whenever that extra dependency is absent,
 * which in this deployment it usually is.
 *
 * Delivery is synchronous, so a frame is never queued behind anything: the
 * `publish` call returns only once every subscriber has been handed the frame.
 */
export class InMemoryRealtimeBus implements RealtimeBus {
  readonly #listeners = new Set<RealtimeListener>();

  /** @param event - Frame to deliver to every current subscriber. */
  publish(event: RealtimeEvent): void {
    // Iterating a copy, because a subscriber is allowed to detach itself from
    // inside its own callback (an SSE writer that just discovered its socket is
    // gone does exactly that). Mutating the live set mid-iteration would skip
    // whichever subscriber happened to be next.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not cost the others the frame, and must not
        // keep throwing on every later frame either — a stream that fails while
        // being written is finished, so it is dropped here. Nothing is logged:
        // the failure is a transport one (a closed socket), and the subscriber's
        // own teardown is what releases its resources.
        this.#listeners.delete(listener);
      }
    }
  }

  /**
   * @param listener - Called for every frame published while attached.
   * @returns Detaches the subscriber.
   */
  subscribe(listener: RealtimeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** How many subscribers are attached. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#listeners.size;
  }
}
