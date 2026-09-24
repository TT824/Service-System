/**
 * Application configuration parsing.
 *
 * Environment variables are parsed at the composition root into a typed,
 * immutable configuration value. Missing or invalid configuration is a
 * *value* (a tagged error), never a thrown exception, so bootstrap can print a
 * safe startup message and terminate. Secrets are wrapped in {@link Redacted}.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { Redacted } from './redacted';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const APP_ENVIRONMENTS = ['local', 'test', 'production'] as const;
const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
const AUTH_STORAGE_MODES = ['auto', 'memory', 'postgres'] as const;
const WECOM_TRANSPORT_SETTINGS = ['mock', 'real'] as const;

/** Application runtime boundary. */
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/** Node.js runtime boundary. */
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Structured log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Where durable authentication state is kept.
 *
 * `auto` follows the environment boundary: `test` uses the deterministic
 * in-memory adapter, `local` and `production` use PostgreSQL.
 */
export type AuthStorageMode = (typeof AUTH_STORAGE_MODES)[number];

/**
 * Which enterprise WeChat transport the environment asks the API to bind.
 *
 * `real` binds the WeChat Customer Service adapter, which holds no credential
 * of its own: every credential arrives through configuration, and the adapter
 * refuses to run when any of them is missing. `mock` remains available for
 * automated tests and deliberate local probes, but it is not the product
 * default.
 */
export type WecomTransportSetting = (typeof WECOM_TRANSPORT_SETTINGS)[number];

