import { ReleaseEvidenceEvaluator, type ProviderContext, type ProviderHealth, type ProviderModule, type ReleaseEvidenceRecord } from "@job-search/domain";
import { fixtureJobsByProvider } from "./fixtures";
import { pageFingerprints, selectorPacks } from "./selector-packs";

export interface ProviderReadinessInput {
  providerId: string;
  environment?: ProviderContext["environment"];
  runtimeKind?: "fixture" | "live" | "unknown";
  health: ProviderHealth;
  fixtureCount: number;
  selectorPackVersion: string | null;
  fingerprintCount: number;
  canaryStatus: "passed" | "failed" | "missing";
  dryRunSubmitBoundaryPassed: boolean;
  replayAvailable: boolean;
  liveSubmitImplementation?: boolean;
  manualFallbackAvailable: boolean;
  rateLimitsConfigured: boolean;
  proofPackSupported: boolean;
  disableSwitchAvailable: boolean;
  captchaBypassAbsent: boolean;
}

export interface ProviderReadinessReport {
  providerId: string;
  runtimeKind: "fixture" | "live" | "unknown";
  readyForReadOnly: boolean;
  readyForDryRun: boolean;
  readyForReviewFirstSubmit: boolean;
  readyForControlledAutoApply: boolean;
  recommendedStatus: "stable" | "read_only" | "apply_disabled" | "needs_review";
  blockers: string[];
  warnings: string[];
}

export interface ProviderReadinessCollectionInput {
  registry: { list(): ProviderModule[] };
  environment: ProviderContext["environment"];
  now?: Date;
  canaryMaxAgeHours?: number | undefined;
  canaryRuns?: Iterable<{ providerId: string; status: string; createdAt?: string | undefined }> | undefined;
  replayReports?: Iterable<{ flowRunId: string; status: string }> | undefined;
  providerConfigs?: Iterable<{ providerId: string; enabled?: boolean | undefined; statusOverride?: string | undefined }> | undefined;
}

export function buildProviderReadinessEvidenceFromReleaseEvidence(input: {
  records: ReleaseEvidenceRecord[];
  expectedProviderIds: string[];
  providerConfigs: NonNullable<ProviderReadinessCollectionInput["providerConfigs"]>;
  now?: Date;
}): Pick<ProviderReadinessCollectionInput, "canaryRuns" | "replayReports" | "providerConfigs"> {
  const evaluator = new ReleaseEvidenceEvaluator();
  const nowMs = (input.now ?? new Date()).getTime();
  const expectedProviderIds = new Set(input.expectedProviderIds);
  const canaryEvidence = input.records
    .filter((record) => record.evidenceType === "live_canary_passed" && typeof record.providerId === "string" && expectedProviderIds.has(record.providerId))
    .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > nowMs)
    .map((record) => {
      const failures = evaluator.validateRecord({
        record,
        expectedProviderIds: input.expectedProviderIds,
        ...(input.now ? { now: input.now } : {})
      });
      const checkedAt = typeof record.metadata.checkedAt === "string" ? record.metadata.checkedAt : record.observedAt;
      return {
        canaryRunId: typeof record.metadata.canaryRunId === "string" ? record.metadata.canaryRunId : record.evidenceId,
        providerId: record.providerId!,
        status: record.status === "passed" && failures.length === 0 ? "passed" : "failed",
        createdAt: checkedAt
      };
    });
  return {
    canaryRuns: canaryEvidence.map(({ providerId, status, createdAt }) => ({ providerId, status, createdAt })),
    replayReports: canaryEvidence
      .filter((record) => record.status === "passed")
      .map((record) => ({
        flowRunId: `${record.providerId}:${record.canaryRunId}:release-evidence`,
        status: "replayed"
      })),
    providerConfigs: input.providerConfigs
  };
}

export async function collectProviderReadinessReports(input: ProviderReadinessCollectionInput): Promise<ProviderReadinessReport[]> {
  const now = input.now ?? new Date();
  const providers = input.registry.list();
  const health = await Promise.all(providers.map((provider) => provider.healthcheck({ now, environment: input.environment })));
  return health.map((item, index) =>
    buildProviderReadinessReport(item, providers[index]!, {
      environment: input.environment,
      now,
      canaryMaxAgeHours: input.canaryMaxAgeHours,
      canaryRuns: input.canaryRuns,
      replayReports: input.replayReports,
      providerConfigs: input.providerConfigs
    })
  );
}

