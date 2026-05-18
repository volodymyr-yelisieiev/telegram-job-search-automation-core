import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReleaseEvidenceRecord } from "@job-search/domain";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface SoakEvidenceInput {
  startedAt?: string;
  completedAt?: string;
  durationDays?: number;
  duplicateApplicationCount: number;
  proofCoveragePercent: number;
  stateLossDetected: boolean;
  unsupportedFactCount: number;
  incidentDrillPassed: boolean;
  rollbackDrillPassed: boolean;
  acceptancePassed?: boolean;
}

export interface SoakEvidenceReport {
  schemaVersion: "soak-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  input: SoakEvidenceInput;
  durationDays: number;
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export function buildSoakEvidenceReport(input: {
  report: SoakEvidenceInput;
  source: string;
  liveEvidenceAllowed: boolean;
  ttlDays?: number;
  now?: Date;
}): SoakEvidenceReport {
  const now = input.now ?? new Date();
  const ttlDays = input.ttlDays ?? 30;
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const failures: string[] = [];
  const durationDays = soakDurationDays(input.report);
  const startedAtMs = input.report.startedAt ? Date.parse(input.report.startedAt) : Number.NaN;
  const completedAtMs = input.report.completedAt ? Date.parse(input.report.completedAt) : Number.NaN;

  if (!liveEvidenceAllowed) {
    failures.push("soak_evidence_requires_live_source");
  }
  if (!input.report.startedAt || !isIsoDateString(input.report.startedAt)) {
    failures.push("started_at_required");
  } else if (startedAtMs > now.getTime()) {
    failures.push("started_at_in_future");
  }
  if (!Number.isFinite(durationDays) || durationDays < 7) {
    failures.push("minimum_seven_day_duration_required");
  }
  if (!input.report.completedAt || !isIsoDateString(input.report.completedAt)) {
    failures.push("completed_at_required");
  } else if (completedAtMs > now.getTime()) {
    failures.push("completed_at_in_future");
  }
  if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) && completedAtMs <= startedAtMs) {
    failures.push("completed_at_must_follow_started_at");
  }
  if (input.report.duplicateApplicationCount !== 0) {
    failures.push("zero_duplicate_applications_required");
  }
  if (input.report.proofCoveragePercent !== 100) {
    failures.push("full_proof_coverage_required");
  }
  if (input.report.stateLossDetected !== false) {
    failures.push("no_state_loss_required");
  }
  if (input.report.unsupportedFactCount !== 0) {
    failures.push("zero_unsupported_facts_required");
  }
  if (input.report.incidentDrillPassed !== true) {
    failures.push("incident_drill_required");
  }
  if (input.report.rollbackDrillPassed !== true) {
    failures.push("rollback_drill_required");
  }
  if (input.report.acceptancePassed === false) {
    failures.push("soak_acceptance_failed");
  }

  const evidenceRecord =
    failures.length === 0
      ? {
          evidenceId: "seven-day-soak-passed",
          evidenceType: "seven_day_soak_passed",
          providerId: null,
          status: "passed",
          observedAt: input.report.completedAt!,
          expiresAt: new Date(completedAtMs + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
          source,
          metadata: {
            ...(input.report.startedAt ? { startedAt: input.report.startedAt } : {}),
            ...(input.report.completedAt ? { completedAt: input.report.completedAt } : {}),
            durationDays,
            duplicateApplicationCount: input.report.duplicateApplicationCount,
            proofCoveragePercent: input.report.proofCoveragePercent,
            stateLossDetected: input.report.stateLossDetected,
            unsupportedFactCount: input.report.unsupportedFactCount,
            incidentDrillPassed: input.report.incidentDrillPassed,
            rollbackDrillPassed: input.report.rollbackDrillPassed
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  return {
    schemaVersion: "soak-evidence/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed,
    input: input.report,
    durationDays,
    evidenceRecord,
    failures
  };
}

export function parseSoakEvidenceInput(contents: string): SoakEvidenceInput {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Soak evidence input must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const startedAt = nonEmptyString(object.startedAt);
  const completedAt = nonEmptyString(object.completedAt);
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof object.durationDays === "number" ? { durationDays: object.durationDays } : {}),
    duplicateApplicationCount: numberValue(object.duplicateApplicationCount),
    proofCoveragePercent: numberValue(object.proofCoveragePercent),
    stateLossDetected: object.stateLossDetected === true,
    unsupportedFactCount: numberValue(object.unsupportedFactCount),
    incidentDrillPassed: object.incidentDrillPassed === true,
    rollbackDrillPassed: object.rollbackDrillPassed === true,
    ...(typeof object.acceptance === "object" && object.acceptance !== null && "passed" in object.acceptance
      ? { acceptancePassed: (object.acceptance as { passed?: unknown }).passed === true }
      : typeof object.acceptancePassed === "boolean"
        ? { acceptancePassed: object.acceptancePassed }
        : {})
  };
}

function soakDurationDays(report: SoakEvidenceInput): number {
  if (report.startedAt && report.completedAt) {
    return (new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()) / (24 * 60 * 60 * 1000);
  }
  return 0;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function isLiveEvidenceSource(source: string): boolean {
  const normalized = source.trim();
  return normalized.length > 0 && !/(fixture|mock|local|test|example|template|placeholder)/i.test(normalized) && hasExternalProofReference(normalized);
}

function hasExternalProofReference(source: string): boolean {
  return (
    /\bhttps?:\/\/[^\s]+/i.test(source) ||
    /\b(?:github-actions|gitlab|circleci|buildkite|jenkins|argo|airflow|temporal):\/\/[^\s]+/i.test(source) ||
    /\b(?:run|workflow|build|job|execution|pipeline|proof|probe|smoke|canary|drill|audit|check)\b[\s:#/-]+[a-z0-9][a-z0-9._:-]*/i.test(source)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isIsoDateString(value: string): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && value.includes("T");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.env.SOAK_EVIDENCE_INPUT_PATH;
  if (!inputPath) {
    throw new Error("SOAK_EVIDENCE_INPUT_PATH is required");
  }
  const report = buildSoakEvidenceReport({
    report: parseSoakEvidenceInput(readFileSync(inputPath, "utf8")),
    source: process.env.SOAK_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.SOAK_EVIDENCE_ASSERT_LIVE === "true",
    ...(process.env.SOAK_EVIDENCE_TTL_DAYS ? { ttlDays: parsePositiveNumber(process.env.SOAK_EVIDENCE_TTL_DAYS) } : {})
  });
  if (process.env.SOAK_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when SOAK_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append soak evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.SOAK_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.SOAK_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.SOAK_EVIDENCE_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}