/** Parsed application configuration. */
export type AppConfig = {
  readonly appEnv: AppEnvironment;
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly workerHealthHost: string;
  readonly workerHealthPort: number;
  readonly healthTimeoutMs: number;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly databaseUrl: Redacted<string>;
  readonly redisUrl: Redacted<string>;
  /**
   * The key media URLs are signed with (`MEDIA_URL_SECRET`).
   *
   * A stored picture is served to an `<img>` tag, which cannot carry the
   * identity header the rest of the API requires, so the URL itself has to be
   * the authorization: a short-lived signature over the tenant, the message and
   * an expiry. That makes this key a capability — anyone holding it can mint a
   * URL for any tenant's media — which is why production must supply its own
   * rather than inherit the published local default.
   */
  readonly mediaUrlSecret: Redacted<string>;
  readonly objectStorage: {
    readonly endpoint: string;
    readonly port: number;
    readonly useSsl: boolean;
    readonly accessKey: Redacted<string>;
    readonly secretKey: Redacted<string>;
    readonly bucket: string;
  };
  /**
   * The embedding service the index sweep sends slice text to.
   *
   * An empty {@link AppConfig.embedding.baseUrl} or
   * {@link AppConfig.embedding.model} means **no embedding provider is bound**,
   * which is a supported state rather than a misconfiguration: the sweep gates on
   * it, claims nothing, and every slice stays `pending` until a model is
   * configured. Production is the exception — there both variables are required,
   * so a deployment that would silently index nothing fails to start instead.
   */
  readonly embedding: {
    /** Base URL of the embedding service (`EMBEDDING_BASE_URL`); empty means "not configured". */
    readonly baseUrl: string;
    /**
     * Model name (`EMBEDDING_MODEL`); empty means "not configured".
     *
     * This string is part of a vector row's address — `knowledge_chunk_embeddings`
     * is unique on `(tenant_id, chunk_id, embedding_model)` — so it is the name
     * the provider tells the truth about, not a label chosen for display.
     */
    readonly model: string;
    /** Hard deadline for one embedding request (`EMBEDDING_TIMEOUT_MS`). */
    readonly timeoutMs: number;
  };
  /**
   * The retrieval sidecar the fused candidates are reranked by.
   *
   * An empty {@link AppConfig.rerank.baseUrl} or
   * {@link AppConfig.rerank.model} means **no rerank provider is bound**, which
   * is a supported state: the read answers with the fused order, which is every
   * answer this system gave before the reranker existed. Unlike the embedding
   * pair, **neither variable is required in production** — the two absences look
   * nothing alike. A deployment with no embedding service indexes nothing and
   * says nothing, which is why those two are in
   * {@link PRODUCTION_REQUIRED_VARIABLES}; a deployment with no reranker returns
   * a worse-ordered but complete answer, which is a quality setting rather than
   * a failure. The line is the one the generation section draws below.
   */
  readonly rerank: {
    /** Base URL of the sidecar (`RERANK_BASE_URL`); empty means "not configured". */
    readonly baseUrl: string;
    /**
     * The model the caller believes is loaded (`RERANK_MODEL`); empty means "not
     * configured".
     *
     * A label rather than an address: nothing is stored under this name, and a
     * wrong value costs a refused request rather than a corrupted row. It is
     * sent with every call so that a sidecar running something else refuses to
     * answer — see `http-rerank-provider`.
     */
    readonly model: string;
    /** Hard deadline for one rerank request (`RERANK_TIMEOUT_MS`). */
    readonly timeoutMs: number;
  };
  /**
   * The generation service reply drafts are asked for.
   *
   * A blank {@link AppConfig.generation.apiKey} or
   * {@link AppConfig.generation.model} means **no generation provider is
   * bound**, which is a supported state rather than a misconfiguration: the
   * suggestion engine falls back to its deterministic candidates and records
   * the reason on the set, so a workbench shows an honest hint instead of an
   * empty panel. Unlike the embedding pair, these variables are **not** required
   * in production — a deployment that did not buy generation is a deployment
   * that still answers from its own knowledge.
   */
  readonly generation: {
    /** API key (`DEEPSEEK_API_KEY`); blank means "not configured". */
    readonly apiKey: Redacted<string>;
    /** Base URL of the API (`DEEPSEEK_BASE_URL`). */
    readonly baseUrl: string;
    /**
     * Model to ask (`DEEPSEEK_MODEL`).
     *
     * A label and not an address: `suggestion_sets.provider` records the
     * provider, so a wrong name here costs a misleading log line and a
     * `generation_model_not_found`, never a corrupted row.
     */
    readonly model: string;
    /** Hard deadline for one generation request (`DEEPSEEK_TIMEOUT_MS`). */
    readonly timeoutMs: number;
  };
  readonly wecom: {
    /** Whether the enterprise WeChat channel is enabled. Defaults to `false`. */
    readonly enabled: boolean;
    /** Which transport the environment asks for. Defaults to `real`. */
    readonly transport: WecomTransportSetting;
    readonly corpId: string;
    readonly agentId: string;
    readonly secret: Redacted<string>;
    readonly token: Redacted<string>;
    readonly aesKey: Redacted<string>;
    /**
     * WeChat **Customer Service** application secret (`WECOM_KF_SECRET`).
     *
     * Kept deliberately separate from {@link AppConfig.wecom.secret}: since
     * 2023-12-01 the customer-service API no longer accepts a self-built
     * application secret, so real mode must never fall back to `WECOM_SECRET`.
     * Empty means "not configured".
     */
    readonly kfSecret: Redacted<string>;
    /**
     * `open_kfid` of the customer-service account the callback belongs to
     * (`WECOM_OPEN_KFID`). Empty means "not configured".
     */
    readonly openKfId: string;
  };
  readonly auth: {
    /** Where durable authentication state is kept. */
    readonly storage: AuthStorageMode;
    /** Configured outbound OTP provider key; empty means "not configured". */
    readonly otpProvider: string;
    /** Configured OIDC provider key; empty means "not configured". */
    readonly oidcProvider: string;
    /** Issuer key local OIDC identities are namespaced under. */
    readonly oidcIssuer: string;
    /**
     * Whether the `x-member-id` / `x-tenant-id` demo identity headers are
     * accepted. They are always refused in production; outside production they
     * are accepted in `test` and in `local` only when this flag is set.
     */
    readonly demoIdentityHeaders: boolean;
    /**
     * Whether a code issued in local development may be echoed back to the
     * caller so the sign-in loop can be completed without a real SMS/e-mail
     * provider.
     *
     * Defaults to `false` and is only ever consulted when `APP_ENV=local`; the
     * HTTP boundary additionally requires the resolved provider to be the
     * deterministic local one. `test` and `production` never honour it, and no
     * other surface (log, error, persistence, admin response) exposes a code.
     */
    readonly developmentOtpVisible: boolean;
  };
};

