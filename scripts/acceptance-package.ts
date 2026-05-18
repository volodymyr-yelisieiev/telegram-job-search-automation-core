import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type RuntimeConfig } from "@job-search/config";
import { InMemoryDatabase } from "@job-search/db";
import {
  ReleaseEvidenceEvaluator,
  ReleaseGateEvaluator,
  releaseEvidenceTypes,
  type ReleaseEvidenceRecord,
  type ReleaseEvidenceSummary,
  type ReleaseEvidenceType,
  type ReleaseGateReport
} from "@job-search/domain";
import {
  buildProviderReadinessEvidenceFromReleaseEvidence,
  collectProviderReadinessReports,
  createRuntimeProviderRegistryWithOverrides,
  type ProviderReadinessCollectionInput,
  type ProviderReadinessReport,
  type ProviderRegistry
} from "@job-search/providers";
import { runAcceleratedSoak, type AcceleratedSoakReport } from "./accelerated-soak";

export interface AcceptanceValidationReport {
  passed: boolean;
  fixtureSoakPassed: boolean;
  releaseGatePassed: boolean;
  gaSignoffPassed: boolean;
  blockers: string[];
  residualRisks: string[];
}

export interface GaSignoffSigner {
  role: "product_owner" | "engineering" | "operations" | "security";
  name: string;
  date: string;
  decision: "approved" | "rejected";
  notes?: string;
}

export interface GaSignoffEvidenceRefs {
  issueRegister?: string;
  runbookDrillReport?: string;
  residualRiskRecord?: string;
  maintenancePlan?: string;
}

export interface GaSignoffInput {
  checklistVersion: "ga-signoff/v1";
  p0P1Closed: boolean;
  p2P3HaveOwners: boolean;
  runbookDrillsReviewed: boolean;
  residualRiskAccepted: boolean;
  postGaMaintenancePlanReady: boolean;
  evidenceRefs?: GaSignoffEvidenceRefs;
  signers: GaSignoffSigner[];
}

export interface AcceptancePackage {
  schemaVersion: "acceptance-package/v1";
  generatedAt: string;
  environment: RuntimeConfig["app"]["environment"];
  mode: RuntimeConfig["app"]["mode"];
  irreversibleActionsEnabled: boolean;
  secretsBackend: RuntimeConfig["security"]["secretsBackend"];
  expectedProviderIds: string[];
  soak: AcceleratedSoakReport;
  providerReadiness: ProviderReadinessReport[];
  releaseEvidence: {
    records: ReleaseEvidenceRecord[];
    summary: ReleaseEvidenceSummary;
  };
  releaseGate: ReleaseGateReport;
  acceptance: AcceptanceValidationReport;
  gaSignoff: {
    checklistVersion: "ga-signoff/v1";
    p0P1Closed: boolean;
    p2P3HaveOwners: boolean;
    runbookDrillsReviewed: boolean;
    residualRiskAccepted: boolean;
    postGaMaintenancePlanReady: boolean;
    explicitSignoffProvided: boolean;
    evidenceRefs: Required<Record<keyof GaSignoffEvidenceRefs, string | null>>;
    signers: GaSignoffSigner[];
    blockers: string[];
  };
}

export interface BuildAcceptancePackageInput {
  iterations?: number;
  config?: RuntimeConfig;
  db?: InMemoryDatabase;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
  releaseEvidence?: ReleaseEvidenceRecord[];
  gaSignoff?: GaSignoffInput;
  soakReport?: AcceleratedSoakReport;
  now?: Date;
}

