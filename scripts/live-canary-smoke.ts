import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { buildCanaryEvidenceReport, isLiveEvidenceSource, type CanaryEvidenceInputRecord } from "./canary-evidence";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface LiveCanarySmokeTarget {
  providerId: string;
  kind?: "http" | "telegram_get_me";
  url?: string;
  expectedText?: string;
  forbiddenText?: string[];
  expectedStatus?: number;
  token?: string;
}

export interface LiveCanarySmokeReport {
  schemaVersion: "live-canary-smoke/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  canaryApiCalled: boolean;
  expectedProviderIds: string[];
  targets: Array<{
    providerId: string;
    kind: "http" | "telegram_get_me";
    urlHash: string | null;
    expectedTextHash: string | null;
    forbiddenTextHashes: string[];
    expectedStatus: number | null;
  }>;
  results: CanaryEvidenceInputRecord[];
  evidenceRecords: ReleaseEvidenceRecord[];
  failures: string[];
}

export type LiveCanarySmokeFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export async function buildLiveCanarySmokeReport(input: {
  targets: LiveCanarySmokeTarget[];
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  expectedProviderIds?: string[];
  telegramBotToken?: string;
  ttlHours?: number;
  now?: Date;
  fetchImpl?: LiveCanarySmokeFetch;
  telegramApiBaseUrl?: string;
}): Promise<LiveCanarySmokeReport> {
  const now = input.now ?? new Date();
  const source = input.source.trim();
  const expectedProviderIds = uniqueSorted(input.expectedProviderIds ?? input.targets.map((target) => target.providerId).filter(Boolean));
  const targetSummaries = input.targets.map(safeTargetSummary);
  const setupFailures = validateSetup({
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    targets: input.targets,
    expectedProviderIds
  });
  if (setupFailures.length > 0) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      expectedProviderIds,
      targets: targetSummaries,
      failures: setupFailures
    });
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      expectedProviderIds,
      targets: targetSummaries,
      failures: ["fetch_unavailable"]
    });
  }

  const results: CanaryEvidenceInputRecord[] = [];
  for (const target of input.targets) {
    const kind = target.kind ?? "http";
    results.push(
      kind === "telegram_get_me"
        ? await runTelegramGetMeCanary({
            target,
            now,
            fetchImpl,
            token: target.token ?? input.telegramBotToken ?? "",
            ...(input.telegramApiBaseUrl ? { apiBaseUrl: input.telegramApiBaseUrl } : {})
          })
        : await runHttpCanary({ target, now, fetchImpl })
    );
  }

  const evidence = buildCanaryEvidenceReport({
    records: results,
    expectedProviderIds,
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    ...(input.ttlHours ? { ttlHours: input.ttlHours } : {}),
    now
  });
  return {
    schemaVersion: "live-canary-smoke/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed && isLiveEvidenceSource(source),
    confirmLive: input.confirmLive,
    canaryApiCalled: true,
    expectedProviderIds,
    targets: targetSummaries,
    results,
    evidenceRecords: evidence.evidenceRecords,
    failures: evidence.failures
  };
}

function validateSetup(input: {
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  targets: LiveCanarySmokeTarget[];
  expectedProviderIds: string[];
}): string[] {
  const failures: string[] = [];
  if (!input.confirmLive) {
    failures.push("live_canary_smoke_confirm_live_required");
  }
  if (!input.liveEvidenceAllowed) {
    failures.push("live_canary_evidence_assert_live_required");
  }
  if (!isLiveEvidenceSource(input.source)) {
    failures.push("live_canary_source_required");
  }
  if (input.targets.length === 0) {
    failures.push("live_canary_targets_required");
  }
  if (input.expectedProviderIds.length === 0) {
    failures.push("expected_provider_ids_required");
  }
  for (const target of input.targets) {
    if (!nonEmptyString(target.providerId)) {
      failures.push("target_provider_id_required");
    }
    const kind = target.kind ?? "http";
    if (kind === "http" && !nonEmptyString(target.url)) {
      failures.push(`target_url_required:${target.providerId || "unknown"}`);
    }
  }
  return failures;
}

async function runHttpCanary(input: {
  target: LiveCanarySmokeTarget;
  now: Date;
  fetchImpl: LiveCanarySmokeFetch;
}): Promise<CanaryEvidenceInputRecord> {
  const providerId = input.target.providerId;
  const checkedAt = input.now.toISOString();
  const checks = ["http_get", "http_status"];
  const failures: string[] = [];
  const start = Date.now();
  let statusCode = 0;
  try {
    const response = await input.fetchImpl(input.target.url!, {
      method: "GET",
      headers: {
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "telegram-job-search-automation-live-canary/1.0"
      }
    });
    statusCode = response.status;
    if (input.target.expectedStatus ? response.status !== input.target.expectedStatus : !response.ok) {
      failures.push(`http_status_unexpected:${response.status}`);
    }
    const text = await response.text();
    if (input.target.expectedText) {
      checks.push("expected_text");
      if (!text.includes(input.target.expectedText)) {
        failures.push("expected_text_missing");
      }
    }
    for (const forbiddenText of input.target.forbiddenText ?? []) {
      checks.push("forbidden_text");
      if (forbiddenText.length > 0 && text.includes(forbiddenText)) {
        failures.push("forbidden_text_present");
      }
    }
  } catch (error) {
    failures.push(`http_canary_exception:${safeFailureMessage(error)}`);
  }

  return {
    providerId,
    status: failures.length === 0 ? "passed" : "failed",
    canaryRunId: `live-canary-${providerId}-${stableHash(`${providerId}:${checkedAt}:${statusCode}`)}`,
    checkedAt,
    checks,
    failures,
    metrics: {
      latencyMs: Date.now() - start,
      statusCode
    }
  };
}

