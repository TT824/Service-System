/**
 * Time and identifier seams for the authentication domain.
 *
 * Expiry, lockout, rate limiting and rotation all depend on "now", and every
 * durable record needs a stable identifier. Both are injected so a test can
 * drive a deterministic clock and identifier sequence instead of sleeping or
 * matching generated ids by pattern.
 */

import { randomUUID } from 'node:crypto';

/** Source of the current time for authentication decisions. */
export interface AuthClock {
  /** Current time as an ISO-8601 instant. */
  now(): string;
}

/** Clock backed by the system time. */
export class SystemAuthClock implements AuthClock {
  /** @inheritdoc */
  now(): string {
    return new Date().toISOString();
  }
}

/** Clock that returns a caller-controlled instant, advanced by tests. */
export class FixedAuthClock implements AuthClock {
  #current: string;

  /**
   * @param start - Initial instant as an ISO-8601 string.
   */
  constructor(start: string) {
    this.#current = start;
  }

  /** @inheritdoc */
  now(): string {
    return this.#current;
  }

  /**
   * Replace the current instant.
   *
   * @param instant - New instant as an ISO-8601 string.
   */
  set(instant: string): void {
    this.#current = instant;
  }

  /**
   * Advance the clock by a fixed duration.
   *
   * @param milliseconds - Duration to advance.
   */
  advance(milliseconds: number): void {
    this.#current = new Date(Date.parse(this.#current) + milliseconds).toISOString();
  }
}

/** Source of identifiers for new authentication records. */
export interface AuthIdGenerator {
  /**
   * Produce the next identifier.
   *
   * @param prefix - Human-readable record prefix (for example `user`).
   * @returns A unique identifier starting with `prefix-`.
   */
  next(prefix: string): string;
}

/** Identifier generator backed by random UUIDs. */
export class RandomAuthIdGenerator implements AuthIdGenerator {
  /** @inheritdoc */
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}

/** Identifier generator that returns a predictable, incrementing sequence. */
export class SequentialAuthIdGenerator implements AuthIdGenerator {
  #sequence = 0;

  /** @inheritdoc */
  next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${String(this.#sequence).padStart(4, '0')}`;
  }
}
