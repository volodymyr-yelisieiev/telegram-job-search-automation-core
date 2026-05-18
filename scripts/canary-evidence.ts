import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReleaseEvidenceRecord } from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface CanaryEvidenceInputRecord {
  providerId: string;
  status: string;
  canaryRunId?: string;
  id?: string;
  checkedAt?: string;
  checks?: string[];
  failures?: string[];
  metrics?: Record<string, number>;
}

export interface CanaryEvidenceReport {
  schemaVersion: "canary-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  expectedProviderIds: string[];
  inputRecords: number;
  passedProviderIds: string[];
  failedProviderIds: string[];
  missingProviderIds: string[];
  evidenceRecords: ReleaseEvidenceRecord[];
  failures: string[];
}

export function buildCanaryEvidenceReport(input: {
  records: CanaryEvidenceInputRecord[];
  expectedProviderIds?: string[];
  source: string;
  liveEvidenceAllowed: boolean;
  ttlHours?: number;
  now?: Date;
}): CanaryEvidenceReport {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours ?? 24;
  const expectedProviderIds = uniqueSorted(input.expectedProviderIds ?? defaultExpectedProviderIds());
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const failures: string[] = [];
  if (!liveEvidenceAllowed) {
    failures.push("live_canary_evidence_requires_live_source");
  }

  const passedProviderIds: string[] = [];
  const failedProviderIds: string[] = [];
  const missingProviderIds: string[] = [];
  const evidenceRecords: ReleaseEvidenceRecord[] = [];

  for (const providerId of expectedProviderIds) {
    const providerRecords = input.records.filter((record) => record.providerId === providerId);
    const passed = providerRecords.find((record) => record.status === "passed");
    if (!passed) {
      if (providerRecords.length > 0) {
        failedProviderIds.push(providerId);
      } else {
        missingProviderIds.push(providerId);
      }
      continue;
    }
    passedProviderIds.push(providerId);
    if (!liveEvidenceAllowed) {
      continue;
    }

    const canaryRunId = nonEmptyString(passed.canaryRunId) ?? nonEmptyString(passed.id);
    const checkedAt = nonEmptyString(passed.checkedAt);
    if (!canaryRunId) {
      failures.push(`canary_run_id_required:${providerId}`);
      continue;
    }
    if (!checkedAt || !isIsoDateString(checkedAt)) {
      failures.push(`checked_at_required:${providerId}`);
      continue;
    }
    const checkedAtMs = Date.parse(checkedAt);
    if (checkedAtMs > now.getTime()) {
      failures.push(`checked_at_in_future:${providerId}`);
      continue;
    }
    const expiresAt = new Date(checkedAtMs + ttlHours * 60 * 60 * 1000).toISOString();
    if (Date.parse(expiresAt) <= now.getTime()) {
      failures.push(`canary_evidence_expired:${providerId}`);
      continue;
    }

    evidenceRecords.push({
      evidenceId: `live-canary-${providerId}`,
      evidenceType: "live_canary_passed",
      providerId,
      status: "passed",
      observedAt: checkedAt,
      expiresAt,
      source,
      metadata: {
        canaryRunId,
        checkedAt,
        result: "passed",
        checks: passed.checks ?? []
      }
    });
  }

  if (failedProviderIds.length > 0) {
    failures.push(`live_canary_failed:${failedProviderIds.join("|")}`);
  }
  if (missingProviderIds.length > 0) {
    failures.push(`live_canary_missing:${missingProviderIds.join("|")}`);
  }

  return {
    schemaVersion: "canary-evidence/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed,
    expectedProviderIds,
    inputRecords: input.records.length,
    passedProviderIds: uniqueSorted(passedProviderIds),
    failedProviderIds: uniqueSorted(failedProviderIds),
    missingProviderIds: uniqueSorted(missingProviderIds),
    evidenceRecords,
    failures
  };
}

export function parseCanaryEvidenceResults(contents: string): CanaryEvidenceInputRecord[] {
  const parsed = JSON.parse(contents) as unknown;
  const records = Array.isArray(parsed) ? parsed : recordsFromObject(parsed);
  if (!records) {
    throw new Error("Canary evidence input must be an array or an object with results/records/canaryResults");
  }
  return records.map(assertCanaryEvidenceInputRecord);
}

function recordsFromObject(value: unknown): unknown[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ["results", "records", "canaryResults"]) {
    if (Array.isArray(object[key])) {
      return object[key];
    }
  }
  return null;
}

function assertCanaryEvidenceInputRecord(record: unknown, index: number): CanaryEvidenceInputRecord {
  if (!record || typeof record !== "object") {
    throw new Error(`Invalid canary record at index ${index}`);
  }
  const object = record as Record<string, unknown>;
  const providerId = nonEmptyString(object.providerId);
  const status = nonEmptyString(object.status);
  if (!providerId) {
    throw new Error(`Canary record ${index} is missing providerId`);
  }
  if (!status) {
    throw new Error(`Canary record ${index} is missing status`);
  }
  const canaryRunId = nonEmptyString(object.canaryRunId);
  const id = nonEmptyString(object.id);
  const checkedAt = nonEmptyString(object.checkedAt);
  return {
    providerId,
    status,
    ...(canaryRunId ? { canaryRunId } : {}),
    ...(id ? { id } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(Array.isArray(object.checks) && object.checks.every((item) => typeof item === "string") ? { checks: object.checks } : {}),
    ...(Array.isArray(object.failures) && object.failures.every((item) => typeof item === "string") ? { failures: object.failures } : {}),
    ...(isNumberRecord(object.metrics) ? { metrics: object.metrics } : {})
  };
}

function defaultExpectedProviderIds(): string[] {
  return createFixtureProviderRegistry().list().map((provider) => provider.providerId);
}

export function isLiveEvidenceSource(source: string): boolean {
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

function isNumberRecord(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every((item) => typeof item === "number");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultsPath = process.env.CANARY_EVIDENCE_RESULTS_PATH;
  if (!resultsPath) {
    throw new Error("CANARY_EVIDENCE_RESULTS_PATH is required");
  }
  const report = buildCanaryEvidenceReport({
    records: parseCanaryEvidenceResults(readFileSync(resultsPath, "utf8")),
    source: process.env.CANARY_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.CANARY_EVIDENCE_ASSERT_LIVE === "true",
    ...(process.env.CANARY_EVIDENCE_TTL_HOURS ? { ttlHours: parsePositiveNumber(process.env.CANARY_EVIDENCE_TTL_HOURS) } : {})
  });
  if (process.env.CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when CANARY_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (report.failures.length > 0 || report.evidenceRecords.length === 0) {
      throw new Error(`Cannot append live canary evidence: ${report.failures.join(", ") || "no_evidence_records"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: report.evidenceRecords });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.CANARY_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.CANARY_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.CANARY_EVIDENCE_OUTPUT_PATH, serialized);
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
