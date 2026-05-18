import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { stableHash } from "@job-search/domain";
import { LlmGateway, OpenAiCompatibleTransport, PromptRegistry, type LlmTransport } from "@job-search/llm";
import { z } from "zod";

export interface LlmSmokeReport {
  schemaVersion: "llm-smoke/v1";
  generatedAt: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  llmApiCalled: boolean;
  configSummary: {
    provider: RuntimeConfig["llm"]["provider"];
    model: string;
    apiBaseUrlHash: string | null;
    apiKeyHash: string | null;
    timeoutMs: number;
    maxRetries: number;
    maxInputChars: number;
  };
  promptVersion: string;
  result: {
    ok: boolean;
    modelVersion: string | null;
    inputHash: string | null;
    estimatedInputChars: number | null;
    validationErrors: string[];
    latencyMs: number | null;
  };
  failures: string[];
}

const diagnosticsSchema = z.object({ ok: z.boolean() }).strict();

export async function buildLlmSmokeReport(input: {
  config?: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  confirmLive: boolean;
  liveEvidenceAllowed: boolean;
  now?: Date;
  transport?: LlmTransport;
}): Promise<LlmSmokeReport> {
  const now = input.now ?? new Date();
  const config = input.config ?? loadConfig(input.env ?? process.env);
  const configSummary = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiBaseUrlHash: config.llm.apiBaseUrl ? stableHash(config.llm.apiBaseUrl) : null,
    apiKeyHash: config.llm.apiKey.length > 0 ? stableHash(config.llm.apiKey) : null,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    maxInputChars: config.llm.maxInputChars
  };
  const setupFailures = validateSetup({ config, confirmLive: input.confirmLive, liveEvidenceAllowed: input.liveEvidenceAllowed });
  if (setupFailures.length > 0) {
    return emptyReport({ now, confirmLive: input.confirmLive, liveEvidenceAllowed: input.liveEvidenceAllowed, configSummary, failures: setupFailures });
  }

  const start = Date.now();
  const transport = input.transport ?? new OpenAiCompatibleTransport(config.llm.apiBaseUrl!);
  const result = await new LlmGateway({
    modelVersion: config.llm.model,
    transport,
    apiKey: config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    maxInputChars: config.llm.maxInputChars
  }).generateStructured(diagnosticsSchema, {
    task: "diagnostics",
    ok: true
  });
  const failures = result.ok ? [] : result.validationErrors.map((failure) => `llm_diagnostics_failed:${failure}`);
  return {
    schemaVersion: "llm-smoke/v1",
    generatedAt: now.toISOString(),
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    llmApiCalled: true,
    configSummary,
    promptVersion: result.promptVersion,
    result: {
      ok: result.ok,
      modelVersion: result.modelVersion,
      inputHash: result.inputHash,
      estimatedInputChars: result.estimatedInputChars,
      validationErrors: result.validationErrors,
      latencyMs: Date.now() - start
    },
    failures
  };
}

function validateSetup(input: { config: RuntimeConfig; confirmLive: boolean; liveEvidenceAllowed: boolean }): string[] {
  const failures: string[] = [];
  if (!input.confirmLive) {
    failures.push("llm_smoke_confirm_live_required");
  }
  if (!input.liveEvidenceAllowed) {
    failures.push("llm_smoke_assert_live_required");
  }
  if (input.config.llm.provider === "mock") {
    failures.push("live_llm_provider_required");
  }
  if (input.config.llm.provider === "openai-compatible" && (!input.config.llm.apiBaseUrl || input.config.llm.apiKey.length === 0)) {
    failures.push("llm_api_configuration_required");
  }
  return failures;
}

function emptyReport(input: {
  now: Date;
  confirmLive: boolean;
  liveEvidenceAllowed: boolean;
  configSummary: LlmSmokeReport["configSummary"];
  failures: string[];
}): LlmSmokeReport {
  return {
    schemaVersion: "llm-smoke/v1",
    generatedAt: input.now.toISOString(),
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    llmApiCalled: false,
    configSummary: input.configSummary,
    promptVersion: PromptRegistry.version,
    result: {
      ok: false,
      modelVersion: null,
      inputHash: null,
      estimatedInputChars: null,
      validationErrors: [],
      latencyMs: null
    },
    failures: input.failures
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildLlmSmokeReport({
    confirmLive: process.env.LLM_SMOKE_CONFIRM_LIVE === "true",
    liveEvidenceAllowed: process.env.LLM_SMOKE_ASSERT_LIVE === "true"
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.LLM_SMOKE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.LLM_SMOKE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.LLM_SMOKE_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}
