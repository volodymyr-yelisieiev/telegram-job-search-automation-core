import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRoadmapCompletionAudit, type CompletionAuditRow, type RoadmapCompletionAuditReport } from "./roadmap-completion-audit";

const liveProofInputEnvKeys = [
  "LIVE_PROOF_INPUTS_ASSERT_LIVE",
  "EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH",
  "EXTERNAL_SECRETS_EVIDENCE_SOURCE",
  "CANARY_EVIDENCE_RESULTS_PATH",
  "CANARY_EVIDENCE_SOURCE",
  "PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH",
  "PROVIDER_SUBMIT_EVIDENCE_SOURCE",
  "CALENDAR_EVIDENCE_INPUT_PATH",
  "CALENDAR_EVIDENCE_SOURCE",
  "OUTBOUND_EVIDENCE_INPUT_PATH",
  "OUTBOUND_EVIDENCE_SOURCE",
  "SOAK_EVIDENCE_INPUT_PATH",
  "SOAK_EVIDENCE_SOURCE"
] as const;

const liveProofInputEnvAssignments =
  "LIVE_PROOF_INPUTS_ASSERT_LIVE=true EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH=live-secrets-probe.json EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url> CANARY_EVIDENCE_RESULTS_PATH=live-canary-results.json CANARY_EVIDENCE_SOURCE=<live-workflow-url> PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH=live-provider-submit-proof.json PROVIDER_SUBMIT_EVIDENCE_SOURCE=<live-workflow-url> CALENDAR_EVIDENCE_INPUT_PATH=live-calendar-smoke.json CALENDAR_EVIDENCE_SOURCE=<live-workflow-url> OUTBOUND_EVIDENCE_INPUT_PATH=live-dispatch-proof.json OUTBOUND_EVIDENCE_SOURCE=<live-workflow-url> SOAK_EVIDENCE_INPUT_PATH=live-7-day-soak.json SOAK_EVIDENCE_SOURCE=<live-workflow-url>";

export interface LiveCompletionActionGroup {
  id: string;
  title: string;
  status: "complete" | "pending";
  missingChecks: string[];
  blockingRowRefs: {
    roadmap: string[];
    prd: string[];
  };
  requiredArtifacts: string[];
  requiredEnvKeys: string[];
  commands: string[];
  notes: string[];
}

export interface LiveCompletionPlanReport {
  schemaVersion: "live-completion-plan/v1";
  generatedAt: string;
  auditComplete: boolean;
  missingArtifacts: string[];
  missingChecks: string[];
  runtimeBlockers: string[];
  releaseEvidenceBlockers: string[];
  gaSignoffBlockers: string[];
  acceptanceBlockers: string[];
  actionGroups: LiveCompletionActionGroup[];
  blockingRows: {
    roadmap: Array<Pick<CompletionAuditRow, "id" | "status" | "missingLiveChecks">>;
    prd: Array<Pick<CompletionAuditRow, "id" | "status" | "missingLiveChecks">>;
  };
}

