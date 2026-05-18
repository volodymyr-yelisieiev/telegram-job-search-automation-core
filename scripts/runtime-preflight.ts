import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { createPool, LocalEncryptedFileSecretStore, S3CompatibleObjectStorageAdapter } from "@job-search/db";
import { stableHash } from "@job-search/domain";
import { LlmGateway, OpenAiCompatibleTransport } from "@job-search/llm";
import { z } from "zod";

export type RuntimePreflightCheckName =
  | "production_environment"
  | "controlled_or_full_auto_apply_mode"
  | "irreversible_actions_enabled"
  | "live_submit_provider_configured"
  | "postgres_state_backend"
  | "bullmq_queue_backend"
  | "postgres_reachable"
  | "redis_reachable"
  | "external_secrets_backend"
  | "local_encrypted_file_secret_store"
  | "s3_object_storage_configured"
  | "s3_object_storage_roundtrip"
  | "telegram_bot_configured"
  | "telegram_webhook_secret_configured"
  | "telegram_get_me"
  | "live_llm_provider"
  | "llm_api_configured"
  | "llm_chat_completion";

export interface RuntimePreflightCheck {
  name: RuntimePreflightCheckName;
  required: boolean;
  passed: boolean;
  reason: string | null;
  metadata: Record<string, unknown>;
}

export interface RuntimePreflightReport {
  schemaVersion: "runtime-preflight/v1";
  generatedAt: string;
  runExternalProbes: boolean;
  configSummary: {
    environment: RuntimeConfig["app"]["environment"];
    mode: RuntimeConfig["app"]["mode"];
    irreversibleActionsEnabled: boolean;
    stateBackend: RuntimeConfig["persistence"]["stateBackend"];
    queueBackend: RuntimeConfig["queue"]["backend"];
    postgresUrlHash: string;
    redisUrlHash: string;
    secretsBackend: RuntimeConfig["security"]["secretsBackend"];
    localEncryptedFileConfigured: boolean | null;
    objectStorageBackend: RuntimeConfig["objectStorage"]["backend"];
    objectStorageRootHash: string | null;
    s3EndpointHash: string | null;
    s3BucketHash: string | null;
    s3Region: string | null;
    s3AccessKeyIdHash: string | null;
    s3SecretAccessKeyConfigured: boolean | null;
    telegramBotConfigured: boolean;
    telegramTokenHash: string | null;
    telegramWebhookSecretConfigured: boolean;
    telegramWebhookSecretHash: string | null;
    llmProvider: RuntimeConfig["llm"]["provider"];
    llmApiConfigured: boolean;
    llmApiBaseUrlHash: string | null;
    liveSubmitProviders: Array<{
      providerId: string;
      endpointHash: string | null;
      authTokenEnvHash: string | null;
      authTokenConfigured: boolean;
    }>;
  };
  checks: RuntimePreflightCheck[];
  passed: boolean;
  failures: string[];
}

type ProbeOverrides = Partial<Record<RuntimePreflightCheckName, RuntimePreflightCheck>>;

