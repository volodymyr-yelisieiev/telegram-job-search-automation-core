import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

type ExternalSecretsBackend = "aws_secrets_manager" | "gcp_secret_manager" | "vault" | "local_encrypted_file";

export interface ExternalSecretsEvidenceInput {
  backend: ExternalSecretsBackend;
  checkedAt: string;
  accessCheck?: boolean;
  probe?: string;
  backendScope?: string;
  secretReferenceIds?: string[];
  coveredProviderIds?: string[];
  telegramBot?: boolean;
}

export interface ExternalSecretsCredentialInventory {
  expectedProviderIds: string[];
  coveredProviderIds: string[];
  missingProviderIds: string[];
  telegramBot: boolean;
  secretReferenceIds: string[];
  referenceCount: number;
  failures: string[];
}

export interface ExternalSecretsEvidenceReport {
  schemaVersion: "external-secrets-evidence/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  inputSummary: {
    backend: ExternalSecretsBackend;
    checkedAt: string;
    accessCheck: boolean;
    probe: string | null;
    backendScopeHash: string | null;
    referenceCount: number;
    coveredProviderIds: string[];
    telegramBot: boolean;
  };
  credentialInventory: ExternalSecretsCredentialInventory | null;
  releaseEvidence: ReleaseEvidenceRecord | null;
  credentialEvidence: ReleaseEvidenceRecord | null;
  failures: string[];
}