/**
 * Configuration startup failure.
 *
 * The message contains only environment variable names and generic reasons,
 * never the raw values, so secrets cannot leak into startup logs.
 */
export class AppConfigError extends Error {
  readonly _tag = 'config_error' as const;

  /**
   * @param message - Safe human-readable description.
   * @param missingRequired - Names of required variables absent in production.
   */
  constructor(
    message: string,
    readonly missingRequired: ReadonlyArray<string> = [],
  ) {
    super(message);
    this.name = 'AppConfigError';
  }
}

/** Result of parsing application configuration. */
export type AppConfigResult =
  | { readonly _tag: 'ok'; readonly config: AppConfig }
  | { readonly _tag: 'err'; readonly error: AppConfigError };

/** Raw environment variable bag read from `process.env`. */
export type EnvVars = Record<string, string | undefined>;

/**
 * Default deadline for one embedding request.
 *
 * Five seconds rather than the one {@link AppConfig.healthTimeoutMs} allows: the
 * request goes to a model server that may have to load the model into memory
 * first, and a cold load was measured at 2.18s on this machine. A deadline under
 * that would fail the first attempt after every restart — which reads as a
 * provider outage while it is really a schedule that was chosen too tight.
 */
const DEFAULT_EMBEDDING_TIMEOUT_MS = 5_000;

/**
 * Default deadline for one rerank request.
 *
 * **Not sized to the worst case, and that is the decision.** A rerank is *N*
 * forward passes batched into one request, and *N* is bounded by
 * `KNOWLEDGE_RERANK_CANDIDATES`, so the cost depends entirely on how long a
 * slice is. Measured on this machine (2026-09-21, `bge-reranker-base` on CPU,
 * 20 candidates) against the real corpus: **0.43 s**. The chunker's declared
 * ceiling, `KNOWLEDGE_CHUNK_MAX_CHARS` = 500 characters, is a different story —
 * twenty of those pad every pair to the model's 512-token limit and take
 * **16.2 s**. Both are real numbers for real inputs, and a deadline that covered
 * the second would leave an agent waiting on a suggestion panel for sixteen
 * seconds.
 *
 * So this is sized to what an agent should wait instead. A batch that exceeds it
 * does not lose the read: the provider reports the deadline as an
 * `AbortError`, the service answers with the fused order, and that is the
 * complete answer every deployment gave before a reranker existed. **That
 * fallback is the whole reason the number can be chosen for the reader rather
 * than for the input** — the same property the generation deadline cannot
 * claim, because a generation timeout costs a draft while a rerank timeout costs
 * a reordering.
 *
 * A deployment whose knowledge is long-form prose rather than product
 * specifications should lower the candidate bound or the sidecar's
 * `RERANK_MAX_LENGTH`, and both are configuration rather than code.
 */
const DEFAULT_RERANK_TIMEOUT_MS = 5_000;

/**
 * Default deadline for one generation request.
 *
 * Four times the embedding deadline, from measurement rather than symmetry: the
 * live endpoint answered a three-entry prompt in 0.74 s on `deepseek-chat` and
 * took 8.7 s on `deepseek-v4-pro`, so a 5 s deadline would have failed the
 * slower model on a prompt that worked. An agent is waiting on this, which is
 * what caps it at 20 s rather than leaving it unbounded.
 */
const DEFAULT_GENERATION_TIMEOUT_MS = 20_000;

