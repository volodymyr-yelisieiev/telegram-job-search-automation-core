import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ReleaseEvidenceEvaluator, type ReleaseEvidenceRecord } from "@job-search/domain";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { buildCalendarEvidenceReport, parseCalendarEvidenceInput } from "./calendar-evidence";
import { buildCanaryEvidenceReport, parseCanaryEvidenceResults } from "./canary-evidence";
import { buildExternalSecretsEvidenceReport, parseExternalSecretsEvidenceInput } from "./external-secrets-evidence";
import { buildOutboundDispatchEvidenceReport, parseOutboundDispatchEvidenceInput } from "./outbound-evidence";
import { buildProviderSubmitEvidenceReport, parseProviderSubmitEvidenceInput } from "./provider-submit-evidence";
import { buildSoakEvidenceReport, parseSoakEvidenceInput } from "./soak-evidence";

export type LiveProofInputId = "external_secrets" | "live_canaries" | "provider_submit" | "calendar" | "outbound_dispatch" | "seven_day_soak";

export interface LiveProofInputsValidationItem {
  id: LiveProofInputId;
  title: string;
  path: string;
  source: string;
  present: boolean;
  releaseEvidenceRecordIds: string[];
  releaseEvidenceTypes: string[];
  failures: string[];
}

export interface LiveProofInputsValidationReport {
  schemaVersion: "live-proof-inputs-validation/v1";
  generatedAt: string;
  liveEvidenceAllowed: boolean;
  expectedProviderIds: string[];
  passed: boolean;
  items: LiveProofInputsValidationItem[];
  releaseEvidenceRecordCount: number;
  releaseEvidenceTypes: string[];
  failures: string[];
}

interface ValidationResult {
  item: LiveProofInputsValidationItem;
  records: ReleaseEvidenceRecord[];
}

export function buildLiveProofInputsValidationReport(input: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  liveEvidenceAllowed?: boolean;
  expectedProviderIds?: string[];
  secretsPath?: string;
  canaryPath?: string;
  providerSubmitPath?: string;
  calendarPath?: string;
  outboundPath?: string;
  soakPath?: string;
  secretsSource?: string;
  canarySource?: string;
  providerSubmitSource?: string;
  calendarSource?: string;
  outboundSource?: string;
  soakSource?: string;
} = {}): LiveProofInputsValidationReport {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const liveEvidenceAllowed = input.liveEvidenceAllowed ?? env.LIVE_PROOF_INPUTS_ASSERT_LIVE === "true";
  const expectedProviderIds = uniqueSorted(
    input.expectedProviderIds ?? parseProviderIds(env.LIVE_PROOF_INPUTS_EXPECTED_PROVIDER_IDS) ?? defaultExpectedProviderIds()
  );
  const results = [
    validateExternalSecrets({
      path: input.secretsPath ?? env.EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH ?? "live-secrets-probe.json",
      source: input.secretsSource ?? env.EXTERNAL_SECRETS_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    }),
    validateCanaries({
      path: input.canaryPath ?? env.CANARY_EVIDENCE_RESULTS_PATH ?? "live-canary-results.json",
      source: input.canarySource ?? env.CANARY_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    }),
    validateProviderSubmit({
      path: input.providerSubmitPath ?? env.PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH ?? "live-provider-submit-proof.json",
      source: input.providerSubmitSource ?? env.PROVIDER_SUBMIT_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    }),
    validateCalendar({
      path: input.calendarPath ?? env.CALENDAR_EVIDENCE_INPUT_PATH ?? "live-calendar-smoke.json",
      source: input.calendarSource ?? env.CALENDAR_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    }),
    validateOutbound({
      path: input.outboundPath ?? env.OUTBOUND_EVIDENCE_INPUT_PATH ?? "live-dispatch-proof.json",
      source: input.outboundSource ?? env.OUTBOUND_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    }),
    validateSoak({
      path: input.soakPath ?? env.SOAK_EVIDENCE_INPUT_PATH ?? "live-7-day-soak.json",
      source: input.soakSource ?? env.SOAK_EVIDENCE_SOURCE ?? "",
      liveEvidenceAllowed,
      expectedProviderIds,
      now
    })
  ];
  const records = results.flatMap((result) => result.records);
  const failures = [
    ...(liveEvidenceAllowed ? [] : ["live_proof_inputs_assert_live_required"]),
    ...results.flatMap((result) => result.item.failures.map((failure) => `${result.item.id}:${failure}`))
  ];

  return {
    schemaVersion: "live-proof-inputs-validation/v1",
    generatedAt: now.toISOString(),
    liveEvidenceAllowed,
    expectedProviderIds,
    passed: failures.length === 0,
    items: results.map((result) => result.item),
    releaseEvidenceRecordCount: records.length,
    releaseEvidenceTypes: uniqueSorted(records.map((record) => record.evidenceType)),
    failures
  };
}

function validateExternalSecrets(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "external_secrets",
    title: "External secrets and credential inventory",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildExternalSecretsEvidenceReport({
        record: parseExternalSecretsEvidenceInput(contents),
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        expectedProviderIds: input.expectedProviderIds,
        now: input.now
      });
      const records = [report.releaseEvidence, report.credentialEvidence].filter((record): record is ReleaseEvidenceRecord => record !== null);
      return {
        records,
        failures: [
          ...report.failures,
          ...(report.releaseEvidence ? [] : ["external_secrets_release_evidence_missing"]),
          ...(report.credentialEvidence ? [] : ["live_credentials_release_evidence_missing"])
        ]
      };
    }
  });
}