export function buildExternalSecretsEvidenceReport(input: {
  record: ExternalSecretsEvidenceInput;
  source: string;
  liveEvidenceAllowed: boolean;
  expectedProviderIds?: string[];
  ttlHours?: number;
  now?: Date;
}): ExternalSecretsEvidenceReport {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours ?? 24;
  const source = input.source.trim();
  const liveEvidenceAllowed = input.liveEvidenceAllowed && isLiveEvidenceSource(source);
  const expectedProviderIds = uniqueSorted(input.expectedProviderIds ?? defaultExpectedProviderIds());
  const secretReferenceIds = uniqueSorted(input.record.secretReferenceIds ?? []);
  const coveredProviderIds = uniqueSorted(input.record.coveredProviderIds ?? []);
  const accessCheck = input.record.accessCheck === true;
  const probe = nonEmptyString(input.record.probe);
  const failures: string[] = [];

  if (!liveEvidenceAllowed) {
    failures.push("external_secrets_evidence_requires_live_source");
  }
  if (!isApprovedSecretBackend(input.record.backend)) {
    failures.push("approved_secret_backend_required");
  }
  if (!accessCheck && probe !== "passed") {
    failures.push("secrets_backend_access_check_required");
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
      failures.push("external_secrets_evidence_expired");
    }
  }
  if (input.ttlHours !== undefined && input.ttlHours <= 0) {
    failures.push("positive_ttl_hours_required");
  }
  if (metadataContainsRawSecret(input.record)) {
    failures.push("input_contains_raw_secret");
  }
  const expiresAt = isIsoDateString(input.record.checkedAt)
    ? new Date(Date.parse(input.record.checkedAt) + ttlHours * 60 * 60 * 1000).toISOString()
    : now.toISOString();

  const credentialInventory =
    secretReferenceIds.length > 0 || coveredProviderIds.length > 0 || input.record.telegramBot !== undefined
      ? buildCredentialInventory({
          expectedProviderIds,
          secretReferenceIds,
          coveredProviderIds,
          telegramBot: input.record.telegramBot === true
        })
      : null;

  const releaseEvidence =
    failures.length === 0
      ? {
          evidenceId: `external-secrets-${input.record.backend}`,
          evidenceType: "external_secrets_backend",
          providerId: null,
          status: "passed",
          observedAt: input.record.checkedAt,
          expiresAt,
          source,
          metadata: {
            backend: input.record.backend,
            ...(accessCheck ? { accessCheck: true } : { probe: "passed" }),
            checkedAt: input.record.checkedAt,
            ...(input.record.backendScope ? { backendScopeHash: stableHash(input.record.backendScope) } : {}),
            ...(secretReferenceIds.length > 0 ? { referenceCount: secretReferenceIds.length } : {})
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  const credentialEvidence =
    failures.length === 0 && credentialInventory && credentialInventory.failures.length === 0
      ? {
          evidenceId: "external-secrets-live-credentials",
          evidenceType: "live_credentials_configured",
          providerId: null,
          status: "passed",
          observedAt: input.record.checkedAt,
          expiresAt,
          source,
          metadata: {
            backend: input.record.backend,
            checkedAt: input.record.checkedAt,
            secretReferenceIds,
            coveredProviderIds: credentialInventory.coveredProviderIds,
            telegramBot: true,
            referenceCount: credentialInventory.referenceCount
          }
        } satisfies ReleaseEvidenceRecord
      : null;

  return {
    schemaVersion: "external-secrets-evidence/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed,
    inputSummary: {
      backend: input.record.backend,
      checkedAt: input.record.checkedAt,
      accessCheck,
      probe: probe ?? null,
      backendScopeHash: input.record.backendScope ? stableHash(input.record.backendScope) : null,
      referenceCount: secretReferenceIds.length,
      coveredProviderIds,
      telegramBot: input.record.telegramBot === true
    },
    credentialInventory,
    releaseEvidence,
    credentialEvidence,
    failures
  };
}

export function parseExternalSecretsEvidenceInput(contents: string): ExternalSecretsEvidenceInput {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("External secrets evidence input must be an object");
  }
  if (metadataContainsRawSecret(parsed)) {
    throw new Error("External secrets evidence input contains raw secret-like values");
  }
  const object = parsed as Record<string, unknown>;
  const backend = nonEmptyString(object.backend);
  const checkedAt = nonEmptyString(object.checkedAt);
  if (!backend || !isApprovedSecretBackend(backend)) {
    throw new Error("External secrets evidence input is missing an approved backend");
  }
  if (!checkedAt) {
    throw new Error("External secrets evidence input is missing checkedAt");
  }
  return {
    backend,
    checkedAt,
    ...(object.accessCheck === true ? { accessCheck: true } : {}),
    ...(nonEmptyString(object.probe) ? { probe: nonEmptyString(object.probe)! } : {}),
    ...(nonEmptyString(object.backendScope) ? { backendScope: nonEmptyString(object.backendScope)! } : {}),
    ...(stringArray(object.secretReferenceIds).length > 0 ? { secretReferenceIds: stringArray(object.secretReferenceIds) } : {}),
    ...(stringArray(object.coveredProviderIds).length > 0 ? { coveredProviderIds: stringArray(object.coveredProviderIds) } : {}),
    ...(typeof object.telegramBot === "boolean" ? { telegramBot: object.telegramBot } : {})
  };
}

export function isLiveEvidenceSource(source: string): boolean {
  const normalized = source.trim();
  const isManagedLocalEncryptedSecretStore = /local[-_\s]?encrypted[-_\s]?file[-_\s]?secret[-_\s]?store/i.test(normalized);
  const blockedSourcePattern = isManagedLocalEncryptedSecretStore
    ? /(fixture|mock|test|example|template|placeholder)/i
    : /(fixture|mock|local|test|example|template|placeholder)/i;
  return normalized.length > 0 && !blockedSourcePattern.test(normalized) && hasExternalProofReference(normalized);
}