/** The base URL used when `DEEPSEEK_BASE_URL` is not set. */
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** The model asked when `DEEPSEEK_MODEL` is not set. */
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

const LOCAL_DATABASE_URL = 'postgres://kefu:kefu@127.0.0.1:5432/kefu';
const LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';
const LOCAL_OBJECT_STORAGE_ACCESS_KEY = 'minioadmin';
const LOCAL_OBJECT_STORAGE_SECRET_KEY = 'minioadmin';
const LOCAL_OBJECT_STORAGE_BUCKET = 'media';

/**
 * The signing key a local run mints media URLs with.
 *
 * A published value, like the local object-store credential above: it exists so
 * that `npm run dev` serves a customer's picture without anyone configuring
 * anything, and it is named in {@link PRODUCTION_REQUIRED_VARIABLES} so that a
 * real deployment cannot keep it. Anyone holding this string could mint a URL
 * for any tenant's stored media.
 */
const LOCAL_MEDIA_URL_SECRET = 'kefu-local-media-url-secret';

const envSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('local'),
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(1000),
  EMBEDDING_BASE_URL: z.string().default(''),
  EMBEDDING_MODEL: z.string().default(''),
  EMBEDDING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(DEFAULT_EMBEDDING_TIMEOUT_MS),
  RERANK_BASE_URL: z.string().default(''),
  RERANK_MODEL: z.string().default(''),
  RERANK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(DEFAULT_RERANK_TIMEOUT_MS),
  DEEPSEEK_API_KEY: z
    .string()
    .default('')
    .transform((value) => Redacted.of(value)),
  DEEPSEEK_BASE_URL: z.string().default(DEFAULT_DEEPSEEK_BASE_URL),
  DEEPSEEK_MODEL: z.string().default(DEFAULT_DEEPSEEK_MODEL),
  DEEPSEEK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(DEFAULT_GENERATION_TIMEOUT_MS),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(LOCAL_DATABASE_URL)
    .transform((value) => Redacted.of(value)),
  REDIS_URL: z
    .string()
    .min(1)
    .default(LOCAL_REDIS_URL)
    .transform((value) => Redacted.of(value)),
  OBJECT_STORAGE_ENDPOINT: z.string().min(1).default('127.0.0.1'),
  OBJECT_STORAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(9000),
  OBJECT_STORAGE_USE_SSL: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  OBJECT_STORAGE_ACCESS_KEY: z
    .string()
    .min(1)
    .default(LOCAL_OBJECT_STORAGE_ACCESS_KEY)
    .transform((value) => Redacted.of(value)),
  OBJECT_STORAGE_SECRET_KEY: z
    .string()
    .min(1)
    .default(LOCAL_OBJECT_STORAGE_SECRET_KEY)
    .transform((value) => Redacted.of(value)),
  OBJECT_STORAGE_BUCKET: z.string().min(1).default(LOCAL_OBJECT_STORAGE_BUCKET),
  MEDIA_URL_SECRET: z
    .string()
    .min(1)
    .default(LOCAL_MEDIA_URL_SECRET)
    .transform((value) => Redacted.of(value)),
  WECOM_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  WECOM_TRANSPORT: z.enum(WECOM_TRANSPORT_SETTINGS).default('real'),
  WECOM_CORP_ID: z.string().default(''),
  WECOM_AGENT_ID: z.string().default(''),
  WECOM_SECRET: z
    .string()
    .default('')
    .transform((value) => Redacted.of(value)),
  WECOM_KF_SECRET: z
    .string()
    .default('')
    .transform((value) => Redacted.of(value)),
  WECOM_OPEN_KFID: z.string().default(''),
  WECOM_TOKEN: z
    .string()
    .default('')
    .transform((value) => Redacted.of(value)),
  WECOM_AES_KEY: z
    .string()
    .default('')
    .transform((value) => Redacted.of(value)),
  AUTH_STORAGE: z.enum(AUTH_STORAGE_MODES).default('auto'),
  AUTH_OTP_PROVIDER: z.string().default(''),
  AUTH_OIDC_PROVIDER: z.string().default(''),
  AUTH_OIDC_ISSUER: z.string().default('local-oidc'),
  AUTH_DEMO_IDENTITY_HEADERS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  AUTH_DEVELOPMENT_OTP_VISIBLE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
});

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * Parse environment variables into application configuration.
 *
 * @param env - Raw environment variables (typically `process.env`).
 * @returns A tagged result: parsed config or a safe startup error.
 */
