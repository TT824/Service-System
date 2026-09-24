import { BadRequestException } from '@nestjs/common';

/**
 * Small, dependency-free request-body validation helpers.
 *
 * The kernel avoids a validation library in the MVP; these helpers project an
 * untrusted JSON body into plain typed values and reject malformed input with
 * the stable `bad_request` error envelope.
 */

/** Read the body as a plain JSON object. */
export function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Read a required non-empty string field. */
export function bodyRequiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Read an optional string field. */
export function bodyOptionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return value;
}

/** Read an optional boolean field. */
export function bodyOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }
  return value;
}

/** Read an optional positive integer field. */
export function bodyOptionalPositiveInt(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  return value;
}

/** Read an optional positive integer that must be present. */
export function bodyRequiredPositiveInt(body: Record<string, unknown>, field: string): number {
  const value = bodyOptionalPositiveInt(body, field);
  if (value === undefined) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Read an optional count: a whole number of rows, zero included.
 *
 * Separate from {@link bodyOptionalPositiveInt} because `0` is a real answer
 * here — an import that failed on its first row has zero successes — while a row
 * number of `0` is not a row.
 */
export function bodyOptionalCount(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return value;
}

/** Read an optional array of strings. */
export function bodyOptionalStringArray(
  body: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestException(`${field} must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
}

/**
 * Read a string field that may be explicitly cleared.
 *
 * Unlike {@link bodyOptionalString}, an explicit `null` comes back as `null`
 * rather than as "field absent". The two mean different things wherever a column
 * is nullable: `{"subtitle": null}` clears the subtitle, while omitting the key
 * leaves it as it was.
 *
 * @param body - The parsed request body.
 * @param field - Field name to read.
 * @returns The string, `null` when explicitly cleared, or `undefined` when absent.
 */
export function bodyNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string or null`);
  }
  return value;
}

/**
 * Read a required field constrained to a fixed vocabulary.
 *
 * @param body - The parsed request body.
 * @param field - Field name to read.
 * @param allowed - The accepted values, in the order the domain declares them.
 * @returns The matched value.
 * @throws {BadRequestException} When the field is missing or outside the list.
 */
export function bodyRequiredEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
): T {
  const value = body[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Read an optional field constrained to a fixed vocabulary.
 *
 * @param body - The parsed request body.
 * @param field - Field name to read.
 * @param allowed - The accepted values, in the order the domain declares them.
 * @returns The matched value, or `undefined` when absent.
 * @throws {BadRequestException} When the field is present but outside the list.
 */
export function bodyOptionalEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: ReadonlyArray<T>,
): T | undefined {
  if (body[field] === undefined || body[field] === null) {
    return undefined;
  }
  return bodyRequiredEnum(body, field, allowed);
}

/**
 * Read an optional object of scalar values, as the catalogue's attribute maps
 * are shaped.
 *
 * @param body - The parsed request body.
 * @param field - Field name to read.
 * @returns The object as a read-only map, or `undefined` when absent.
 * @throws {BadRequestException} When the field is not a flat scalar map.
 */
export function bodyOptionalScalarRecord(
  body: Record<string, unknown>,
  field: string,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    const kind = typeof entry;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new BadRequestException(`${field}.${key} must be a string, number or boolean`);
    }
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string | number | boolean>>;
}

/**
 * Read an optional object of string values — a variant dimension map.
 *
 * @param body - The parsed request body.
 * @param field - Field name to read.
 * @returns The object as a read-only string map, or `undefined` when absent.
 * @throws {BadRequestException} When the field is not a flat string map.
 */
export function bodyOptionalStringRecord(
  body: Record<string, unknown>,
  field: string,
): Readonly<Record<string, string>> | undefined {
  const record = bodyOptionalScalarRecord(body, field);
  if (record === undefined) {
    return undefined;
  }
  const entries = Object.entries(record);
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') {
      throw new BadRequestException(`${field}.${key} must be a string`);
    }
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}
