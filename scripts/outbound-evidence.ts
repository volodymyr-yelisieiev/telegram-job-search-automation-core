import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface OutboundDispatchEvidenceInput {
  proofId: string;
  transport: string;
  textHash: string;
  idempotencyKeyHash?: string;
  idempotencyKey?: string;
  deliveryStatus?: string;
  proofStatus?: string;
  status?: string;
  deliveredAt?: string;
  rawMessagePresent?: boolean;
}

export interface OutboundDispatchEvidenceReport {
  schemaVersion: "outbound-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  evidenceTtlHours: number;
  input: Omit<OutboundDispatchEvidenceInput, "idempotencyKey"> & { idempotencyKeyPresent: boolean };
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export function buildOutboundDispatchEvidenceReport(input: {
  proof: OutboundDispatchEvidenceInput;
  source: string;
  liveEvidenceAllowed: boolean;
  ttlHours?: number;
  now?: Date;
}): OutboundDispatchEvidenceReport {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours ?? 24;
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const failures: string[] = [];
  const status = input.proof.deliveryStatus ?? input.proof.proofStatus ?? input.proof.status;
  const rawIdempotencyKey = nonEmptyString(input.proof.idempotencyKey);
  const idempotencyKeyHash = nonEmptyString(input.proof.idempotencyKeyHash) ?? (rawIdempotencyKey ? stableHash(rawIdempotencyKey) : null);
  const deliveredAt = nonEmptyString(input.proof.deliveredAt);
  const deliveredAtMs = deliveredAt && isIsoDateString(deliveredAt) ? Date.parse(deliveredAt) : null;
  const expiresAt = deliveredAtMs ? new Date(deliveredAtMs + ttlHours * 60 * 60 * 1000).toISOString() : null;
  const { idempotencyKey, ...safeInput } = input.proof;

  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    failures.push("outbound_dispatch_ttl_hours_invalid");
  }
  if (!liveEvidenceAllowed) {
    failures.push("outbound_dispatch_evidence_requires_live_source");
  }
  if (!nonEmptyString(input.proof.proofId)) {
    failures.push("proof_id_required");
  }
  if (!["provider", "telegram", "calendar"].includes(input.proof.transport)) {
    failures.push("live_transport_required");
  }
  if (!idempotencyKeyHash) {
    failures.push("idempotency_key_hash_required");
  }
  if (!nonEmptyString(input.proof.textHash)) {
    failures.push("text_hash_required");
  }
  if (status !== "sent") {
    failures.push("sent_delivery_status_required");
  }
  if (!deliveredAt || !isIsoDateString(deliveredAt)) {
    failures.push("delivered_at_required");
  } else if (Date.parse(deliveredAt) > now.getTime()) {
    failures.push("delivered_at_in_future");
  } else if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    failures.push("outbound_dispatch_evidence_expired");
  }
  if (input.proof.rawMessagePresent) {
    failures.push("raw_message_not_allowed");
  }

  const evidenceRecord =
    failures.length === 0
      ? {
          evidenceId: "outbound-dispatch-proof-ready",
          evidenceType: "outbound_dispatch_proof_ready",
          providerId: null,
          status: "passed",
          observedAt: deliveredAt!,
          expiresAt: expiresAt!,
          source,
          metadata: {
            proofId: input.proof.proofId,
            transport: input.proof.transport,
            idempotencyKeyHash,
            textHash: input.proof.textHash,
            deliveryStatus: "sent",
            deliveredAt: deliveredAt!
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  return {
    schemaVersion: "outbound-evidence/v1",
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

export function parseOutboundDispatchEvidenceInput(contents: string): OutboundDispatchEvidenceInput {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Outbound dispatch evidence input must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const proofId = nonEmptyString(object.proofId);
  const transport = nonEmptyString(object.transport);
  const textHash = nonEmptyString(object.textHash);
  if (!proofId) {
    throw new Error("Outbound dispatch evidence input is missing proofId");
  }
  if (!transport) {
    throw new Error("Outbound dispatch evidence input is missing transport");
  }
  if (!textHash) {
    throw new Error("Outbound dispatch evidence input is missing textHash");
  }
  const idempotencyKeyHash = nonEmptyString(object.idempotencyKeyHash);
  const idempotencyKey = nonEmptyString(object.idempotencyKey);
  const deliveryStatus = nonEmptyString(object.deliveryStatus);
  const proofStatus = nonEmptyString(object.proofStatus);
  const status = nonEmptyString(object.status);
  const deliveredAt = nonEmptyString(object.deliveredAt);
  return {
    proofId,
    transport,
    textHash,
    ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(proofStatus ? { proofStatus } : {}),
    ...(status ? { status } : {}),
    ...(deliveredAt ? { deliveredAt } : {}),
    rawMessagePresent: "text" in object || "messageText" in object || "rawMessage" in object
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
  const inputPath = process.env.OUTBOUND_EVIDENCE_INPUT_PATH;
  if (!inputPath) {
    throw new Error("OUTBOUND_EVIDENCE_INPUT_PATH is required");
  }
  const ttlHours = process.env.OUTBOUND_EVIDENCE_TTL_HOURS ? parsePositiveNumber(process.env.OUTBOUND_EVIDENCE_TTL_HOURS) : undefined;
  const report = buildOutboundDispatchEvidenceReport({
    proof: parseOutboundDispatchEvidenceInput(readFileSync(inputPath, "utf8")),
    source: process.env.OUTBOUND_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.OUTBOUND_EVIDENCE_ASSERT_LIVE === "true",
    ...(ttlHours !== undefined ? { ttlHours } : {})
  });
  if (process.env.OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append outbound dispatch evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.OUTBOUND_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.OUTBOUND_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.OUTBOUND_EVIDENCE_OUTPUT_PATH, serialized);
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
