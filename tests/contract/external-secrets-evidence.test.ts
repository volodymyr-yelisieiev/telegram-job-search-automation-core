import { describe, expect, it } from "vitest";
import { ReleaseEvidenceEvaluator } from "@job-search/domain";
import { buildExternalSecretsEvidenceReport, parseExternalSecretsEvidenceInput } from "../../scripts/external-secrets-evidence";

describe("external secrets evidence ingestion", () => {
  it("converts managed-secret-store probe results into release evidence without leaking backend scope", () => {
    const report = buildExternalSecretsEvidenceReport({
      record: {
        backend: "vault",
        checkedAt: "2026-05-18T00:00:00.000Z",
        accessCheck: true,
        backendScope: "https://vault.example/v1/secret/data/job-search",
        secretReferenceIds: ["vault://secret/data/job-search/hh", "vault://secret/data/job-search/robota", "vault://secret/data/job-search/telegram"],
        coveredProviderIds: ["hh", "robota", "telegram"],
        telegramBot: true
      },
      source: "production secrets workflow 42",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(report.failures).toEqual([]);
    expect(report.releaseEvidence).toMatchObject({
      evidenceType: "external_secrets_backend",
      status: "passed",
      expiresAt: "2026-05-19T00:00:00.000Z",
      metadata: {
        backend: "vault",
        accessCheck: true,
        checkedAt: "2026-05-18T00:00:00.000Z",
        referenceCount: 3,
        backendScopeHash: expect.any(String)
      }
    });
    expect(report.credentialEvidence).toMatchObject({
      evidenceType: "live_credentials_configured",
      metadata: {
        backend: "vault",
        checkedAt: "2026-05-18T00:00:00.000Z",
        coveredProviderIds: ["hh", "robota", "telegram"],
        telegramBot: true,
        referenceCount: 3
      }
    });
    expect(JSON.stringify(report)).not.toContain("https://vault.example");
    expect(
      new ReleaseEvidenceEvaluator().summarize({
        expectedProviderIds: ["hh", "robota", "telegram"],
        records: [report.releaseEvidence!, report.credentialEvidence!],
        now: new Date("2026-05-18T00:00:00.000Z")
      })
    ).toMatchObject({
      externalSecretsBackend: true,
      liveCredentialsConfigured: true
    });
  });

  it("requires a live source and complete credential coverage before emitting credential evidence", () => {
    const report = buildExternalSecretsEvidenceReport({
      record: {
        backend: "aws_secrets_manager",
        checkedAt: "2026-05-18T00:00:00.000Z",
        probe: "passed",
        secretReferenceIds: ["arn:aws:secretsmanager:eu-central-1:123456789012:secret:job-search/hh"],
        coveredProviderIds: ["hh"],
        telegramBot: false
      },
      source: "local fixture evidence",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(report.liveEvidenceAllowed).toBe(false);
    expect(report.releaseEvidence).toBeNull();
    expect(report.credentialEvidence).toBeNull();
    expect(report.failures).toContain("external_secrets_evidence_requires_live_source");
    expect(report.credentialInventory?.failures).toEqual(
      expect.arrayContaining(["credential_coverage_missing:robota|telegram", "telegram_bot_credential_missing"])
    );
  });

  it("does not re-mint stale secret-store probes as fresh evidence", () => {
    const report = buildExternalSecretsEvidenceReport({
      record: {
        backend: "vault",
        checkedAt: "2026-05-18T00:00:00.000Z",
        accessCheck: true,
        secretReferenceIds: ["vault://secret/data/job-search/hh", "vault://secret/data/job-search/robota", "vault://secret/data/job-search/telegram"],
        coveredProviderIds: ["hh", "robota", "telegram"],
        telegramBot: true
      },
      source: "production secrets workflow 42",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(report.releaseEvidence).toBeNull();
    expect(report.credentialEvidence).toBeNull();
    expect(report.failures).toContain("external_secrets_evidence_expired");
  });

  it("rejects raw secret-like values in the input artifact", () => {
    expect(() =>
      parseExternalSecretsEvidenceInput(
        JSON.stringify({
          backend: "gcp_secret_manager",
          checkedAt: "2026-05-18T00:00:00.000Z",
          accessCheck: true,
          token: "Bearer live-provider-token"
        })
      )
    ).toThrow(/raw secret-like values/);
  });
});