export async function buildRuntimePreflightReport(input: {
  config?: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  runExternalProbes?: boolean;
  probeOverrides?: ProbeOverrides;
  fetchImpl?: typeof fetch;
  objectStorageFetchImpl?: typeof fetch;
} = {}): Promise<RuntimePreflightReport> {
  const now = input.now ?? new Date();
  const config = input.config ?? loadConfig(input.env ?? process.env);
  const runExternalProbes = input.runExternalProbes ?? false;
  const checks: RuntimePreflightCheck[] = [];
  const add = (check: RuntimePreflightCheck): void => {
    checks.push(input.probeOverrides?.[check.name] ?? check);
  };
  const addProbe = async (name: RuntimePreflightCheckName, factory: () => Promise<RuntimePreflightCheck>): Promise<void> => {
    checks.push(input.probeOverrides?.[name] ?? (await factory()));
  };

  add(staticCheck("production_environment", config.app.environment === "production", "NODE_ENV must be production"));
  add(staticCheck("controlled_or_full_auto_apply_mode", ["controlled_auto_apply", "full_auto_apply"].includes(config.app.mode), "APP_MODE must enable live automation"));
  add(staticCheck("irreversible_actions_enabled", config.app.irreversibleActionsEnabled, "IRREVERSIBLE_ACTIONS_ENABLED must be true"));
  const liveSubmitProviders = liveSubmitProviderSummary(config, input.env ?? process.env);
  const liveSubmitProviderRequired = requiresLiveSubmitProvider(config);
  add({
    name: "live_submit_provider_configured",
    required: liveSubmitProviderRequired,
    passed:
      !liveSubmitProviderRequired ||
      (liveSubmitProviders.length > 0 && liveSubmitProviders.every((provider) => provider.endpointHash !== null && provider.authTokenConfigured)),
    reason:
      !liveSubmitProviderRequired || (liveSubmitProviders.length > 0 && liveSubmitProviders.every((provider) => provider.endpointHash !== null && provider.authTokenConfigured))
        ? null
        : "At least one enabled live provider must have liveSubmitEndpoint plus configured liveSubmitAuthTokenEnv",
    metadata: {
      liveSubmitProviderCount: liveSubmitProviders.length,
      configuredProviderIds: liveSubmitProviders.filter((provider) => provider.endpointHash !== null && provider.authTokenConfigured).map((provider) => provider.providerId)
    }
  });
  add(staticCheck("postgres_state_backend", config.persistence.stateBackend === "postgres", "STATE_BACKEND must be postgres"));
  add(staticCheck("bullmq_queue_backend", config.queue.backend === "bullmq", "QUEUE_BACKEND must be bullmq"));
  if (config.persistence.stateBackend === "postgres") {
    await addProbe("postgres_reachable", () => runExternalProbes ? probePostgres(config) : Promise.resolve(skippedProbe("postgres_reachable")));
  }
  await addProbe("redis_reachable", () => runExternalProbes ? probeRedis(config) : Promise.resolve(skippedProbe("redis_reachable")));
  add(staticCheck("external_secrets_backend", config.security.secretsBackend !== "env", "SECRETS_BACKEND must not be env"));
  if (config.security.secretsBackend === "local_encrypted_file") {
    await addProbe("local_encrypted_file_secret_store", () => runExternalProbes ? probeLocalSecretStore(config, now) : Promise.resolve(skippedProbe("local_encrypted_file_secret_store")));
  }
  const s3ObjectStorageConfigured =
    config.objectStorage.backend === "s3_compatible" &&
    Boolean(config.objectStorage.s3.endpoint) &&
    config.objectStorage.s3.bucket.length > 0 &&
    config.objectStorage.s3.region.length > 0 &&
    config.objectStorage.s3.accessKeyIdConfigured &&
    config.objectStorage.s3.secretAccessKeyConfigured;
  add(
    staticCheck(
      "s3_object_storage_configured",
      s3ObjectStorageConfigured,
      "OBJECT_STORAGE_BACKEND must be s3_compatible with endpoint, bucket, region, and credentials"
    )
  );
  if (config.objectStorage.backend === "s3_compatible") {
    await addProbe("s3_object_storage_roundtrip", () =>
      runExternalProbes
        ? probeS3ObjectStorage(config, input.objectStorageFetchImpl ?? fetch, now)
        : Promise.resolve(skippedProbe("s3_object_storage_roundtrip"))
    );
  }
  add(staticCheck("telegram_bot_configured", config.telegram.token.length > 0, "TELEGRAM_BOT_TOKEN must be configured"));
  if (config.telegram.token.length > 0) {
    add(
      staticCheck(
        "telegram_webhook_secret_configured",
        config.telegram.webhookSecretConfigured,
        "TELEGRAM_WEBHOOK_SECRET must be configured for guarded inbound Telegram webhooks"
      )
    );
  }
  if (config.telegram.token.length > 0) {
    await addProbe("telegram_get_me", () => runExternalProbes ? probeTelegram(config, input.fetchImpl ?? fetch) : Promise.resolve(skippedProbe("telegram_get_me")));
  }
  add(staticCheck("live_llm_provider", config.llm.provider !== "mock", "LLM_PROVIDER must not be mock"));
  add(staticCheck("llm_api_configured", config.llm.provider === "openai-compatible" && Boolean(config.llm.apiBaseUrl) && config.llm.apiKey.length > 0, "LLM API base URL and API key must be configured"));
  if (config.llm.provider === "openai-compatible" && config.llm.apiBaseUrl && config.llm.apiKey.length > 0) {
    await addProbe("llm_chat_completion", () => runExternalProbes ? probeLlm(config) : Promise.resolve(skippedProbe("llm_chat_completion")));
  }

  const failures = checks
    .filter((check) => check.required && !check.passed)
    .map((check) => `${check.name}:${check.reason ?? "failed"}`);
  if (!runExternalProbes) {
    failures.push("external_probes_not_run");
  }

  return {
    schemaVersion: "runtime-preflight/v1",
    generatedAt: now.toISOString(),
    runExternalProbes,
    configSummary: {
      environment: config.app.environment,
      mode: config.app.mode,
      irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
      stateBackend: config.persistence.stateBackend,
      queueBackend: config.queue.backend,
      postgresUrlHash: stableHash(config.postgres.url),
      redisUrlHash: stableHash(config.redis.url),
      secretsBackend: config.security.secretsBackend,
      localEncryptedFileConfigured: config.security.secretsBackend === "local_encrypted_file" ? config.security.localEncryptedFile.masterKeyConfigured : null,
      objectStorageBackend: config.objectStorage.backend,
      objectStorageRootHash: config.objectStorage.backend === "filesystem" ? stableHash(config.objectStorage.root) : null,
      s3EndpointHash: config.objectStorage.s3.endpoint ? stableHash(config.objectStorage.s3.endpoint) : null,
      s3BucketHash: config.objectStorage.s3.bucket.length > 0 ? stableHash(config.objectStorage.s3.bucket) : null,
      s3Region: config.objectStorage.s3.region.length > 0 ? config.objectStorage.s3.region : null,
      s3AccessKeyIdHash: config.objectStorage.s3.accessKeyId.length > 0 ? stableHash(config.objectStorage.s3.accessKeyId) : null,
      s3SecretAccessKeyConfigured: config.objectStorage.s3.secretAccessKeyConfigured,
      telegramBotConfigured: config.telegram.token.length > 0,
      telegramTokenHash: config.telegram.token.length > 0 ? stableHash(config.telegram.token) : null,
      telegramWebhookSecretConfigured: config.telegram.webhookSecretConfigured,
      telegramWebhookSecretHash: config.telegram.webhookSecret.length > 0 ? stableHash(config.telegram.webhookSecret) : null,
      llmProvider: config.llm.provider,
      llmApiConfigured: config.llm.provider === "openai-compatible" && Boolean(config.llm.apiBaseUrl) && config.llm.apiKey.length > 0,
      llmApiBaseUrlHash: config.llm.apiBaseUrl ? stableHash(config.llm.apiBaseUrl) : null,
      liveSubmitProviders
    },
    checks,
    passed: failures.length === 0,
    failures
  };
}

