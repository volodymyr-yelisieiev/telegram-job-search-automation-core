import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveAcceptanceGateReport } from "../../scripts/live-acceptance-gate";
import { buildLiveCompletionPlan } from "../../scripts/live-completion-plan";
import { buildReleaseDocumentationPack } from "../../scripts/release-documentation-pack";
import { buildRoadmapCompletionAudit } from "../../scripts/roadmap-completion-audit";
import { buildRoadmapComplianceReport } from "../../scripts/roadmap-compliance-check";
import { buildRoadmapLocalGatesReport } from "../../scripts/roadmap-local-gates";
import { buildRuntimePreflightReport, parseRuntimePreflightReport, type RuntimePreflightCheckName } from "../../scripts/runtime-preflight";

const TEST_NOW = new Date("2026-05-18T00:00:00.000Z");

function expectEnvPlaceholders(requiredEnvKeys: string[], commands: string[]): void {
  const commandText = commands.join("\n");
  for (const key of requiredEnvKeys) {
    expect(commandText).toContain(`${key}=`);
  }
}

describe("roadmap compliance matrix", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("covers every roadmap sprint with allowed status and evidence", () => {
    const report = buildRoadmapComplianceReport();

    expect(report).toMatchObject({
      schemaVersion: "roadmap-compliance-validation/v1",
      roadmapSprintCount: 40,
      matrixSprintCount: 40,
      boardSprintCount: 40,
      missingMatrixSprintIds: [],
      extraMatrixSprintIds: [],
      missingBoardSprintIds: [],
      extraBoardSprintIds: [],
      invalidStatuses: [],
      boardStatusMismatches: [],
      blankEvidenceSprintIds: [],
      selfCheckPresent: true,
      passed: true,
      failures: []
    });
    expect(report.roadmapSprintIds).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(report.matrixSprintIds).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(report.boardSprintIds).toEqual(Array.from({ length: 40 }, (_, index) => index));
  });

  it("keeps final completion blocked while live evidence and sign-off are missing", async () => {
    const report = await buildRoadmapCompletionAudit({
      releaseEvidencePath: "missing-release-evidence.json",
      gaSignoffPath: "missing-ga-signoff.json",
      acceptanceIterations: 1
    });

    expect(report).toMatchObject({
      schemaVersion: "roadmap-completion-audit/v1",
      roadmapCompliancePassed: true,
      complete: false,
      missingLiveArtifacts: [
        "missing_release_evidence_file:missing-release-evidence.json",
        "missing_ga_signoff_file:missing-ga-signoff.json",
        "missing_runtime_preflight_file:runtime-preflight.json"
      ],
      liveArtifactValidation: {
        releaseEvidence: { present: false, records: 0, blockers: [] },
        gaSignoff: { present: false, explicitSignoffProvided: false, blockers: [] },
        runtime: {
          environment: "local",
          mode: "review_first",
          irreversibleActionsEnabled: false,
          stateBackend: "memory",
          secretsBackend: "env",
          preflight: {
            present: false,
            passed: null,
            externalProbesRun: null,
            configMatches: null
          },
          blockers: expect.arrayContaining([
            "production_environment_required",
            "controlled_or_full_auto_apply_mode_required",
            "irreversible_actions_enabled_required",
            "postgres_state_backend_required",
            "external_secrets_backend_required",
            "telegram_bot_token_required",
            "live_llm_provider_required",
            "runtime_preflight_report_required"
          ])
        },
        aggregateGates: {
          releaseGate: {
            readyForLiveAutomation: false,
            failures: expect.arrayContaining(["release_evidence:missing_live_credentials_evidence"])
          },
          acceptancePackage: {
            passed: false,
            fixtureSoakPassed: true,
            releaseGatePassed: false,
            gaSignoffPassed: false,
            blockers: expect.arrayContaining(["release_evidence:missing_live_credentials_evidence", "ga_signoff:explicit_ga_signoff_missing"])
          }
        }
      }
    });
    expect(report.roadmapBlockers.map((blocker) => blocker.id)).toEqual(expect.arrayContaining(["23", "30", "38"]));
    expect(report.roadmapBlockers.find((blocker) => blocker.id === "23")?.missingLiveChecks).toEqual(
      expect.arrayContaining(["aggregate:acceptance_package", "release_evidence:live_credentials_configured"])
    );
    expect(report.prdBlockers.map((blocker) => blocker.id)).toEqual(expect.arrayContaining(["Irreversible actions", "Live providers/accounts/Telegram/calendar/secrets"]));
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "roadmap_blocker:23:external_evidence_required",
        "prd_blocker:Irreversible actions:irreversible_live_behavior_not_enabled",
        "runtime:production_environment_required",
        "aggregate_release_gate:release_evidence:missing_live_credentials_evidence",
        "aggregate_acceptance:ga_signoff:explicit_ga_signoff_missing"
      ])
    );
  });

  it("builds a redacted live completion handoff plan from completion blockers", async () => {
    const report = await buildLiveCompletionPlan({
      releaseEvidencePath: "missing-release-evidence.json",
      gaSignoffPath: "missing-ga-signoff.json",
      acceptanceIterations: 1,
      env: {
        TELEGRAM_BOT_TOKEN: "123:super-secret-token",
        LLM_API_KEY: "super-secret-llm-key"
      },
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(report).toMatchObject({
      schemaVersion: "live-completion-plan/v1",
      auditComplete: false,
      missingArtifacts: expect.arrayContaining([
        "missing_release_evidence_file:missing-release-evidence.json",
        "missing_ga_signoff_file:missing-ga-signoff.json"
      ]),
      missingChecks: expect.arrayContaining([
        "runtime:production_environment",
        "release_evidence:live_credentials_configured",
        "release_evidence:seven_day_soak_passed",
        "aggregate:ga_signoff"
      ]),
      blockingRows: {
        roadmap: expect.arrayContaining([expect.objectContaining({ id: "23" }), expect.objectContaining({ id: "38" })]),
        prd: expect.arrayContaining([expect.objectContaining({ id: "Live providers/accounts/Telegram/calendar/secrets" })])
      }
    });
    expect(report.actionGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime_preflight",
          status: "pending",
          blockingRowRefs: {
            roadmap: expect.arrayContaining(["1", "2", "6", "24", "36"]),
            prd: expect.arrayContaining(["Irreversible actions", "Queues", "Live providers/accounts/Telegram/calendar/secrets"])
          },
          requiredEnvKeys: expect.arrayContaining(["NODE_ENV", "QUEUE_BACKEND", "TELEGRAM_WEBHOOK_SECRET", "LLM_API_KEY"]),
          commands: expect.arrayContaining([expect.stringContaining("DATABASE_URL=<postgres-url>"), expect.stringContaining("TELEGRAM_BOT_TOKEN=<bot-token>")])
        }),
        expect.objectContaining({
          id: "release_evidence",
          status: "pending",
          blockingRowRefs: {
            roadmap: expect.arrayContaining(["9", "10", "20", "23", "29", "33", "38"]),
            prd: expect.arrayContaining(["Outbound recruiter replies", "Interview coordination", "Live providers/accounts/Telegram/calendar/secrets"])
          },
          requiredArtifacts: expect.arrayContaining([
            "release-evidence.json",
            "live-secrets-probe.json",
            "live-canary-results.json",
            "live-provider-submit-proof.json",
            "live-calendar-smoke.json",
            "live-dispatch-proof.json",
            "live-7-day-soak.json"
          ]),
          commands: expect.arrayContaining([
            expect.stringContaining("pnpm release:live-inputs:validate"),
            expect.stringContaining("CANARY_SMOKE_SOURCE=<live-workflow-url>"),
            expect.stringContaining("GOOGLE_CALENDAR_SMOKE_TIME_MIN=<iso-start>"),
            expect.stringContaining("TELEGRAM_DISPATCH_TEXT=<approved-text>"),
            expect.stringContaining("pnpm soak:evidence")
          ])
        }),
        expect.objectContaining({
          id: "ga_signoff",
          status: "pending",
          blockingRowRefs: {
            roadmap: expect.arrayContaining(["30", "35", "38"]),
            prd: []
          },
          requiredArtifacts: ["ga-signoff.json"]
        }),
        expect.objectContaining({
          id: "final_acceptance_audit",
          status: "pending",
          blockingRowRefs: {
            roadmap: expect.arrayContaining(["1", "2", "23", "24", "25", "38"]),
            prd: expect.arrayContaining(["Irreversible actions", "Outbound recruiter replies", "Observability"])
          },
          commands: expect.arrayContaining([expect.stringContaining("pnpm roadmap:live-acceptance"), expect.stringContaining("pnpm roadmap:completion-audit")])
        })
      ])
    );
    const runtimeGroup = report.actionGroups.find((group) => group.id === "runtime_preflight")!;
    const releaseGroup = report.actionGroups.find((group) => group.id === "release_evidence")!;
    const finalGroup = report.actionGroups.find((group) => group.id === "final_acceptance_audit")!;
    expectEnvPlaceholders(runtimeGroup.requiredEnvKeys, runtimeGroup.commands);
    expectEnvPlaceholders(releaseGroup.requiredEnvKeys, releaseGroup.commands);
    expectEnvPlaceholders(finalGroup.requiredEnvKeys, finalGroup.commands);
    expect(finalGroup.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("LIVE_PROOF_INPUTS_ASSERT_LIVE=true"),
        expect.stringContaining("EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url>"),
        expect.stringContaining("SOAK_EVIDENCE_SOURCE=<live-workflow-url>"),
        expect.stringContaining("pnpm roadmap:live-acceptance")
      ])
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-llm-key");
  });

  it("validates the final documentation pack required for GA handoff", () => {
    const report = buildReleaseDocumentationPack({ now: new Date("2026-05-18T00:00:00.000Z") });

    expect(report).toMatchObject({
      schemaVersion: "release-documentation-pack/v1",
      generatedAt: "2026-05-18T00:00:00.000Z",
      valid: true,
      missingFiles: [],
      emptyFiles: [],
      blockers: []
    });
    expect(report.fileCount).toBeGreaterThanOrEqual(45);
    expect(report.groups.map((group) => group.id)).toEqual([
      "prd_and_roadmap",
      "adrs",
      "runbooks",
      "provider_playbooks",
      "security_and_deployment",
      "release_notes",
      "verification_and_live_handoff"
    ]);
    expect(report.groups.find((group) => group.id === "release_notes")?.requiredFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining(["docs/releases/R0-baseline.md", "docs/releases/R8-ga.md", "docs/releases/GA-signoff-checklist.md"])
    );
    expect(report.groups.find((group) => group.id === "verification_and_live_handoff")?.requiredFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "docs/examples/release-evidence.example.json",
        "docs/examples/ga-signoff.example.json",
        "docs/examples/runtime-preflight.example.json",
        "docs/examples/live-secrets-probe.example.json",
        "docs/examples/live-canary-results.example.json",
        "docs/examples/live-provider-submit-proof.example.json",
        "docs/examples/live-calendar-smoke.example.json",
        "docs/examples/live-dispatch-proof.example.json",
        "docs/examples/live-7-day-soak.example.json"
      ])
    );
    const roadmapMatrix = readFileSync("docs/verification/ROADMAP_COMPLIANCE_MATRIX.md", "utf8");
    expect(roadmapMatrix).toContain("queue resilience checks");
    expect(roadmapMatrix).toContain("live-provider-submit-proof.json");
    expect(roadmapMatrix).toContain("blocking roadmap/PRD row references");
    expect(roadmapMatrix).toContain("release:live-inputs:validate");
    expect(roadmapMatrix).toContain("roadmap:live-acceptance");
    const releaseGates = readFileSync("docs/deployment/release-gates.md", "utf8");
    const r8Notes = readFileSync("docs/releases/R8-ga.md", "utf8");
    const gaChecklist = readFileSync("docs/releases/GA-signoff-checklist.md", "utf8");
    for (const artifact of [
      "live-secrets-probe.json",
      "live-canary-results.json",
      "live-provider-submit-proof.json",
      "live-calendar-smoke.json",
      "live-dispatch-proof.json",
      "live-7-day-soak.json"
    ]) {
      expect(releaseGates).toContain(artifact);
      expect(r8Notes).toContain(artifact);
      expect(gaChecklist).toContain(artifact);
    }
    expect(gaChecklist).toContain("LIVE_PROOF_INPUTS_ASSERT_LIVE=true");
    expect(gaChecklist).toContain("LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true");
    expect(gaChecklist).toContain("pnpm roadmap:live-acceptance");
    expect(report.groups.flatMap((group) => group.requiredFiles).every((file) => file.sha256 && file.sha256.length === 64)).toBe(true);
  });

  it("summarizes local roadmap gates for verify and CI without requiring live evidence", async () => {
    const report = await buildRoadmapLocalGatesReport({
      releaseEvidencePath: "missing-release-evidence.json",
      gaSignoffPath: "missing-ga-signoff.json",
      acceptanceIterations: 1,
      env: {
        TELEGRAM_BOT_TOKEN: "123:super-secret-token",
        LLM_API_KEY: "super-secret-llm-key"
      },
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    expect(report).toMatchObject({
      schemaVersion: "roadmap-local-gates/v1",
      generatedAt: "2026-05-18T00:00:00.000Z",
      passed: true,
      roadmapCompliance: {
        passed: true,
        roadmapSprintCount: 40,
        matrixSprintCount: 40,
        boardSprintCount: 40,
        failures: []
      },
      documentationPack: {
        valid: true,
        missingFileCount: 0,
        emptyFileCount: 0,
        blockers: []
      },
      liveHandoff: {
        generated: true,
        auditComplete: false,
        status: "pending_external_evidence",
        missingArtifactCount: 3,
        actionGroupIds: ["runtime_preflight", "release_evidence", "ga_signoff", "final_acceptance_audit"],
        missingActionGroupIds: []
      },
      queueResilience: {
        queueRuntime: "memory",
        duplicateSuppressed: true,
        workerRestartRecovered: true,
        deadLetterVisible: true,
        retryQueued: true,
        redisRestartCheck: "simulated",
        passed: true,
        failures: []
      },
      failures: []
    });
    expect(report.documentationPack.fileCount).toBeGreaterThanOrEqual(45);
    expect(report.liveHandoff.missingCheckCount).toBeGreaterThan(0);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-llm-key");
  });

  it("redacts sensitive runtime preflight probe failures", async () => {
    const report = await buildRuntimePreflightReport({
      env: {
        TELEGRAM_BOT_TOKEN: "123:secret-token",
        TELEGRAM_ALLOWED_USER_IDS: "1"
      },
      runExternalProbes: true,
      probeOverrides: {
        redis_reachable: passedProbe("redis_reachable")
      },
      fetchImpl: async () => {
        throw new Error("request failed https://api.telegram.org/bot123:secret-token/getMe token=123:secret-token Bearer provider-token");
      }
    });

    const telegramProbe = report.checks.find((check) => check.name === "telegram_get_me");
    expect(telegramProbe?.passed).toBe(false);
    expect(telegramProbe?.reason).toContain("[redacted:");
    expect(JSON.stringify(report)).not.toContain("123:secret-token");
    expect(JSON.stringify(report)).not.toContain("provider-token");
    expect(JSON.stringify(report)).not.toContain("https://api.telegram.org/bot123:secret-token");
  });

  it("can resolve local-safe roadmap rows when live evidence, runtime, and sign-off are complete", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "roadmap-completion-"));
    try {
      const releaseEvidencePath = join(tempDir, "release-evidence.json");
      const gaSignoffPath = join(tempDir, "ga-signoff.json");
      const runtimePreflightPath = join(tempDir, "runtime-preflight.json");
      writeFileSync(releaseEvidencePath, JSON.stringify(completeReleaseEvidence(), null, 2));
      writeFileSync(gaSignoffPath, JSON.stringify(completeGaSignoff(), null, 2));
      const env = {
        NODE_ENV: "production",
        API_TOKEN: "prod-token",
	        APP_MODE: "controlled_auto_apply",
	        IRREVERSIBLE_ACTIONS_ENABLED: "true",
	        STATE_BACKEND: "postgres",
	        QUEUE_BACKEND: "bullmq",
	        SECRETS_BACKEND: "vault",
	        PROVIDER_CONFIG_JSON: JSON.stringify([
	          {
	            providerId: "hh",
	            enabled: true,
	            runtimeKind: "live",
	            statusOverride: "stable",
	            liveSubmitEndpoint: "https://submit.example/hh",
	            liveSubmitAuthTokenEnv: "HH_SUBMIT_TOKEN"
	          },
	          {
	            providerId: "robota",
	            enabled: true,
	            runtimeKind: "live",
	            statusOverride: "stable",
	            liveSubmitEndpoint: "https://submit.example/robota",
	            liveSubmitAuthTokenEnv: "ROBOTA_SUBMIT_TOKEN"
	          }
	        ]),
	        HH_SUBMIT_TOKEN: "hh-submit-secret",
	        ROBOTA_SUBMIT_TOKEN: "robota-submit-secret",
	        OBJECT_STORAGE_BACKEND: "s3_compatible",
        OBJECT_STORAGE_S3_ENDPOINT: "https://s3.example.test",
        OBJECT_STORAGE_S3_BUCKET: "job-search-artifacts",
        OBJECT_STORAGE_S3_REGION: "eu-central-1",
        OBJECT_STORAGE_S3_ACCESS_KEY_ID: "access-key",
        OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "secret-key",
        TELEGRAM_BOT_TOKEN: "live-telegram-token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        TELEGRAM_WEBHOOK_SECRET: "live-telegram-webhook-secret",
        LLM_PROVIDER: "openai-compatible",
        LLM_API_BASE_URL: "https://llm.example.test",
        LLM_API_KEY: "live-llm-key"
      };
      const runtimePreflight = await buildRuntimePreflightReport({
        env,
        runExternalProbes: true,
        probeOverrides: {
          postgres_reachable: passedProbe("postgres_reachable", { migrationRows: 9 }),
          redis_reachable: passedProbe("redis_reachable"),
          s3_object_storage_roundtrip: passedProbe("s3_object_storage_roundtrip", { bytes: 32, cleanupDeleted: true }),
          telegram_get_me: passedProbe("telegram_get_me", { botIdPresent: true, usernamePresent: true }),
          llm_chat_completion: passedProbe("llm_chat_completion", { model: "local-mock", promptVersion: "test" })
        },
        now: new Date("2026-05-18T00:00:00.000Z")
      });
      const serializedRuntimePreflight = JSON.stringify(runtimePreflight, null, 2);
      expect(serializedRuntimePreflight).not.toContain("https://llm.example.test");
      expect(serializedRuntimePreflight).not.toContain("https://s3.example.test");
      expect(serializedRuntimePreflight).not.toContain("https://submit.example/hh");
      expect(serializedRuntimePreflight).not.toContain("hh-submit-secret");
      expect(serializedRuntimePreflight).not.toContain("secret-key");
      expect(serializedRuntimePreflight).not.toContain("live-telegram-webhook-secret");
      expect(runtimePreflight.configSummary).toMatchObject({
        llmApiConfigured: true,
        llmApiBaseUrlHash: expect.any(String),
        queueBackend: "bullmq",
        objectStorageBackend: "s3_compatible",
        s3EndpointHash: expect.any(String),
        s3BucketHash: expect.any(String),
        s3Region: "eu-central-1",
        s3AccessKeyIdHash: expect.any(String),
        s3SecretAccessKeyConfigured: true,
        telegramWebhookSecretConfigured: true,
        telegramWebhookSecretHash: expect.any(String),
        liveSubmitProviders: [
          { providerId: "hh", endpointHash: expect.any(String), authTokenEnvHash: expect.any(String), authTokenConfigured: true },
          { providerId: "robota", endpointHash: expect.any(String), authTokenEnvHash: expect.any(String), authTokenConfigured: true }
        ]
      });
      expect(runtimePreflight.configSummary).not.toHaveProperty("llmApiBaseUrl");
      expect(runtimePreflight.configSummary).not.toHaveProperty("s3Endpoint");
      writeFileSync(runtimePreflightPath, serializedRuntimePreflight);

      const report = await buildRoadmapCompletionAudit({
        releaseEvidencePath,
        gaSignoffPath,
        runtimePreflightPath,
        acceptanceIterations: 1,
        env,
        now: new Date("2026-05-18T01:00:00.000Z")
      });

      expect(report).toMatchObject({
        complete: true,
        roadmapBlockers: [],
        prdBlockers: [],
        missingLiveArtifacts: [],
        failures: [],
        liveArtifactValidation: {
          runtime: {
            environment: "production",
            mode: "controlled_auto_apply",
            irreversibleActionsEnabled: true,
            stateBackend: "postgres",
            queueBackend: "bullmq",
            secretsBackend: "vault",
            objectStorageBackend: "s3_compatible",
            s3ObjectStorageConfigured: true,
            telegramBotConfigured: true,
            telegramWebhookSecretConfigured: true,
            llmProvider: "openai-compatible",
            llmApiConfigured: true,
            preflight: {
              present: true,
              passed: true,
              externalProbesRun: true,
              generatedAt: "2026-05-18T00:00:00.000Z",
              ageHours: 1,
              maxAgeHours: 24,
              fresh: true,
              configMatches: true,
              failures: []
            },
            blockers: []
          },
          aggregateGates: {
            releaseGate: { readyForLiveAutomation: true, failures: [] },
            acceptancePackage: { passed: true, releaseGatePassed: true, gaSignoffPassed: true }
          }
        }
      });
      expect(report.resolvedRoadmapRows.map((row) => row.id)).toEqual(
        expect.arrayContaining(["1", "2", "6", "23", "29", "30", "33", "38"])
      );
      expect(report.resolvedPrdRows.map((row) => row.id)).toEqual(
        expect.arrayContaining(["Irreversible actions", "Outbound recruiter replies", "Live providers/accounts/Telegram/calendar/secrets"])
      );
      const gate = await buildLiveAcceptanceGateReport({
        releaseEvidencePath,
        gaSignoffPath,
        runtimePreflightPath,
        acceptanceIterations: 1,
        env,
        now: new Date("2026-05-18T01:00:00.000Z")
      });
      expect(gate).toMatchObject({
        schemaVersion: "live-acceptance-gate/v1",
        passed: true,
        failures: [],
        validateLiveInputs: false,
        releaseEvidence: { valid: true, records: 9, failures: [] },
        gaSignoff: { valid: true, explicitSignoffProvided: true, signers: 4, blockers: [] },
        acceptance: {
          environment: "production",
          mode: "controlled_auto_apply",
          irreversibleActionsEnabled: true,
          acceptance: { passed: true, releaseGatePassed: true, gaSignoffPassed: true }
        },
        completionAudit: { complete: true, missingLiveArtifacts: [], failures: [] }
      });
      expect(gate.checks.map((check) => check.id)).toEqual([
        "runtime_config",
        "live_proof_inputs",
        "release_evidence",
        "ga_signoff",
        "acceptance_package",
        "roadmap_completion_audit"
      ]);
      const serializedGate = JSON.stringify(gate);
      expect(serializedGate).not.toContain("live-telegram-token");
      expect(serializedGate).not.toContain("hh-submit-secret");
      expect(serializedGate).not.toContain("https://llm.example.test");

      const staleRuntimePreflightPath = join(tempDir, "runtime-preflight-stale.json");
      writeFileSync(
        staleRuntimePreflightPath,
        JSON.stringify(
          await buildRuntimePreflightReport({
            env: { ...env, TELEGRAM_BOT_TOKEN: "different-live-telegram-token" },
            runExternalProbes: true,
            probeOverrides: {
              postgres_reachable: passedProbe("postgres_reachable", { migrationRows: 9 }),
              redis_reachable: passedProbe("redis_reachable"),
              s3_object_storage_roundtrip: passedProbe("s3_object_storage_roundtrip", { bytes: 32, cleanupDeleted: true }),
              telegram_get_me: passedProbe("telegram_get_me", { botIdPresent: true, usernamePresent: true }),
              llm_chat_completion: passedProbe("llm_chat_completion", { model: "local-mock", promptVersion: "test" })
            },
            now: new Date("2026-05-18T00:00:00.000Z")
          }),
          null,
          2
        )
      );
      const staleReport = await buildRoadmapCompletionAudit({
        releaseEvidencePath,
        gaSignoffPath,
        runtimePreflightPath: staleRuntimePreflightPath,
        acceptanceIterations: 1,
        env,
        now: new Date("2026-05-18T01:00:00.000Z")
      });
      expect(staleReport).toMatchObject({
        complete: false,
        liveArtifactValidation: {
          runtime: {
            preflight: {
              present: true,
              passed: true,
              externalProbesRun: true,
              configMatches: false
            },
            blockers: expect.arrayContaining(["runtime_preflight_config_mismatch"])
          }
        }
      });
      expect(staleReport.failures).toContain("runtime:runtime_preflight_config_mismatch");

      const incompleteRuntimePreflightPath = join(tempDir, "runtime-preflight-incomplete.json");
      const incompleteRuntimePreflight = await buildRuntimePreflightReport({
        env,
        runExternalProbes: true,
        probeOverrides: {
          postgres_reachable: passedProbe("postgres_reachable", { migrationRows: 9 }),
          redis_reachable: passedProbe("redis_reachable"),
          s3_object_storage_roundtrip: passedProbe("s3_object_storage_roundtrip", { bytes: 32, cleanupDeleted: true }),
          telegram_get_me: passedProbe("telegram_get_me", { botIdPresent: true, usernamePresent: true }),
          llm_chat_completion: passedProbe("llm_chat_completion", { model: "local-mock", promptVersion: "test" })
        },
        now: new Date("2026-05-18T00:00:00.000Z")
      });
      writeFileSync(
        incompleteRuntimePreflightPath,
        JSON.stringify(
          {
            ...incompleteRuntimePreflight,
            checks: incompleteRuntimePreflight.checks.filter((check) => check.name !== "s3_object_storage_roundtrip"),
            passed: true,
            failures: []
          },
          null,
          2
        )
      );
      const incompletePreflightReport = await buildRoadmapCompletionAudit({
        releaseEvidencePath,
        gaSignoffPath,
        runtimePreflightPath: incompleteRuntimePreflightPath,
        acceptanceIterations: 1,
        env,
        now: new Date("2026-05-18T01:00:00.000Z")
      });
      expect(incompletePreflightReport).toMatchObject({
        complete: false,
        liveArtifactValidation: {
          runtime: {
            blockers: expect.arrayContaining(["runtime_preflight_required_check_missing_or_failed:s3_object_storage_roundtrip"])
          }
        }
      });
      expect(incompletePreflightReport.failures).toContain("runtime:runtime_preflight_required_check_missing_or_failed:s3_object_storage_roundtrip");

      const expiredRuntimePreflightPath = join(tempDir, "runtime-preflight-expired.json");
      writeFileSync(
        expiredRuntimePreflightPath,
        JSON.stringify(
          await buildRuntimePreflightReport({
            env,
            runExternalProbes: true,
            probeOverrides: {
              postgres_reachable: passedProbe("postgres_reachable", { migrationRows: 9 }),
              redis_reachable: passedProbe("redis_reachable"),
              s3_object_storage_roundtrip: passedProbe("s3_object_storage_roundtrip", { bytes: 32, cleanupDeleted: true }),
              telegram_get_me: passedProbe("telegram_get_me", { botIdPresent: true, usernamePresent: true }),
              llm_chat_completion: passedProbe("llm_chat_completion", { model: "local-mock", promptVersion: "test" })
            },
            now: new Date("2026-05-16T00:00:00.000Z")
          }),
          null,
          2
        )
      );
      const expiredReport = await buildRoadmapCompletionAudit({
        releaseEvidencePath,
        gaSignoffPath,
        runtimePreflightPath: expiredRuntimePreflightPath,
        acceptanceIterations: 1,
        env,
        now: new Date("2026-05-18T01:00:00.000Z")
      });
      expect(expiredReport).toMatchObject({
        complete: false,
        liveArtifactValidation: {
          runtime: {
            preflight: {
              present: true,
              passed: true,
              externalProbesRun: true,
              configMatches: true,
              fresh: false,
              ageHours: 49,
              maxAgeHours: 24
            },
            blockers: expect.arrayContaining(["runtime_preflight_expired"])
          }
        }
      });
      expect(expiredReport.failures).toContain("runtime:runtime_preflight_expired");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects example live artifacts even when files are present", async () => {
    const runtimePreflightExample = parseRuntimePreflightReport(readFileSync("docs/examples/runtime-preflight.example.json", "utf8"));
    expect(runtimePreflightExample).toMatchObject({
      schemaVersion: "runtime-preflight/v1",
      runExternalProbes: false,
      passed: false,
      configSummary: {
        environment: "local",
        stateBackend: "memory",
        queueBackend: "memory",
        secretsBackend: "env",
        objectStorageBackend: "filesystem",
        llmProvider: "mock"
      }
    });
    const report = await buildRoadmapCompletionAudit({
      releaseEvidencePath: "docs/examples/release-evidence.example.json",
      gaSignoffPath: "docs/examples/ga-signoff.example.json",
      runtimePreflightPath: "docs/examples/runtime-preflight.example.json",
      acceptanceIterations: 1
    });

    expect(report).toMatchObject({
      complete: false,
      missingLiveArtifacts: [],
      liveArtifactValidation: {
        releaseEvidence: {
          present: true,
          records: 9,
          invalidEvidenceIds: expect.arrayContaining(["cred-all"]),
          blockers: expect.arrayContaining([expect.stringContaining("invalid_release_evidence:cred-all:")])
        },
        gaSignoff: {
          present: true,
          explicitSignoffProvided: true,
          blockers: expect.arrayContaining(["signoff_example_value:product_owner"])
        },
        runtime: {
          preflight: {
            present: true,
            passed: false,
            externalProbesRun: false,
            configMatches: true
          },
          blockers: expect.arrayContaining([
            "runtime_preflight_failed",
            "runtime_preflight_external_probes_required",
            "runtime_preflight_required_check_missing_or_failed:production_environment"
          ])
        },
        aggregateGates: {
          releaseGate: {
            readyForLiveAutomation: false,
            failures: expect.arrayContaining([expect.stringContaining("release_evidence:invalid_release_evidence:cred-all:")])
          },
          acceptancePackage: {
            passed: false,
            gaSignoffPassed: false,
            blockers: expect.arrayContaining([
              expect.stringContaining("release_evidence:invalid_release_evidence:cred-all:"),
              "ga_signoff:signoff_example_value:product_owner"
            ])
          }
        }
      }
    });
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("release_evidence:invalid_release_evidence:cred-all:"),
        "ga_signoff:signoff_example_value:product_owner",
        "runtime:runtime_preflight_failed",
        "runtime:runtime_preflight_external_probes_required"
      ])
    );
  });
});

