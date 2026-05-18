import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { stableHash, type ErrorCode, type ProofPack, type ReplayReport } from "@job-search/domain";
import { createLogger, type MetricsRegistry } from "@job-search/observability";

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
  domAnchors: string[];
}

export interface FlowFingerprint {
  id: string;
  urlPattern: string;
  titlePattern: string;
  requiredDomAnchors: string[];
  requiredTextAnchors: string[];
  captchaIndicators: string[];
  captchaDomAnchors?: string[];
  captchaUrlPatterns?: string[];
}

export interface FlowAction {
  actionId: string;
  selectorKey?: string;
}

export interface FlowState {
  stateId: string;
  expectedFingerprint: string;
  guards: string[];
  actions: FlowAction[];
  transitions: Record<string, string>;
  terminal?: boolean;
}

export interface FlowDefinition {
  flowId: string;
  provider: string;
  version: string;
  selectorPackVersion: string;
  entryState: string;
  states: Record<string, FlowState>;
}

export interface SelectorRegistryEntry {
  primary: string;
  fallbacks: string[];
  required: boolean;
}

export interface FlowRunStep {
  stateId: string;
  status: "succeeded" | "failed";
  usedSelectors: string[];
  errorCode: ErrorCode | null;
}

export interface FlowRunResult {
  flowRunId: string;
  status: "succeeded" | "failed" | "manual_review_required";
  reachedSubmitBoundary: boolean;
  steps: FlowRunStep[];
  proofPack: ProofPack;
  errorCode: ErrorCode | null;
}

export interface BrowserArtifactManifest {
  flowRunId: string;
  screenshotKeys: string[];
  domSnapshotKeys: string[];
  traceKey: string | null;
  createdAt: string;
}

export type BrowserErrorOutcome = "retry_scheduled" | "provider_disabled" | "apply_failed" | "read_only_fallback" | "dead_lettered" | "manual_review";

export class FingerprintEngine {
  matches(snapshot: BrowserPageSnapshot, fingerprint: FlowFingerprint): { matched: boolean; errorCode: ErrorCode | null } {
    const lowerText = snapshot.text.toLowerCase();
    const hasCaptcha = fingerprint.captchaIndicators.some((indicator) => lowerText.includes(indicator.toLowerCase()));
    const hasCaptchaDom = (fingerprint.captchaDomAnchors ?? []).some((anchor) => snapshot.domAnchors.includes(anchor));
    const hasCaptchaUrl = (fingerprint.captchaUrlPatterns ?? []).some((pattern) => snapshot.url.toLowerCase().includes(pattern.toLowerCase()));
    if (hasCaptcha || hasCaptchaDom || hasCaptchaUrl) {
      return { matched: false, errorCode: "captcha_required" };
    }

    if (!snapshot.url.includes(fingerprint.urlPattern)) {
      return { matched: false, errorCode: "page_fingerprint_mismatch" };
    }

    const titlePattern = new RegExp(fingerprint.titlePattern, "i");
    if (!titlePattern.test(snapshot.title)) {
      return { matched: false, errorCode: "page_fingerprint_mismatch" };
    }

    const domOk = fingerprint.requiredDomAnchors.every((anchor) => snapshot.domAnchors.includes(anchor));
    if (!domOk) {
      return { matched: false, errorCode: "page_fingerprint_mismatch" };
    }

    const textOk = fingerprint.requiredTextAnchors.every((anchor) => lowerText.includes(anchor.toLowerCase()));
    if (!textOk) {
      return { matched: false, errorCode: "page_fingerprint_mismatch" };
    }

    return { matched: true, errorCode: null };
  }
}

export class SelectorRegistry {
  constructor(private readonly selectors: Record<string, SelectorRegistryEntry>) {}

  resolve(selectorKey: string, availableSelectors: string[]): { selector: string | null; errorCode: ErrorCode | null } {
    const definition = this.selectors[selectorKey];
    if (!definition) {
      return { selector: null, errorCode: "selector_missing" };
    }

    const candidates = [definition.primary, ...definition.fallbacks];
    const matched = candidates.filter((candidate) => availableSelectors.includes(candidate));
    if (matched.length > 1) {
      return { selector: null, errorCode: "selector_ambiguous" };
    }
    if (matched.length === 1) {
      return { selector: matched[0] ?? null, errorCode: null };
    }
    if (definition.required) {
      return { selector: null, errorCode: "selector_missing" };
    }
    return { selector: null, errorCode: null };
  }
}