function validateCanaries(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "live_canaries",
    title: "Live provider canaries",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildCanaryEvidenceReport({
        records: parseCanaryEvidenceResults(contents),
        expectedProviderIds: input.expectedProviderIds,
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        now: input.now
      });
      return {
        records: report.evidenceRecords,
        failures: [...report.failures, ...(report.evidenceRecords.length > 0 ? [] : ["live_canary_release_evidence_missing"])]
      };
    }
  });
}

function validateProviderSubmit(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "provider_submit",
    title: "Provider submit proof",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildProviderSubmitEvidenceReport({
        proof: parseProviderSubmitEvidenceInput(contents),
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        expectedProviderIds: input.expectedProviderIds,
        now: input.now
      });
      return {
        records: report.evidenceRecord ? [report.evidenceRecord] : [],
        failures: [...report.failures, ...(report.evidenceRecord ? [] : ["provider_submit_release_evidence_missing"])]
      };
    }
  });
}

function validateCalendar(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "calendar",
    title: "Calendar integration smoke",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildCalendarEvidenceReport({
        record: parseCalendarEvidenceInput(contents),
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        now: input.now
      });
      return {
        records: report.evidenceRecord ? [report.evidenceRecord] : [],
        failures: [...report.failures, ...(report.evidenceRecord ? [] : ["calendar_release_evidence_missing"])]
      };
    }
  });
}

function validateOutbound(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "outbound_dispatch",
    title: "Outbound dispatch proof",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildOutboundDispatchEvidenceReport({
        proof: parseOutboundDispatchEvidenceInput(contents),
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        now: input.now
      });
      return {
        records: report.evidenceRecord ? [report.evidenceRecord] : [],
        failures: [...report.failures, ...(report.evidenceRecord ? [] : ["outbound_dispatch_release_evidence_missing"])]
      };
    }
  });
}

function validateSoak(input: CommonValidationInput): ValidationResult {
  return validateFile({
    id: "seven_day_soak",
    title: "Seven-day soak report",
    path: input.path,
    source: input.source,
    expectedProviderIds: input.expectedProviderIds,
    now: input.now,
    build: (contents) => {
      const report = buildSoakEvidenceReport({
        report: parseSoakEvidenceInput(contents),
        source: input.source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        now: input.now
      });
      return {
        records: report.evidenceRecord ? [report.evidenceRecord] : [],
        failures: [...report.failures, ...(report.evidenceRecord ? [] : ["seven_day_soak_release_evidence_missing"])]
      };
    }
  });
}

interface CommonValidationInput {
  path: string;
  source: string;
  liveEvidenceAllowed: boolean;
  expectedProviderIds: string[];
  now: Date;
}

function validateFile(input: {
  id: LiveProofInputId;
  title: string;
  path: string;
  source: string;
  expectedProviderIds: string[];
  now: Date;
  build: (contents: string) => { records: ReleaseEvidenceRecord[]; failures: string[] };
}): ValidationResult {
  if (!existsSync(input.path)) {
    return validationResult(input, [], [`missing_input_file:${input.path}`], false);
  }
  const contents = readFileSync(input.path, "utf8");
  const markerFailures = hasExampleMarker(contents) ? ["input_contains_example_marker"] : [];
  try {
    const built = input.build(contents);
    return validationResult(
      input,
      built.records,
      [...markerFailures, ...built.failures, ...releaseEvidenceRecordFailures(built.records, input.expectedProviderIds, input.now)],
      true
    );
  } catch (error) {
    return validationResult(input, [], [...markerFailures, `parse_or_validation_error:${errorMessage(error)}`], true);
  }
}

function validationResult(
  input: { id: LiveProofInputId; title: string; path: string; source: string },
  records: ReleaseEvidenceRecord[],
  failures: string[],
  present: boolean
): ValidationResult {
  return {
    item: {
      id: input.id,
      title: input.title,
      path: input.path,
      source: input.source,
      present,
      releaseEvidenceRecordIds: records.map((record) => record.evidenceId),
      releaseEvidenceTypes: uniqueSorted(records.map((record) => record.evidenceType)),
      failures
    },
    records
  };
}

function releaseEvidenceRecordFailures(records: ReleaseEvidenceRecord[], expectedProviderIds: string[], now: Date): string[] {
  const evaluator = new ReleaseEvidenceEvaluator();
  return records.flatMap((record) =>
    evaluator
      .validateRecord({ record, expectedProviderIds, now })
      .map((failure) => `release_evidence_record_invalid:${record.evidenceId}:${failure}`)
  );
}

function hasExampleMarker(contents: string): boolean {
  return /(example input shape only|replace-with|example:\/\/)/i.test(contents);
}

function defaultExpectedProviderIds(): string[] {
  return createFixtureProviderRegistry().list().map((provider) => provider.providerId);
}

function parseProviderIds(value: string | undefined): string[] | null {
  const parsed = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return parsed.length > 0 ? parsed : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildLiveProofInputsValidationReport();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.LIVE_PROOF_INPUTS_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.LIVE_PROOF_INPUTS_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.LIVE_PROOF_INPUTS_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}
