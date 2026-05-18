import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { LocalEncryptedFileSecretStore, type SecretStoreProbe } from "@job-search/db";
import type { ReleaseEvidenceRecord, SecretReference } from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { parseReleaseEvidenceRecords } from "./acceptance-package";

export interface CredentialInventoryReport {
  expectedProviderIds: string[];
  coveredProviderIds: string[];
  missingProviderIds: string[];
  telegramBot: boolean;
  secretReferenceIds: string[];
  referenceCount: number;
  usableReferenceCount: number;
  expiredReferenceCount: number;
  failures: string[];
}

export interface SecretStoreProbeReport {
  schemaVersion: "secret-store-probe/v1";
  generatedAt: string;
  backend: RuntimeConfig["security"]["secretsBackend"];
  configured: boolean;
  probe: SecretStoreProbe | null;
  credentialInventory: CredentialInventoryReport | null;
  releaseEvidence: ReleaseEvidenceRecord | null;
  credentialEvidence: ReleaseEvidenceRecord | null;
  failures: string[];
}

export async function buildSecretStoreProbeReport(input: {
  config?: RuntimeConfig;
  now?: Date;
  evidenceId?: string;
  credentialEvidenceId?: string;
  expectedProviderIds?: string[];
  evidenceTtlHours?: number;
} = {}): Promise<SecretStoreProbeReport> {
  const now = input.now ?? new Date();
  const evidenceTtlHours = input.evidenceTtlHours ?? 24;
  const expiresAt = new Date(now.getTime() + evidenceTtlHours * 60 * 60 * 1000).toISOString();
  const sourceRunReference = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const config = input.config ?? loadConfig();
  const failures: string[] = [];
  let probe: SecretStoreProbe | null = null;
  let credentialInventory: CredentialInventoryReport | null = null;
  let releaseEvidence: ReleaseEvidenceRecord | null = null;
  let credentialEvidence: ReleaseEvidenceRecord | null = null;

  if (config.security.secretsBackend !== "local_encrypted_file") {
    failures.push("local_encrypted_file_backend_required");
  }
  if (!config.security.localEncryptedFile.masterKeyConfigured) {
    failures.push("local_encrypted_file_master_key_required");
  }

  if (failures.length === 0) {
    try {
      const store = new LocalEncryptedFileSecretStore({
        rootDir: config.security.localEncryptedFile.root,
        masterKey: config.security.localEncryptedFile.masterKey
      });
      probe = await store.probe(now);
      credentialInventory = buildCredentialInventory({
        references: await store.listReferences(),
        expectedProviderIds: input.expectedProviderIds ?? defaultExpectedProviderIds(),
        now
      });
      releaseEvidence = {
        evidenceId: input.evidenceId ?? "secret-store-local-encrypted-file",
        evidenceType: "external_secrets_backend",
        providerId: null,
        status: "passed",
        observedAt: now.toISOString(),
        expiresAt,
        source: `local-encrypted-file-secret-store probe run ${sourceRunReference}`,
        metadata: {
          backend: "local_encrypted_file",
          probe: "passed",
          checkedAt: probe.checkedAt,
          referenceCount: probe.referenceCount,
          storeRootHash: stableHash(config.security.localEncryptedFile.root),
          masterKeyConfigured: true
        }
      };
      if (credentialInventory.failures.length === 0) {
        credentialEvidence = {
          evidenceId: input.credentialEvidenceId ?? "secret-store-live-credentials",
          evidenceType: "live_credentials_configured",
          providerId: null,
          status: "passed",
          observedAt: now.toISOString(),
          expiresAt,
          source: `local-encrypted-file-secret-store inventory run ${sourceRunReference}`,
          metadata: {
            backend: "local_encrypted_file",
            checkedAt: now.toISOString(),
            secretReferenceIds: credentialInventory.secretReferenceIds,
            coveredProviderIds: credentialInventory.coveredProviderIds,
            telegramBot: credentialInventory.telegramBot,
            referenceCount: credentialInventory.usableReferenceCount
          }
        };
      }
    } catch (error) {
      failures.push(`local_encrypted_file_probe_failed:${errorMessage(error)}`);
    }
  }

  return {
    schemaVersion: "secret-store-probe/v1",
    generatedAt: now.toISOString(),
    backend: config.security.secretsBackend,
    configured: failures.length === 0,
    probe,
    credentialInventory,
    releaseEvidence,
    credentialEvidence,
    failures
  };
}

