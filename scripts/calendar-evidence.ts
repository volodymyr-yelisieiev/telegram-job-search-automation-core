import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReleaseEvidenceRecord } from "@job-search/domain";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface CalendarEvidenceInput {
  calendarProvider: string;
  checkedAt: string;
  readCheck: boolean;
  conflictCheck: boolean;
  writeCheck: boolean;
}

export interface CalendarEvidenceReport {
  schemaVersion: "calendar-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  input: CalendarEvidenceInput;
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export function buildCalendarEvidenceReport(input: {
  record: CalendarEvidenceInput;
  source: string;
  liveEvidenceAllowed: boolean;
  ttlHours?: number;
  now?: Date;
}): CalendarEvidenceReport {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours ?? 24;
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const failures: string[] = [];
  if (!liveEvidenceAllowed) {
    failures.push("calendar_evidence_requires_live_source");
  }
  if (input.record.calendarProvider.trim().length === 0) {
    failures.push("calendar_provider_required");
  }
  if (!isIsoDateString(input.record.checkedAt)) {
    failures.push("checked_at_required");
  } else {
    const checkedAtMs = Date.parse(input.record.checkedAt);
    const expiresAtMs = checkedAtMs + ttlHours * 60 * 60 * 1000;
    if (checkedAtMs > now.getTime()) {
      failures.push("checked_at_in_future");
    }
    if (expiresAtMs <= now.getTime()) {
      failures.push("calendar_evidence_expired");
    }
  }
  for (const check of ["readCheck", "conflictCheck", "writeCheck"] as const) {
    if (input.record[check] !== true) {
      failures.push(`${check}_required`);
    }
  }

  const evidenceRecord =
    failures.length === 0
      ? {
          evidenceId: "calendar-integration-ready",
          evidenceType: "calendar_integration_ready",
          providerId: null,
          status: "passed",
          observedAt: input.record.checkedAt,
          expiresAt: new Date(Date.parse(input.record.checkedAt) + ttlHours * 60 * 60 * 1000).toISOString(),
          source,
          metadata: {
            calendarProvider: input.record.calendarProvider,
            checkedAt: input.record.checkedAt,
            readCheck: true,
            conflictCheck: true,
            writeCheck: true
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  return {
    schemaVersion: "calendar-evidence/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed,
    input: input.record,
    evidenceRecord,
    failures
  };
}

export function parseCalendarEvidenceInput(contents: string): CalendarEvidenceInput {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Calendar evidence input must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const calendarProvider = nonEmptyString(object.calendarProvider);
  const checkedAt = nonEmptyString(object.checkedAt);
  if (!calendarProvider) {
    throw new Error("Calendar evidence input is missing calendarProvider");
  }
  if (!checkedAt) {
    throw new Error("Calendar evidence input is missing checkedAt");
  }
  return {
    calendarProvider,
    checkedAt,
    readCheck: object.readCheck === true,
    conflictCheck: object.conflictCheck === true,
    writeCheck: object.writeCheck === true
  };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.env.CALENDAR_EVIDENCE_INPUT_PATH;
  if (!inputPath) {
    throw new Error("CALENDAR_EVIDENCE_INPUT_PATH is required");
  }
  const report = buildCalendarEvidenceReport({
    record: parseCalendarEvidenceInput(readFileSync(inputPath, "utf8")),
    source: process.env.CALENDAR_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.CALENDAR_EVIDENCE_ASSERT_LIVE === "true",
    ...(process.env.CALENDAR_EVIDENCE_TTL_HOURS ? { ttlHours: parsePositiveNumber(process.env.CALENDAR_EVIDENCE_TTL_HOURS) } : {})
  });
  if (process.env.CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append calendar evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.CALENDAR_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.CALENDAR_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.CALENDAR_EVIDENCE_OUTPUT_PATH, serialized);
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
