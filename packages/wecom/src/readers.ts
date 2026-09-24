/**
 * Boundary readers for a decoded provider JSON document.
 *
 * Every WeCom answer this package inspects — a `gettoken` reply, a `kf/send_msg`
 * reply — arrives as `{ errcode, errmsg, ... }` under provider control: a field
 * may be missing, of the wrong type, `null`, or a string where a number was
 * promised. Reading those fields through one narrow set of helpers is what keeps
 * a malformed answer from becoming an exception thrown out of a transport, and
 * keeps the three readers identical wherever an answer is parsed.
 *
 * Nothing here carries a value anywhere: each helper returns `null` for
 * "not readable", so a caller decides what an absent field means instead of
 * inheriting a coercion.
 */

/** Narrow an unknown JSON value to a non-array object. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Read a finite number field, or `null`. */
export function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a non-empty trimmed string field, or `null`. */
export function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
