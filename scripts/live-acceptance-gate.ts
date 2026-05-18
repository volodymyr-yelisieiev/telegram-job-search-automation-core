import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import {
  buildAcceptancePackage,
  loadGaSignoffFile,
  loadReleaseEvidenceFile,
  type AcceptancePackage
} from "./acceptance-package";
import { buildGaSignoffValidationReport, type GaSignoffValidationReport } from "./ga-signoff-validate";
import { buildLiveProofInputsValidationReport, type LiveProofInputsValidationReport } from "./live-proof-inputs-validate";
import { buildReleaseEvidenceValidationReport, type ReleaseEvidenceValidationReport } from "./release-evidence-validate";
import { buildRoadmapCompletionAudit, type RoadmapCompletionAuditReport } from "./roadmap-completion-audit";

export interface LiveAcceptanceGateCheck {
  id:
    | "runtime_config"
    | "live_proof_inputs"
    | "release_evidence"
    | "ga_signoff"
    | "acceptance_package"
    | "roadmap_completion_audit";
  required: boolean;
  passed: boolean;
  failures: string[];
}

export interface LiveAcceptanceGateReport {
  schemaVersion: "live-acceptance-gate/v1";
  generatedAt: string;
  paths: {
    releaseEvidence: string;
    gaSignoff: string;
    runtimePreflight: string;
  };
  validateLiveInputs: boolean;
  acceptanceIterations: number;
  runtimePreflightMaxAgeHours: number;
  checks: LiveAcceptanceGateCheck[];
  liveProofInputs: LiveProofInputsValidationReport | null;
  releaseEvidence: Pick<ReleaseEvidenceValidationReport, "valid" | "records" | "failures" | "releaseGate"> | null;
  gaSignoff: Pick<GaSignoffValidationReport, "valid" | "present" | "explicitSignoffProvided" | "signers" | "blockers" | "parseError"> | null;
  acceptance: Pick<AcceptancePackage, "environment" | "mode" | "irreversibleActionsEnabled" | "acceptance"> | null;
  completionAudit: Pick<
    RoadmapCompletionAuditReport,
    "complete" | "missingLiveArtifacts" | "roadmapBlockers" | "prdBlockers" | "failures"
  > | null;
  passed: boolean;
  failures: string[];
}