export function parseAppConfig(env: EnvVars): AppConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => formatIssue(issue)).join('; ');
    return { _tag: 'err', error: new AppConfigError(`invalid configuration: ${message}`) };
  }

  const missingRequired = productionMissingRequired(env, parsed.data);
  if (missingRequired.length > 0) {
    const names = missingRequired.join(', ');
    return {
      _tag: 'err',
      error: new AppConfigError(
        `missing required environment variables in production: ${names}`,
        missingRequired,
      ),
    };
  }

  return { _tag: 'ok', config: toConfig(parsed.data) };
}

const PRODUCTION_REQUIRED_VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_PORT',
  'OBJECT_STORAGE_USE_SSL',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
  'OBJECT_STORAGE_BUCKET',
  'MEDIA_URL_SECRET',
  'CORS_ORIGINS',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_MODEL',
] as const;

function productionMissingRequired(env: EnvVars, parsed: ParsedEnv): ReadonlyArray<string> {
  if (parsed.APP_ENV !== 'production') {
    return [];
  }
  const missing: string[] = [];
  for (const name of PRODUCTION_REQUIRED_VARIABLES) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      missing.push(name);
    }
  }
  return missing;
}

function formatIssue(issue: {
  readonly code: string;
  readonly path: ReadonlyArray<PropertyKey>;
}): string {
  const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  return `${key}: ${describeIssueCode(issue.code)}`;
}

function describeIssueCode(code: string): string {
  switch (code) {
    case 'invalid_type':
      return 'has the wrong type or is missing';
    case 'invalid_enum_value':
      return 'is not an allowed value';
    case 'invalid_string':
      return 'has an invalid string format';
    case 'too_small':
      return 'is too short or too small';
    case 'too_big':
      return 'is too long or too large';
    default:
      return 'is invalid';
  }
}

function toConfig(parsed: ParsedEnv): AppConfig {
  const corsOrigins = parsed.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const config: AppConfig = {
    appEnv: parsed.APP_ENV,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    workerHealthHost: parsed.WORKER_HEALTH_HOST,
    workerHealthPort: parsed.WORKER_HEALTH_PORT,
    healthTimeoutMs: parsed.HEALTH_TIMEOUT_MS,
    corsOrigins,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    mediaUrlSecret: parsed.MEDIA_URL_SECRET,
    objectStorage: {
      endpoint: parsed.OBJECT_STORAGE_ENDPOINT,
      port: parsed.OBJECT_STORAGE_PORT,
      useSsl: parsed.OBJECT_STORAGE_USE_SSL,
      accessKey: parsed.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: parsed.OBJECT_STORAGE_SECRET_KEY,
      bucket: parsed.OBJECT_STORAGE_BUCKET,
    },
    embedding: {
      baseUrl: parsed.EMBEDDING_BASE_URL,
      model: parsed.EMBEDDING_MODEL,
      timeoutMs: parsed.EMBEDDING_TIMEOUT_MS,
    },
    rerank: {
      baseUrl: parsed.RERANK_BASE_URL,
      model: parsed.RERANK_MODEL,
      timeoutMs: parsed.RERANK_TIMEOUT_MS,
    },
    generation: {
      apiKey: parsed.DEEPSEEK_API_KEY,
      baseUrl: parsed.DEEPSEEK_BASE_URL,
      model: parsed.DEEPSEEK_MODEL,
      timeoutMs: parsed.DEEPSEEK_TIMEOUT_MS,
    },
    wecom: {
      enabled: parsed.WECOM_ENABLED,
      transport: parsed.WECOM_TRANSPORT,
      corpId: parsed.WECOM_CORP_ID,
      agentId: parsed.WECOM_AGENT_ID,
      secret: parsed.WECOM_SECRET,
      token: parsed.WECOM_TOKEN,
      aesKey: parsed.WECOM_AES_KEY,
      kfSecret: parsed.WECOM_KF_SECRET,
      openKfId: parsed.WECOM_OPEN_KFID,
    },
    auth: {
      storage: parsed.AUTH_STORAGE,
      otpProvider: parsed.AUTH_OTP_PROVIDER,
      oidcProvider: parsed.AUTH_OIDC_PROVIDER,
      oidcIssuer: parsed.AUTH_OIDC_ISSUER,
      demoIdentityHeaders: parsed.AUTH_DEMO_IDENTITY_HEADERS,
      developmentOtpVisible: parsed.AUTH_DEVELOPMENT_OTP_VISIBLE,
    },
  };
  return Object.freeze({
    ...config,
    corsOrigins: Object.freeze(corsOrigins),
    objectStorage: Object.freeze(config.objectStorage),
    embedding: Object.freeze(config.embedding),
    rerank: Object.freeze(config.rerank),
    generation: Object.freeze(config.generation),
    wecom: Object.freeze(config.wecom),
    auth: Object.freeze(config.auth),
  });
}