function hasExternalProofReference(source: string): boolean {
  return (
    /\bhttps?:\/\/[^\s]+/i.test(source) ||
    /\b(?:github-actions|gitlab|circleci|buildkite|jenkins|argo|airflow|temporal):\/\/[^\s]+/i.test(source) ||
    /\b(?:run|workflow|build|job|execution|pipeline|proof|probe|smoke|canary|drill|audit|check)\b[\s:#/-]+[a-z0-9][a-z0-9._:-]*/i.test(source)
  );
}

function buildCredentialInventory(input: {
  expectedProviderIds: string[];
  secretReferenceIds: string[];
  coveredProviderIds: string[];
  telegramBot: boolean;
}): ExternalSecretsCredentialInventory {
  const coveredProviderIds = uniqueSorted(input.coveredProviderIds.filter((providerId) => input.expectedProviderIds.includes(providerId)));
  const missingProviderIds = input.expectedProviderIds.filter((providerId) => !coveredProviderIds.includes(providerId));
  const failures: string[] = [];
  if (input.secretReferenceIds.length === 0) {
    failures.push("secret_reference_ids_missing");
  }
  if (missingProviderIds.length > 0) {
    failures.push(`credential_coverage_missing:${missingProviderIds.join("|")}`);
  }
  if (!input.telegramBot) {
    failures.push("telegram_bot_credential_missing");
  }
  return {
    expectedProviderIds: input.expectedProviderIds,
    coveredProviderIds,
    missingProviderIds,
    telegramBot: input.telegramBot,
    secretReferenceIds: input.secretReferenceIds,
    referenceCount: input.secretReferenceIds.length,
    failures
  };
}

function defaultExpectedProviderIds(): string[] {
  return createFixtureProviderRegistry().list().map((provider) => provider.providerId);
}

function isApprovedSecretBackend(value: unknown): value is ExternalSecretsBackend {
  return value === "aws_secrets_manager" || value === "gcp_secret_manager" || value === "vault" || value === "local_encrypted_file";
}

function metadataContainsRawSecret(value: unknown, depth = 0): boolean {
  if (depth > 12) {
    return true;
  }
  if (typeof value === "string") {
    return containsRawSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => metadataContainsRawSecret(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => metadataContainsRawSecret(item, depth + 1));
  }
  return false;
}

function containsRawSecret(value: string): boolean {
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:api[_-]?key|token|secret|password|session)=([^&\s]+)/i.test(value) ||
    /(?:sk|ghp|glpat|xox[baprs])[-_a-z0-9]{16,}/i.test(value)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isIsoDateString(value: string): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && value.includes("T");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? uniqueSorted(value.filter((item) => item.trim().length > 0))
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.env.EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH;
  if (!inputPath) {
    throw new Error("EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH is required");
  }
  const report = buildExternalSecretsEvidenceReport({
    record: parseExternalSecretsEvidenceInput(readFileSync(inputPath, "utf8")),
    source: process.env.EXTERNAL_SECRETS_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.EXTERNAL_SECRETS_EVIDENCE_ASSERT_LIVE === "true",
    ...(process.env.EXTERNAL_SECRETS_EVIDENCE_TTL_HOURS ? { ttlHours: parsePositiveNumber(process.env.EXTERNAL_SECRETS_EVIDENCE_TTL_HOURS) } : {})
  });
  if (process.env.EXTERNAL_SECRETS_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when EXTERNAL_SECRETS_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.releaseEvidence) {
      throw new Error(`Cannot append external secrets evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    if (process.env.EXTERNAL_SECRETS_EVIDENCE_REQUIRE_CREDENTIALS === "true" && !report.credentialEvidence) {
      throw new Error(
        `Cannot append credential evidence: ${report.credentialInventory?.failures.join(", ") ?? "credential_inventory_missing"}`
      );
    }
    upsertReleaseEvidenceRecords({
      path: process.env.RELEASE_EVIDENCE_PATH,
      records: [report.releaseEvidence, report.credentialEvidence].filter((record): record is ReleaseEvidenceRecord => record !== null)
    });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.EXTERNAL_SECRETS_EVIDENCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.EXTERNAL_SECRETS_EVIDENCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.EXTERNAL_SECRETS_EVIDENCE_OUTPUT_PATH, serialized);
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