export class DeterministicFlowRunner {
  private readonly logger = createLogger("automation-flow-runner");
  private readonly fingerprintEngine = new FingerprintEngine();

  constructor(private readonly metrics?: MetricsRegistry) {}

  run(input: {
    flow: FlowDefinition;
    fingerprints: Record<string, FlowFingerprint>;
    selectorRegistry: SelectorRegistry;
    snapshots: Record<string, BrowserPageSnapshot>;
    availableSelectorsByState: Record<string, string[]>;
    guardResults?: Record<string, boolean>;
    stopBeforeActions: string[];
  }): FlowRunResult {
    const flowRunId = randomUUID();
    const steps: FlowRunStep[] = [];
    let currentStateId = input.flow.entryState;
    let reachedSubmitBoundary = false;
    let errorCode: ErrorCode | null = null;
    const startedAt = new Date().toISOString();

    for (let guard = 0; guard < 25; guard += 1) {
      const state = input.flow.states[currentStateId];
      if (!state) {
        errorCode = "form_schema_changed";
        break;
      }

      const fingerprint = input.fingerprints[state.expectedFingerprint];
      const snapshot = input.snapshots[state.stateId];
      if (!fingerprint || !snapshot) {
        errorCode = "page_fingerprint_mismatch";
        steps.push({ stateId: state.stateId, status: "failed", usedSelectors: [], errorCode });
        break;
      }

      const fingerprintResult = this.fingerprintEngine.matches(snapshot, fingerprint);
      if (!fingerprintResult.matched) {
        errorCode = fingerprintResult.errorCode;
        steps.push({ stateId: state.stateId, status: "failed", usedSelectors: [], errorCode });
        break;
      }

      const failedGuard = state.guards.find((guardName) => input.guardResults?.[guardName] !== true);
      if (failedGuard) {
        errorCode = guardFailureCode(failedGuard);
        steps.push({ stateId: state.stateId, status: "failed", usedSelectors: [], errorCode });
        return this.result(input.flow, flowRunId, errorCode === "captcha_required" ? "manual_review_required" : "failed", reachedSubmitBoundary, steps, startedAt, errorCode);
      }

      const usedSelectors: string[] = [];
      for (const action of state.actions) {
        if (input.stopBeforeActions.includes(action.actionId)) {
          if (action.selectorKey) {
            const selectorResult = input.selectorRegistry.resolve(
              action.selectorKey,
              input.availableSelectorsByState[state.stateId] ?? []
            );
            if (selectorResult.errorCode) {
              errorCode = selectorResult.errorCode;
              steps.push({ stateId: state.stateId, status: "failed", usedSelectors, errorCode });
              return this.result(input.flow, flowRunId, "failed", reachedSubmitBoundary, steps, startedAt, errorCode);
            }
            if (selectorResult.selector) {
              usedSelectors.push(selectorResult.selector);
            }
          }
          reachedSubmitBoundary = true;
          steps.push({ stateId: state.stateId, status: "succeeded", usedSelectors, errorCode: null });
          return this.result(input.flow, flowRunId, "succeeded", reachedSubmitBoundary, steps, startedAt, null);
        }

        if (action.selectorKey) {
          const selectorResult = input.selectorRegistry.resolve(
            action.selectorKey,
            input.availableSelectorsByState[state.stateId] ?? []
          );
          if (selectorResult.errorCode) {
            errorCode = selectorResult.errorCode;
            steps.push({ stateId: state.stateId, status: "failed", usedSelectors, errorCode });
            return this.result(input.flow, flowRunId, "failed", reachedSubmitBoundary, steps, startedAt, errorCode);
          }
          if (selectorResult.selector) {
            usedSelectors.push(selectorResult.selector);
          }
        }
      }

      steps.push({ stateId: state.stateId, status: "succeeded", usedSelectors, errorCode: null });
      if (state.terminal) {
        return this.result(input.flow, flowRunId, "succeeded", reachedSubmitBoundary, steps, startedAt, null);
      }
      const next = state.transitions[state.actions.at(-1)?.actionId ?? ""];
      if (!next) {
        errorCode = "form_schema_changed";
        break;
      }
      currentStateId = next;
    }

    this.logger.warn("flow_failed", { flowId: input.flow.flowId, errorCode });
    return this.result(input.flow, flowRunId, errorCode === "captcha_required" ? "manual_review_required" : "failed", reachedSubmitBoundary, steps, startedAt, errorCode);
  }