export function upsertReleaseEvidenceRecord(input: { path: string; record: ReleaseEvidenceRecord }): void {
  upsertReleaseEvidenceRecords({ path: input.path, records: [input.record] });
}

export function upsertReleaseEvidenceRecords(input: { path: string; records: ReleaseEvidenceRecord[] }): void {
  const existing = existsSync(input.path) ? parseReleaseEvidenceRecords(readFileSync(input.path, "utf8")) : [];
  const replacementIds = new Set(input.records.map((record) => record.evidenceId));
  const records = existing.filter((record) => !replacementIds.has(record.evidenceId));
  records.push(...input.records);
  mkdirSync(dirname(input.path), { recursive: true });
  writeFileSync(input.path, `${JSON.stringify({ records }, null, 2)}\n`);
}

function buildCredentialInventory(input: {
  references: SecretReference[];
  expectedProviderIds: string[];
  now: Date;
}): CredentialInventoryReport {
  const expectedProviderIds = uniqueSorted(input.expectedProviderIds.filter((providerId) => providerId.trim().length > 0));
  const expiredReferences = input.references.filter((reference) => reference.expiresAt && new Date(reference.expiresAt).getTime() <= input.now.getTime());
  const usableReferences = input.references.filter((reference) => !expiredReferences.includes(reference));
  const providerCredentialPurposes: Array<SecretReference["purpose"]> = ["provider_api", "browser_session", "telegram_bot"];
  const providerCredentialReferences = usableReferences.filter((reference) => providerCredentialPurposes.includes(reference.purpose));
  const coveredProviderIds = uniqueSorted(
    providerCredentialReferences
      .map((reference) => reference.providerId)
      .filter((providerId) => expectedProviderIds.includes(providerId))
  );
  const secretReferenceIds = uniqueSorted(providerCredentialReferences.map((reference) => reference.reference));
  const telegramBot = usableReferences.some((reference) => reference.purpose === "telegram_bot");
  const missingProviderIds = expectedProviderIds.filter((providerId) => !coveredProviderIds.includes(providerId));
  const failures: string[] = [];
  if (secretReferenceIds.length === 0) {
    failures.push("secret_reference_ids_missing");
  }
  if (missingProviderIds.length > 0) {
    failures.push(`credential_coverage_missing:${missingProviderIds.join("|")}`);
  }
  if (!telegramBot) {
    failures.push("telegram_bot_credential_missing");
  }

  return {
    expectedProviderIds,
    coveredProviderIds,
    missingProviderIds,
    telegramBot,
    secretReferenceIds,
    referenceCount: input.references.length,
    usableReferenceCount: usableReferences.length,
    expiredReferenceCount: expiredReferences.length,
    failures
  };
}

function defaultExpectedProviderIds(): string[] {
  return createFixtureProviderRegistry().list().map((provider) => provider.providerId);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildSecretStoreProbeReport({
    ...(process.env.SECRET_STORE_PROBE_EVIDENCE_TTL_HOURS ? { evidenceTtlHours: parsePositiveNumber(process.env.SECRET_STORE_PROBE_EVIDENCE_TTL_HOURS) } : {})
  });
  if (process.env.SECRET_STORE_PROBE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when SECRET_STORE_PROBE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.releaseEvidence) {
      throw new Error(`Cannot append release evidence while probe is failing: ${report.failures.join(", ")}`);
    }
    if (process.env.SECRET_STORE_PROBE_REQUIRE_CREDENTIALS === "true" && !report.credentialEvidence) {
      throw new Error(`Cannot append credential evidence: ${report.credentialInventory?.failures.join(", ") ?? "credential_inventory_missing"}`);
    }
    upsertReleaseEvidenceRecords({
      path: process.env.RELEASE_EVIDENCE_PATH,
      records: [report.releaseEvidence, report.credentialEvidence].filter((record): record is ReleaseEvidenceRecord => record !== null)
    });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.SECRET_STORE_PROBE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.SECRET_STORE_PROBE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.SECRET_STORE_PROBE_OUTPUT_PATH, serialized);
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
