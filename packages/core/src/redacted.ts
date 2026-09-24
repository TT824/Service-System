/**
 * A wrapper that keeps a sensitive value out of accidental logs, traces and
 * JSON serialization.
 *
 * Wrap credentials and connection strings at configuration boundaries and
 * unwrap only where the raw value is required (for example inside a database
 * or object-storage adapter).
 */
export class Redacted<T> {
  readonly #value: T;

  private constructor(value: T) {
    this.#value = value;
  }

  /**
   * Wrap a sensitive value.
   *
   * @param value - The sensitive value to protect.
   * @returns A redaction wrapper that hides the value from serialization.
   */
  static of<T>(value: T): Redacted<T> {
    return new Redacted(value);
  }

  /**
   * Reveal the raw value.
   *
   * Only call this at the narrow boundary where the value is actually needed.
   *
   * @returns The original sensitive value.
   */
  unwrap(): T {
    return this.#value;
  }

  /**
   * JSON-safe representation. Never exposes the wrapped value.
   *
   * @returns A placeholder string.
   */
  toJSON(): string {
    return '[Redacted]';
  }
}