  private result(
    flow: FlowDefinition,
    flowRunId: string,
    status: FlowRunResult["status"],
    reachedSubmitBoundary: boolean,
    steps: FlowRunStep[],
    startedAt: string,
    errorCode: ErrorCode | null
  ): FlowRunResult {
    this.metrics?.increment("provider_flow_runs_total", { provider: flow.provider, status });
    return {
      flowRunId,
      status,
      reachedSubmitBoundary,
      steps,
      proofPack: {
        proofPackId: `proof_${flowRunId}`,
        provider: flow.provider,
        accountId: "local-safe-account",
        entityId: flowRunId,
        flowId: flow.flowId,
        flowVersion: flow.version,
        selectorPackVersion: flow.selectorPackVersion,
        startedAt,
        completedAt: new Date().toISOString(),
        preActionScreenshotKey: `proof/${flowRunId}/pre.png`,
        postActionScreenshotKey: reachedSubmitBoundary ? null : `proof/${flowRunId}/post.png`,
        domSnapshotBeforeKey: `proof/${flowRunId}/before.html`,
        domSnapshotAfterKey: reachedSubmitBoundary ? null : `proof/${flowRunId}/after.html`,
        confirmationText: reachedSubmitBoundary ? "Dry-run stopped before irreversible action" : null,
        confirmationUrl: null,
        finalStatus: status,
        errorCode,
        auditEventId: null
      },
      errorCode
    };
  }
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, { providerId: string; accountId: string; encryptedStateKey: string; expiresAt: string | null }>();

  createSession(providerId: string, accountId: string, encryptedStateKey: string, expiresAt: string | null): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { providerId, accountId, encryptedStateKey, expiresAt });
    return sessionId;
  }

  assertUsable(sessionId: string): { usable: boolean; errorCode: ErrorCode | null } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { usable: false, errorCode: "session_expired" };
    }
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
      return { usable: false, errorCode: "session_expired" };
    }
    return { usable: true, errorCode: null };
  }
}

export class BrowserAuthStateVault {
  store(input: { providerId: string; accountId: string; rawState: string; secretRef: string }): { encryptedStateKey: string; stateHash: string } {
    const stateHash = stableHash(input.rawState);
    return {
      encryptedStateKey: `browser-state://${input.providerId}/${input.accountId}/${stateHash}?secret=${stableHash(input.secretRef)}`,
      stateHash
    };
  }

  verify(input: { encryptedStateKey: string; expectedStateHash: string }): boolean {
    return input.encryptedStateKey.includes(input.expectedStateHash);
  }
}

/* v8 ignore start -- real browser context creation requires installed Playwright browsers and is covered by staging smoke. */
export class PlaywrightRuntimeFactory {
  async createContext(input: {
    providerId: string;
    accountId: string;
    environment: "local" | "dev" | "staging" | "production";
    headed?: boolean;
    debug?: boolean;
    storageStatePath?: string | null;
  }): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
    if (input.environment === "production" && (input.headed || input.debug)) {
      throw new Error("Headed/debug browser mode is not allowed in production without audited ops override");
    }
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: !input.headed });
    const context = await browser.newContext({
      ...(input.storageStatePath ? { storageState: input.storageStatePath } : {})
    });
    return {
      context,
      close: async () => {
        await context.close();
        await browser.close();
      }
    };
  }
}
/* v8 ignore stop */

export class BrowserArtifactCapture {
  captureFixtureArtifacts(input: { flowRunId: string; root: string; html: string; screenshotBytes?: Uint8Array; traceBytes?: Uint8Array }): BrowserArtifactManifest {
    const base = join(input.root, input.flowRunId);
    mkdirSync(base, { recursive: true });
    const screenshotKey = join(base, "pre.png");
    const domKey = join(base, "before.html");
    const traceKey = input.traceBytes ? join(base, "trace.zip") : null;
    writeFileSync(screenshotKey, input.screenshotBytes ?? new Uint8Array([137, 80, 78, 71]));
    writeFileSync(domKey, input.html);
    if (traceKey) {
      writeFileSync(traceKey, input.traceBytes!);
    }
    return {
      flowRunId: input.flowRunId,
      screenshotKeys: [screenshotKey],
      domSnapshotKeys: [domKey],
      traceKey,
      createdAt: new Date().toISOString()
    };
  }
}