export async function buildAcceptancePackage(input: BuildAcceptancePackageInput = {}): Promise<AcceptancePackage> {
  const now = input.now ?? new Date();
  const config = input.config ?? loadAcceptanceConfig();
  const db = input.db ?? new InMemoryDatabase();
  db.systemMode = config.app.mode;
  const registry = input.registry ?? createRuntimeProviderRegistryWithOverrides(config.providers, input.env ?? process.env);
  const soak =
    input.soakReport ??
    (await runAcceleratedSoak({
      iterations: input.iterations ?? 7,
      config,
      db,
      registry
    }));
  const providers = registry.list();
  const expectedProviderIds = providers.map((provider) => provider.providerId);
  const autoApplyProviderIds = providers.filter((provider) => provider.capabilities.autoApply).map((provider) => provider.providerId);
  const releaseEvidenceRecords = input.releaseEvidence ?? [...db.releaseEvidence.values()];
  const providerReadinessEvidence = buildProviderReadinessEvidence({
    records: releaseEvidenceRecords,
    expectedProviderIds,
    providerConfigs: config.providers,
    now
  });
  const providerReadiness = await collectProviderReadinessReports({
    registry,
    environment: config.app.environment,
    now,
    ...providerReadinessEvidence
  });
  const autoApplyProviderReadiness = providerReadiness.filter((provider) => autoApplyProviderIds.includes(provider.providerId));
  const releaseEvidenceSummary = new ReleaseEvidenceEvaluator().summarize({
    records: releaseEvidenceRecords,
    expectedProviderIds,
    now
  });
  const releaseGate = new ReleaseGateEvaluator().evaluate({
    mode: db.systemMode,
    irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
    providerReadiness: autoApplyProviderReadiness,
    liveCredentialsConfigured: releaseEvidenceSummary.liveCredentialsConfigured,
    externalSecretsBackend: config.security.secretsBackend !== "env" && releaseEvidenceSummary.externalSecretsBackend,
    liveCanariesPassing: releaseEvidenceSummary.liveCanariesPassing,
    providerSubmitProofReady: releaseEvidenceSummary.providerSubmitProofReady,
    calendarIntegrationReady: releaseEvidenceSummary.calendarIntegrationReady,
    sevenDaySoakPassed: releaseEvidenceSummary.sevenDaySoakPassed,
    outboundDispatchProofReady: releaseEvidenceSummary.outboundDispatchProofReady
  });
  const gaSignoff = buildGaSignoffChecklist({ signoff: input.gaSignoff, now });

  return {
    schemaVersion: "acceptance-package/v1",
    generatedAt: now.toISOString(),
    environment: config.app.environment,
    mode: db.systemMode,
    irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
    secretsBackend: config.security.secretsBackend,
    expectedProviderIds,
    soak,
    providerReadiness,
    releaseEvidence: {
      records: releaseEvidenceRecords,
      summary: releaseEvidenceSummary
    },
    releaseGate,
    acceptance: validateAcceptancePackage({
      config,
      soak,
      providerReadiness,
      autoApplyProviderIds,
      releaseEvidenceSummary,
      releaseGate,
      gaSignoff
    }),
    gaSignoff
  };
}

export function buildGaSignoffChecklist(input: { signoff?: GaSignoffInput | undefined; now?: Date | undefined }): AcceptancePackage["gaSignoff"] {
  const signoff = input.signoff;
  const now = input.now ?? new Date();
  const checklist = {
    checklistVersion: "ga-signoff/v1" as const,
    p0P1Closed: signoff?.p0P1Closed ?? false,
    p2P3HaveOwners: signoff?.p2P3HaveOwners ?? false,
    runbookDrillsReviewed: signoff?.runbookDrillsReviewed ?? false,
    residualRiskAccepted: signoff?.residualRiskAccepted ?? false,
    postGaMaintenancePlanReady: signoff?.postGaMaintenancePlanReady ?? false,
    explicitSignoffProvided: Boolean(signoff),
    evidenceRefs: normalizeGaSignoffEvidenceRefs(signoff?.evidenceRefs),
    signers: signoff?.signers ?? [],
    blockers: [] as string[]
  };
  if (!checklist.explicitSignoffProvided) {
    checklist.blockers.push("explicit_ga_signoff_missing");
  }
  if (!checklist.p0P1Closed) {
    checklist.blockers.push("p0_p1_issues_not_closed");
  }
  if (!checklist.p2P3HaveOwners) {
    checklist.blockers.push("p2_p3_issues_missing_owner_or_timeline");
  }
  if (!checklist.runbookDrillsReviewed) {
    checklist.blockers.push("runbook_drills_not_reviewed");
  }
  if (!checklist.residualRiskAccepted) {
    checklist.blockers.push("residual_risk_not_accepted");
  }
  if (!checklist.postGaMaintenancePlanReady) {
    checklist.blockers.push("post_ga_maintenance_plan_missing");
  }
  if (checklist.explicitSignoffProvided) {
    for (const [key, value] of Object.entries(checklist.evidenceRefs)) {
      if (!value) {
        checklist.blockers.push(`signoff_evidence_ref_missing:${key}`);
      } else if (isUnverifiedSignoffReference(value)) {
        checklist.blockers.push(`signoff_evidence_ref_unverified_or_example:${key}`);
      }
    }
  }
  for (const role of ["product_owner", "engineering", "operations", "security"] as const) {
    const signer = checklist.signers.find((candidate) => candidate.role === role);
    if (!signer) {
      checklist.blockers.push(`signoff_missing_role:${role}`);
      continue;
    }
    if (signer.decision !== "approved") {
      checklist.blockers.push(`signoff_not_approved:${role}`);
    }
    const signerDateMs = Date.parse(signer.date);
    if (Number.isNaN(signerDateMs)) {
      checklist.blockers.push(`signoff_invalid_date:${role}`);
    } else if (signerDateMs > now.getTime()) {
      checklist.blockers.push(`signoff_date_in_future:${role}`);
    }
    if (isExampleSignoffValue(signer)) {
      checklist.blockers.push(`signoff_example_value:${role}`);
    }
  }
  return checklist;
}

