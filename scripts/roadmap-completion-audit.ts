import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { ReleaseEvidenceEvaluator, stableHash } from "@job-search/domain";
import { createFixtureProviderRegistry, createRuntimeProviderRegistryWithOverrides, type ProviderRegistry } from "@job-search/providers";
import { buildAcceptancePackage, buildGaSignoffChecklist, parseGaSignoffFile, parseReleaseEvidenceRecords } from "./acceptance-package";
import { buildRoadmapComplianceReport } from "./roadmap-compliance-check";
import { buildReleaseEvidenceValidationReport } from "./release-evidence-validate";
import { parseRuntimePreflightReport, type RuntimePreflightCheckName, type RuntimePreflightReport } from "./runtime-preflight";

const incompleteRoadmapStatuses = new Set(["Implemented/local-safe", "External evidence required"]);
const incompletePrdStatuses = new Set(["Partial/local-safe", "Deferred/external", "Local-safe only", "Implemented locally", "Implemented/local-safe"]);

export interface CompletionAuditRow {
  id: string;
  status: string;
  evidence: string;
  reason: string;
  requiredLiveChecks: string[];
  missingLiveChecks: string[];
}

export interface RoadmapCompletionAuditReport {
  schemaVersion: "roadmap-completion-audit/v1";
  roadmapCompliancePassed: boolean;
  complete: boolean;
  roadmapBlockers: CompletionAuditRow[];
  prdBlockers: CompletionAuditRow[];
  resolvedRoadmapRows: CompletionAuditRow[];
  resolvedPrdRows: CompletionAuditRow[];
  missingLiveArtifacts: string[];
  liveArtifactValidation: {
    releaseEvidence: {
      path: string;
      present: boolean;
      records: number;
      acceptedEvidenceIds: string[];
      invalidEvidenceIds: string[];
      capabilities: {
        liveCredentialsConfigured: boolean;
        externalSecretsBackend: boolean;
        liveCanariesPassing: boolean;
        providerSubmitProofReady: boolean;
        calendarIntegrationReady: boolean;
        sevenDaySoakPassed: boolean;
        outboundDispatchProofReady: boolean;
      };
      blockers: string[];
      parseError: string | null;
    };
    gaSignoff: {
      path: string;
      present: boolean;
      explicitSignoffProvided: boolean;
      blockers: string[];
      parseError: string | null;
    };
    runtime: {
      environment: string | null;
      mode: string | null;
      irreversibleActionsEnabled: boolean | null;
      stateBackend: string | null;
      queueBackend: string | null;
      secretsBackend: string | null;
      localEncryptedFileConfigured: boolean | null;
      objectStorageBackend: string | null;
      s3ObjectStorageConfigured: boolean | null;
      telegramBotConfigured: boolean | null;
      telegramWebhookSecretConfigured: boolean | null;
      llmProvider: string | null;
      llmApiConfigured: boolean | null;
      preflight: {
        path: string;
        present: boolean;
        generatedAt: string | null;
        ageHours: number | null;
        maxAgeHours: number;
        fresh: boolean | null;
        passed: boolean | null;
        externalProbesRun: boolean | null;
        configMatches: boolean | null;
        failures: string[];
        parseError: string | null;
      };
      blockers: string[];
      parseError: string | null;
    };
    aggregateGates: {
      releaseGate: {
        readyForLiveAutomation: boolean | null;
        blockers: string[];
        failures: string[];
        parseError: string | null;
      };
      acceptancePackage: {
        passed: boolean | null;
        fixtureSoakPassed: boolean | null;
        releaseGatePassed: boolean | null;
        gaSignoffPassed: boolean | null;
        blockers: string[];
        residualRisks: string[];
        parseError: string | null;
      };
    };
  };
  failures: string[];
}