function completeReleaseEvidence() {
  return {
    records: [
      {
        evidenceId: "cred-all",
        evidenceType: "live_credentials_configured",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "vault credential coverage check run 1",
        metadata: {
          checkedAt: "2026-05-18T00:00:00.000Z",
          secretReferenceIds: ["vault://job-search/hh/session", "vault://job-search/robota/session", "vault://job-search/telegram/bot"],
          coveredProviderIds: ["hh", "robota", "telegram"],
          telegramBot: true
        }
      },
      {
        evidenceId: "secrets-vault",
        evidenceType: "external_secrets_backend",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "vault access probe run 1",
        metadata: { backend: "vault", accessCheck: true, checkedAt: "2026-05-18T00:00:00.000Z" }
      },
	      ...["hh", "robota", "telegram"].map((providerId) => ({
        evidenceId: `canary-${providerId}`,
        evidenceType: "live_canary_passed",
        providerId,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "provider canary run 1",
        metadata: {
          canaryRunId: `canary-${providerId}-1`,
          checkedAt: "2026-05-18T00:00:00.000Z",
          result: "passed"
	        }
	      })),
	      {
	        evidenceId: "provider-submit-live",
	        evidenceType: "provider_submit_proof_ready",
	        providerId: "hh",
	        status: "passed",
	        observedAt: "2026-05-18T00:00:00.000Z",
	        expiresAt: "2026-05-19T00:00:00.000Z",
	        source: "production provider submit workflow run 1",
	        metadata: {
	          applicationId: "app-live-1",
	          proofId: "provider-submit-proof-1",
	          action: "send_application",
	          transport: "provider",
	          idempotencyKeyHash: "hash-idempotency",
	          draftHash: "hash-draft",
	          submitStatus: "submitted",
	          submittedAt: "2026-05-18T00:00:00.000Z"
	        }
	      },
	      {
	        evidenceId: "calendar-live",
        evidenceType: "calendar_integration_ready",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "calendar smoke run 1",
        metadata: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        }
      },
      {
        evidenceId: "soak-live",
        evidenceType: "seven_day_soak_passed",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-06-17T00:00:00.000Z",
        source: "production soak run 1",
        metadata: {
          startedAt: "2026-05-10T00:00:00.000Z",
          completedAt: "2026-05-18T00:00:00.000Z",
          duplicateApplicationCount: 0,
          proofCoveragePercent: 100,
          stateLossDetected: false,
          unsupportedFactCount: 0,
          incidentDrillPassed: true,
          rollbackDrillPassed: true
        }
      },
      {
        evidenceId: "dispatch-live",
        evidenceType: "outbound_dispatch_proof_ready",
        providerId: null,
        status: "passed",
        observedAt: "2026-05-18T00:00:00.000Z",
        expiresAt: "2026-05-19T00:00:00.000Z",
        source: "dispatch proof run 1",
        metadata: {
          proofId: "proof-live-1",
          transport: "telegram",
          idempotencyKeyHash: "hash-idempotency",
          textHash: "hash-text",
          deliveryStatus: "sent",
          deliveredAt: "2026-05-18T00:00:00.000Z"
        }
      }
    ]
  };
}

function passedProbe(name: RuntimePreflightCheckName, metadata: Record<string, unknown> = {}) {
  return {
    name,
    required: true,
    passed: true,
    reason: null,
    metadata
  };
}

function completeGaSignoff() {
  return {
    checklistVersion: "ga-signoff/v1",
    p0P1Closed: true,
    p2P3HaveOwners: true,
    runbookDrillsReviewed: true,
    residualRiskAccepted: true,
    postGaMaintenancePlanReady: true,
    evidenceRefs: {
      issueRegister: "release/2026-05-18/issues",
      runbookDrillReport: "release/2026-05-18/runbook-drills",
      residualRiskRecord: "release/2026-05-18/residual-risk",
      maintenancePlan: "release/2026-05-18/maintenance-plan"
    },
    signers: [
      { role: "product_owner", name: "Product Owner", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
      { role: "engineering", name: "Engineering Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
      { role: "operations", name: "Operations Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" },
      { role: "security", name: "Security Lead", date: "2026-05-18T00:00:00.000Z", decision: "approved" }
    ]
  };
}