export function validateAcceptancePackage(input: {
  config: RuntimeConfig;
  soak: AcceleratedSoakReport;
  providerReadiness: ProviderReadinessReport[];
  autoApplyProviderIds?: string[];
  releaseEvidenceSummary: ReleaseEvidenceSummary;
  releaseGate: ReleaseGateReport;
  gaSignoff: AcceptancePackage["gaSignoff"];
}): AcceptanceValidationReport {
  const blockers = new Set<string>();
  for (const failure of input.soak.acceptance.failures) {
    blockers.add(`fixture_soak:${failure}`);
  }
  for (const blocker of input.releaseEvidenceSummary.blockers) {
    blockers.add(`release_evidence:${blocker}`);
  }
  for (const blocker of input.releaseGate.blockers) {
    blockers.add(`release_gate:${blocker}`);
  }
  for (const blocker of input.gaSignoff.blockers) {
    blockers.add(`ga_signoff:${blocker}`);
  }
  const autoApplyProviderIds = new Set(input.autoApplyProviderIds ?? input.providerReadiness.map((provider) => provider.providerId));
  for (const provider of input.providerReadiness.filter((report) => autoApplyProviderIds.has(report.providerId) && !report.readyForControlledAutoApply)) {
    blockers.add(`provider_readiness:${provider.providerId}:${provider.blockers.join(",") || "not_ready_for_controlled_auto_apply"}`);
  }

  const residualRisks = [
    input.config.app.environment !== "production" ? "local_safe_package_requires_production_signoff" : null,
    input.config.security.secretsBackend === "env" ? "env_secret_backend_is_not_a_live_irreversible_actions_store" : null,
    !input.config.app.irreversibleActionsEnabled ? "irreversible_actions_disabled" : null,
    !input.releaseEvidenceSummary.sevenDaySoakPassed ? "dated_7_day_soak_not_recorded" : null
  ].filter((risk): risk is string => risk !== null);
  for (const risk of residualRisks) {
    blockers.add(`residual_risk:${risk}`);
  }

  return {
    passed: input.soak.acceptance.passed && input.releaseGate.readyForLiveAutomation && input.gaSignoff.blockers.length === 0 && residualRisks.length === 0,
    fixtureSoakPassed: input.soak.acceptance.passed,
    releaseGatePassed: input.releaseGate.readyForLiveAutomation,
    gaSignoffPassed: input.gaSignoff.blockers.length === 0,
    blockers: [...blockers],
    residualRisks
  };
}

export function buildProviderReadinessEvidence(input: {
  records: ReleaseEvidenceRecord[];
  expectedProviderIds: string[];
  providerConfigs: RuntimeConfig["providers"];
  now?: Date;
}): Pick<ProviderReadinessCollectionInput, "canaryRuns" | "replayReports" | "providerConfigs"> {
  return buildProviderReadinessEvidenceFromReleaseEvidence(input);
}