export async function buildRoadmapCompletionAudit(input: {
  roadmapPath?: string;
  roadmapMatrixPath?: string;
  prdMatrixPath?: string;
  releaseEvidencePath?: string;
  gaSignoffPath?: string;
  runtimePreflightPath?: string;
  runtimePreflightMaxAgeHours?: number;
  acceptanceIterations?: number;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<RoadmapCompletionAuditReport> {
  const roadmapMatrixPath = input.roadmapMatrixPath ?? "docs/verification/ROADMAP_COMPLIANCE_MATRIX.md";
  const prdMatrixPath = input.prdMatrixPath ?? "docs/verification/PRD_COMPLIANCE_MATRIX.md";
  const releaseEvidencePath = input.releaseEvidencePath ?? "release-evidence.json";
  const gaSignoffPath = input.gaSignoffPath ?? "ga-signoff.json";
  const runtimePreflightPath = input.runtimePreflightPath ?? "runtime-preflight.json";
  const roadmapCompliance = buildRoadmapComplianceReport({
    ...(input.roadmapPath ? { roadmapPath: input.roadmapPath } : {}),
    matrixPath: roadmapMatrixPath
  });
  const failures = [...roadmapCompliance.failures.map((failure) => `roadmap_compliance:${failure}`)];
  const roadmapRows = parseMarkdownRows(readExistingFile(roadmapMatrixPath, failures));
  const prdRows = parseMarkdownRows(readExistingFile(prdMatrixPath, failures));
  const liveArtifactValidation = {
    ...validateLiveArtifacts({
      releaseEvidencePath,
      gaSignoffPath,
      runtimePreflightPath,
      runtimePreflightMaxAgeHours: input.runtimePreflightMaxAgeHours ?? 24,
      env: input.env ?? process.env,
      now: input.now ?? new Date()
    }),
    aggregateGates: await validateAggregateGates({
      releaseEvidencePath,
      gaSignoffPath,
      iterations: input.acceptanceIterations ?? 7,
      env: input.env ?? process.env,
      registry: input.registry
    })
  };
  const roadmapRowsWithRequirements = roadmapRows
    .filter((row) => incompleteRoadmapStatuses.has(row.status))
    .map((row) =>
      buildCompletionAuditRow({
        row,
        reason: row.status === "External evidence required" ? "external_evidence_required" : "local_safe_not_live_complete",
        requiredLiveChecks: requiredRoadmapChecks(row.id),
        validation: liveArtifactValidation
      })
    );
  const prdRowsWithRequirements = prdRows
    .filter((row) => incompletePrdStatuses.has(row.status))
    .map((row) =>
      buildCompletionAuditRow({
        row,
        reason: prdBlockerReason(row.status),
        requiredLiveChecks: requiredPrdChecks(row.id),
        validation: liveArtifactValidation
      })
    );
  const roadmapBlockers = roadmapRowsWithRequirements.filter((row) => row.missingLiveChecks.length > 0);
  const prdBlockers = prdRowsWithRequirements.filter((row) => row.missingLiveChecks.length > 0);
  const resolvedRoadmapRows = roadmapRowsWithRequirements.filter((row) => row.missingLiveChecks.length === 0);
  const resolvedPrdRows = prdRowsWithRequirements.filter((row) => row.missingLiveChecks.length === 0);
  const missingLiveArtifacts = [
    existsSync(releaseEvidencePath) ? null : `missing_release_evidence_file:${releaseEvidencePath}`,
    existsSync(gaSignoffPath) ? null : `missing_ga_signoff_file:${gaSignoffPath}`,
    existsSync(runtimePreflightPath) ? null : `missing_runtime_preflight_file:${runtimePreflightPath}`
  ].filter((item): item is string => item !== null);
  for (const blocker of roadmapBlockers) {
    failures.push(`roadmap_blocker:${blocker.id}:${blocker.reason}`);
  }
  for (const blocker of prdBlockers) {
    failures.push(`prd_blocker:${blocker.id}:${blocker.reason}`);
  }
  failures.push(...missingLiveArtifacts);
  failures.push(...liveArtifactValidation.releaseEvidence.blockers.map((blocker) => `release_evidence:${blocker}`));
  if (liveArtifactValidation.releaseEvidence.parseError) {
    failures.push(`release_evidence_parse_error:${liveArtifactValidation.releaseEvidence.parseError}`);
  }
  failures.push(...liveArtifactValidation.gaSignoff.blockers.map((blocker) => `ga_signoff:${blocker}`));
  if (liveArtifactValidation.gaSignoff.parseError) {
    failures.push(`ga_signoff_parse_error:${liveArtifactValidation.gaSignoff.parseError}`);
  }
  failures.push(...liveArtifactValidation.runtime.blockers.map((blocker) => `runtime:${blocker}`));
  if (liveArtifactValidation.runtime.parseError) {
    failures.push(`runtime_parse_error:${liveArtifactValidation.runtime.parseError}`);
  }
  failures.push(...liveArtifactValidation.aggregateGates.releaseGate.failures.map((failure) => `aggregate_release_gate:${failure}`));
  if (liveArtifactValidation.aggregateGates.releaseGate.readyForLiveAutomation !== true) {
    failures.push("aggregate_release_gate:not_ready_for_live_automation");
  }
  if (liveArtifactValidation.aggregateGates.releaseGate.parseError) {
    failures.push(`aggregate_release_gate_parse_error:${liveArtifactValidation.aggregateGates.releaseGate.parseError}`);
  }
  failures.push(...liveArtifactValidation.aggregateGates.acceptancePackage.blockers.map((blocker) => `aggregate_acceptance:${blocker}`));
  failures.push(...liveArtifactValidation.aggregateGates.acceptancePackage.residualRisks.map((risk) => `aggregate_acceptance_residual_risk:${risk}`));
  if (liveArtifactValidation.aggregateGates.acceptancePackage.passed !== true) {
    failures.push("aggregate_acceptance:not_passed");
  }
  if (liveArtifactValidation.aggregateGates.acceptancePackage.parseError) {
    failures.push(`aggregate_acceptance_parse_error:${liveArtifactValidation.aggregateGates.acceptancePackage.parseError}`);
  }

  return {
    schemaVersion: "roadmap-completion-audit/v1",
    roadmapCompliancePassed: roadmapCompliance.passed,
    complete: failures.length === 0,
    roadmapBlockers,
    prdBlockers,
    resolvedRoadmapRows,
    resolvedPrdRows,
    missingLiveArtifacts,
    liveArtifactValidation,
    failures
  };
}

function buildCompletionAuditRow(input: {
  row: { id: string; status: string; evidence: string };
  reason: string;
  requiredLiveChecks: string[];
  validation: RoadmapCompletionAuditReport["liveArtifactValidation"];
}): CompletionAuditRow {
  const requiredLiveChecks = [...new Set(input.requiredLiveChecks)];
  return {
    id: input.row.id,
    status: input.row.status,
    evidence: input.row.evidence,
    reason: input.reason,
    requiredLiveChecks,
    missingLiveChecks: requiredLiveChecks.filter((check) => !liveCheckPassed(check, input.validation))
  };
}

function requiredRoadmapChecks(id: string): string[] {
  const base = ["runtime:production_environment", "aggregate:acceptance_package"];
  const bySprint: Record<string, string[]> = {
    "1": ["runtime:postgres_state_backend", "release_evidence:seven_day_soak_passed"],
    "2": ["runtime:postgres_state_backend", "runtime:bullmq_queue_backend", "release_evidence:seven_day_soak_passed"],
    "6": ["runtime:live_llm_provider", "runtime:llm_api_configured"],
    "9": ["release_evidence:live_credentials_configured", "release_evidence:live_canaries_passing"],
    "10": ["release_evidence:live_credentials_configured", "release_evidence:live_canaries_passing"],
    "14": ["release_evidence:seven_day_soak_passed"],
    "15": ["runtime:s3_object_storage_configured", "release_evidence:external_secrets_backend", "release_evidence:live_credentials_configured"],
    "16": ["release_evidence:live_canaries_passing"],
    "20": ["release_evidence:live_canaries_passing", "release_evidence:seven_day_soak_passed"],
    "23": ["aggregate:release_gate", "release_evidence:live_credentials_configured", "release_evidence:provider_submit_proof_ready"],
    "24": ["runtime:controlled_or_full_auto_apply_mode", "runtime:irreversible_actions_enabled", "aggregate:release_gate"],
    "25": ["release_evidence:live_canaries_passing", "aggregate:release_gate"],
    "29": ["release_evidence:outbound_dispatch_proof_ready"],
    "30": ["runtime:controlled_or_full_auto_apply_mode", "release_evidence:outbound_dispatch_proof_ready", "aggregate:ga_signoff"],
    "33": ["release_evidence:calendar_integration_ready", "release_evidence:outbound_dispatch_proof_ready"],
    "35": ["runtime:external_secrets_backend", "release_evidence:external_secrets_backend", "aggregate:ga_signoff"],
    "36": [
      "runtime:postgres_state_backend",
      "runtime:telegram_bot_configured",
      "runtime:telegram_webhook_secret_configured",
      "runtime:s3_object_storage_configured",
      "aggregate:release_gate"
    ],
    "38": ["release_evidence:seven_day_soak_passed", "aggregate:ga_signoff"]
  };
  return [...base, ...(bySprint[id] ?? [])];
}

function requiredPrdChecks(id: string): string[] {
  const base = ["runtime:production_environment", "aggregate:acceptance_package"];
  const byArea: Record<string, string[]> = {
    "Irreversible actions": ["runtime:controlled_or_full_auto_apply_mode", "runtime:irreversible_actions_enabled", "aggregate:release_gate"],
    "Outbound recruiter replies": ["release_evidence:outbound_dispatch_proof_ready"],
    "Interview coordination": ["release_evidence:calendar_integration_ready", "release_evidence:outbound_dispatch_proof_ready"],
    "Proof artifacts": ["release_evidence:outbound_dispatch_proof_ready", "release_evidence:seven_day_soak_passed"],
    Queues: ["runtime:bullmq_queue_backend"],
    Observability: ["release_evidence:seven_day_soak_passed"],
    "Live providers/accounts/Telegram/calendar/secrets": [
      "runtime:telegram_bot_configured",
      "runtime:telegram_webhook_secret_configured",
      "release_evidence:live_credentials_configured",
      "release_evidence:external_secrets_backend",
      "release_evidence:live_canaries_passing",
      "release_evidence:calendar_integration_ready"
    ]
  };
  return [...base, ...(byArea[id] ?? [])];
}

function liveCheckPassed(check: string, validation: RoadmapCompletionAuditReport["liveArtifactValidation"]): boolean {
  switch (check) {
    case "aggregate:acceptance_package":
      return validation.aggregateGates.acceptancePackage.passed === true;
    case "aggregate:release_gate":
      return validation.aggregateGates.releaseGate.readyForLiveAutomation === true;
    case "aggregate:ga_signoff":
      return validation.aggregateGates.acceptancePackage.gaSignoffPassed === true && validation.gaSignoff.blockers.length === 0;
    case "runtime:production_environment":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("production_environment_required") && validation.runtime.parseError === null;
    case "runtime:controlled_or_full_auto_apply_mode":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("controlled_or_full_auto_apply_mode_required") && validation.runtime.parseError === null;
    case "runtime:irreversible_actions_enabled":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("irreversible_actions_enabled_required") && validation.runtime.parseError === null;
    case "runtime:external_secrets_backend":
      return (
        runtimePreflightPassed(validation) &&
        !validation.runtime.blockers.includes("external_secrets_backend_required") &&
        !validation.runtime.blockers.includes("local_encrypted_file_master_key_required") &&
        validation.runtime.parseError === null
      );
    case "runtime:s3_object_storage_configured":
      return (
        runtimePreflightPassed(validation) &&
        validation.runtime.s3ObjectStorageConfigured === true &&
        !validation.runtime.blockers.includes("s3_object_storage_required") &&
        validation.runtime.parseError === null
      );
    case "runtime:postgres_state_backend":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("postgres_state_backend_required") && validation.runtime.parseError === null;
    case "runtime:bullmq_queue_backend":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("bullmq_queue_backend_required") && validation.runtime.parseError === null;
    case "runtime:telegram_bot_configured":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("telegram_bot_token_required") && validation.runtime.parseError === null;
    case "runtime:telegram_webhook_secret_configured":
      return (
        runtimePreflightPassed(validation) &&
        validation.runtime.telegramWebhookSecretConfigured === true &&
        !validation.runtime.blockers.includes("telegram_webhook_secret_required") &&
        validation.runtime.parseError === null
      );
    case "runtime:live_llm_provider":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("live_llm_provider_required") && validation.runtime.parseError === null;
    case "runtime:llm_api_configured":
      return runtimePreflightPassed(validation) && !validation.runtime.blockers.includes("llm_api_configuration_required") && validation.runtime.parseError === null;
    case "release_evidence:live_credentials_configured":
      return validation.releaseEvidence.capabilities.liveCredentialsConfigured;
    case "release_evidence:external_secrets_backend":
      return validation.releaseEvidence.capabilities.externalSecretsBackend;
    case "release_evidence:live_canaries_passing":
      return validation.releaseEvidence.capabilities.liveCanariesPassing;
    case "release_evidence:provider_submit_proof_ready":
      return validation.releaseEvidence.capabilities.providerSubmitProofReady;
    case "release_evidence:calendar_integration_ready":
      return validation.releaseEvidence.capabilities.calendarIntegrationReady;
    case "release_evidence:seven_day_soak_passed":
      return validation.releaseEvidence.capabilities.sevenDaySoakPassed;
    case "release_evidence:outbound_dispatch_proof_ready":
      return validation.releaseEvidence.capabilities.outboundDispatchProofReady;
    default:
      return false;
  }
}

function runtimePreflightPassed(validation: RoadmapCompletionAuditReport["liveArtifactValidation"]): boolean {
  return (
    validation.runtime.preflight.passed === true &&
    validation.runtime.preflight.externalProbesRun === true &&
    validation.runtime.preflight.configMatches === true &&
    validation.runtime.preflight.fresh === true &&
    validation.runtime.preflight.parseError === null
  );
}

function validateLiveArtifacts(input: {
  releaseEvidencePath: string;
  gaSignoffPath: string;
  runtimePreflightPath: string;
  runtimePreflightMaxAgeHours: number;
  env: NodeJS.ProcessEnv;
  now: Date;
}): RoadmapCompletionAuditReport["liveArtifactValidation"] {
  const emptyCapabilities = {
    liveCredentialsConfigured: false,
      externalSecretsBackend: false,
      liveCanariesPassing: false,
      providerSubmitProofReady: false,
      calendarIntegrationReady: false,
    sevenDaySoakPassed: false,
    outboundDispatchProofReady: false
  };
  const expectedProviderIds = createFixtureProviderRegistry().list().map((provider) => provider.providerId);
  const releaseEvidence = {
    path: input.releaseEvidencePath,
    present: existsSync(input.releaseEvidencePath),
    records: 0,
    acceptedEvidenceIds: [] as string[],
    invalidEvidenceIds: [] as string[],
    capabilities: { ...emptyCapabilities },
    blockers: [] as string[],
    parseError: null as string | null
  };
  if (releaseEvidence.present) {
    try {
      const records = parseReleaseEvidenceRecords(readFileSync(input.releaseEvidencePath, "utf8"));
      const summary = new ReleaseEvidenceEvaluator().summarize({ records, expectedProviderIds, now: input.now });
      releaseEvidence.records = records.length;
      releaseEvidence.acceptedEvidenceIds = summary.acceptedEvidenceIds;
      releaseEvidence.invalidEvidenceIds = summary.invalidEvidenceIds;
      releaseEvidence.capabilities = {
        liveCredentialsConfigured: summary.liveCredentialsConfigured,
        externalSecretsBackend: summary.externalSecretsBackend,
        liveCanariesPassing: summary.liveCanariesPassing,
        providerSubmitProofReady: summary.providerSubmitProofReady,
        calendarIntegrationReady: summary.calendarIntegrationReady,
        sevenDaySoakPassed: summary.sevenDaySoakPassed,
        outboundDispatchProofReady: summary.outboundDispatchProofReady
      };
      releaseEvidence.blockers = summary.blockers;
    } catch (error) {
      releaseEvidence.parseError = errorMessage(error);
    }
  }

  const gaSignoff = {
    path: input.gaSignoffPath,
    present: existsSync(input.gaSignoffPath),
    explicitSignoffProvided: false,
    blockers: [] as string[],
    parseError: null as string | null
  };
  if (gaSignoff.present) {
    try {
      const checklist = buildGaSignoffChecklist({ signoff: parseGaSignoffFile(readFileSync(input.gaSignoffPath, "utf8")), now: input.now });
      gaSignoff.explicitSignoffProvided = checklist.explicitSignoffProvided;
      gaSignoff.blockers = checklist.blockers;
    } catch (error) {
      gaSignoff.parseError = errorMessage(error);
    }
  }

  const runtime = {
    environment: null as string | null,
    mode: null as string | null,
    irreversibleActionsEnabled: null as boolean | null,
    stateBackend: null as string | null,
    queueBackend: null as string | null,
    secretsBackend: null as string | null,
    localEncryptedFileConfigured: null as boolean | null,
    objectStorageBackend: null as string | null,
    s3ObjectStorageConfigured: null as boolean | null,
    telegramBotConfigured: null as boolean | null,
    telegramWebhookSecretConfigured: null as boolean | null,
    llmProvider: null as string | null,
    llmApiConfigured: null as boolean | null,
    preflight: {
      path: input.runtimePreflightPath,
      present: existsSync(input.runtimePreflightPath),
      generatedAt: null as string | null,
      ageHours: null as number | null,
      maxAgeHours: input.runtimePreflightMaxAgeHours,
      fresh: null as boolean | null,
      passed: null as boolean | null,
      externalProbesRun: null as boolean | null,
      configMatches: null as boolean | null,
      failures: [] as string[],
      parseError: null as string | null
    },
    blockers: [] as string[],
    parseError: null as string | null
  };
  try {
    const config = loadConfig(input.env);
    runtime.environment = config.app.environment;
    runtime.mode = config.app.mode;
    runtime.irreversibleActionsEnabled = config.app.irreversibleActionsEnabled;
    runtime.stateBackend = config.persistence.stateBackend;
    runtime.queueBackend = config.queue.backend;
    runtime.secretsBackend = config.security.secretsBackend;
    runtime.localEncryptedFileConfigured =
      config.security.secretsBackend === "local_encrypted_file" ? config.security.localEncryptedFile.masterKeyConfigured : null;
    runtime.objectStorageBackend = config.objectStorage.backend;
    runtime.s3ObjectStorageConfigured =
      config.objectStorage.backend === "s3_compatible" &&
      Boolean(config.objectStorage.s3.endpoint) &&
      config.objectStorage.s3.bucket.length > 0 &&
      config.objectStorage.s3.region.length > 0 &&
      config.objectStorage.s3.accessKeyIdConfigured &&
      config.objectStorage.s3.secretAccessKeyConfigured;
    runtime.telegramBotConfigured = config.telegram.token.length > 0;
    runtime.telegramWebhookSecretConfigured = config.telegram.webhookSecretConfigured;
    runtime.llmProvider = config.llm.provider;
    runtime.llmApiConfigured = config.llm.provider === "openai-compatible" && Boolean(config.llm.apiBaseUrl) && config.llm.apiKey.length > 0;
    if (config.app.environment !== "production") {
      runtime.blockers.push("production_environment_required");
    }
    if (config.app.mode !== "controlled_auto_apply" && config.app.mode !== "full_auto_apply") {
      runtime.blockers.push("controlled_or_full_auto_apply_mode_required");
    }
    if (!config.app.irreversibleActionsEnabled) {
      runtime.blockers.push("irreversible_actions_enabled_required");
    }
    if (config.persistence.stateBackend !== "postgres") {
      runtime.blockers.push("postgres_state_backend_required");
    }
    if (config.queue.backend !== "bullmq") {
      runtime.blockers.push("bullmq_queue_backend_required");
    }
    if (config.security.secretsBackend === "env") {
      runtime.blockers.push("external_secrets_backend_required");
    }
    if (config.security.secretsBackend === "local_encrypted_file" && !config.security.localEncryptedFile.masterKeyConfigured) {
      runtime.blockers.push("local_encrypted_file_master_key_required");
    }
    if (!runtime.s3ObjectStorageConfigured) {
      runtime.blockers.push("s3_object_storage_required");
    }
    if (config.telegram.token.length === 0) {
      runtime.blockers.push("telegram_bot_token_required");
    }
    if (config.telegram.token.length > 0 && !config.telegram.webhookSecretConfigured) {
      runtime.blockers.push("telegram_webhook_secret_required");
    }
    if (config.llm.provider === "mock") {
      runtime.blockers.push("live_llm_provider_required");
    }
    if (config.llm.provider === "openai-compatible" && (!config.llm.apiBaseUrl || config.llm.apiKey.length === 0)) {
      runtime.blockers.push("llm_api_configuration_required");
    }
    if (runtime.preflight.present) {
      try {
        const preflight = parseRuntimePreflightReport(readFileSync(input.runtimePreflightPath, "utf8"));
        runtime.preflight.passed = preflight.passed;
        runtime.preflight.externalProbesRun = preflight.runExternalProbes;
        runtime.preflight.failures = preflight.failures;
        runtime.preflight.configMatches = runtimePreflightMatchesConfig(preflight, config, input.env);
        runtime.preflight.generatedAt = preflight.generatedAt;
        const generatedAtMs = Date.parse(preflight.generatedAt);
        if (Number.isNaN(generatedAtMs)) {
          runtime.preflight.fresh = false;
          runtime.blockers.push("runtime_preflight_invalid_generated_at");
        } else {
          const ageHours = (input.now.getTime() - generatedAtMs) / (60 * 60 * 1000);
          runtime.preflight.ageHours = Math.round(ageHours * 1000) / 1000;
          if (ageHours < 0) {
            runtime.preflight.fresh = false;
            runtime.blockers.push("runtime_preflight_generated_at_in_future");
          } else if (ageHours > input.runtimePreflightMaxAgeHours) {
            runtime.preflight.fresh = false;
            runtime.blockers.push("runtime_preflight_expired");
          } else {
            runtime.preflight.fresh = true;
          }
        }
        if (!preflight.passed) {
          runtime.blockers.push("runtime_preflight_failed");
        }
        if (!preflight.runExternalProbes) {
          runtime.blockers.push("runtime_preflight_external_probes_required");
        }
        if (!runtime.preflight.configMatches) {
          runtime.blockers.push("runtime_preflight_config_mismatch");
        }
        for (const checkName of missingOrFailedRequiredRuntimePreflightChecks(preflight, config)) {
          runtime.blockers.push(`runtime_preflight_required_check_missing_or_failed:${checkName}`);
        }
      } catch (error) {
        runtime.preflight.parseError = errorMessage(error);
        runtime.blockers.push("runtime_preflight_parse_error");
      }
    } else {
      runtime.blockers.push("runtime_preflight_report_required");
    }
  } catch (error) {
    runtime.parseError = errorMessage(error);
  }

  return {
    releaseEvidence,
    gaSignoff,
    runtime,
    aggregateGates: {
      releaseGate: { readyForLiveAutomation: null, blockers: [], failures: [], parseError: null },
      acceptancePackage: {
        passed: null,
        fixtureSoakPassed: null,
        releaseGatePassed: null,
        gaSignoffPassed: null,
        blockers: [],
        residualRisks: [],
        parseError: null
      }
    }
  };
}

async function validateAggregateGates(input: {
  releaseEvidencePath: string;
  gaSignoffPath: string;
  iterations: number;
  env: NodeJS.ProcessEnv;
  registry?: ProviderRegistry | undefined;
}): Promise<RoadmapCompletionAuditReport["liveArtifactValidation"]["aggregateGates"]> {
  const releaseGate = {
    readyForLiveAutomation: null as boolean | null,
    blockers: [] as string[],
    failures: [] as string[],
    parseError: null as string | null
  };
  const acceptancePackage = {
    passed: null as boolean | null,
    fixtureSoakPassed: null as boolean | null,
    releaseGatePassed: null as boolean | null,
    gaSignoffPassed: null as boolean | null,
    blockers: [] as string[],
    residualRisks: [] as string[],
    parseError: null as string | null
  };

  try {
    const config = loadConfig(input.env);
    const registry = input.registry ?? createRuntimeProviderRegistryWithOverrides(config.providers, input.env);
    const releaseEvidence = existsSync(input.releaseEvidencePath)
      ? parseReleaseEvidenceRecords(readFileSync(input.releaseEvidencePath, "utf8"))
      : [];
    const gaSignoff = existsSync(input.gaSignoffPath) ? parseGaSignoffFile(readFileSync(input.gaSignoffPath, "utf8")) : undefined;
    const releaseEvidenceReport = await buildReleaseEvidenceValidationReport({
      evidencePath: input.releaseEvidencePath,
      records: releaseEvidence,
      config,
      registry,
      env: input.env
    });
    releaseGate.readyForLiveAutomation = releaseEvidenceReport.releaseGate.readyForLiveAutomation;
    releaseGate.blockers = releaseEvidenceReport.releaseGate.blockers;
    releaseGate.failures = releaseEvidenceReport.failures;

    const acceptance = await buildAcceptancePackage({
      iterations: input.iterations,
      releaseEvidence,
      ...(gaSignoff ? { gaSignoff } : {}),
      config,
      registry,
      env: input.env
    });
    acceptancePackage.passed = acceptance.acceptance.passed;
    acceptancePackage.fixtureSoakPassed = acceptance.acceptance.fixtureSoakPassed;
    acceptancePackage.releaseGatePassed = acceptance.acceptance.releaseGatePassed;
    acceptancePackage.gaSignoffPassed = acceptance.acceptance.gaSignoffPassed;
    acceptancePackage.blockers = acceptance.acceptance.blockers;
    acceptancePackage.residualRisks = acceptance.acceptance.residualRisks;
  } catch (error) {
    const message = errorMessage(error);
    releaseGate.parseError = message;
    acceptancePackage.parseError = message;
  }

  return { releaseGate, acceptancePackage };
}

function readExistingFile(path: string, failures: string[]): string {
  if (!existsSync(path)) {
    failures.push(`missing_file:${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function parseMarkdownRows(contents: string): Array<{ id: string; status: string; evidence: string }> {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .map((cells) => {
      if (cells.length >= 4) {
        return { id: cells[0]!, status: cells[2]!, evidence: cells[3]! };
      }
      if (cells.length === 3) {
        return { id: cells[0]!, status: cells[1]!, evidence: cells[2]! };
      }
      return null;
    })
    .filter((row): row is { id: string; status: string; evidence: string } => row !== null)
    .filter((row) => row.id !== "Sprint" && row.id !== "PRD Area" && !/^:?-{3,}:?$/.test(row.id));
}

function prdBlockerReason(status: string): string {
  if (status === "Deferred/external") {
    return "external_integration_required";
  }
  if (status === "Local-safe only") {
    return "irreversible_live_behavior_not_enabled";
  }
  if (status === "Implemented locally") {
    return "deployment_integration_required";
  }
  return "partial_local_safe_only";
}

function runtimePreflightMatchesConfig(preflight: RuntimePreflightReport, config: RuntimeConfig, env: NodeJS.ProcessEnv): boolean {
  return (
    preflight.configSummary.environment === config.app.environment &&
    preflight.configSummary.mode === config.app.mode &&
    preflight.configSummary.irreversibleActionsEnabled === config.app.irreversibleActionsEnabled &&
    preflight.configSummary.stateBackend === config.persistence.stateBackend &&
    preflight.configSummary.queueBackend === config.queue.backend &&
    preflight.configSummary.postgresUrlHash === stableHash(config.postgres.url) &&
    preflight.configSummary.redisUrlHash === stableHash(config.redis.url) &&
    preflight.configSummary.secretsBackend === config.security.secretsBackend &&
    preflight.configSummary.localEncryptedFileConfigured ===
      (config.security.secretsBackend === "local_encrypted_file" ? config.security.localEncryptedFile.masterKeyConfigured : null) &&
    preflight.configSummary.objectStorageBackend === config.objectStorage.backend &&
    preflight.configSummary.objectStorageRootHash === (config.objectStorage.backend === "filesystem" ? stableHash(config.objectStorage.root) : null) &&
    preflight.configSummary.s3EndpointHash === (config.objectStorage.s3.endpoint ? stableHash(config.objectStorage.s3.endpoint) : null) &&
    preflight.configSummary.s3BucketHash === (config.objectStorage.s3.bucket.length > 0 ? stableHash(config.objectStorage.s3.bucket) : null) &&
    preflight.configSummary.s3Region === (config.objectStorage.s3.region.length > 0 ? config.objectStorage.s3.region : null) &&
    preflight.configSummary.s3AccessKeyIdHash ===
      (config.objectStorage.s3.accessKeyId.length > 0 ? stableHash(config.objectStorage.s3.accessKeyId) : null) &&
    preflight.configSummary.s3SecretAccessKeyConfigured === config.objectStorage.s3.secretAccessKeyConfigured &&
    preflight.configSummary.telegramBotConfigured === (config.telegram.token.length > 0) &&
    preflight.configSummary.telegramTokenHash === (config.telegram.token.length > 0 ? stableHash(config.telegram.token) : null) &&
    preflight.configSummary.telegramWebhookSecretConfigured === config.telegram.webhookSecretConfigured &&
    preflight.configSummary.telegramWebhookSecretHash === (config.telegram.webhookSecret.length > 0 ? stableHash(config.telegram.webhookSecret) : null) &&
    preflight.configSummary.llmProvider === config.llm.provider &&
    preflight.configSummary.llmApiConfigured === (config.llm.provider === "openai-compatible" && Boolean(config.llm.apiBaseUrl) && config.llm.apiKey.length > 0) &&
    preflight.configSummary.llmApiBaseUrlHash === (config.llm.apiBaseUrl ? stableHash(config.llm.apiBaseUrl) : null) &&
    JSON.stringify(preflight.configSummary.liveSubmitProviders) === JSON.stringify(liveSubmitProviderSummary(config, env))
  );
}

function missingOrFailedRequiredRuntimePreflightChecks(preflight: RuntimePreflightReport, config: RuntimeConfig): RuntimePreflightCheckName[] {
  const requiredChecks = expectedRuntimePreflightChecks(config);
  const checksByName = new Map(preflight.checks.map((check) => [check.name, check]));
  return requiredChecks.filter((name) => {
    const check = checksByName.get(name);
    return !check || !check.required || !check.passed;
  });
}

function expectedRuntimePreflightChecks(config: RuntimeConfig): RuntimePreflightCheckName[] {
  return [
    "production_environment",
    "controlled_or_full_auto_apply_mode",
    "irreversible_actions_enabled",
    ...(requiresLiveSubmitProvider(config) ? (["live_submit_provider_configured"] as const) : []),
    "postgres_state_backend",
    "bullmq_queue_backend",
    ...(config.persistence.stateBackend === "postgres" ? (["postgres_reachable"] as const) : []),
    "redis_reachable",
    "external_secrets_backend",
    ...(config.security.secretsBackend === "local_encrypted_file" ? (["local_encrypted_file_secret_store"] as const) : []),
    "s3_object_storage_configured",
    ...(config.objectStorage.backend === "s3_compatible" ? (["s3_object_storage_roundtrip"] as const) : []),
    "telegram_bot_configured",
    ...(config.telegram.token.length > 0 ? (["telegram_webhook_secret_configured"] as const) : []),
    ...(config.telegram.token.length > 0 ? (["telegram_get_me"] as const) : []),
    "live_llm_provider",
    "llm_api_configured",
    ...(config.llm.provider === "openai-compatible" && config.llm.apiBaseUrl && config.llm.apiKey.length > 0 ? (["llm_chat_completion"] as const) : [])
  ];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildRoadmapCompletionAudit({
    ...(process.env.ROADMAP_PATH ? { roadmapPath: process.env.ROADMAP_PATH } : {}),
    ...(process.env.ROADMAP_MATRIX_PATH ? { roadmapMatrixPath: process.env.ROADMAP_MATRIX_PATH } : {}),
    ...(process.env.PRD_MATRIX_PATH ? { prdMatrixPath: process.env.PRD_MATRIX_PATH } : {}),
    ...(process.env.RELEASE_EVIDENCE_PATH ? { releaseEvidencePath: process.env.RELEASE_EVIDENCE_PATH } : {}),
    ...(process.env.GA_SIGNOFF_PATH ? { gaSignoffPath: process.env.GA_SIGNOFF_PATH } : {}),
    ...(process.env.RUNTIME_PREFLIGHT_PATH ? { runtimePreflightPath: process.env.RUNTIME_PREFLIGHT_PATH } : {}),
    ...(process.env.RUNTIME_PREFLIGHT_MAX_AGE_HOURS ? { runtimePreflightMaxAgeHours: parsePositiveNumber(process.env.RUNTIME_PREFLIGHT_MAX_AGE_HOURS) } : {}),
    ...(process.env.ACCEPTANCE_ITERATIONS ? { acceptanceIterations: parsePositiveInteger(process.env.ACCEPTANCE_ITERATIONS) } : {})
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.ROADMAP_COMPLETION_AUDIT_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.ROADMAP_COMPLETION_AUDIT_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.ROADMAP_COMPLETION_AUDIT_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.complete) {
    process.exitCode = 1;
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}