/**
 * Whether demo identity headers may be honoured for this configuration.
 *
 * `x-member-id`/`x-tenant-id` are a development stand-in for a verified
 * credential: they are never accepted in production, always accepted in
 * `test`, and accepted in `local` only when the demo flag was set explicitly.
 *
 * @param config - Parsed application configuration.
 * @returns `true` when the header identity path is permitted.
 */
export function allowsDemoIdentityHeaders(config: AppConfig): boolean {
  if (config.appEnv === 'production') {
    return false;
  }
  if (config.appEnv === 'test') {
    return true;
  }
  return config.auth.demoIdentityHeaders;
}

/**
 * Environment variables the real WeChat Customer Service transport requires.
 *
 * The list names variables only. It is what lets a status surface say exactly
 * what is missing without ever reading out, comparing or echoing a value.
 */
export const WECOM_REAL_REQUIRED_VARIABLES = [
  'WECOM_CORP_ID',
  'WECOM_KF_SECRET',
  'WECOM_TOKEN',
  'WECOM_AES_KEY',
  'WECOM_OPEN_KFID',
] as const;

/**
 * The five values a real customer-service connection needs, as plain text.
 *
 * This is the **typed** shape: what an operator enters on the channel page and
 * what the platform stores, as opposed to {@link AppConfig}'s `wecom` slice,
 * which is the boot-time environment reading with its secrets wrapped in
 * `Redacted` and a transport switch beside them. {@link wecomValuesOf} is the
 * one conversion between the two.
 */
export type WecomCredentialValues = {
  readonly corpId: string;
  readonly kfSecret: string;
  readonly callbackToken: string;
  readonly aesKey: string;
  readonly openKfId: string;
};

/**
 * The one length the WeCom console issues for an `EncodingAESKey`.
 *
 * Mirrored by the console's own form (`apps/web/src/views/wecom-config-form`)
 * because the web client does not import this package; a change here has to be
 * made there too, which is what that file's constant says.
 */
export const WECOM_AES_KEY_LENGTH = 43;

/** Why one typed value is not usable. A code, not a sentence — 文案在各端。 */
export type WecomCredentialProblemCode = 'missing' | 'wrong_length';

/** One unusable field of a typed credential set. */
export type WecomCredentialProblem = {
  /** The variable naming the field, which is also how both surfaces label it. */
  readonly variable: string;
  readonly code: WecomCredentialProblemCode;
  /** Observed length, present only on `wrong_length` — never a value or a fragment. */
  readonly observedLength?: number;
};