export async function buildLiveAcceptanceGateReport(input: {
  releaseEvidencePath?: string;
  gaSignoffPath?: string;
  runtimePreflightPath?: string;
  runtimePreflightMaxAgeHours?: number;
  acceptanceIterations?: number;
  validateLiveInputs?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<LiveAcceptanceGateReport> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const releaseEvidencePath = input.releaseEvidencePath ?? env.RELEASE_EVIDENCE_PATH ?? "release-evidence.json";
  const gaSignoffPath = input.gaSignoffPath ?? env.GA_SIGNOFF_PATH ?? "ga-signoff.json";
  const runtimePreflightPath = input.runtimePreflightPath ?? env.RUNTIME_PREFLIGHT_PATH ?? "runtime-preflight.json";
  const acceptanceIterations = input.acceptanceIterations ?? parsePositiveInteger(env.ACCEPTANCE_ITERATIONS, 7);
  const runtimePreflightMaxAgeHours = input.runtimePreflightMaxAgeHours ?? parsePositiveNumber(env.RUNTIME_PREFLIGHT_MAX_AGE_HOURS, 24);
  const validateLiveInputs = input.validateLiveInputs ?? env.LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE === "true";
  const checks: LiveAcceptanceGateCheck[] = [];

  const configResult = loadRuntimeConfig(env);
  checks.push({
    id: "runtime_config",
    required: true,
    passed: configResult.config !== null,
    failures: configResult.config ? [] : [configResult.error ?? "runtime_config_invalid"]
  });

  let liveProofInputs: LiveProofInputsValidationReport | null = null;
  if (validateLiveInputs) {
    liveProofInputs = buildLiveProofInputsValidationReport({ env, now });
    checks.push({
      id: "live_proof_inputs",
      required: true,
      passed: liveProofInputs.passed,
      failures: liveProofInputs.failures
    });
  } else {
    checks.push({
      id: "live_proof_inputs",
      required: false,
      passed: true,
      failures: []
    });
  }

  const releaseEvidenceResult = await validateReleaseEvidence({
    config: configResult.config,
    evidencePath: releaseEvidencePath,
    env,
    now
  });
  checks.push(releaseEvidenceResult.check);

  const gaSignoffReport = buildGaSignoffValidationReport({ path: gaSignoffPath, now });
  checks.push({
    id: "ga_signoff",
    required: true,
    passed: gaSignoffReport.valid,
    failures: [...gaSignoffReport.blockers, ...(gaSignoffReport.parseError ? [`parse_error:${gaSignoffReport.parseError}`] : [])]
  });

  const acceptanceResult = await validateAcceptancePackage({
    config: configResult.config,
    releaseEvidencePath,
    gaSignoffPath,
    acceptanceIterations,
    env,
    now
  });
  checks.push(acceptanceResult.check);

  const completionAuditResult = await validateCompletionAudit({
    releaseEvidencePath,
    gaSignoffPath,
    runtimePreflightPath,
    runtimePreflightMaxAgeHours,
    acceptanceIterations,
    env,
    now
  });
  checks.push(completionAuditResult.check);

  const failures = checks.flatMap((check) => (check.passed ? [] : check.failures.map((failure) => `${check.id}:${failure}`)));

  return {
    schemaVersion: "live-acceptance-gate/v1",
    generatedAt: now.toISOString(),
    paths: {
      releaseEvidence: releaseEvidencePath,
      gaSignoff: gaSignoffPath,
      runtimePreflight: runtimePreflightPath
    },
    validateLiveInputs,
    acceptanceIterations,
    runtimePreflightMaxAgeHours,
    checks,
    liveProofInputs,
    releaseEvidence: releaseEvidenceResult.report
      ? {
          valid: releaseEvidenceResult.report.valid,
          records: releaseEvidenceResult.report.records,
          failures: releaseEvidenceResult.report.failures,
          releaseGate: releaseEvidenceResult.report.releaseGate
        }
      : null,
    gaSignoff: {
      valid: gaSignoffReport.valid,
      present: gaSignoffReport.present,
      explicitSignoffProvided: gaSignoffReport.explicitSignoffProvided,
      signers: gaSignoffReport.signers,
      blockers: gaSignoffReport.blockers,
      parseError: gaSignoffReport.parseError
    },
    acceptance: acceptanceResult.package
      ? {
          environment: acceptanceResult.package.environment,
          mode: acceptanceResult.package.mode,
          irreversibleActionsEnabled: acceptanceResult.package.irreversibleActionsEnabled,
          acceptance: acceptanceResult.package.acceptance
        }
      : null,
    completionAudit: completionAuditResult.report
      ? {
          complete: completionAuditResult.report.complete,
          missingLiveArtifacts: completionAuditResult.report.missingLiveArtifacts,
          roadmapBlockers: completionAuditResult.report.roadmapBlockers,
          prdBlockers: completionAuditResult.report.prdBlockers,
          failures: completionAuditResult.report.failures
        }
      : null,
    passed: failures.length === 0,
    failures
  };
}

function loadRuntimeConfig(env: NodeJS.ProcessEnv): { config: RuntimeConfig | null; error: string | null } {
  try {
    return { config: loadConfig(env), error: null };
  } catch (error) {
    return { config: null, error: errorMessage(error) };
  }
}

async function validateReleaseEvidence(input: {
  config: RuntimeConfig | null;
  evidencePath: string;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<{ check: LiveAcceptanceGateCheck; report: ReleaseEvidenceValidationReport | null }> {
  if (!input.config) {
    return {
      check: { id: "release_evidence", required: true, passed: false, failures: ["runtime_config_invalid"] },
      report: null
    };
  }
  try {
    const report = await buildReleaseEvidenceValidationReport({
      evidencePath: input.evidencePath,
      config: input.config,
      env: input.env,
      now: input.now
    });
    return {
      check: { id: "release_evidence", required: true, passed: report.valid, failures: report.failures },
      report
    };
  } catch (error) {
    return {
      check: { id: "release_evidence", required: true, passed: false, failures: [`parse_or_validation_error:${errorMessage(error)}`] },
      report: null
    };
  }
}

async function validateAcceptancePackage(input: {
  config: RuntimeConfig | null;
  releaseEvidencePath: string;
  gaSignoffPath: string;
  acceptanceIterations: number;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<{ check: LiveAcceptanceGateCheck; package: AcceptancePackage | null }> {
  if (!input.config) {
    return {
      check: { id: "acceptance_package", required: true, passed: false, failures: ["runtime_config_invalid"] },
      package: null
    };
  }
  try {
    const releaseEvidence = loadReleaseEvidenceFile(input.releaseEvidencePath);
    const gaSignoff = loadGaSignoffFile(input.gaSignoffPath);
    const acceptancePackage = await buildAcceptancePackage({
      iterations: input.acceptanceIterations,
      releaseEvidence,
      ...(gaSignoff ? { gaSignoff } : {}),
      config: input.config,
      env: input.env,
      now: input.now
    });
    return {
      check: {
        id: "acceptance_package",
        required: true,
        passed: acceptancePackage.acceptance.passed,
        failures: acceptancePackage.acceptance.blockers
      },
      package: acceptancePackage
    };
  } catch (error) {
    return {
      check: { id: "acceptance_package", required: true, passed: false, failures: [`parse_or_validation_error:${errorMessage(error)}`] },
      package: null
    };
  }
}

async function validateCompletionAudit(input: {
  releaseEvidencePath: string;
  gaSignoffPath: string;
  runtimePreflightPath: string;
  runtimePreflightMaxAgeHours: number;
  acceptanceIterations: number;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<{ check: LiveAcceptanceGateCheck; report: RoadmapCompletionAuditReport | null }> {
  try {
    const report = await buildRoadmapCompletionAudit({
      releaseEvidencePath: input.releaseEvidencePath,
      gaSignoffPath: input.gaSignoffPath,
      runtimePreflightPath: input.runtimePreflightPath,
      runtimePreflightMaxAgeHours: input.runtimePreflightMaxAgeHours,
      acceptanceIterations: input.acceptanceIterations,
      env: input.env,
      now: input.now
    });
    return {
      check: { id: "roadmap_completion_audit", required: true, passed: report.complete, failures: report.failures },
      report
    };
  } catch (error) {
    return {
      check: { id: "roadmap_completion_audit", required: true, passed: false, failures: [`parse_or_validation_error:${errorMessage(error)}`] },
      report: null
    };
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildLiveAcceptanceGateReport();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.LIVE_ACCEPTANCE_GATE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.LIVE_ACCEPTANCE_GATE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.LIVE_ACCEPTANCE_GATE_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}