export async function buildLiveCompletionPlan(input: {
  releaseEvidencePath?: string;
  gaSignoffPath?: string;
  runtimePreflightPath?: string;
  runtimePreflightMaxAgeHours?: number;
  acceptanceIterations?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<LiveCompletionPlanReport> {
  const now = input.now ?? new Date();
  const audit = await buildRoadmapCompletionAudit({
    ...(input.releaseEvidencePath ? { releaseEvidencePath: input.releaseEvidencePath } : {}),
    ...(input.gaSignoffPath ? { gaSignoffPath: input.gaSignoffPath } : {}),
    ...(input.runtimePreflightPath ? { runtimePreflightPath: input.runtimePreflightPath } : {}),
    ...(input.runtimePreflightMaxAgeHours ? { runtimePreflightMaxAgeHours: input.runtimePreflightMaxAgeHours } : {}),
    ...(input.acceptanceIterations ? { acceptanceIterations: input.acceptanceIterations } : {}),
    env: input.env ?? process.env,
    now
  });
  const missingChecks = collectMissingChecks(audit);
  const runtimeMissingChecks = missingChecks.filter((check) => check.startsWith("runtime:"));
  const releaseMissingChecks = missingChecks.filter((check) => check.startsWith("release_evidence:"));
  const gaMissingChecks = missingChecks.filter((check) => check === "aggregate:ga_signoff");
  const acceptanceMissingChecks = missingChecks.filter((check) => check === "aggregate:acceptance_package" || check === "aggregate:release_gate");
  return {
    schemaVersion: "live-completion-plan/v1",
    generatedAt: now.toISOString(),
    auditComplete: audit.complete,
    missingArtifacts: audit.missingLiveArtifacts,
    missingChecks,
    runtimeBlockers: audit.liveArtifactValidation.runtime.blockers,
    releaseEvidenceBlockers: audit.liveArtifactValidation.releaseEvidence.blockers,
    gaSignoffBlockers: audit.liveArtifactValidation.gaSignoff.blockers,
    acceptanceBlockers: audit.liveArtifactValidation.aggregateGates.acceptancePackage.blockers,
    actionGroups: [
      runtimeActionGroup(audit, runtimeMissingChecks),
      releaseEvidenceActionGroup(audit, releaseMissingChecks),
      gaSignoffActionGroup(audit, gaMissingChecks),
      finalAuditActionGroup(audit, acceptanceMissingChecks)
    ],
    blockingRows: {
      roadmap: audit.roadmapBlockers.map(compactRow),
      prd: audit.prdBlockers.map(compactRow)
    }
  };
}

function runtimeActionGroup(audit: RoadmapCompletionAuditReport, missingChecks: string[]): LiveCompletionActionGroup {
  const runtimeMissing = missingChecks.length > 0 || audit.missingLiveArtifacts.some((artifact) => artifact.startsWith("missing_runtime_preflight_file:"));
  return {
    id: "runtime_preflight",
    title: "Generate fresh production runtime preflight",
    status: runtimeMissing ? "pending" : "complete",
    missingChecks,
    blockingRowRefs: blockingRowsForChecks(audit, missingChecks),
    requiredArtifacts: ["runtime-preflight.json"],
    requiredEnvKeys: [
      "NODE_ENV",
      "API_TOKEN",
      "APP_MODE",
      "IRREVERSIBLE_ACTIONS_ENABLED",
      "STATE_BACKEND",
      "DATABASE_URL",
      "QUEUE_BACKEND",
      "REDIS_URL",
      "SECRETS_BACKEND",
      "PROVIDER_CONFIG_JSON",
      "HH_SUBMIT_TOKEN",
      "ROBOTA_SUBMIT_TOKEN",
      "OBJECT_STORAGE_BACKEND",
      "OBJECT_STORAGE_S3_ENDPOINT",
      "OBJECT_STORAGE_S3_BUCKET",
      "OBJECT_STORAGE_S3_REGION",
      "OBJECT_STORAGE_S3_ACCESS_KEY_ID",
      "OBJECT_STORAGE_S3_SECRET_ACCESS_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "TELEGRAM_WEBHOOK_SECRET",
      "LLM_PROVIDER",
      "LLM_API_BASE_URL",
      "LLM_API_KEY",
      "RUNTIME_PREFLIGHT_OUTPUT_PATH"
    ],
    commands: [
      "NODE_ENV=production API_TOKEN=<prod-token> APP_MODE=controlled_auto_apply IRREVERSIBLE_ACTIONS_ENABLED=true STATE_BACKEND=postgres DATABASE_URL=<postgres-url> QUEUE_BACKEND=bullmq REDIS_URL=<redis-url> SECRETS_BACKEND=<approved-backend> PROVIDER_CONFIG_JSON='[{\"providerId\":\"hh\",\"enabled\":true,\"runtimeKind\":\"live\",\"statusOverride\":\"stable\",\"liveSubmitEndpoint\":\"<submit-endpoint>\",\"liveSubmitAuthTokenEnv\":\"HH_SUBMIT_TOKEN\"},{\"providerId\":\"robota\",\"enabled\":true,\"runtimeKind\":\"live\",\"statusOverride\":\"stable\",\"liveSubmitEndpoint\":\"<submit-endpoint>\",\"liveSubmitAuthTokenEnv\":\"ROBOTA_SUBMIT_TOKEN\"}]' HH_SUBMIT_TOKEN=<hh-submit-token> ROBOTA_SUBMIT_TOKEN=<robota-submit-token> OBJECT_STORAGE_BACKEND=s3_compatible OBJECT_STORAGE_S3_ENDPOINT=<s3-url> OBJECT_STORAGE_S3_BUCKET=<bucket> OBJECT_STORAGE_S3_REGION=<region> OBJECT_STORAGE_S3_ACCESS_KEY_ID=<access-key-id> OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=<secret-access-key> TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_ALLOWED_USER_IDS=<user-ids> TELEGRAM_WEBHOOK_SECRET=<webhook-secret> LLM_PROVIDER=openai-compatible LLM_API_BASE_URL=<llm-url> LLM_API_KEY=<llm-key> RUNTIME_PREFLIGHT_OUTPUT_PATH=runtime-preflight.json pnpm runtime:preflight"
    ],
    notes: [
      "Run with real production or approved staging endpoints and credentials.",
      "The generated preflight must match the final audit environment and stay inside the freshness window."
    ]
  };
}

function releaseEvidenceActionGroup(audit: RoadmapCompletionAuditReport, missingChecks: string[]): LiveCompletionActionGroup {
  const releaseMissing = missingChecks.length > 0 || audit.missingLiveArtifacts.some((artifact) => artifact.startsWith("missing_release_evidence_file:"));
  return {
    id: "release_evidence",
    title: "Record expiring live release evidence",
    status: releaseMissing ? "pending" : "complete",
    missingChecks,
    blockingRowRefs: blockingRowsForChecks(audit, missingChecks),
    requiredArtifacts: releaseEvidenceArtifacts(missingChecks),
    requiredEnvKeys: [
      "RELEASE_EVIDENCE_PATH",
      ...liveProofInputEnvKeys,
      "EXTERNAL_SECRETS_EVIDENCE_ASSERT_LIVE",
      "EXTERNAL_SECRETS_EVIDENCE_APPEND_RELEASE_EVIDENCE",
      "CANARY_EVIDENCE_ASSERT_LIVE",
      "CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE",
      "CANARY_SMOKE_TARGETS_JSON",
      "CANARY_SMOKE_EXPECTED_PROVIDER_IDS",
      "CANARY_SMOKE_SOURCE",
      "CANARY_SMOKE_CONFIRM_LIVE",
      "PROVIDER_SUBMIT_EVIDENCE_ASSERT_LIVE",
      "PROVIDER_SUBMIT_EVIDENCE_APPEND_RELEASE_EVIDENCE",
      "CALENDAR_EVIDENCE_ASSERT_LIVE",
      "CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE",
      "GOOGLE_CALENDAR_ACCESS_TOKEN",
      "GOOGLE_CALENDAR_ID",
      "GOOGLE_CALENDAR_SMOKE_TIME_MIN",
      "GOOGLE_CALENDAR_SMOKE_TIME_MAX",
      "GOOGLE_CALENDAR_SMOKE_SOURCE",
      "GOOGLE_CALENDAR_SMOKE_CONFIRM_LIVE",
      "OUTBOUND_EVIDENCE_ASSERT_LIVE",
      "OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_DISPATCH_CHAT_ID",
      "TELEGRAM_DISPATCH_TEXT",
      "TELEGRAM_DISPATCH_SOURCE",
      "TELEGRAM_DISPATCH_CONFIRM_LIVE",
      "SOAK_EVIDENCE_ASSERT_LIVE",
      "SOAK_EVIDENCE_APPEND_RELEASE_EVIDENCE"
    ],
    commands: releaseEvidenceCommands(missingChecks),
    notes: [
      "Use externally captured live artifacts or explicit-confirm smoke commands only.",
      "Evidence ingesters reject fixture sources, raw secret-like values, stale timestamps, and non-expiring claims."
    ]
  };
}

function gaSignoffActionGroup(audit: RoadmapCompletionAuditReport, missingChecks: string[]): LiveCompletionActionGroup {
  const signoffMissing = missingChecks.length > 0 || audit.missingLiveArtifacts.some((artifact) => artifact.startsWith("missing_ga_signoff_file:"));
  return {
    id: "ga_signoff",
    title: "Collect real GA sign-off",
    status: signoffMissing ? "pending" : "complete",
    missingChecks,
    blockingRowRefs: blockingRowsForChecks(audit, missingChecks),
    requiredArtifacts: ["ga-signoff.json"],
    requiredEnvKeys: ["GA_SIGNOFF_PATH"],
    commands: ["GA_SIGNOFF_PATH=ga-signoff.json pnpm ga-signoff:validate"],
    notes: [
      "Sign-off must include product, engineering, operations, and security decisions.",
      "Evidence refs must point to the real issue register, runbook drill report, residual-risk record, and maintenance plan."
    ]
  };
}

function finalAuditActionGroup(audit: RoadmapCompletionAuditReport, missingChecks: string[]): LiveCompletionActionGroup {
  return {
    id: "final_acceptance_audit",
    title: "Run fail-closed acceptance and roadmap completion audit",
    status: audit.complete ? "complete" : "pending",
    missingChecks,
    blockingRowRefs: blockingRowsForChecks(audit, missingChecks),
    requiredArtifacts: ["release-evidence.json", "ga-signoff.json", "runtime-preflight.json"],
    requiredEnvKeys: [
      "RELEASE_EVIDENCE_PATH",
      "GA_SIGNOFF_PATH",
      "RUNTIME_PREFLIGHT_PATH",
      "ACCEPTANCE_ITERATIONS",
      "LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE",
      ...liveProofInputEnvKeys
    ],
    commands: [
      "RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 pnpm acceptance:package",
      `${liveProofInputEnvAssignments} RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true pnpm roadmap:live-acceptance`,
      "RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 pnpm roadmap:completion-audit"
    ],
    notes: ["This is the only machine gate that can mark the roadmap complete."]
  };
}

function releaseEvidenceCommands(missingChecks: string[]): string[] {
  const commands: string[] = [];
  const needs = new Set(missingChecks);
  if (needs.size > 0) {
    commands.push(`${liveProofInputEnvAssignments} pnpm release:live-inputs:validate`);
  }
  if (needs.has("release_evidence:live_credentials_configured") || needs.has("release_evidence:external_secrets_backend")) {
    commands.push("EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH=live-secrets-probe.json EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url> EXTERNAL_SECRETS_EVIDENCE_ASSERT_LIVE=true EXTERNAL_SECRETS_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm secrets:evidence");
  }
  if (needs.has("release_evidence:live_canaries_passing")) {
    commands.push("CANARY_EVIDENCE_RESULTS_PATH=live-canary-results.json CANARY_EVIDENCE_SOURCE=<live-workflow-url> CANARY_EVIDENCE_ASSERT_LIVE=true CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm canary:evidence");
    commands.push("CANARY_SMOKE_TARGETS_JSON='<targets-json>' CANARY_SMOKE_EXPECTED_PROVIDER_IDS=hh,robota,telegram CANARY_SMOKE_SOURCE=<live-workflow-url> CANARY_SMOKE_CONFIRM_LIVE=true CANARY_EVIDENCE_ASSERT_LIVE=true CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json TELEGRAM_BOT_TOKEN=<bot-token> pnpm canary:live-smoke");
  }
  if (needs.has("release_evidence:provider_submit_proof_ready")) {
    commands.push("PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH=live-provider-submit-proof.json PROVIDER_SUBMIT_EVIDENCE_SOURCE=<live-workflow-url> PROVIDER_SUBMIT_EVIDENCE_ASSERT_LIVE=true PROVIDER_SUBMIT_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm provider-submit:evidence");
  }
  if (needs.has("release_evidence:calendar_integration_ready")) {
    commands.push("CALENDAR_EVIDENCE_INPUT_PATH=live-calendar-smoke.json CALENDAR_EVIDENCE_SOURCE=<live-workflow-url> CALENDAR_EVIDENCE_ASSERT_LIVE=true CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm calendar:evidence");
    commands.push("GOOGLE_CALENDAR_ACCESS_TOKEN=<oauth-token> GOOGLE_CALENDAR_ID=<calendar-id> GOOGLE_CALENDAR_SMOKE_TIME_MIN=<iso-start> GOOGLE_CALENDAR_SMOKE_TIME_MAX=<iso-end> GOOGLE_CALENDAR_SMOKE_SOURCE=<live-workflow-url> GOOGLE_CALENDAR_SMOKE_CONFIRM_LIVE=true CALENDAR_EVIDENCE_ASSERT_LIVE=true CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm google-calendar:smoke");
  }
  if (needs.has("release_evidence:outbound_dispatch_proof_ready")) {
    commands.push("OUTBOUND_EVIDENCE_INPUT_PATH=live-dispatch-proof.json OUTBOUND_EVIDENCE_SOURCE=<live-workflow-url> OUTBOUND_EVIDENCE_ASSERT_LIVE=true OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm outbound:evidence");
    commands.push("TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_DISPATCH_CHAT_ID=<chat-id> TELEGRAM_DISPATCH_TEXT=<approved-text> TELEGRAM_DISPATCH_SOURCE=<live-workflow-url> TELEGRAM_DISPATCH_CONFIRM_LIVE=true OUTBOUND_EVIDENCE_ASSERT_LIVE=true OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm telegram:dispatch-smoke");
  }
  if (needs.has("release_evidence:seven_day_soak_passed")) {
    commands.push("SOAK_EVIDENCE_INPUT_PATH=live-7-day-soak.json SOAK_EVIDENCE_SOURCE=<live-workflow-url> SOAK_EVIDENCE_ASSERT_LIVE=true SOAK_EVIDENCE_APPEND_RELEASE_EVIDENCE=true RELEASE_EVIDENCE_PATH=release-evidence.json pnpm soak:evidence");
  }
  return commands.length > 0 ? commands : ["RELEASE_EVIDENCE_PATH=release-evidence.json pnpm release:evidence:validate"];
}

function releaseEvidenceArtifacts(missingChecks: string[]): string[] {
  const artifacts = new Set(["release-evidence.json"]);
  const needs = new Set(missingChecks);
  if (needs.has("release_evidence:live_credentials_configured") || needs.has("release_evidence:external_secrets_backend")) {
    artifacts.add("live-secrets-probe.json");
  }
  if (needs.has("release_evidence:live_canaries_passing")) {
    artifacts.add("live-canary-results.json");
  }
  if (needs.has("release_evidence:provider_submit_proof_ready")) {
    artifacts.add("live-provider-submit-proof.json");
  }
  if (needs.has("release_evidence:calendar_integration_ready")) {
    artifacts.add("live-calendar-smoke.json");
  }
  if (needs.has("release_evidence:outbound_dispatch_proof_ready")) {
    artifacts.add("live-dispatch-proof.json");
  }
  if (needs.has("release_evidence:seven_day_soak_passed")) {
    artifacts.add("live-7-day-soak.json");
  }
  return [...artifacts];
}

function collectMissingChecks(audit: RoadmapCompletionAuditReport): string[] {
  return [
    ...audit.roadmapBlockers.flatMap((row) => row.missingLiveChecks),
    ...audit.prdBlockers.flatMap((row) => row.missingLiveChecks)
  ].filter(unique).sort();
}

function blockingRowsForChecks(
  audit: RoadmapCompletionAuditReport,
  checks: string[]
): LiveCompletionActionGroup["blockingRowRefs"] {
  const needs = new Set(checks);
  return {
    roadmap: audit.roadmapBlockers
      .filter((row) => row.missingLiveChecks.some((check) => needs.has(check)))
      .map((row) => row.id),
    prd: audit.prdBlockers
      .filter((row) => row.missingLiveChecks.some((check) => needs.has(check)))
      .map((row) => row.id)
  };
}

function compactRow(row: CompletionAuditRow): Pick<CompletionAuditRow, "id" | "status" | "missingLiveChecks"> {
  return {
    id: row.id,
    status: row.status,
    missingLiveChecks: row.missingLiveChecks
  };
}

function unique(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildLiveCompletionPlan({
    ...(process.env.RELEASE_EVIDENCE_PATH ? { releaseEvidencePath: process.env.RELEASE_EVIDENCE_PATH } : {}),
    ...(process.env.GA_SIGNOFF_PATH ? { gaSignoffPath: process.env.GA_SIGNOFF_PATH } : {}),
    ...(process.env.RUNTIME_PREFLIGHT_PATH ? { runtimePreflightPath: process.env.RUNTIME_PREFLIGHT_PATH } : {}),
    ...(process.env.RUNTIME_PREFLIGHT_MAX_AGE_HOURS ? { runtimePreflightMaxAgeHours: Number(process.env.RUNTIME_PREFLIGHT_MAX_AGE_HOURS) } : {}),
    ...(process.env.ACCEPTANCE_ITERATIONS ? { acceptanceIterations: Number(process.env.ACCEPTANCE_ITERATIONS) } : {})
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.LIVE_COMPLETION_PLAN_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.LIVE_COMPLETION_PLAN_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.LIVE_COMPLETION_PLAN_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (process.env.LIVE_COMPLETION_PLAN_REQUIRE_READY === "true" && !report.auditComplete) {
    process.exitCode = 1;
  }
}
