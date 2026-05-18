import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { ReleaseEvidenceEvaluator, ReleaseGateEvaluator, type ReleaseEvidenceRecord, type ReleaseEvidenceSummary, type ReleaseGateReport } from "@job-search/domain";
import { collectProviderReadinessReports, createRuntimeProviderRegistryWithOverrides, type ProviderReadinessReport, type ProviderRegistry } from "@job-search/providers";
import { buildProviderReadinessEvidence, loadReleaseEvidenceFile } from "./acceptance-package";

export interface ReleaseEvidenceValidationReport {
  schemaVersion: "release-evidence-validation/v1";
  generatedAt: string;
  evidencePath: string;
  environment: RuntimeConfig["app"]["environment"];
  mode: RuntimeConfig["app"]["mode"];
  irreversibleActionsEnabled: boolean;
  stateBackend: RuntimeConfig["persistence"]["stateBackend"];
  queueBackend: RuntimeConfig["queue"]["backend"];
  objectStorageBackend: RuntimeConfig["objectStorage"]["backend"];
  telegramBotConfigured: boolean;
  telegramWebhookSecretConfigured: boolean;
  llmProvider: RuntimeConfig["llm"]["provider"];
  llmApiConfigured: boolean;
  secretsBackend: RuntimeConfig["security"]["secretsBackend"];
  expectedProviderIds: string[];
  records: number;
  providerReadiness: ProviderReadinessReport[];
  releaseEvidence: ReleaseEvidenceSummary;
  releaseGate: ReleaseGateReport;
  valid: boolean;
  failures: string[];
}

export async function buildReleaseEvidenceValidationReport(input: {
  evidencePath: string;
  records?: ReleaseEvidenceRecord[];
  config?: RuntimeConfig;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<ReleaseEvidenceValidationReport> {
  const now = input.now ?? new Date();
  const config = input.config ?? loadConfig();
  const registry = input.registry ?? createRuntimeProviderRegistryWithOverrides(config.providers, input.env ?? process.env);
  const records = input.records ?? loadReleaseEvidenceFile(input.evidencePath);
  const providers = registry.list();
  const expectedProviderIds = providers.map((provider) => provider.providerId);
  const autoApplyProviderIds = new Set(providers.filter((provider) => provider.capabilities.autoApply).map((provider) => provider.providerId));
  const providerReadinessEvidence = buildProviderReadinessEvidence({
    records,
    expectedProviderIds,
    providerConfigs: config.providers,
    now
  });
  const providerReadiness = await collectProviderReadinessReports({
    registry,
    environment: config.app.environment,
    now,
    ...providerReadinessEvidence
  });
  const releaseEvidence = new ReleaseEvidenceEvaluator().summarize({ records, expectedProviderIds, now });
  const releaseGate = new ReleaseGateEvaluator().evaluate({
    mode: config.app.mode,
    irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
    providerReadiness: providerReadiness.filter((provider) => autoApplyProviderIds.has(provider.providerId)),
    liveCredentialsConfigured: releaseEvidence.liveCredentialsConfigured,
    externalSecretsBackend: config.security.secretsBackend !== "env" && releaseEvidence.externalSecretsBackend,
    liveCanariesPassing: releaseEvidence.liveCanariesPassing,
    providerSubmitProofReady: releaseEvidence.providerSubmitProofReady,
    calendarIntegrationReady: releaseEvidence.calendarIntegrationReady,
    sevenDaySoakPassed: releaseEvidence.sevenDaySoakPassed,
    outboundDispatchProofReady: releaseEvidence.outboundDispatchProofReady
  });
  const failures = [
    ...releaseEvidence.blockers.map((blocker) => `release_evidence:${blocker}`),
    ...releaseGate.blockers.map((blocker) => `release_gate:${blocker}`),
    ...runtimeEnvelopeFailures(config)
  ];

  return {
    schemaVersion: "release-evidence-validation/v1",
    generatedAt: now.toISOString(),
    evidencePath: input.evidencePath,
    environment: config.app.environment,
    mode: config.app.mode,
    irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
    stateBackend: config.persistence.stateBackend,
    queueBackend: config.queue.backend,
    objectStorageBackend: config.objectStorage.backend,
    telegramBotConfigured: config.telegram.token.length > 0,
    telegramWebhookSecretConfigured: config.telegram.webhookSecretConfigured,
    llmProvider: config.llm.provider,
    llmApiConfigured: config.llm.provider === "openai-compatible" && Boolean(config.llm.apiBaseUrl) && config.llm.apiKey.length > 0,
    secretsBackend: config.security.secretsBackend,
    expectedProviderIds,
    records: records.length,
    providerReadiness,
    releaseEvidence,
    releaseGate,
    valid: failures.length === 0,
    failures
  };
}

function runtimeEnvelopeFailures(config: RuntimeConfig): string[] {
  return [
    config.app.environment !== "production" ? "runtime:production_environment_required" : null,
    config.app.mode !== "controlled_auto_apply" && config.app.mode !== "full_auto_apply" ? "runtime:controlled_or_full_auto_apply_mode_required" : null,
    !config.app.irreversibleActionsEnabled ? "runtime:irreversible_actions_enabled_required" : null,
    config.persistence.stateBackend !== "postgres" ? "runtime:postgres_state_backend_required" : null,
    config.queue.backend !== "bullmq" ? "runtime:bullmq_queue_backend_required" : null,
    config.security.secretsBackend === "env" ? "runtime:external_secrets_backend_required" : null,
    config.security.secretsBackend === "local_encrypted_file" && !config.security.localEncryptedFile.masterKeyConfigured
      ? "runtime:local_encrypted_file_master_key_required"
      : null,
    config.objectStorage.backend !== "s3_compatible" ? "runtime:s3_object_storage_required" : null,
    config.telegram.token.length === 0 ? "runtime:telegram_bot_token_required" : null,
    !config.telegram.webhookSecretConfigured ? "runtime:telegram_webhook_secret_required" : null,
    config.llm.provider === "mock" ? "runtime:live_llm_provider_required" : null,
    config.llm.provider === "openai-compatible" && (!config.llm.apiBaseUrl || config.llm.apiKey.length === 0) ? "runtime:llm_api_configuration_required" : null
  ].filter((failure): failure is string => failure !== null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidencePath = process.env.RELEASE_EVIDENCE_PATH ?? "release-evidence.json";
  const report = await buildReleaseEvidenceValidationReport({ evidencePath });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RELEASE_EVIDENCE_VALIDATION_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.RELEASE_EVIDENCE_VALIDATION_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.RELEASE_EVIDENCE_VALIDATION_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.valid) {
    process.exitCode = 1;
  }
}
