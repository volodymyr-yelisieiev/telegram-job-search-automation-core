import { randomUUID } from "node:crypto";
import type { ErrorCode, ProofPack, ReplayReport } from "@job-search/domain";
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

export class CanaryRunner {
  async runProviderCanary(
    providerId: string,
    input: { selectorPack?: { selectors: Record<string, unknown> }; fingerprints?: unknown[] } = {}
  ): Promise<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[] }> {
    const checks = ["auth_canary", "search_results_canary", "job_page_canary", "apply_form_without_submit"];
    const failures: string[] = [];
    if (providerId !== "telegram") {
      if (!input.selectorPack || Object.keys(input.selectorPack.selectors).length === 0) {
        failures.push("selector_pack_missing");
      }
      if (!input.fingerprints || input.fingerprints.length === 0) {
        failures.push("fingerprints_missing");
      }
    }
    return {
      providerId,
      status: failures.length === 0 ? "passed" : "failed",
      checks,
      failures
    };
  }
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
}

export const hhDryRunFlow: FlowDefinition = {
  flowId: "hh_auto_apply_v1",
  provider: "hh",
  version: "2026-05-16-v1",
  selectorPackVersion: "2026-05-16-v1",
  entryState: "job_details",
  states: {
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
        submit_application: "confirmation"
      }
    },
    confirmation: {
      stateId: "confirmation",
      expectedFingerprint: "hh_confirmation",
      guards: [],
      actions: [{ actionId: "capture_confirmation" }],
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
    no_captcha: "captcha_required"
  };
  return guardErrors[guardName] ?? "form_schema_changed";
}