/**
 * The problems with one typed credential set, as data.
 *
 * The *rules* live here and only here, because three surfaces have to agree
 * about what a usable set is: the channel page's own form, the write route that
 * accepts what it posted, and the status the boot reports. The way they disagree
 * is silently — a form that accepts a 41-character key and a route that refuses
 * it reads as "the server is broken", and the operator has no way to see which
 * of the two is lying.
 *
 * What is *not* here is prose: a problem is a code plus the variable it names,
 * and each surface renders its own sentence (the console's are Chinese; this
 * package speaks codes, like every other refusal it returns).
 *
 * @param values - What an operator typed, or what configuration resolved to.
 * @returns One problem per unusable field, in {@link WECOM_REAL_REQUIRED_VARIABLES} order.
 */
export function wecomCredentialProblems(
  values: WecomCredentialValues,
): ReadonlyArray<WecomCredentialProblem> {
  const typed: Readonly<Record<string, string>> = {
    WECOM_CORP_ID: values.corpId,
    WECOM_KF_SECRET: values.kfSecret,
    WECOM_TOKEN: values.callbackToken,
    WECOM_AES_KEY: values.aesKey,
    WECOM_OPEN_KFID: values.openKfId,
  };

  const problems: WecomCredentialProblem[] = [];
  for (const variable of WECOM_REAL_REQUIRED_VARIABLES) {
    if ((typed[variable] ?? '').trim().length === 0) {
      problems.push({ variable, code: 'missing' });
    }
  }

  const aesKey = values.aesKey.trim();
  if (aesKey.length > 0 && aesKey.length !== WECOM_AES_KEY_LENGTH) {
    problems.push({
      variable: 'WECOM_AES_KEY',
      code: 'wrong_length',
      observedLength: aesKey.length,
    });
  }

  return problems;
}

/**
 * The typed shape of the boot-time environment slice.
 *
 * The one place `Redacted` values are unwrapped for a rule that only trims
 * them; nothing here returns, logs or echoes what it read.
 *
 * @param credentials - The parsed `wecom` configuration slice.
 * @returns The same five values as plain text.
 */
export function wecomValuesOf(credentials: AppConfig['wecom']): WecomCredentialValues {
  return {
    corpId: credentials.corpId,
    kfSecret: credentials.kfSecret.unwrap(),
    callbackToken: credentials.token.unwrap(),
    aesKey: credentials.aesKey.unwrap(),
    openKfId: credentials.openKfId,
  };
}

/**
 * Which of the real-mode credential variables are absent.
 *
 * `WECOM_AGENT_ID` and `WECOM_SECRET` are deliberately *not* consulted: they
 * describe a self-built application, and the customer-service API stopped
 * accepting an application secret, so neither may stand in for
 * `WECOM_KF_SECRET`.
 *
 * Answered through {@link wecomCredentialProblems} rather than by a second
 * reading of the same four conditions: a stored credential set and an
 * environment one are the same five values, and "what is missing" must not
 * depend on which of the two a deployment happens to use.
 *
 * @param credentials - The parsed `wecom` configuration slice.
 * @returns Names of the missing variables, in declaration order.
 */
export function wecomRealMissingVariables(credentials: AppConfig['wecom']): ReadonlyArray<string> {
  return wecomCredentialProblems(wecomValuesOf(credentials))
    .filter((problem) => problem.code === 'missing')
    .map((problem) => problem.variable);
}

/** Which of the two credential sets a deployment is authenticating with. */
export type WecomCredentialOrigin = 'console' | 'environment';

/**
 * What the transports should authenticate with, decided in one place.
 *
 * `ready` carries the five values a request needs; `unconfigured` carries what
 * is wrong with them, as codes naming variables — never a value. There is no
 * third case and no "sort of usable": a transport that authenticates with an
 * empty secret produces a provider error where the operator needed to be told
 * which field to fill in.
 */
