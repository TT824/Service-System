/**
 * Row-to-domain value converters shared by the durable platform adapters.
 *
 * The durable adapters read raw `pg` rows and must hand the domain exactly the
 * value shapes the in-memory adapters produce: `TIMESTAMPTZ` columns come back
 * as `Date` objects (or `string`s, depending on the driver version), `BOOLEAN`
 * columns must be real booleans rather than driver strings, and `INTEGER`
 * columns must be numbers. Normalising in one place keeps the in-memory and
 * PostgreSQL adapters interchangeable, which is the whole point of the port.
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
 * Normalise a nullable `INTEGER` column.
 *
 * Distinct from {@link toNumber}, which answers `0` for a value it cannot read:
 * for a column where `NULL` is a fact — "this message has no stored media" —
 * an unreadable value must stay `null` rather than become a size of zero that
 * every reader would take at face value.
 *
 * @param value - Column value as the driver returned it.
 * @returns The number, or `null` when the column is SQL `NULL` or not numeric.
 */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/**
 * Normalise a JSON/JSONB column to a plain object.
 *
 * @param value - Column value as the driver returned it.
 * @returns The decoded object, or an empty object when the column is not one.
 */
export function toRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Normalise a `JSONB` array column to a string array.
 *
 * @param value - Column value as the driver returned it.
 * @returns The decoded string entries; non-string entries are dropped.
 */
export function toStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Normalise a `JSONB` array column to an array of plain objects.
 *
 * @param value - Column value as the driver returned it.
 * @returns The decoded object entries; non-object entries are dropped.
 */
export function toRecordArray(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}