export function buildProviderReadinessReport(
  health: ProviderHealth,
  provider: Pick<ProviderModule, "capabilities" | "runtimeKind">,
  evidence: {
    environment?: ProviderContext["environment"] | undefined;
    now?: Date | undefined;
    canaryMaxAgeHours?: number | undefined;
    canaryRuns?: Iterable<{ providerId: string; status: string; createdAt?: string | undefined }> | undefined;
    replayReports?: Iterable<{ flowRunId: string; status: string }> | undefined;
    providerConfigs?: Iterable<{ providerId: string; enabled?: boolean | undefined; statusOverride?: string | undefined }> | undefined;
  } = {}
): ProviderReadinessReport {
  const selectorPack = selectorPacks[health.providerId];
  const fingerprints = pageFingerprints[health.providerId] ?? [];
  const supportsSubmitBoundary = provider.capabilities.autoApply;
  const runtimeKind = provider.runtimeKind ?? "unknown";
  const environment = evidence.environment ?? "local";
  const now = evidence.now ?? new Date();
  const canaryMaxAgeHours = evidence.canaryMaxAgeHours ?? 24;
  const providerConfig = evidence.providerConfigs ? [...evidence.providerConfigs].find((config) => config.providerId === health.providerId) : null;
  const canaryStatus =
    canaryStatusForProvider(health.providerId, evidence.canaryRuns, now, canaryMaxAgeHours) ??
    (environment === "production" ? "missing" : health.providerId === "telegram" ? "passed" : selectorPack && fingerprints.length > 0 ? "passed" : "missing");
  const replayAvailable = replayAvailableForProvider(health.providerId, evidence.replayReports) ?? environment !== "production";
  return evaluateProviderReadiness({
    providerId: health.providerId,
    environment,
    runtimeKind,
    health,
    fixtureCount: fixtureJobsByProvider[health.providerId]?.length ?? 0,
    selectorPackVersion: selectorPack?.version ?? null,
    fingerprintCount: fingerprints.length,
    canaryStatus,
    dryRunSubmitBoundaryPassed: supportsSubmitBoundary,
    replayAvailable,
    liveSubmitImplementation: !supportsSubmitBoundary || runtimeKind === "live",
    manualFallbackAvailable: true,
    rateLimitsConfigured: true,
    proofPackSupported: supportsSubmitBoundary,
    disableSwitchAvailable: evidence.providerConfigs ? Boolean(providerConfig) : environment !== "production",
    captchaBypassAbsent: true
  });
}

function canaryStatusForProvider(
  providerId: string,
  canaryRuns?: Iterable<{ providerId: string; status: string; createdAt?: string | undefined }>,
  now = new Date(),
  maxAgeHours = 24
): ProviderReadinessInput["canaryStatus"] | null {
  if (!canaryRuns) {
    return null;
  }
  const latest = [...canaryRuns]
    .filter((run) => run.providerId === providerId)
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
    .at(-1);
  if (!latest) {
    return "missing";
  }
  const createdAt = latest.createdAt ? Date.parse(latest.createdAt) : NaN;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  if (!Number.isFinite(createdAt) || createdAt > now.getTime() || now.getTime() - createdAt > maxAgeMs) {
    return "missing";
  }
  return latest.status === "passed" ? "passed" : "failed";
}

function replayAvailableForProvider(providerId: string, replayReports?: Iterable<{ flowRunId: string; status: string }>): boolean | null {
  if (!replayReports) {
    return null;
  }
  return [...replayReports].some((report) => report.status === "replayed" && report.flowRunId.includes(providerId));
}

export function evaluateProviderReadiness(input: ProviderReadinessInput): ProviderReadinessReport {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const environment = input.environment ?? "local";
  const runtimeKind = input.runtimeKind ?? "unknown";
  const liveSubmitImplementation = input.liveSubmitImplementation ?? true;
  const require = (condition: boolean, code: string): void => {
    if (!condition) {
      blockers.push(code);
    }
  };

  require(input.health.status !== "blocked" && input.health.status !== "deprecated", "provider_health_blocks_use");
  require(input.fixtureCount > 0, "fixtures_missing");
  require(input.rateLimitsConfigured, "rate_limits_missing");
  require(input.manualFallbackAvailable, "manual_fallback_missing");
  require(input.disableSwitchAvailable, "disable_switch_missing");
  require(input.captchaBypassAbsent, "captcha_bypass_must_be_absent");

  const readyForReadOnly = blockers.length === 0;

  require(Boolean(input.selectorPackVersion), "selector_pack_missing");
  require(input.fingerprintCount > 0, "fingerprints_missing");
  require(input.canaryStatus === "passed", `canary_${input.canaryStatus}`);
  require(input.dryRunSubmitBoundaryPassed, "dry_run_submit_boundary_missing");
  require(input.replayAvailable, "replay_missing");
  const readyForDryRun = readyForReadOnly && blockers.length === 0;

  require(input.proofPackSupported, "proof_pack_missing");
  require(environment !== "production" || !input.proofPackSupported || liveSubmitImplementation, "live_submit_implementation_missing");
  const readyForReviewFirstSubmit = readyForDryRun && blockers.length === 0;

  if (input.health.status !== "stable") {
    warnings.push(`provider_health_is_${input.health.status}`);
  }
  const readyForControlledAutoApply = readyForReviewFirstSubmit && input.health.status === "stable" && warnings.length === 0;

  return {
    providerId: input.providerId,
    runtimeKind,
    readyForReadOnly,
    readyForDryRun,
    readyForReviewFirstSubmit,
    readyForControlledAutoApply,
    recommendedStatus: recommendedStatus({ readyForReadOnly, readyForDryRun, readyForReviewFirstSubmit, readyForControlledAutoApply, blockers }),
    blockers,
    warnings
  };
}

function recommendedStatus(input: {
  readyForReadOnly: boolean;
  readyForDryRun: boolean;
  readyForReviewFirstSubmit: boolean;
  readyForControlledAutoApply: boolean;
  blockers: string[];
}): ProviderReadinessReport["recommendedStatus"] {
  if (input.readyForControlledAutoApply) {
    return "stable";
  }
  if (input.readyForReadOnly && input.readyForDryRun && input.readyForReviewFirstSubmit) {
    return "apply_disabled";
  }
  if (input.readyForReadOnly) {
    return "read_only";
  }
  return "needs_review";
}