export type WecomCredentialResolution =
  | {
      readonly _tag: 'ready';
      readonly values: WecomCredentialValues;
      readonly origin: WecomCredentialOrigin;
    }
  | {
      readonly _tag: 'unconfigured';
      /**
       * Which set was examined and found unusable.
       *
       * Carried because it says what to go and fix: a problem in the stored set
       * is the console form, a problem in the environment is the deployment's
       * `.env`. Without it an operator is told a field is missing and left to
       * guess which of the two places holds the set that has it missing.
       */
      readonly origin: WecomCredentialOrigin;
      readonly problems: ReadonlyArray<WecomCredentialProblem>;
    };

/**
 * Decide which credential set a deployment authenticates with.
 *
 * The console wins whenever it holds a set at all — complete or not. That is the
 * whole point of the console being able to store one: an operator who typed five
 * fields and clicked 连接 has said which company this deployment is; a half-typed
 * intention that silently fell back to `.env` would connect under an identity
 * nobody chose, and would report success for it. Falling back is for a
 * deployment that never stored anything, which is every deployment until someone
 * uses the form.
 *
 * So a stored set is reported as `unconfigured` rather than ignored when a field
 * is empty or the AES key is the wrong length. Nothing reaches here that the
 * console's own write route would have refused, so that branch is about a set
 * that was usable when written and is not any more — a binding whose `corp_id`
 * or `open_kfid` was cleared by hand, say. A state that has to be said out loud
 * is exactly the state this function exists to say.
 *
 * @param input.stored - The set the console holds, or `undefined` when it holds none.
 * @param input.environment - The parsed `wecom` configuration slice, the fallback.
 * @returns The values to authenticate with, or the problems that stop it.
 */
export function resolveWecomCredentials(input: {
  readonly stored: WecomCredentialValues | undefined;
  readonly environment: AppConfig['wecom'];
}): WecomCredentialResolution {
  const chosen =
    input.stored === undefined
      ? { values: wecomValuesOf(input.environment), origin: 'environment' as const }
      : { values: input.stored, origin: 'console' as const };
  const problems = wecomCredentialProblems(chosen.values);
  return problems.length === 0
    ? { _tag: 'ready', values: chosen.values, origin: chosen.origin }
    : { _tag: 'unconfigured', origin: chosen.origin, problems };
}

/**
 * The variable names an unconfigured resolution still needs.
 *
 * The projection every refusal message and status surface is allowed to say out
 * loud: names, never values.
 *
 * @param problems - Problems reported by {@link wecomCredentialProblems}.
 * @returns The variables, in declaration order, one per problem.
 */
export function wecomProblemVariables(
  problems: ReadonlyArray<WecomCredentialProblem>,
): ReadonlyArray<string> {
  return problems.map((problem) => problem.variable);
}

/**
 * Directories between a compiled entrypoint and the repository root.
 *
 * A compiled application runs from `apps/<app>/dist`, so the root is
 * `<entrypoint>/../../..`: `dist` -> `apps/<app>` -> `apps` -> root.
 */
const COMPILED_ENTRYPOINT_TO_ROOT_SEGMENTS = ['..', '..', '..'] as const;

/**
 * Resolve the shared repository `.env` from a compiled application entrypoint.
 *
 * The repository keeps exactly one environment file, at its root; there is no
 * per-application `.env`. Both applications are compiled to `apps/<app>/dist`,
 * so the file lives three directories above the entrypoint. Resolving it here
 * rather than with a hand-written relative literal in each `main.ts` keeps the
 * two bootstrap files from drifting apart and makes the mapping testable: from
 * `apps/api/dist` this yields `<root>/.env`, never `apps/.env`.
 *
 * @param entrypointDir - `__dirname` of the compiled entrypoint.
 * @returns Absolute path of the repository root `.env`.
 */
export function resolveRepositoryEnvPath(entrypointDir: string): string {
  return path.resolve(entrypointDir, ...COMPILED_ENTRYPOINT_TO_ROOT_SEGMENTS, '.env');
}