async function runTelegramGetMeCanary(input: {
  target: LiveCanarySmokeTarget;
  now: Date;
  fetchImpl: LiveCanarySmokeFetch;
  token: string;
  apiBaseUrl?: string;
}): Promise<CanaryEvidenceInputRecord> {
  const providerId = input.target.providerId;
  const checkedAt = input.now.toISOString();
  const checks = ["telegram_get_me"];
  const failures: string[] = [];
  const start = Date.now();
  let statusCode = 0;
  if (input.token.trim().length === 0) {
    failures.push("telegram_bot_token_required");
  } else {
    try {
      const response = await input.fetchImpl(`${input.apiBaseUrl ?? "https://api.telegram.org"}/bot${input.token}/getMe`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      statusCode = response.status;
      if (!response.ok) {
        failures.push(`telegram_get_me_failed:${response.status}`);
      } else {
        const body = await response.json();
        failures.push(...validateTelegramGetMeBody(body));
      }
    } catch (error) {
      failures.push(`telegram_canary_exception:${safeFailureMessage(error)}`);
    }
  }
  return {
    providerId,
    status: failures.length === 0 ? "passed" : "failed",
    canaryRunId: `live-canary-${providerId}-${stableHash(`${providerId}:${checkedAt}:${statusCode}`)}`,
    checkedAt,
    checks,
    failures,
    metrics: {
      latencyMs: Date.now() - start,
      statusCode
    }
  };
}

function validateTelegramGetMeBody(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return ["telegram_get_me_response_not_object"];
  }
  const object = body as Record<string, unknown>;
  if (object.ok !== true) {
    return ["telegram_get_me_response_not_ok"];
  }
  const result = object.result;
  if (!result || typeof result !== "object") {
    return ["telegram_get_me_result_missing"];
  }
  const id = (result as Record<string, unknown>).id;
  return typeof id === "number" && Number.isFinite(id) ? [] : ["telegram_get_me_bot_id_missing"];
}

function safeTargetSummary(target: LiveCanarySmokeTarget): LiveCanarySmokeReport["targets"][number] {
  return {
    providerId: target.providerId,
    kind: target.kind ?? "http",
    urlHash: target.url ? stableHash(target.url) : null,
    expectedTextHash: target.expectedText ? stableHash(target.expectedText) : null,
    forbiddenTextHashes: (target.forbiddenText ?? []).map((text) => stableHash(text)),
    expectedStatus: target.expectedStatus ?? null
  };
}

function emptyReport(input: {
  now: Date;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  expectedProviderIds: string[];
  targets: LiveCanarySmokeReport["targets"];
  failures: string[];
}): LiveCanarySmokeReport {
  return {
    schemaVersion: "live-canary-smoke/v1",
    generatedAt: input.now.toISOString(),
    source: input.source,
    liveEvidenceAllowed: input.liveEvidenceAllowed && isLiveEvidenceSource(input.source),
    confirmLive: input.confirmLive,
    canaryApiCalled: false,
    expectedProviderIds: input.expectedProviderIds,
    targets: input.targets,
    results: [],
    evidenceRecords: [],
    failures: input.failures
  };
}

export function parseLiveCanarySmokeTargets(contents: string): LiveCanarySmokeTarget[] {
  const parsed = JSON.parse(contents) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("CANARY_SMOKE_TARGETS_JSON must be an array");
  }
  return parsed.map((target, index) => {
    if (!target || typeof target !== "object") {
      throw new Error(`Invalid live canary target at index ${index}`);
    }
    const object = target as Record<string, unknown>;
    const providerId = nonEmptyString(object.providerId);
    if (!providerId) {
      throw new Error(`Live canary target ${index} is missing providerId`);
    }
    const kind = object.kind === "telegram_get_me" ? "telegram_get_me" : "http";
    const url = nonEmptyString(object.url);
    const expectedText = nonEmptyString(object.expectedText);
    const expectedStatus = typeof object.expectedStatus === "number" && Number.isFinite(object.expectedStatus) ? object.expectedStatus : undefined;
    const token = nonEmptyString(object.token);
    return {
      providerId,
      kind,
      ...(url ? { url } : {}),
      ...(expectedText ? { expectedText } : {}),
      ...(Array.isArray(object.forbiddenText) && object.forbiddenText.every((item) => typeof item === "string") ? { forbiddenText: object.forbiddenText } : {}),
      ...(expectedStatus ? { expectedStatus } : {}),
      ...(token ? { token } : {})
    };
  });
}

function parseProviderIds(value: string | undefined, targets: LiveCanarySmokeTarget[]): string[] {
  const parsed = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return uniqueSorted(parsed.length > 0 ? parsed : targets.map((target) => target.providerId));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^a-z0-9._:-]+/gi, "_").slice(0, 120);
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetsJson = process.env.CANARY_SMOKE_TARGETS_JSON;
  if (!targetsJson) {
    throw new Error("CANARY_SMOKE_TARGETS_JSON is required");
  }
  const targets = parseLiveCanarySmokeTargets(targetsJson);
  const report = await buildLiveCanarySmokeReport({
    targets,
    source: process.env.CANARY_SMOKE_SOURCE ?? process.env.CANARY_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.CANARY_EVIDENCE_ASSERT_LIVE === "true",
    confirmLive: process.env.CANARY_SMOKE_CONFIRM_LIVE === "true",
    expectedProviderIds: parseProviderIds(process.env.CANARY_SMOKE_EXPECTED_PROVIDER_IDS, targets),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
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
  const outputPath = process.env.CANARY_SMOKE_OUTPUT_PATH ?? process.env.CANARY_EVIDENCE_OUTPUT_PATH;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}