export function loadGaSignoffFile(path: string): GaSignoffInput | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return parseGaSignoffFile(readFileSync(path, "utf8"));
}

export function parseGaSignoffFile(contents: string): GaSignoffInput {
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new Error("GA sign-off file must be an object");
  }
  const checklistVersion = parsed.checklistVersion;
  if (checklistVersion !== "ga-signoff/v1") {
    throw new Error("GA sign-off file has invalid checklistVersion");
  }
  const p0P1Closed = requireBooleanField(parsed.p0P1Closed, "p0P1Closed");
  const p2P3HaveOwners = requireBooleanField(parsed.p2P3HaveOwners, "p2P3HaveOwners");
  const runbookDrillsReviewed = requireBooleanField(parsed.runbookDrillsReviewed, "runbookDrillsReviewed");
  const residualRiskAccepted = requireBooleanField(parsed.residualRiskAccepted, "residualRiskAccepted");
  const postGaMaintenancePlanReady = requireBooleanField(parsed.postGaMaintenancePlanReady, "postGaMaintenancePlanReady");
  const evidenceRefs = parseGaSignoffEvidenceRefs(parsed.evidenceRefs);
  const signers = parsed.signers;
  if (!Array.isArray(signers)) {
    throw new Error("GA sign-off file must include signers array");
  }
  return {
    checklistVersion,
    p0P1Closed,
    p2P3HaveOwners,
    runbookDrillsReviewed,
    residualRiskAccepted,
    postGaMaintenancePlanReady,
    ...(evidenceRefs ? { evidenceRefs } : {}),
    signers: signers.map((signer, index) => assertGaSignoffSigner(signer, index))
  };
}

function assertGaSignoffSigner(signer: unknown, index: number): GaSignoffSigner {
  if (!isRecord(signer)) {
    throw new Error(`GA sign-off signer ${index} must be an object`);
  }
  const role = signer.role;
  const name = signer.name;
  const date = signer.date;
  const decision = signer.decision;
  const notes = signer.notes;
  if (!isGaSignoffRole(role)) {
    throw new Error(`GA sign-off signer ${index} has invalid role`);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`GA sign-off signer ${index} is missing name`);
  }
  if (typeof date !== "string" || Number.isNaN(Date.parse(date))) {
    throw new Error(`GA sign-off signer ${index} has invalid date`);
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`GA sign-off signer ${index} has invalid decision`);
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw new Error(`GA sign-off signer ${index} has invalid notes`);
  }
  return {
    role,
    name,
    date,
    decision,
    ...(notes === undefined ? {} : { notes })
  };
}

function isGaSignoffRole(value: unknown): value is GaSignoffSigner["role"] {
  return value === "product_owner" || value === "engineering" || value === "operations" || value === "security";
}

function isExampleSignoffValue(signer: GaSignoffSigner): boolean {
  return /^example\b/i.test(signer.name.trim()) || /example only/i.test(signer.notes ?? "");
}

function isUnverifiedSignoffReference(value: string): boolean {
  return (
    /example|template|placeholder|sample|dummy|fake|todo|tbd|unverified|unconfirmed|pending|draft/i.test(value) ||
    /^(?:n\/a|none|null|unknown|link|url)$/i.test(value.trim()) ||
    /\bexample\.(?:com|org|net)\b/i.test(value)
  );
}

function normalizeGaSignoffEvidenceRefs(evidenceRefs: GaSignoffEvidenceRefs | undefined): Required<Record<keyof GaSignoffEvidenceRefs, string | null>> {
  return {
    issueRegister: evidenceRefs?.issueRegister?.trim() || null,
    runbookDrillReport: evidenceRefs?.runbookDrillReport?.trim() || null,
    residualRiskRecord: evidenceRefs?.residualRiskRecord?.trim() || null,
    maintenancePlan: evidenceRefs?.maintenancePlan?.trim() || null
  };
}

