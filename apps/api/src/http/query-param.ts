/**
 * Reading one value out of a query bag.
 *
 * Both callers here read a query parameter in order to *compare* it — against a
 * provider digest or against a signature — so the narrowing has to be explicit
 * rather than whatever a cast produces. Express hands back a string, an array
 * when the parameter repeats, or undefined; a repeated parameter that collapsed
 * into `"a,b"` would be a value nobody signed.
 */

/** Read a non-empty trimmed string out of a query bag. */
export function queryString(query: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = query[name];
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : null;
  }
  // Express parses a repeated parameter into an array; the first value is the
  // only one a signature check may use, so a duplicate cannot smuggle a second.
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' && first.trim().length > 0 ? first.trim() : null;
  }
  return null;
}
