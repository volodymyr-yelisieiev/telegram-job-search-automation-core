import "dotenv/config";
import { z } from "zod";
import { appModes } from "@job-search/domain";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_MODE: z.enum(appModes).default("review_first"),
  APP_TIMEZONE: z.string().default("Europe/Vienna"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_TOKEN: z.string().optional().default("local-dev-token"),
  API_CORS_ORIGINS: z.string().optional().default("http://127.0.0.1:3000,http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://job_search:job_search@127.0.0.1:5432/job_search"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6380"),
  QUEUE_BACKEND: z.enum(["memory", "bullmq"]).default("memory"),
  STATE_BACKEND: z.enum(["memory", "postgres"]).default("memory"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(""),
  OBJECT_STORAGE_BACKEND: z.enum(["filesystem", "s3_compatible"]).default("filesystem"),
  OBJECT_STORAGE_ROOT: z.string().default("./var/object-storage"),
  OBJECT_STORAGE_S3_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_S3_BUCKET: z.string().optional().default(""),
  OBJECT_STORAGE_S3_REGION: z.string().optional().default(""),
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: z.string().optional().default(""),
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  SECRETS_BACKEND: z.enum(["env", "aws_secrets_manager", "gcp_secret_manager", "vault", "local_encrypted_file"]).default("env"),
  LOCAL_SECRET_STORE_ROOT: z.string().default("./var/secrets"),
  LOCAL_SECRET_STORE_MASTER_KEY: z.string().optional().default(""),
  RETENTION_RAW_PAYLOAD_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_ARTIFACT_DAYS: z.coerce.number().int().positive().default(30),
  LLM_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  LLM_API_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default("local-mock"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(1),
  LLM_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(20_000),
  PROVIDER_CONFIG_JSON: z.string().optional().default("[]"),
  IRREVERSIBLE_ACTIONS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true")
});

export type RuntimeConfig = ReturnType<typeof loadConfig>;

const providerConfigSchema = z.object({
  providerId: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  runtimeKind: z.enum(["fixture", "live"]).optional(),
  statusOverride: z.enum(["stable", "degraded", "read_only", "apply_disabled", "blocked", "needs_review", "deprecated"]).optional(),
  message: z.string().optional(),
  queries: z.array(z.string().min(1)).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  maxPagesPerRun: z.number().int().positive().optional(),
  maxJobsPerRun: z.number().int().nonnegative().optional(),
  concurrency: z.number().int().positive().optional(),
  liveSubmitEndpoint: z.string().url().optional(),
  liveSubmitAuthTokenEnv: z.string().min(1).optional(),
  liveSubmitAuthHeader: z.string().min(1).optional(),
  liveSubmitTimeoutMs: z.number().int().positive().optional()
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const environment: "local" | "production" = parsed.NODE_ENV === "production" ? "production" : "local";
  const allowedUserIds = parsed.TELEGRAM_ALLOWED_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean);
  const corsOrigins = parsed.API_CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  const providerConfigs = parseProviderConfigs(parsed.PROVIDER_CONFIG_JSON);

  if (parsed.TELEGRAM_BOT_TOKEN.length > 0 && allowedUserIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must be non-empty when TELEGRAM_BOT_TOKEN is configured");
  }

  if (environment === "production") {
    if (parsed.API_TOKEN.length === 0 || parsed.API_TOKEN === "local-dev-token") {
      throw new Error("Production API_TOKEN must be explicitly configured and cannot use the local default");
    }
    if ((parsed.API_HOST === "0.0.0.0" || parsed.API_HOST === "::") && corsOrigins.length === 0) {
      throw new Error("Production public API bind requires explicit API_CORS_ORIGINS");
    }
    if (parsed.TELEGRAM_BOT_TOKEN.length > 0 && parsed.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      throw new Error("Production TELEGRAM_WEBHOOK_SECRET must be at least 16 characters when TELEGRAM_BOT_TOKEN is configured");
    }
    if (parsed.IRREVERSIBLE_ACTIONS_ENABLED && parsed.SECRETS_BACKEND === "env") {
      throw new Error("Production irreversible actions require an external SECRETS_BACKEND");
    }
    if (
      parsed.IRREVERSIBLE_ACTIONS_ENABLED &&
      parsed.SECRETS_BACKEND === "local_encrypted_file" &&
      parsed.LOCAL_SECRET_STORE_MASTER_KEY.length < 16
    ) {
      throw new Error("Production local_encrypted_file SECRETS_BACKEND requires LOCAL_SECRET_STORE_MASTER_KEY with at least 16 characters");
    }
    if (parsed.IRREVERSIBLE_ACTIONS_ENABLED && parsed.OBJECT_STORAGE_BACKEND === "filesystem") {
      throw new Error("Production irreversible actions require S3-compatible OBJECT_STORAGE_BACKEND");
    }
  }

  if (parsed.OBJECT_STORAGE_BACKEND === "s3_compatible") {
    if (!parsed.OBJECT_STORAGE_S3_ENDPOINT) {
      throw new Error("OBJECT_STORAGE_S3_ENDPOINT is required when OBJECT_STORAGE_BACKEND=s3_compatible");
    }
    if (parsed.OBJECT_STORAGE_S3_BUCKET.length === 0) {
      throw new Error("OBJECT_STORAGE_S3_BUCKET is required when OBJECT_STORAGE_BACKEND=s3_compatible");
    }
    if (parsed.OBJECT_STORAGE_S3_REGION.length === 0) {
      throw new Error("OBJECT_STORAGE_S3_REGION is required when OBJECT_STORAGE_BACKEND=s3_compatible");
    }
    if (parsed.OBJECT_STORAGE_S3_ACCESS_KEY_ID.length === 0 || parsed.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY.length === 0) {
      throw new Error("OBJECT_STORAGE_S3_ACCESS_KEY_ID and OBJECT_STORAGE_S3_SECRET_ACCESS_KEY are required when OBJECT_STORAGE_BACKEND=s3_compatible");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    app: {
      mode: parsed.APP_MODE,
      timezone: parsed.APP_TIMEZONE,
      environment,
      irreversibleActionsEnabled: parsed.IRREVERSIBLE_ACTIONS_ENABLED
    },
    api: {
      host: parsed.API_HOST,
      port: parsed.API_PORT,
      token: parsed.API_TOKEN,
      corsOrigins
    },
    postgres: {
      url: parsed.DATABASE_URL
    },
    redis: {
      url: parsed.REDIS_URL
    },
    queue: {
      backend: parsed.QUEUE_BACKEND,
      redisUrl: parsed.REDIS_URL
    },
    persistence: {
      stateBackend: parsed.STATE_BACKEND
    },
    telegram: {
      token: parsed.TELEGRAM_BOT_TOKEN,
      allowedUserIds,
      webhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
      webhookSecretConfigured: parsed.TELEGRAM_WEBHOOK_SECRET.length > 0
    },
    objectStorage: {
      backend: parsed.OBJECT_STORAGE_BACKEND,
      root: parsed.OBJECT_STORAGE_ROOT,
      s3: {
        endpoint: parsed.OBJECT_STORAGE_S3_ENDPOINT ?? null,
        bucket: parsed.OBJECT_STORAGE_S3_BUCKET,
        region: parsed.OBJECT_STORAGE_S3_REGION,
        accessKeyIdConfigured: parsed.OBJECT_STORAGE_S3_ACCESS_KEY_ID.length > 0,
        secretAccessKeyConfigured: parsed.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY.length > 0,
        accessKeyId: parsed.OBJECT_STORAGE_S3_ACCESS_KEY_ID,
        secretAccessKey: parsed.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY
      }
    },
    security: {
      secretsBackend: parsed.SECRETS_BACKEND,
      localEncryptedFile: {
        root: parsed.LOCAL_SECRET_STORE_ROOT,
        masterKey: parsed.LOCAL_SECRET_STORE_MASTER_KEY,
        masterKeyConfigured: parsed.LOCAL_SECRET_STORE_MASTER_KEY.length >= 16
      }
    },
    retention: {
      rawPayloadDays: parsed.RETENTION_RAW_PAYLOAD_DAYS,
      artifactDays: parsed.RETENTION_ARTIFACT_DAYS
    },
    llm: {
      provider: parsed.LLM_PROVIDER,
      apiBaseUrl: parsed.LLM_API_BASE_URL ?? null,
      apiKey: parsed.LLM_API_KEY,
      model: parsed.LLM_MODEL,
      timeoutMs: parsed.LLM_TIMEOUT_MS,
      maxRetries: parsed.LLM_MAX_RETRIES,
      maxInputChars: parsed.LLM_MAX_INPUT_CHARS
    },
    providers: providerConfigs
  };
}

export function isLiveTelegramEnabled(config: RuntimeConfig): boolean {
  return config.telegram.token.length > 0;
}

function parseProviderConfigs(contents: string) {
  const parsed: unknown = JSON.parse(contents);
  if (!Array.isArray(parsed)) {
    throw new Error("PROVIDER_CONFIG_JSON must be a JSON array");
  }
  return parsed.map((item, index) => {
    const result = providerConfigSchema.safeParse(item);
    if (!result.success) {
      throw new Error(`Invalid provider config at index ${index}: ${result.error.issues.map((issue) => issue.message).join(", ")}`);
    }
    return result.data;
  });
}