function parseGaSignoffEvidenceRefs(value: unknown): GaSignoffEvidenceRefs | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("GA sign-off evidenceRefs must be an object");
  }
  const evidenceRefs: GaSignoffEvidenceRefs = {};
  for (const field of ["issueRegister", "runbookDrillReport", "residualRiskRecord", "maintenancePlan"] as const) {
    const item = value[field];
    if (item === undefined) {
      continue;
    }
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`GA sign-off evidenceRefs.${field} must be a non-empty string`);
    }
    evidenceRefs[field] = item;
  }
  return evidenceRefs;
}

function requireBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`GA sign-off file has invalid ${field}`);
  }
  return value;
}

export function loadReleaseEvidenceFile(path: string): ReleaseEvidenceRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  return parseReleaseEvidenceRecords(readFileSync(path, "utf8"));
}

export function parseReleaseEvidenceRecords(contents: string): ReleaseEvidenceRecord[] {
  const parsed: unknown = JSON.parse(contents);
  const records = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.records) ? parsed.records : null;
  if (!records) {
    throw new Error("Release evidence file must be an array or an object with a records array");
  }
  return records.map((record, index) => assertReleaseEvidenceRecord(record, index));
}

function assertReleaseEvidenceRecord(record: unknown, index: number): ReleaseEvidenceRecord {
  if (!isRecord(record)) {
    throw new Error(`Release evidence record ${index} must be an object`);
  }
  if (typeof record.evidenceId !== "string" || record.evidenceId.trim().length === 0) {
    throw new Error(`Release evidence record ${index} is missing evidenceId`);
  }
  if (!isReleaseEvidenceType(record.evidenceType)) {
    throw new Error(`Release evidence record ${index} has invalid evidenceType`);
  }
  if (record.providerId !== null && typeof record.providerId !== "string") {
    throw new Error(`Release evidence record ${index} has invalid providerId`);
  }
  if (record.status !== "passed" && record.status !== "failed") {
    throw new Error(`Release evidence record ${index} has invalid status`);
  }
  if (typeof record.observedAt !== "string" || Number.isNaN(Date.parse(record.observedAt))) {
    throw new Error(`Release evidence record ${index} has invalid observedAt`);
  }
  if (record.expiresAt !== null && (typeof record.expiresAt !== "string" || Number.isNaN(Date.parse(record.expiresAt)))) {
    throw new Error(`Release evidence record ${index} has invalid expiresAt`);
  }
  if (typeof record.source !== "string" || record.source.trim().length === 0) {
    throw new Error(`Release evidence record ${index} is missing source`);
  }
  if (!isRecord(record.metadata)) {
    throw new Error(`Release evidence record ${index} has invalid metadata`);
  }
  return {
    evidenceId: record.evidenceId,
    evidenceType: record.evidenceType,
    providerId: record.providerId,
    status: record.status,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    source: record.source,
    metadata: record.metadata
  };
}

function isReleaseEvidenceType(value: unknown): value is ReleaseEvidenceType {
  return typeof value === "string" && releaseEvidenceTypes.includes(value as ReleaseEvidenceType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}

function loadAcceptanceConfig(): RuntimeConfig {
  if (process.env.NODE_ENV === "production") {
    return loadConfig();
  }
  return loadConfig({
    ...process.env,
    APP_MODE: process.env.APP_MODE ?? "review_first",
    API_TOKEN: process.env.API_TOKEN ?? "acceptance-token"
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releaseEvidence = process.env.RELEASE_EVIDENCE_PATH ? loadReleaseEvidenceFile(process.env.RELEASE_EVIDENCE_PATH) : undefined;
  const gaSignoff = process.env.GA_SIGNOFF_PATH ? loadGaSignoffFile(process.env.GA_SIGNOFF_PATH) : undefined;
  const acceptancePackage = await buildAcceptancePackage({
    iterations: parsePositiveInteger(process.env.ACCEPTANCE_ITERATIONS ?? process.env.SOAK_ITERATIONS, 7),
    ...(releaseEvidence ? { releaseEvidence } : {}),
    ...(gaSignoff ? { gaSignoff } : {})
  });
  const serialized = `${JSON.stringify(acceptancePackage, null, 2)}\n`;
  if (process.env.ACCEPTANCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.ACCEPTANCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.ACCEPTANCE_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!acceptancePackage.acceptance.fixtureSoakPassed || !acceptancePackage.acceptance.passed) {
    process.exitCode = 1;
  }
}
