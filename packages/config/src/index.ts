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
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional().default(""),
  OBJECT_STORAGE_ROOT: z.string().default("./var/object-storage"),
  LLM_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  IRREVERSIBLE_ACTIONS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true")
});

export type RuntimeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const environment: "local" | "production" = parsed.NODE_ENV === "production" ? "production" : "local";
  const allowedUserIds = parsed.TELEGRAM_ALLOWED_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean);
  const corsOrigins = parsed.API_CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);

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
    telegram: {
      token: parsed.TELEGRAM_BOT_TOKEN,
      allowedUserIds
    },
    objectStorage: {
      root: parsed.OBJECT_STORAGE_ROOT
    },
    llm: {
      provider: parsed.LLM_PROVIDER
    }
  };
}

export function isLiveTelegramEnabled(config: RuntimeConfig): boolean {
  return config.telegram.token.length > 0;
}
