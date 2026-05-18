import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface ProviderSubmitEvidenceInput {
  providerId: string;
  applicationId: string;
  proofId: string;
  draftHash: string;
  action?: string;
  transport?: string;
  idempotencyKeyHash?: string;
  idempotencyKey?: string;
  submitStatus?: string;
  proofStatus?: string;
  status?: string;
  submittedAt?: string;
  rawApplicationPayloadPresent?: boolean;
}

export interface ProviderSubmitEvidenceReport {
  schemaVersion: "provider-submit-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  evidenceTtlHours: number;
  input: Omit<ProviderSubmitEvidenceInput, "idempotencyKey"> & { idempotencyKeyPresent: boolean };
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export function buildProviderSubmitEvidenceReport(input: {
  proof: ProviderSubmitEvidenceInput;
  expectedProviderIds?: string[];
  source: string;
  liveEvidenceAllowed: boolean;
  ttlHours?: number;
  now?: Date;
}): ProviderSubmitEvidenceReport {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours ?? 24;
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const failures: string[] = [];
  const action = input.proof.action ?? "send_application";
  const transport = input.proof.transport ?? "provider";
  const status = input.proof.submitStatus ?? input.proof.proofStatus ?? input.proof.status;
  const rawIdempotencyKey = nonEmptyString(input.proof.idempotencyKey);
  const idempotencyKeyHash = nonEmptyString(input.proof.idempotencyKeyHash) ?? (rawIdempotencyKey ? stableHash(rawIdempotencyKey) : null);
  const submittedAt = nonEmptyString(input.proof.submittedAt);
  const submittedAtMs = submittedAt && isIsoDateString(submittedAt) ? Date.parse(submittedAt) : null;
  const expiresAt = submittedAtMs ? new Date(submittedAtMs + ttlHours * 60 * 60 * 1000).toISOString() : null;
  const { idempotencyKey, ...safeInput } = input.proof;

  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    failures.push("provider_submit_ttl_hours_invalid");
  }
  if (!liveEvidenceAllowed) {
    failures.push("provider_submit_evidence_requires_live_source");
  }
  if (!nonEmptyString(input.proof.providerId)) {
    failures.push("provider_id_required");
  } else if (input.expectedProviderIds && input.expectedProviderIds.length > 0 && !input.expectedProviderIds.includes(input.proof.providerId)) {
    failures.push("provider_id_not_expected");
  }
  if (!nonEmptyString(input.proof.applicationId)) {
    failures.push("application_id_required");
  }
  if (!nonEmptyString(input.proof.proofId)) {
    failures.push("proof_id_required");
  }
  if (action !== "send_application") {
    failures.push("send_application_action_required");
  }
  if (transport !== "provider") {
    failures.push("provider_transport_required");
  }
  if (!idempotencyKeyHash) {
    failures.push("idempotency_key_hash_required");
  }
  if (!nonEmptyString(input.proof.draftHash)) {
    failures.push("draft_hash_required");
  }
  if (status !== "submitted") {
    failures.push("submitted_status_required");
  }
  if (!submittedAt || !isIsoDateString(submittedAt)) {
    failures.push("submitted_at_required");
  } else if (Date.parse(submittedAt) > now.getTime()) {
    failures.push("submitted_at_in_future");
  } else if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    failures.push("provider_submit_evidence_expired");
  }
  if (input.proof.rawApplicationPayloadPresent) {
    failures.push("raw_application_payload_not_allowed");
  }

  const evidenceRecord =
    failures.length === 0
      ? {
          evidenceId: `provider-submit-proof-${input.proof.providerId}`,
          evidenceType: "provider_submit_proof_ready",
          providerId: input.proof.providerId,
          status: "passed",
          observedAt: submittedAt!,
          expiresAt: expiresAt!,
          source,
          metadata: {
            applicationId: input.proof.applicationId,
            proofId: input.proof.proofId,
            action: "send_application",
            transport: "provider",
            idempotencyKeyHash,
            draftHash: input.proof.draftHash,
            submitStatus: "submitted",
            submittedAt: submittedAt!
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  return {
    schemaVersion: "provider-submit-evidence/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed,
    evidenceTtlHours: ttlHours,
    input: {
      ...safeInput,
      idempotencyKeyPresent: Boolean(idempotencyKey)
    },
    evidenceRecord,
    failures
  };
}

export function parseProviderSubmitEvidenceInput(contents: string): ProviderSubmitEvidenceInput {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Provider submit evidence input must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const providerId = nonEmptyString(object.providerId);
  const applicationId = nonEmptyString(object.applicationId);
  const proofId = nonEmptyString(object.proofId);
  const draftHash = nonEmptyString(object.draftHash) ?? nonEmptyString(object.approvedDraftHash);
  if (!providerId) {
    throw new Error("Provider submit evidence input is missing providerId");
  }
  if (!applicationId) {
    throw new Error("Provider submit evidence input is missing applicationId");
  }
  if (!proofId) {
    throw new Error("Provider submit evidence input is missing proofId");
  }
  if (!draftHash) {
    throw new Error("Provider submit evidence input is missing draftHash");
  }
  const action = nonEmptyString(object.action);
  const transport = nonEmptyString(object.transport);
  const idempotencyKeyHash = nonEmptyString(object.idempotencyKeyHash);
  const idempotencyKey = nonEmptyString(object.idempotencyKey);
  const submitStatus = nonEmptyString(object.submitStatus);
  const proofStatus = nonEmptyString(object.proofStatus);
  const status = nonEmptyString(object.status);
  const submittedAt = nonEmptyString(object.submittedAt);
  return {
    providerId,
    applicationId,
    proofId,
    draftHash,
    ...(action ? { action } : {}),
    ...(transport ? { transport } : {}),
    ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(submitStatus ? { submitStatus } : {}),
    ...(proofStatus ? { proofStatus } : {}),
    ...(status ? { status } : {}),
    ...(submittedAt ? { submittedAt } : {}),
    rawApplicationPayloadPresent: "coverLetterText" in object || "resumeText" in object || "rawPayload" in object
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
  const inputPath = process.env.PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH;
  if (!inputPath) {
    throw new Error("PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH is required");
  }
  const ttlHours = process.env.PROVIDER_SUBMIT_EVIDENCE_TTL_HOURS ? parsePositiveNumber(process.env.PROVIDER_SUBMIT_EVIDENCE_TTL_HOURS) : undefined;
  const expectedProviderIds = process.env.PROVIDER_SUBMIT_EVIDENCE_EXPECTED_PROVIDER_IDS
    ? process.env.PROVIDER_SUBMIT_EVIDENCE_EXPECTED_PROVIDER_IDS.split(",").map((providerId) => providerId.trim()).filter(Boolean)
    : undefined;
  const report = buildProviderSubmitEvidenceReport({
    proof: parseProviderSubmitEvidenceInput(readFileSync(inputPath, "utf8")),
    source: process.env.PROVIDER_SUBMIT_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.PROVIDER_SUBMIT_EVIDENCE_ASSERT_LIVE === "true",
    ...(expectedProviderIds ? { expectedProviderIds } : {}),
    ...(ttlHours !== undefined ? { ttlHours } : {})
  });
  if (process.env.PROVIDER_SUBMIT_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when PROVIDER_SUBMIT_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append provider submit evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.PROVIDER_SUBMIT_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.PROVIDER_SUBMIT_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.PROVIDER_SUBMIT_EVIDENCE_OUTPUT_PATH, serialized);
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