export function parseRuntimePreflightReport(contents: string): RuntimePreflightReport {
  const parsed = JSON.parse(contents) as RuntimePreflightReport;
  if (parsed.schemaVersion !== "runtime-preflight/v1" || !Array.isArray(parsed.checks)) {
    throw new Error("Runtime preflight report has invalid schema");
  }
  return parsed;
}

function staticCheck(name: RuntimePreflightCheckName, passed: boolean, reason: string): RuntimePreflightCheck {
  return { name, required: true, passed, reason: passed ? null : reason, metadata: {} };
}

function skippedProbe(name: RuntimePreflightCheckName): RuntimePreflightCheck {
  return { name, required: false, passed: true, reason: "external probe not run", metadata: { skipped: true } };
}

function requiresLiveSubmitProvider(config: RuntimeConfig): boolean {
  return config.app.irreversibleActionsEnabled && ["controlled_auto_apply", "full_auto_apply"].includes(config.app.mode);
}

function liveSubmitProviderSummary(config: RuntimeConfig, env: NodeJS.ProcessEnv): RuntimePreflightReport["configSummary"]["liveSubmitProviders"] {
  return config.providers
    .filter((provider) => provider.enabled !== false && provider.runtimeKind === "live")
    .map((provider) => ({
      providerId: provider.providerId,
      endpointHash: provider.liveSubmitEndpoint ? stableHash(provider.liveSubmitEndpoint) : null,
      authTokenEnvHash: provider.liveSubmitAuthTokenEnv ? stableHash(provider.liveSubmitAuthTokenEnv) : null,
      authTokenConfigured: Boolean(provider.liveSubmitAuthTokenEnv && env[provider.liveSubmitAuthTokenEnv])
    }));
}