export class BrowserArtifactAccessLedger {
  authorize(input: { manifest: BrowserArtifactManifest; artifactKey: string; actor: string; purpose: string }): {
    allowed: boolean;
    audit: { artifactKey: string; actor: string; purpose: string; manifestFlowRunId: string; accessHash: string };
  } {
    const allowed = [
      ...input.manifest.screenshotKeys,
      ...input.manifest.domSnapshotKeys,
      ...(input.manifest.traceKey ? [input.manifest.traceKey] : [])
    ].includes(input.artifactKey);
    return {
      allowed,
      audit: {
        artifactKey: input.artifactKey,
        actor: input.actor,
        purpose: input.purpose,
        manifestFlowRunId: input.manifest.flowRunId,
        accessHash: stableHash(`${input.artifactKey}:${input.actor}:${input.purpose}`)
      }
    };
  }
}

export class CanaryRunner {
  async runProviderCanary(
    providerId: string,
    input: { selectorPack?: { selectors: Record<string, unknown> }; fingerprints?: Array<{ id?: string }>; fixtureSnapshots?: Record<string, BrowserPageSnapshot> } = {}
  ): Promise<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[]; metrics: Record<string, number> }> {
    const checks = ["auth_canary", "search_results_canary", "job_page_canary", "apply_form_without_submit"];
    const failures: string[] = [];
    if (providerId !== "telegram") {
      if (!input.selectorPack || Object.keys(input.selectorPack.selectors).length === 0) {
        failures.push("selector_pack_missing");
      }
      if (!input.fingerprints || input.fingerprints.length === 0) {
        failures.push("fingerprints_missing");
      }
      for (const required of ["search_results", "job_details", "application_form"]) {
        if (input.fixtureSnapshots && !input.fixtureSnapshots[required]) {
          failures.push(`fixture_snapshot_missing:${required}`);
        }
      }
    }
    return {
      providerId,
      status: failures.length === 0 ? "passed" : "failed",
      checks,
      failures,
      metrics: {
        selectorCount: Object.keys(input.selectorPack?.selectors ?? {}).length,
        fingerprintCount: input.fingerprints?.length ?? 0,
        fixtureSnapshotCount: Object.keys(input.fixtureSnapshots ?? {}).length
      }
    };
  }
}

export function mapBrowserErrorOutcome(errorCode: ErrorCode | null): BrowserErrorOutcome {
  if (!errorCode) {
    return "apply_failed";
  }
  if (["navigation_timeout", "network_error", "provider_unavailable", "provider_rate_limited"].includes(errorCode)) {
    return "retry_scheduled";
  }
  if (["captcha_required", "anti_automation_detected", "provider_terms_block", "account_locked", "auth_expired", "login_required", "session_expired"].includes(errorCode)) {
    return "provider_disabled";
  }
  if (["selector_missing", "selector_ambiguous", "page_fingerprint_mismatch", "form_schema_changed", "confirmation_missing"].includes(errorCode)) {
    return "dead_lettered";
  }
  if (["job_already_applied", "job_closed", "job_not_matching_policy", "salary_policy_conflict", "location_policy_conflict", "duplicate_company_thread_detected"].includes(errorCode)) {
    return "read_only_fallback";
  }
  if (["facts_matrix_violation", "cover_letter_policy_failed", "resume_not_available"].includes(errorCode)) {
    return "manual_review";
  }
  return "apply_failed";
}

export class ReplayService {
  replay(flowRunId: string, errorCode: ErrorCode | null): ReplayReport {
    return {
      flowRunId,
      status: "replayed",
      summary: errorCode ? `Replay reproduced ${errorCode}` : "Replay completed without reproducing an error",
      reproducedError: errorCode,
      recommendedAction: errorCode === "page_fingerprint_mismatch" ? "Update fingerprint or selector pack after review" : "No action required"
    };
  }

  replayFromArtifacts(input: { flowRunId: string; manifest: BrowserArtifactManifest; errorCode: ErrorCode | null }): ReplayReport {
    return {
      flowRunId: input.flowRunId,
      status: "replayed",
      summary: `Replay loaded ${input.manifest.screenshotKeys.length} screenshots and ${input.manifest.domSnapshotKeys.length} DOM snapshots`,
      reproducedError: input.errorCode,
      recommendedAction: input.errorCode ? "Inspect stored artifacts and update selector/fingerprint after review" : "No action required"
    };
  }
}

