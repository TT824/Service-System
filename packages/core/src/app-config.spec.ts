import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppConfigError,
  WECOM_AES_KEY_LENGTH,
  parseAppConfig,
  resolveRepositoryEnvPath,
  resolveWecomCredentials,
  wecomCredentialProblems,
  wecomProblemVariables,
  wecomRealMissingVariables,
  wecomValuesOf,
  type WecomCredentialValues,
} from './app-config';
import { Redacted } from './redacted';

describe('parseAppConfig', () => {
  it('parses a minimal local environment using documented defaults', () => {
    const result = parseAppConfig({});
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.appEnv).toBe('local');
    expect(result.config.apiPort).toBe(3000);
    expect(result.config.databaseUrl.unwrap()).toBe('postgres://kefu:kefu@127.0.0.1:5432/kefu');
    expect(result.config.objectStorage.bucket).toBe('media');
    expect(result.config.objectStorage.secretKey.toJSON()).toBe('[Redacted]');
    expect(result.config.wecom.enabled).toBe(false);
    expect(result.config.wecom.corpId).toBe('');
    expect(result.config.wecom.secret.unwrap()).toBe('');
    // No embedding model is configured here, and the empty pair is how the
    // Worker is told so; see the case below on what that means downstream.
    expect(result.config.embedding.baseUrl).toBe('');
    expect(result.config.embedding.model).toBe('');
    expect(result.config.embedding.timeoutMs).toBe(5_000);
  });

  it('keeps an unconfigured embedding service as an empty pair rather than a default endpoint', () => {
    // The failure this rules out is a *plausible* default — `127.0.0.1:11434`
    // is where this machine's model server happens to listen, and a default
    // pointing at it would make every deployment that never configured a model
    // quietly talk to whatever is on that port. Empty is a decision; a URL is a
    // claim about a service the operator has not named.
    const result = parseAppConfig({ EMBEDDING_BASE_URL: '  ', EMBEDDING_MODEL: '  ' });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.embedding.baseUrl.trim()).toBe('');
    expect(result.config.embedding.model.trim()).toBe('');
  });

  it('parses a configured embedding service verbatim, model name included', () => {
    const result = parseAppConfig({
      EMBEDDING_BASE_URL: 'http://127.0.0.1:11434',
      EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
      EMBEDDING_TIMEOUT_MS: '9000',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.embedding.baseUrl).toBe('http://127.0.0.1:11434');
    // Verbatim: the tag is part of the name the model server reports back, and
    // it addresses the vector rows, so nothing here trims or normalises it.
    expect(result.config.embedding.model).toBe('qwen3-embedding:0.6b');
    expect(result.config.embedding.timeoutMs).toBe(9_000);
  });

  it('refuses an embedding deadline that is not a positive whole number of milliseconds', () => {
    for (const value of ['0', '-1', '1.5', 'soon']) {
      const result = parseAppConfig({ EMBEDDING_TIMEOUT_MS: value });
      expect(result._tag, `EMBEDDING_TIMEOUT_MS=${value}`).toBe('err');
    }
  });

  it('keeps an unconfigured reranker as an empty pair rather than a default endpoint', () => {
    // The same failure the embedding pair rules out, one port along: 8000 is
    // where this sidecar happens to listen, and a default pointing at it would
    // make every deployment that never started a reranker quietly send it a
    // buyer's question. Empty is a decision; a URL is a claim.
    const result = parseAppConfig({ RERANK_BASE_URL: '  ', RERANK_MODEL: '  ' });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.rerank.baseUrl.trim()).toBe('');
    expect(result.config.rerank.model.trim()).toBe('');
  });

  it('parses a configured reranker verbatim and defaults its deadline', () => {
    const result = parseAppConfig({
      RERANK_BASE_URL: 'http://127.0.0.1:8000',
      RERANK_MODEL: 'bge-reranker-base',
      RERANK_TIMEOUT_MS: '12000',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.rerank.baseUrl).toBe('http://127.0.0.1:8000');
    expect(result.config.rerank.model).toBe('bge-reranker-base');
    expect(result.config.rerank.timeoutMs).toBe(12_000);

    const bare = parseAppConfig({});
    expect(bare._tag).toBe('ok');
    if (bare._tag !== 'ok') {
      return;
    }
    // Only that a usable deadline is there by default. What the number *is* —
    // and it is deliberately not the worst case the chunker permits — is argued
    // at `DEFAULT_RERANK_TIMEOUT_MS`, not here: pinning it in a parse test would
    // make the policy look like a parsing rule.
    expect(Number.isInteger(bare.config.rerank.timeoutMs)).toBe(true);
    expect(bare.config.rerank.timeoutMs).toBeGreaterThan(0);
  });

  it('refuses a rerank deadline that is not a positive whole number of milliseconds', () => {
    for (const value of ['0', '-1', '1.5', 'soon']) {
      const result = parseAppConfig({ RERANK_TIMEOUT_MS: value });
      expect(result._tag, `RERANK_TIMEOUT_MS=${value}`).toBe('err');
    }
  });

  it('never asks production for a reranker', () => {
    // The two absences are not alike, which is why this is asserted rather than
    // left to the required list. A deployment with no embedding service indexes
    // nothing and says nothing, so EMBEDDING_BASE_URL is required. A deployment
    // with no reranker answers with the fused order — every answer this system
    // gave before the reranker existed. Requiring the pair would turn a quality
    // setting into a startup failure.
    const result = parseAppConfig({
      APP_ENV: 'production',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example.internal:5432/kefu',
      REDIS_URL: 'redis://redis.example.internal:6379',
      OBJECT_STORAGE_ENDPOINT: 'minio.example.internal',
      OBJECT_STORAGE_PORT: '9000',
      OBJECT_STORAGE_USE_SSL: 'true',
      OBJECT_STORAGE_ACCESS_KEY: 'prod-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'prod-secret-key',
      OBJECT_STORAGE_BUCKET: 'media',
      CORS_ORIGINS: 'https://console.example.com',
      EMBEDDING_BASE_URL: 'http://embedding.example.internal:11434',
      EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
      MEDIA_URL_SECRET: 'prod-media-url-secret',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.rerank.baseUrl.trim()).toBe('');
    expect(result.config.rerank.model.trim()).toBe('');
  });

  it('defaults the generation service to DeepSeek with no key bound', () => {
    const result = parseAppConfig({});
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    // No key is a decision rather than a gap — the same reading the embedding
    // pair gets — and it is what leaves the deterministic engine answering.
    expect(result.config.generation.apiKey.unwrap()).toBe('');
    expect(result.config.generation.apiKey.toJSON()).toBe('[Redacted]');
    // Unlike the embedding service, this one *does* carry a default endpoint:
    // the base URL names a public API rather than a port on whatever machine
    // happens to be running, so a default cannot silently talk to a stranger.
    expect(result.config.generation.baseUrl).toBe('https://api.deepseek.com');
    expect(result.config.generation.model).toBe('deepseek-chat');
    expect(result.config.generation.timeoutMs).toBe(20_000);
  });

  it('parses a configured generation key verbatim and keeps it out of serialization', () => {
    const result = parseAppConfig({
      DEEPSEEK_API_KEY: 'sk-live-abc',
      DEEPSEEK_BASE_URL: 'https://api.example.internal',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_TIMEOUT_MS: '9000',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.generation.apiKey.unwrap()).toBe('sk-live-abc');
    expect(result.config.generation.apiKey.toJSON()).toBe('[Redacted]');
    expect(JSON.stringify(result.config.generation)).not.toContain('sk-live-abc');
    expect(result.config.generation.baseUrl).toBe('https://api.example.internal');
    expect(result.config.generation.model).toBe('deepseek-v4-pro');
    expect(result.config.generation.timeoutMs).toBe(9_000);
  });

  it('refuses a generation deadline that is not a positive whole number of milliseconds', () => {
    for (const value of ['0', '-1', '1.5', 'soon']) {
      const result = parseAppConfig({ DEEPSEEK_TIMEOUT_MS: value });
      expect(result._tag, `DEEPSEEK_TIMEOUT_MS=${value}`).toBe('err');
    }
  });

  it('never asks production for a generation key', () => {
    // The deliberate opposite of the embedding pair. A deployment that did not
    // buy generation still answers from its own knowledge; refusing to boot over
    // a missing key would take down a working service to report a feature nobody
    // configured, and the set's own fallback reasons already say so.
    const result = parseAppConfig({ APP_ENV: 'production' });
    expect(result._tag).toBe('err');
    if (result._tag !== 'err') {
      return;
    }
    expect(result.error.missingRequired).not.toContain('DEEPSEEK_API_KEY');
    expect(result.error.missingRequired).not.toContain('DEEPSEEK_MODEL');
    expect(result.error.missingRequired).not.toContain('DEEPSEEK_BASE_URL');
  });

  it('parses WECOM_ENABLED as a typed boolean and tolerates missing credentials', () => {
    const result = parseAppConfig({
      APP_ENV: 'test',
      WECOM_ENABLED: 'true',
      WECOM_CORP_ID: 'ww-demo-corp',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.wecom.enabled).toBe(true);
    expect(result.config.wecom.corpId).toBe('ww-demo-corp');
    // Missing credentials never fail local/test startup even when enabled.
    expect(result.config.wecom.agentId).toBe('');
    expect(result.config.wecom.secret.unwrap()).toBe('');
  });

  it('defaults the WeCom transport to real and keeps the customer-service fields separate', () => {
    const defaults = parseAppConfig({ APP_ENV: 'test' });
    expect(defaults._tag).toBe('ok');
    if (defaults._tag !== 'ok') {
      return;
    }
    expect(defaults.config.wecom.transport).toBe('real');
    expect(defaults.config.wecom.kfSecret.unwrap()).toBe('');
    expect(defaults.config.wecom.kfSecret.toJSON()).toBe('[Redacted]');
    expect(defaults.config.wecom.openKfId).toBe('');

    // The customer-service secret and account id are their own variables: an
    // application secret must never land in the customer-service slot, and the
    // old field parsing keeps working unchanged.
    const explicit = parseAppConfig({
      APP_ENV: 'test',
      WECOM_TRANSPORT: 'real',
      WECOM_SECRET: 'ww-demo-app-secret',
      WECOM_KF_SECRET: 'ww-demo-kf-secret',
      WECOM_OPEN_KFID: 'wk-demo-1',
    });
    expect(explicit._tag).toBe('ok');
    if (explicit._tag !== 'ok') {
      return;
    }
    expect(explicit.config.wecom.transport).toBe('real');
    expect(explicit.config.wecom.secret.unwrap()).toBe('ww-demo-app-secret');
    expect(explicit.config.wecom.kfSecret.unwrap()).toBe('ww-demo-kf-secret');
    expect(explicit.config.wecom.openKfId).toBe('wk-demo-1');
  });

  it('rejects an unknown WECOM_TRANSPORT rather than silently falling back', () => {
    const result = parseAppConfig({ APP_ENV: 'test', WECOM_TRANSPORT: 'real-ish' });
    expect(result._tag).toBe('err');
  });

  it('names every variable a real customer-service transport still needs', () => {
    const result = parseAppConfig({
      APP_ENV: 'test',
      WECOM_TRANSPORT: 'real',
      WECOM_CORP_ID: 'ww-demo-corp',
      WECOM_SECRET: 'ww-demo-app-secret',
      WECOM_AGENT_ID: '1000002',
      WECOM_TOKEN: 'demo-token',
      WECOM_AES_KEY: 'demo-aes-key',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    // The application secret and agent id are deliberately not consulted, so
    // they cannot satisfy the customer-service requirement.
    expect(wecomRealMissingVariables(result.config.wecom)).toEqual([
      'WECOM_KF_SECRET',
      'WECOM_OPEN_KFID',
    ]);
    expect(
      wecomRealMissingVariables({ ...result.config.wecom, kfSecret: Redacted.of('x') }),
    ).toEqual(['WECOM_OPEN_KFID']);
  });

  it('defaults the development OTP flag to false and parses an explicit true', () => {
    const defaults = parseAppConfig({});
    expect(defaults._tag).toBe('ok');
    if (defaults._tag !== 'ok') {
      return;
    }
    expect(defaults.config.auth.developmentOtpVisible).toBe(false);

    const explicit = parseAppConfig({ AUTH_DEVELOPMENT_OTP_VISIBLE: 'true' });
    expect(explicit._tag).toBe('ok');
    if (explicit._tag !== 'ok') {
      return;
    }
    expect(explicit.config.auth.developmentOtpVisible).toBe(true);

    // Anything other than the exact string `true` stays false: the flag is a
    // deliberate opt-in, never an accidental truthy value.
    const typo = parseAppConfig({ AUTH_DEVELOPMENT_OTP_VISIBLE: 'TRUE' });
    expect(typo._tag).toBe('ok');
    if (typo._tag !== 'ok') {
      return;
    }
    expect(typo.config.auth.developmentOtpVisible).toBe(false);
  });

  it('rejects an unknown APP_ENV value', () => {
    const result = parseAppConfig({ APP_ENV: 'staging' });
    expect(result._tag).toBe('err');
    if (result._tag !== 'err') {
      return;
    }
    expect(result.error).toBeInstanceOf(AppConfigError);
    expect(result.error.message).toContain('APP_ENV');
    expect(result.error.message).not.toContain('staging-secret');
  });

  it('fails fast in production when required secrets are missing', () => {
    const result = parseAppConfig({ APP_ENV: 'production' });
    expect(result._tag).toBe('err');
    if (result._tag !== 'err') {
      return;
    }
    expect(result.error.missingRequired).toContain('DATABASE_URL');
    expect(result.error.missingRequired).toContain('OBJECT_STORAGE_SECRET_KEY');
    // An embedding service is required wherever it matters: a production
    // deployment with no model runs the sweep, claims nothing and leaves every
    // slice `pending` for ever, which is indistinguishable from a healthy idle
    // index. Failing to start is the only version of that an operator can see.
    expect(result.error.missingRequired).toContain('EMBEDDING_BASE_URL');
    expect(result.error.missingRequired).toContain('EMBEDDING_MODEL');
    // The media URL key is a capability: whoever holds it can mint a read URL
    // for any tenant's stored picture, so a production deployment that silently
    // inherited the published local default would be one secret away from any
    // other deployment's media.
    expect(result.error.missingRequired).toContain('MEDIA_URL_SECRET');
    expect(result.error.message).not.toContain('://');
  });

  it('accepts a complete production environment', () => {
    const result = parseAppConfig({
      APP_ENV: 'production',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.example.internal:5432/kefu',
      REDIS_URL: 'redis://redis.example.internal:6379',
      OBJECT_STORAGE_ENDPOINT: 'minio.example.internal',
      OBJECT_STORAGE_PORT: '9000',
      OBJECT_STORAGE_USE_SSL: 'true',
      OBJECT_STORAGE_ACCESS_KEY: 'prod-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'prod-secret-key',
      OBJECT_STORAGE_BUCKET: 'media',
      CORS_ORIGINS: 'https://console.example.com',
      EMBEDDING_BASE_URL: 'http://embedding.example.internal:11434',
      EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
      MEDIA_URL_SECRET: 'prod-media-url-secret',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    expect(result.config.appEnv).toBe('production');
    expect(result.config.nodeEnv).toBe('production');
    expect(result.config.objectStorage.useSsl).toBe(true);
    expect(result.config.corsOrigins).toEqual(['https://console.example.com']);
    expect(result.config.embedding.model).toBe('qwen3-embedding:0.6b');
    // Wrapped like every other credential, so a config dump or an error message
    // can never carry the value itself.
    expect(result.config.mediaUrlSecret.unwrap()).toBe('prod-media-url-secret');
    expect(JSON.stringify(result.config)).not.toContain('prod-media-url-secret');
    expect(result.config.databaseUrl.unwrap()).toBe(
      'postgres://user:pass@db.example.internal:5432/kefu',
    );
  });
});

describe('resolveRepositoryEnvPath', () => {
  /** Repository root of a synthetic checkout using the real layout. */
  const repoRoot = path.resolve(path.sep, 'srv', 'kefu-saas');

  it.each(['api', 'worker'])(
    'resolves the root .env, never apps/.env, from apps/%s/dist',
    (app) => {
      const entrypointDir = path.join(repoRoot, 'apps', app, 'dist');

      const resolved = resolveRepositoryEnvPath(entrypointDir);

      expect(resolved).toBe(path.join(repoRoot, '.env'));
      // The regression this guards: one `..` too few lands on `apps/.env`,
      // which does not exist, so the application would silently start with
      // default configuration instead of the shared one.
      expect(resolved).not.toBe(path.join(repoRoot, 'apps', '.env'));
      expect(path.dirname(path.dirname(path.dirname(entrypointDir)))).toBe(repoRoot);
    },
  );
});

describe('wecomCredentialProblems', () => {
  /** 控制台发的是固定 43 位；其他长度不是这一份 key。 */
  const AES_KEY = 'k'.repeat(WECOM_AES_KEY_LENGTH);

  function complete(overrides: Partial<WecomCredentialValues> = {}): WecomCredentialValues {
    return {
      corpId: 'ww-demo-corp',
      kfSecret: 'kf-demo-secret',
      callbackToken: 'demo-token',
      aesKey: AES_KEY,
      openKfId: 'wk-demo-1',
      ...overrides,
    };
  }

  it('accepts a complete set', () => {
    expect(wecomCredentialProblems(complete())).toEqual([]);
  });

  it('names every missing field in declaration order', () => {
    const problems = wecomCredentialProblems(complete({ corpId: '', kfSecret: '', callbackToken: '', aesKey: '', openKfId: '' }));
    expect(problems.map((problem) => problem.variable)).toEqual([
      'WECOM_CORP_ID',
      'WECOM_KF_SECRET',
      'WECOM_TOKEN',
      'WECOM_AES_KEY',
      'WECOM_OPEN_KFID',
    ]);
    expect(problems.every((problem) => problem.code === 'missing')).toBe(true);
    // 空字段只说「缺」，不会顺带说「长度不对」：没填和填错了是两件事，操作者要做的
    // 动作也不一样。
    expect(problems.every((problem) => problem.observedLength === undefined)).toBe(true);
  });

  it('treats a whitespace-only field as missing', () => {
    expect(wecomCredentialProblems(complete({ openKfId: '   ' }))).toEqual([
      { variable: 'WECOM_OPEN_KFID', code: 'missing' },
    ]);
  });

  it('reports a wrong-length AES key with its length, and trims before measuring', () => {
    expect(wecomCredentialProblems(complete({ aesKey: 'k'.repeat(41) }))).toEqual([
      { variable: 'WECOM_AES_KEY', code: 'wrong_length', observedLength: 41 },
    ]);
    // 从企业微信控制台粘过来常常带空白，量的是去掉空白之后的长度。
    expect(wecomCredentialProblems(complete({ aesKey: `  ${AES_KEY}\n` }))).toEqual([]);
  });

  it('never returns a value, only the field name', () => {
    const problems = wecomCredentialProblems({
      corpId: 'ww-corp-leaky',
      kfSecret: 'kf-secret-leaky',
      callbackToken: 'token-leaky',
      aesKey: 'short-leaky',
      openKfId: 'wk-leaky',
    });
    const rendered = JSON.stringify(problems);
    for (const leak of ['ww-corp-leaky', 'kf-secret-leaky', 'token-leaky', 'short-leaky']) {
      expect(rendered).not.toContain(leak);
    }
    // 唯一说得出口的观测值，是那个「本来就有规定长度」的字段的长度。
    expect(problems).toEqual([
      { variable: 'WECOM_AES_KEY', code: 'wrong_length', observedLength: 11 },
    ]);
  });

  it('keeps the missing-variables reading about presence, not correctness', () => {
    const result = parseAppConfig({
      APP_ENV: 'test',
      WECOM_CORP_ID: 'ww-demo-corp',
      WECOM_KF_SECRET: 'kf-demo-secret',
      WECOM_TOKEN: 'demo-token',
      WECOM_AES_KEY: 'k'.repeat(41),
      WECOM_OPEN_KFID: 'wk-demo-1',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    // 「缺哪几个」是启动状态在读的判据，语义是「有没有填」：长度不对的 key 在这条读数里
    // 仍然算填了。填得对不对由 wecomCredentialProblems 回答，写路由与「连接」按钮读的是它。
    expect(wecomRealMissingVariables(result.config.wecom)).toEqual([]);
    expect(wecomCredentialProblems(wecomValuesOf(result.config.wecom))).toEqual([
      { variable: 'WECOM_AES_KEY', code: 'wrong_length', observedLength: 41 },
    ]);
  });
});

describe('wecomValuesOf', () => {
  it('unwraps the secret fields and renames the callback token', () => {
    const aesKey = 'k'.repeat(WECOM_AES_KEY_LENGTH);
    const result = parseAppConfig({
      APP_ENV: 'test',
      WECOM_CORP_ID: 'ww-demo-corp',
      WECOM_KF_SECRET: 'kf-demo-secret',
      WECOM_TOKEN: 'demo-token',
      WECOM_AES_KEY: aesKey,
      WECOM_OPEN_KFID: 'wk-demo-1',
    });
    expect(result._tag).toBe('ok');
    if (result._tag !== 'ok') {
      return;
    }
    // 配置里的名字是 TOKEN，凭证里的名字是 callbackToken：同一个值，两个领域的叫法，
    // 转换只有这一处。
    expect(wecomValuesOf(result.config.wecom)).toEqual({
      corpId: 'ww-demo-corp',
      kfSecret: 'kf-demo-secret',
      callbackToken: 'demo-token',
      aesKey,
      openKfId: 'wk-demo-1',
    });
  });
});

describe('resolveWecomCredentials', () => {
  const AES_KEY = 'k'.repeat(WECOM_AES_KEY_LENGTH);

  /** The environment half: a parsed `wecom` slice built from the five variables. */
  function environment(overrides: Readonly<Record<string, string>> = {}) {
    const result = parseAppConfig({
      APP_ENV: 'test',
      WECOM_CORP_ID: 'ww-env-corp',
      WECOM_KF_SECRET: 'kf-env-secret',
      WECOM_TOKEN: 'env-token',
      WECOM_AES_KEY: AES_KEY,
      WECOM_OPEN_KFID: 'wk-env-1',
      ...overrides,
    });
    if (result._tag !== 'ok') {
      throw new Error(`environment could not be parsed: ${result.error.message}`);
    }
    return result.config.wecom;
  }

  /** The console half: one stored set, dated so it is distinguishable from the env. */
  function stored(overrides: Partial<WecomCredentialValues> = {}): WecomCredentialValues {
    return {
      corpId: 'ww-stored-corp',
      kfSecret: 'kf-stored-secret',
      callbackToken: 'stored-token',
      aesKey: AES_KEY,
      openKfId: 'wk-stored-1',
      ...overrides,
    };
  }

  it('authenticates with the stored set when there is one', () => {
    expect(resolveWecomCredentials({ stored: stored(), environment: environment() })).toEqual({
      _tag: 'ready',
      origin: 'console',
      values: stored(),
    });
  });

  it('falls back to the environment when nothing is stored', () => {
    expect(resolveWecomCredentials({ stored: undefined, environment: environment() })).toEqual({
      _tag: 'ready',
      origin: 'environment',
      values: wecomValuesOf(environment()),
    });
  });

  it('does not replace a half-typed stored set with the environment', () => {
    // The load-bearing case: the console holds a set, and it is unusable, and the
    // environment would work. Connecting anyway would mean this deployment speaks
    // as a company nobody chose, and reporting the environment's failure would
    // send the operator to fix a file they did not touch.
    const result = resolveWecomCredentials({
      stored: stored({ kfSecret: '' }),
      environment: environment(),
    });
    expect(result).toEqual({
      _tag: 'unconfigured',
      origin: 'console',
      problems: [{ variable: 'WECOM_KF_SECRET', code: 'missing' }],
    });
  });

  it('keeps a wrong-length stored key out of the connection', () => {
    // The console refuses to store this, so reaching it means the set was usable
    // when written; a 41-character key decrypts no callback and must not be
    // reported as a working connection.
    expect(
      resolveWecomCredentials({ stored: stored({ aesKey: 'k'.repeat(41) }), environment: environment() }),
    ).toEqual({
      _tag: 'unconfigured',
      origin: 'console',
      problems: [{ variable: 'WECOM_AES_KEY', code: 'wrong_length', observedLength: 41 }],
    });
  });

  it('reports an unconfigured environment by its variable names', () => {
    const result = resolveWecomCredentials({
      stored: undefined,
      environment: environment({
        WECOM_CORP_ID: '',
        WECOM_KF_SECRET: '',
        WECOM_TOKEN: '',
        WECOM_AES_KEY: '',
        WECOM_OPEN_KFID: '',
      }),
    });
    expect(result._tag).toBe('unconfigured');
    if (result._tag !== 'unconfigured') {
      return;
    }
    expect(wecomProblemVariables(result.problems)).toEqual([
      'WECOM_CORP_ID',
      'WECOM_KF_SECRET',
      'WECOM_TOKEN',
      'WECOM_AES_KEY',
      'WECOM_OPEN_KFID',
    ]);
  });

  it('says nothing about a value when it cannot connect', () => {
    // Everything a refusal is allowed to carry: variable names, codes and the one
    // declared length. A status surface renders these; none of them is a secret.
    const result = resolveWecomCredentials({
      stored: stored({ kfSecret: 'kf-secret-leaky', aesKey: 'short-leaky' }),
      environment: environment(),
    });
    expect(result._tag).toBe('unconfigured');
    const rendered = JSON.stringify(result);
    for (const leak of ['kf-secret-leaky', 'short-leaky', 'ww-stored-corp', 'stored-token']) {
      expect(rendered).not.toContain(leak);
    }
    expect(result).toEqual({
      _tag: 'unconfigured',
      origin: 'console',
      problems: [{ variable: 'WECOM_AES_KEY', code: 'wrong_length', observedLength: 11 }],
    });
  });
});