async function probePostgres(config: RuntimeConfig): Promise<RuntimePreflightCheck> {
  const pool = createPool(config.postgres.url);
  try {
    await pool.query("SELECT 1 AS ok");
    const migrations = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM schema_migrations");
    return {
      name: "postgres_reachable",
      required: true,
      passed: true,
      reason: null,
      metadata: { migrationRows: Number(migrations.rows[0]?.count ?? 0) }
    };
  } catch (error) {
    return failedProbe("postgres_reachable", error, [config.postgres.url]);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function probeRedis(config: RuntimeConfig): Promise<RuntimePreflightCheck> {
  const redis = new Redis(config.redis.url, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
  try {
    await redis.connect();
    const response = await redis.ping();
    return { name: "redis_reachable", required: true, passed: response === "PONG", reason: response === "PONG" ? null : `Unexpected Redis PING response: ${response}`, metadata: {} };
  } catch (error) {
    return failedProbe("redis_reachable", error, [config.redis.url]);
  } finally {
    redis.disconnect();
  }
}

async function probeLocalSecretStore(config: RuntimeConfig, now: Date): Promise<RuntimePreflightCheck> {
  try {
    const probe = await new LocalEncryptedFileSecretStore({
      rootDir: config.security.localEncryptedFile.root,
      masterKey: config.security.localEncryptedFile.masterKey
    }).probe(now);
    return {
      name: "local_encrypted_file_secret_store",
      required: true,
      passed: true,
      reason: null,
      metadata: { referenceCount: probe.referenceCount }
    };
  } catch (error) {
    return failedProbe("local_encrypted_file_secret_store", error, [
      config.security.localEncryptedFile.root,
      config.security.localEncryptedFile.masterKey
    ]);
  }
}

async function probeS3ObjectStorage(config: RuntimeConfig, fetchImpl: typeof fetch, now: Date): Promise<RuntimePreflightCheck> {
  const s3 = config.objectStorage.s3;
  const objectKey = `runtime-preflight/${stableHash(`${now.toISOString()}:${process.pid}:${Math.random()}`)}.txt`;
  const bytes = new TextEncoder().encode(`runtime-preflight:${stableHash(now.toISOString())}`);
  let objectCreated = false;
  try {
    if (!s3.endpoint) {
      throw new Error("s3_endpoint_required");
    }
    const storage = new S3CompatibleObjectStorageAdapter({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      fetchImpl,
      now: () => now
    });
    await storage.put({
      objectKey,
      bytes,
      contentType: "text/plain",
      metadata: { probe: "runtime-preflight" }
    });
    objectCreated = true;
    const fetched = await storage.get(objectKey);
    if (!fetched) {
      return {
        name: "s3_object_storage_roundtrip",
        required: true,
        passed: false,
        reason: "S3 object storage probe object was not readable after write",
        metadata: { objectKeyHash: stableHash(objectKey) }
      };
    }
    const fetchedBytes = Buffer.from(fetched.bytes);
    const expectedBytes = Buffer.from(bytes);
    if (!fetchedBytes.equals(expectedBytes)) {
      return {
        name: "s3_object_storage_roundtrip",
        required: true,
        passed: false,
        reason: "S3 object storage probe bytes changed during roundtrip",
        metadata: { objectKeyHash: stableHash(objectKey), bytes: bytes.byteLength, fetchedBytes: fetched.bytes.byteLength }
      };
    }
    const deleted = await storage.delete(objectKey);
    objectCreated = !deleted.deleted;
    return {
      name: "s3_object_storage_roundtrip",
      required: true,
      passed: deleted.deleted,
      reason: deleted.deleted ? null : "S3 object storage probe object was not deleted after roundtrip",
      metadata: { objectKeyHash: stableHash(objectKey), bytes: bytes.byteLength, cleanupDeleted: deleted.deleted }
    };
  } catch (error) {
    return failedProbe("s3_object_storage_roundtrip", error, [
      s3.endpoint ?? "",
      s3.bucket,
      s3.accessKeyId,
      s3.secretAccessKey,
      objectKey
    ]);
  } finally {
    if (objectCreated && s3.endpoint) {
      await new S3CompatibleObjectStorageAdapter({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        region: s3.region,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        fetchImpl,
        now: () => now
      })
        .delete(objectKey)
        .catch(() => undefined);
    }
  }
}

async function probeTelegram(config: RuntimeConfig, fetchImpl: typeof fetch): Promise<RuntimePreflightCheck> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.telegram.token}/getMe`);
    if (!response.ok) {
      return { name: "telegram_get_me", required: true, passed: false, reason: `Telegram getMe failed with HTTP ${response.status}`, metadata: {} };
    }
    const body = (await response.json()) as { ok?: boolean; result?: { id?: number; username?: string } };
    return {
      name: "telegram_get_me",
      required: true,
      passed: body.ok === true,
      reason: body.ok === true ? null : "Telegram getMe returned ok=false",
      metadata: { botIdPresent: typeof body.result?.id === "number", usernamePresent: typeof body.result?.username === "string" }
    };
  } catch (error) {
    return failedProbe("telegram_get_me", error, [config.telegram.token]);
  }
}

async function probeLlm(config: RuntimeConfig): Promise<RuntimePreflightCheck> {
  try {
    const result = await new LlmGateway({
      modelVersion: config.llm.model,
      transport: new OpenAiCompatibleTransport(config.llm.apiBaseUrl!),
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: config.llm.maxRetries,
      maxInputChars: config.llm.maxInputChars
    }).generateStructured(z.object({ ok: z.boolean() }), { task: "diagnostics", ok: true });
    return {
      name: "llm_chat_completion",
      required: true,
      passed: result.ok,
      reason: result.ok ? null : `LLM diagnostics failed: ${result.validationErrors.join(", ")}`,
      metadata: { model: config.llm.model, promptVersion: result.promptVersion }
    };
  } catch (error) {
    return failedProbe("llm_chat_completion", error, [config.llm.apiBaseUrl ?? "", config.llm.apiKey]);
  }
}

function failedProbe(name: RuntimePreflightCheckName, error: unknown, sensitiveValues: string[] = []): RuntimePreflightCheck {
  return {
    name,
    required: true,
    passed: false,
    reason: sanitizeProbeFailure(error instanceof Error ? error.message : String(error), sensitiveValues),
    metadata: {}
  };
}

function sanitizeProbeFailure(message: string, sensitiveValues: string[]): string {
  let sanitized = message;
  for (const value of sensitiveValues.filter((item) => item.trim().length > 0)) {
    sanitized = sanitized.split(value).join(`[redacted:${stableHash(value)}]`);
  }
  return sanitized
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|session))=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/(?:postgres|postgresql|redis):\/\/[^\s]+/gi, (value) => `[redacted-url:${stableHash(value)}]`)
    .slice(0, 500);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildRuntimePreflightReport({
    runExternalProbes: process.env.RUNTIME_PREFLIGHT_RUN_PROBES !== "false"
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RUNTIME_PREFLIGHT_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.RUNTIME_PREFLIGHT_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.RUNTIME_PREFLIGHT_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}