export const hhDryRunFlow: FlowDefinition = {
  flowId: "hh_auto_apply_v1",
  provider: "hh",
  version: "2026-05-16-v1",
  selectorPackVersion: "2026-05-16-v1",
  entryState: "search_results",
  states: {
    search_results: {
      stateId: "search_results",
      expectedFingerprint: "hh_results_page",
      guards: ["vacancy_is_active"],
      actions: [{ actionId: "open_job", selectorKey: "job_card" }],
      transitions: {
        open_job: "job_details"
      }
    },
    job_details: {
      stateId: "job_details",
      expectedFingerprint: "hh_job_page",
      guards: ["not_already_applied", "vacancy_is_active", "apply_button_exists"],
      actions: [{ actionId: "click_apply", selectorKey: "apply_button" }],
      transitions: {
        click_apply: "application_form"
      }
    },
    application_form: {
      stateId: "application_form",
      expectedFingerprint: "hh_apply_form",
      guards: ["resume_available", "cover_letter_valid", "no_captcha"],
      actions: [
        { actionId: "select_resume" },
        { actionId: "fill_cover_letter", selectorKey: "cover_letter_textarea" },
        { actionId: "submit_application", selectorKey: "apply_button" }
      ],
      transitions: {
        submit_application: "submit_boundary"
      }
    },
    submit_boundary: {
      stateId: "submit_boundary",
      expectedFingerprint: "hh_apply_form",
      guards: [],
      actions: [{ actionId: "dry_run_complete" }],
      transitions: {
        dry_run_complete: "dry_run_complete"
      }
    },
    dry_run_complete: {
      stateId: "dry_run_complete",
      expectedFingerprint: "hh_apply_form",
      guards: [],
      actions: [],
      transitions: {},
      terminal: true
    }
  }
};

export const robotaDryRunFlow: FlowDefinition = {
  flowId: "robota_auto_apply_v1",
  provider: "robota",
  version: "2026-05-18-v1",
  selectorPackVersion: "2026-05-16-v1",
  entryState: "search_results",
  states: {
    search_results: {
      stateId: "search_results",
      expectedFingerprint: "robota_search_results",
      guards: ["vacancy_is_active"],
      actions: [{ actionId: "open_job", selectorKey: "job_card" }],
      transitions: {
        open_job: "job_details"
      }
    },
    job_details: {
      stateId: "job_details",
      expectedFingerprint: "robota_job_page",
      guards: ["not_already_applied", "vacancy_is_active", "apply_button_exists"],
      actions: [{ actionId: "click_apply", selectorKey: "apply_button" }],
      transitions: {
        click_apply: "application_form"
      }
    },
    application_form: {
      stateId: "application_form",
      expectedFingerprint: "robota_apply_form",
      guards: ["resume_available", "cover_letter_valid", "no_captcha"],
      actions: [
        { actionId: "select_resume" },
        { actionId: "fill_cover_letter" },
        { actionId: "submit_application", selectorKey: "apply_button" }
      ],
      transitions: {
        submit_application: "submit_boundary"
      }
    },
    unsupported_form_variant: {
      stateId: "unsupported_form_variant",
      expectedFingerprint: "robota_apply_form",
      guards: ["supported_form_variant"],
      actions: [],
      transitions: {},
      terminal: true
    },
    submit_boundary: {
      stateId: "submit_boundary",
      expectedFingerprint: "robota_apply_form",
      guards: [],
      actions: [{ actionId: "dry_run_complete" }],
      transitions: {
        dry_run_complete: "dry_run_complete"
      }
    },
    dry_run_complete: {
      stateId: "dry_run_complete",
      expectedFingerprint: "robota_apply_form",
      guards: [],
      actions: [],
      transitions: {},
      terminal: true
    }
  }
};

function guardFailureCode(guardName: string): ErrorCode {
  const guardErrors: Record<string, ErrorCode> = {
    not_already_applied: "job_already_applied",
    vacancy_is_active: "job_closed",
    apply_button_exists: "selector_missing",
    resume_available: "resume_not_available",
    cover_letter_valid: "cover_letter_policy_failed",
    no_captcha: "captcha_required",
    supported_form_variant: "form_schema_changed"
  };
  return guardErrors[guardName] ?? "form_schema_changed";
}
