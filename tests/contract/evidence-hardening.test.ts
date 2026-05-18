import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReleaseEvidenceEvaluator, stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { buildGaSignoffChecklist } from "../../scripts/acceptance-package";
import { buildCalendarEvidenceReport, parseCalendarEvidenceInput } from "../../scripts/calendar-evidence";
import { buildCanaryEvidenceReport, parseCanaryEvidenceResults } from "../../scripts/canary-evidence";
import { buildExternalSecretsEvidenceReport, parseExternalSecretsEvidenceInput } from "../../scripts/external-secrets-evidence";
import { buildLiveProofInputsValidationReport } from "../../scripts/live-proof-inputs-validate";
import { buildOutboundDispatchEvidenceReport, parseOutboundDispatchEvidenceInput } from "../../scripts/outbound-evidence";
import { buildProviderSubmitEvidenceReport, parseProviderSubmitEvidenceInput } from "../../scripts/provider-submit-evidence";
import { buildSoakEvidenceReport, parseSoakEvidenceInput } from "../../scripts/soak-evidence";

describe("live evidence hardening", () => {
  it("validates a complete live proof input bundle before release ledger mutation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "live-proof-inputs-"));
    try {
      const eventAt = "2026-05-18T00:00:00.000Z";
      const source = "https://ci.acme.invalid/job-search/runs/123";
      const paths = {
        secrets: join(tempDir, "live-secrets-probe.json"),
        canaries: join(tempDir, "live-canary-results.json"),
        providerSubmit: join(tempDir, "live-provider-submit-proof.json"),
        calendar: join(tempDir, "live-calendar-smoke.json"),
        outbound: join(tempDir, "live-dispatch-proof.json"),
        soak: join(tempDir, "live-7-day-soak.json")
      };
      writeJson(paths.secrets, {
        backend: "vault",
        checkedAt: eventAt,
        accessCheck: true,
        backendScope: "vault://job-search/production",
        secretReferenceIds: [
          "vault://job-search/hh/credential-ref",
          "vault://job-search/robota/credential-ref",
          "vault://job-search/telegram/bot-ref"
        ],
        coveredProviderIds: ["hh", "robota", "telegram"],
        telegramBot: true
      });
      writeJson(paths.canaries, {
        canaryResults: ["hh", "robota", "telegram"].map((providerId) => ({
          providerId,
          status: "passed",
          canaryRunId: `canary-${providerId}-123`,
          checkedAt: eventAt,
          checks: ["read_only_probe"]
        }))
      });
      writeJson(paths.providerSubmit, {
        providerId: "hh",
        applicationId: "app-123",
        proofId: "provider-submit-proof-123",
        draftHash: "hash-draft-123",
        action: "send_application",
        transport: "provider",
        idempotencyKeyHash: "hash-idempotency-123",
        submitStatus: "submitted",
        submittedAt: eventAt
      });
      writeJson(paths.calendar, {
        calendarProvider: "google-calendar",
        checkedAt: eventAt,
        readCheck: true,
        conflictCheck: true,
        writeCheck: true
      });
      writeJson(paths.outbound, {
        proofId: "outbound-proof-123",
        transport: "telegram",
        idempotencyKeyHash: "hash-dispatch-idempotency-123",
        textHash: "hash-approved-text-123",
        deliveryStatus: "sent",
        deliveredAt: eventAt
      });
      writeJson(paths.soak, completeSoakInput({ completedAt: eventAt }));

      const report = buildLiveProofInputsValidationReport({
        secretsPath: paths.secrets,
        canaryPath: paths.canaries,
        providerSubmitPath: paths.providerSubmit,
        calendarPath: paths.calendar,
        outboundPath: paths.outbound,
        soakPath: paths.soak,
        secretsSource: source,
        canarySource: source,
        providerSubmitSource: source,
        calendarSource: source,
        outboundSource: source,
        soakSource: source,
        expectedProviderIds: ["hh", "robota", "telegram"],
        liveEvidenceAllowed: true,
        now: new Date("2026-05-18T12:00:00.000Z")
      });

      expect(report).toMatchObject({
        schemaVersion: "live-proof-inputs-validation/v1",
        liveEvidenceAllowed: true,
        expectedProviderIds: ["hh", "robota", "telegram"],
        passed: true,
        releaseEvidenceRecordCount: 9,
        failures: []
      });
      expect(report.releaseEvidenceTypes).toEqual(
        expect.arrayContaining([
          "calendar_integration_ready",
          "external_secrets_backend",
          "live_canary_passed",
          "live_credentials_configured",
          "outbound_dispatch_proof_ready",
          "provider_submit_proof_ready",
          "seven_day_soak_passed"
        ])
      );
      expect(report.items.every((item) => item.present && item.failures.length === 0)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects live proof input examples even when a live-looking source is supplied", () => {
    const source = "https://ci.acme.invalid/job-search/runs/123";
    const report = buildLiveProofInputsValidationReport({
      secretsPath: "docs/examples/live-secrets-probe.example.json",
      canaryPath: "docs/examples/live-canary-results.example.json",
      providerSubmitPath: "docs/examples/live-provider-submit-proof.example.json",
      calendarPath: "docs/examples/live-calendar-smoke.example.json",
      outboundPath: "docs/examples/live-dispatch-proof.example.json",
      soakPath: "docs/examples/live-7-day-soak.example.json",
      secretsSource: source,
      canarySource: source,
      providerSubmitSource: source,
      calendarSource: source,
      outboundSource: source,
      soakSource: source,
      expectedProviderIds: ["hh", "robota", "telegram"],
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T12:00:00.000Z")
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "external_secrets:input_contains_example_marker",
        "live_canaries:input_contains_example_marker",
        "provider_submit:input_contains_example_marker",
        "calendar:input_contains_example_marker",
        "outbound_dispatch:input_contains_example_marker",
        "seven_day_soak:input_contains_example_marker"
      ])
    );
  });

  it("requires explicit live assertion before validating a live proof input bundle", () => {
    const source = "https://ci.acme.invalid/job-search/runs/123";
    const report = buildLiveProofInputsValidationReport({
      secretsPath: "docs/examples/live-secrets-probe.example.json",
      canaryPath: "docs/examples/live-canary-results.example.json",
      providerSubmitPath: "docs/examples/live-provider-submit-proof.example.json",
      calendarPath: "docs/examples/live-calendar-smoke.example.json",
      outboundPath: "docs/examples/live-dispatch-proof.example.json",
      soakPath: "docs/examples/live-7-day-soak.example.json",
      secretsSource: source,
      canarySource: source,
      providerSubmitSource: source,
      calendarSource: source,
      outboundSource: source,
      soakSource: source,
      expectedProviderIds: ["hh", "robota", "telegram"],
      liveEvidenceAllowed: false,
      now: new Date("2026-05-18T12:00:00.000Z")
    });

    expect(report.liveEvidenceAllowed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failures).toContain("live_proof_inputs_assert_live_required");
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "external_secrets:external_secrets_evidence_requires_live_source",
        "live_canaries:live_canary_evidence_requires_live_source",
        "provider_submit:provider_submit_evidence_requires_live_source",
        "calendar:calendar_evidence_requires_live_source",
        "outbound_dispatch:outbound_dispatch_evidence_requires_live_source",
        "seven_day_soak:soak_evidence_requires_live_source"
      ])
    );
  });

  it("parses live proof input examples while keeping them blocked as non-live examples", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const exampleSource = "example://replace-with-real-live-workflow-run";

    const secrets = buildExternalSecretsEvidenceReport({
      record: parseExternalSecretsEvidenceInput(readFileSync("docs/examples/live-secrets-probe.example.json", "utf8")),
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(secrets.releaseEvidence).toBeNull();
    expect(secrets.credentialEvidence).toBeNull();
    expect(secrets.failures).toContain("external_secrets_evidence_requires_live_source");

    const canaries = buildCanaryEvidenceReport({
      records: parseCanaryEvidenceResults(readFileSync("docs/examples/live-canary-results.example.json", "utf8")),
      expectedProviderIds: ["hh", "robota", "telegram"],
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(canaries.evidenceRecords).toEqual([]);
    expect(canaries.failures).toContain("live_canary_evidence_requires_live_source");

    const submit = buildProviderSubmitEvidenceReport({
      proof: parseProviderSubmitEvidenceInput(readFileSync("docs/examples/live-provider-submit-proof.example.json", "utf8")),
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(submit.evidenceRecord).toBeNull();
    expect(submit.failures).toContain("provider_submit_evidence_requires_live_source");

    const calendar = buildCalendarEvidenceReport({
      record: parseCalendarEvidenceInput(readFileSync("docs/examples/live-calendar-smoke.example.json", "utf8")),
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(calendar.evidenceRecord).toBeNull();
    expect(calendar.failures).toContain("calendar_evidence_requires_live_source");

    const dispatch = buildOutboundDispatchEvidenceReport({
      proof: parseOutboundDispatchEvidenceInput(readFileSync("docs/examples/live-dispatch-proof.example.json", "utf8")),
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(dispatch.evidenceRecord).toBeNull();
    expect(dispatch.failures).toContain("outbound_dispatch_evidence_requires_live_source");

    const soak = buildSoakEvidenceReport({
      report: parseSoakEvidenceInput(readFileSync("docs/examples/live-7-day-soak.example.json", "utf8")),
      source: exampleSource,
      liveEvidenceAllowed: true,
      now
    });
    expect(soak.evidenceRecord).toBeNull();
    expect(soak.failures).toContain("soak_evidence_requires_live_source");
  });

  it("stamps release evidence with the live source event timestamp instead of re-minting it at package time", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const eventAt = "2026-05-18T00:00:00.000Z";
    const source = "https://ci.acme.invalid/job-search/runs/123";

    expect(
      buildCanaryEvidenceReport({
        records: [{ providerId: "hh", status: "passed", canaryRunId: "canary-hh-123", checkedAt: eventAt }],
        expectedProviderIds: ["hh"],
        source,
        liveEvidenceAllowed: true,
        now
      }).evidenceRecords[0]?.observedAt
    ).toBe(eventAt);
    expect(
      buildCalendarEvidenceReport({
        record: { calendarProvider: "google-calendar", checkedAt: eventAt, readCheck: true, conflictCheck: true, writeCheck: true },
        source,
        liveEvidenceAllowed: true,
        now
      }).evidenceRecord?.observedAt
    ).toBe(eventAt);
    expect(
      buildExternalSecretsEvidenceReport({
        record: {
          backend: "vault",
          checkedAt: eventAt,
          accessCheck: true,
          secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/telegram/bot"],
          coveredProviderIds: ["hh"],
          telegramBot: true
        },
        expectedProviderIds: ["hh"],
        source,
        liveEvidenceAllowed: true,
        now
      }).releaseEvidence?.observedAt
    ).toBe(eventAt);
    expect(
      buildProviderSubmitEvidenceReport({
        proof: {
          providerId: "hh",
          applicationId: "app-123",
          proofId: "provider-proof-123",
          draftHash: "draft-hash",
          action: "send_application",
          transport: "provider",
          idempotencyKeyHash: "idem-hash",
          submitStatus: "submitted",
          submittedAt: eventAt
        },
        source,
        liveEvidenceAllowed: true,
        now
      }).evidenceRecord?.observedAt
    ).toBe(eventAt);
    expect(
      buildOutboundDispatchEvidenceReport({
        proof: {
          proofId: "outbound-proof-123",
          transport: "telegram",
          idempotencyKeyHash: stableHash("reply:1"),
          textHash: stableHash("Approved reply"),
          deliveryStatus: "sent",
          deliveredAt: eventAt
        },
        source,
        liveEvidenceAllowed: true,
        now
      }).evidenceRecord?.observedAt
    ).toBe(eventAt);
    expect(
      buildSoakEvidenceReport({
        report: completeSoakInput({ completedAt: eventAt }),
        source,
        liveEvidenceAllowed: true,
        now
      }).evidenceRecord?.observedAt
    ).toBe(eventAt);
  });

  it("requires a live source with an external run or proof reference", () => {
    const report = buildCalendarEvidenceReport({
      record: {
        calendarProvider: "google-calendar",
        checkedAt: "2026-05-18T00:00:00.000Z",
        readCheck: true,
        conflictCheck: true,
        writeCheck: true
      },
      source: "production calendar smoke",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(report.liveEvidenceAllowed).toBe(false);
    expect(report.evidenceRecord).toBeNull();
    expect(report.failures).toContain("calendar_evidence_requires_live_source");

    const validation = new ReleaseEvidenceEvaluator().validateRecord({
      expectedProviderIds: ["hh"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      record: {
        evidenceId: "calendar-weak-source",
        evidenceType: "calendar_integration_ready",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "calendar smoke",
        metadata: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        }
      }
    });
    expect(validation).toContain("live_evidence_source_required");
  });

  it("derives the seven-day soak from startedAt/completedAt and requires both timestamps", () => {
    const shortReport = buildSoakEvidenceReport({
      report: completeSoakInput({
        startedAt: "2026-05-11T03:00:00.000Z",
        completedAt: "2026-05-18T00:00:00.000Z",
        durationDays: 7
      }),
      source: "production soak run 123",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(shortReport.durationDays).toBeLessThan(7);
    expect(shortReport.evidenceRecord).toBeNull();
    expect(shortReport.failures).toContain("minimum_seven_day_duration_required");

    const missingTimestampReport = buildSoakEvidenceReport({
      report: {
        durationDays: 7,
        duplicateApplicationCount: 0,
        proofCoveragePercent: 100,
        stateLossDetected: false,
        unsupportedFactCount: 0,
        incidentDrillPassed: true,
        rollbackDrillPassed: true
      },
      source: "production soak run 123",
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z")
    });
    expect(missingTimestampReport.failures).toEqual(expect.arrayContaining(["started_at_required", "completed_at_required"]));
  });

  it("rejects release evidence whose observedAt was re-minted after the source event timestamp", () => {
    const evaluator = new ReleaseEvidenceEvaluator();
    const staleRemintedRecord: ReleaseEvidenceRecord = {
      evidenceId: "calendar-reminted",
      evidenceType: "calendar_integration_ready",
      providerId: null,
      status: "passed",
      observedAt: "2026-05-18T12:00:00.000Z",
      expiresAt: "2026-05-19T00:00:00.000Z",
      source: "calendar smoke run 123",
      metadata: {
        calendarProvider: "google-calendar",
        checkedAt: "2026-05-18T00:00:00.000Z",
        readCheck: true,
        conflictCheck: true,
        writeCheck: true
      }
    };

    expect(
      evaluator.validateRecord({
        record: staleRemintedRecord,
        expectedProviderIds: ["hh"],
        now: new Date("2026-05-18T12:00:00.000Z")
      })
    ).toContain("calendar_observed_at_must_match_source_timestamp");
  });

  it("rejects future-dated signers and unverified GA signoff evidence references", () => {
    const checklist = buildGaSignoffChecklist({
      now: new Date("2026-05-18T00:00:00.000Z"),
      signoff: {
        checklistVersion: "ga-signoff/v1",
        p0P1Closed: true,
        p2P3HaveOwners: true,
        runbookDrillsReviewed: true,
        residualRiskAccepted: true,
        postGaMaintenancePlanReady: true,
        evidenceRefs: {
          issueRegister: "pending",
          runbookDrillReport: "release/2026-05-18/runbook-drills",
          residualRiskRecord: "https://example.com/residual-risk",
          maintenancePlan: "release/2026-05-18/maintenance-plan"
        },
        signers: [
          { role: "product_owner", name: "Product Owner", date: "2026-05-19T00:00:00.000Z", decision: "approved" },
          { role: "engineering", name: "Engineering Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
          { role: "operations", name: "Operations Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
          { role: "security", name: "Security Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" }
        ]
      }
    });

    expect(checklist.blockers).toEqual(
      expect.arrayContaining([
        "signoff_date_in_future:product_owner",
        "signoff_evidence_ref_unverified_or_example:issueRegister",
        "signoff_evidence_ref_unverified_or_example:residualRiskRecord"
      ])
    );
  });
});

function completeSoakInput(overrides: Partial<Parameters<typeof buildSoakEvidenceReport>[0]["report"]> = {}) {
  return {
    startedAt: "2026-05-10T00:00:00.000Z",
    completedAt: "2026-05-18T00:00:00.000Z",
    duplicateApplicationCount: 0,
    proofCoveragePercent: 100,
    stateLossDetected: false,
    unsupportedFactCount: 0,
    incidentDrillPassed: true,
    rollbackDrillPassed: true,
    ...overrides
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}
