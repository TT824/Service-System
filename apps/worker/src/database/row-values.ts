/**
 * Row-to-domain value converters for the Worker's durable stores.
 *
 * The Worker writes and reads the same `channel_outbox`, `message_deliveries`
 * and `message_delivery_attempts` rows the API does, and the domain types those
 * rows map to come from `@kefu/core` — so the Worker must normalise driver
 * values to exactly the shapes the API's adapters produce, or a delivery the
 * Worker read would not equal the delivery the API wrote. `TIMESTAMPTZ` columns
 * arrive as `Date` objects (or strings, depending on the driver), `BOOLEAN`
 * columns as driver booleans, `INTEGER` columns as numbers.
 *
 * This is deliberately the *only* thing the Worker shares with the API by
 * copy rather than by import: it is generic driver normalisation with no
 * provider or channel behaviour in it, and importing an API module into the
 * Worker is forbidden — a Worker that depended on the API's source would make
 * the two deployments one deployment.
 *
 * Only `SELECT`ed values pass through here, so nothing in this module ever
 * touches a credential or a connection string.
 */

/**
 * Normalise a timestamp column to the ISO-8601 string the domain uses.
 *
 * @param value - Column value as the driver returned it.
 * @returns The ISO instant, or an empty string when the value is not a time.
 */
export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/**
 * Normalise a nullable timestamp column.
 *
 * @param value - Column value as the driver returned it.
 * @returns The ISO instant, or `null` when the column is SQL `NULL`.
 */
export function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

/**
 * Normalise a `BOOLEAN` column to a real boolean.
 *
 * @param value - Column value as the driver returned it.
 * @returns `true` only for the boolean `true` or the string `'true'`.
 */
export function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Normalise an `INTEGER` column to a number.
 *
 * @param value - Column value as the driver returned it.
 * @returns The number, or `0` when the value is not numeric.
 */
export function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Normalise a required text column to a string.
 *
 * @param value - Column value as the driver returned it.
 * @returns The string value.
 */
export function toText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * Normalise a nullable text column.
 *
 * @param value - Column value as the driver returned it.
 * @returns The string value, or `null` when the column is SQL `NULL`.
 */
export function toTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toText(value);
}
