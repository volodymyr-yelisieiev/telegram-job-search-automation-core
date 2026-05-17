import { describe, expect, it } from "vitest";
import {
  BrowserSessionManager,
  CanaryRunner,
  DeterministicFlowRunner,
  FingerprintEngine,
  hhDryRunFlow,
  ReplayService,
  SelectorRegistry,
  type BrowserPageSnapshot,
  type FlowDefinition,
  type FlowFingerprint
} from "@job-search/automation";

const fingerprints: Record<string, FlowFingerprint> = {
  hh_job_page: {
    id: "hh_job_page",
    urlPattern: "/vacancy/",
    titlePattern: "Backend",
    requiredDomAnchors: ["[data-qa='vacancy-response-link-top']"],
    requiredTextAnchors: ["Откликнуться"],
    captchaIndicators: ["captcha"],
    captchaDomAnchors: ["iframe[src*='recaptcha']"],
    captchaUrlPatterns: ["/challenge"]
  },
  hh_apply_form: {
    id: "hh_apply_form",
    urlPattern: "/vacancy/",
    titlePattern: "Отклик",
    requiredDomAnchors: ["[data-qa='vacancy-response-popup']"],
    requiredTextAnchors: ["Откликнуться"],
    captchaIndicators: ["captcha"]
  }
};

const snapshots: Record<string, BrowserPageSnapshot> = {
  job_details: {
    url: "https://hh.example/vacancy/1001",
    title: "Backend",
    text: "Откликнуться",
    domAnchors: ["[data-qa='vacancy-response-link-top']"]
  },
  application_form: {
    url: "https://hh.example/vacancy/1001",
    title: "Отклик",
    text: "Откликнуться",
    domAnchors: ["[data-qa='vacancy-response-popup']", "textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
  }
};

const guards = {
  not_already_applied: true,
  vacancy_is_active: true,
  apply_button_exists: true,
  resume_available: true,
  cover_letter_valid: true,
  no_captcha: true
};

describe("automation hardening", () => {
  it("requires submit selector before dry-run boundary", () => {
    const result = new DeterministicFlowRunner().run({
      flow: hhDryRunFlow,
      fingerprints,
      selectorRegistry: new SelectorRegistry({
        apply_button: {
          primary: "[data-qa='vacancy-response-link-top']",
          fallbacks: ["button:has-text('Откликнуться')"],
          required: true
        },
        cover_letter_textarea: {
          primary: "textarea[name='letter']",
          fallbacks: ["textarea"],
          required: false
        }
      }),
      snapshots,
      availableSelectorsByState: {
        job_details: ["[data-qa='vacancy-response-link-top']"],
        application_form: ["textarea[name='letter']"]
      },
      guardResults: guards,
      stopBeforeActions: ["submit_application"]
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("selector_missing");
  });

  it("fails ambiguous required selectors", () => {
    const result = new SelectorRegistry({
      apply_button: {
        primary: "[data-qa='vacancy-response-link-top']",
        fallbacks: ["button:has-text('Откликнуться')"],
        required: true
      }
    }).resolve("apply_button", ["[data-qa='vacancy-response-link-top']", "button:has-text('Откликнуться')"]);

    expect(result.errorCode).toBe("selector_ambiguous");
  });

  it("allows missing optional selectors", () => {
    const result = new SelectorRegistry({
      cover_letter_textarea: {
        primary: "textarea[name='letter']",
        fallbacks: ["textarea"],
        required: false
      }
    }).resolve("cover_letter_textarea", []);

    expect(result).toEqual({ selector: null, errorCode: null });
    expect(new SelectorRegistry({}).resolve("missing", [])).toEqual({ selector: null, errorCode: "selector_missing" });
  });

  it("covers fingerprint mismatch variants", () => {
    const engine = new FingerprintEngine();
    expect(engine.matches({ ...snapshots.job_details!, url: "https://hh.example/other" }, fingerprints.hh_job_page!).errorCode).toBe(
      "page_fingerprint_mismatch"
    );
    expect(engine.matches({ ...snapshots.job_details!, title: "Frontend" }, fingerprints.hh_job_page!).errorCode).toBe(
      "page_fingerprint_mismatch"
    );
    expect(engine.matches({ ...snapshots.job_details!, domAnchors: [] }, fingerprints.hh_job_page!).errorCode).toBe(
      "page_fingerprint_mismatch"
    );
    expect(engine.matches({ ...snapshots.job_details!, text: "No apply text" }, fingerprints.hh_job_page!).errorCode).toBe(
      "page_fingerprint_mismatch"
    );
  });

  it("blocks failed guards with mapped error codes", () => {
    const result = new DeterministicFlowRunner().run({
      flow: hhDryRunFlow,
      fingerprints,
      selectorRegistry: new SelectorRegistry({
        apply_button: { primary: "[data-qa='vacancy-response-link-top']", fallbacks: [], required: true },
        cover_letter_textarea: { primary: "textarea[name='letter']", fallbacks: [], required: false }
      }),
      snapshots,
      availableSelectorsByState: { job_details: ["[data-qa='vacancy-response-link-top']"] },
      guardResults: { ...guards, not_already_applied: false },
      stopBeforeActions: ["submit_application"]
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("job_already_applied");
  });

  it("covers terminal success, missing states, no transitions and stop-boundary success", () => {
    const runner = new DeterministicFlowRunner();
    const registry = new SelectorRegistry({
      apply_button: { primary: "[data-qa='vacancy-response-link-top']", fallbacks: [], required: true },
      cover_letter_textarea: { primary: "textarea[name='letter']", fallbacks: [], required: false }
    });

    expect(
      runner.run({
        flow: hhDryRunFlow,
        fingerprints,
        selectorRegistry: registry,
        snapshots,
        availableSelectorsByState: {
          job_details: ["[data-qa='vacancy-response-link-top']"],
          application_form: ["textarea[name='letter']", "[data-qa='vacancy-response-link-top']"],
          confirmation: []
        },
        guardResults: guards,
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "page_fingerprint_mismatch" });

    const terminalFlow: FlowDefinition = {
      flowId: "terminal",
      provider: "hh",
      version: "v1",
      selectorPackVersion: "v1",
      entryState: "job_details",
      states: {
        job_details: { ...hhDryRunFlow.states.job_details!, actions: [], transitions: {}, terminal: true }
      }
    };
    expect(
      runner.run({
        flow: terminalFlow,
        fingerprints,
        selectorRegistry: registry,
        snapshots,
        availableSelectorsByState: { job_details: [] },
        guardResults: guards,
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "succeeded", errorCode: null });

    const missingStateFlow: FlowDefinition = { ...terminalFlow, entryState: "missing" };
    expect(
      runner.run({
        flow: missingStateFlow,
        fingerprints,
        selectorRegistry: registry,
        snapshots,
        availableSelectorsByState: {},
        guardResults: guards,
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "form_schema_changed" });

    const noTransitionFlow: FlowDefinition = {
      ...terminalFlow,
      states: {
        job_details: {
          ...hhDryRunFlow.states.job_details!,
          transitions: {}
        }
      }
    };
    expect(
      runner.run({
        flow: noTransitionFlow,
        fingerprints,
        selectorRegistry: registry,
        snapshots,
        availableSelectorsByState: { job_details: ["[data-qa='vacancy-response-link-top']"] },
        guardResults: guards,
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "form_schema_changed" });

    expect(
      runner.run({
        flow: hhDryRunFlow,
        fingerprints,
        selectorRegistry: registry,
        snapshots,
        availableSelectorsByState: {
          job_details: ["[data-qa='vacancy-response-link-top']"],
          application_form: ["textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
        },
        guardResults: guards,
        stopBeforeActions: ["submit_application"]
      })
    ).toMatchObject({ status: "succeeded", reachedSubmitBoundary: true });
  });

  it("detects CAPTCHA by URL and DOM anchors", () => {
    const engine = new FingerprintEngine();
    expect(
      engine.matches({ ...snapshots.job_details!, url: "https://hh.example/challenge" }, fingerprints.hh_job_page!).errorCode
    ).toBe("captcha_required");
    expect(
      engine.matches(
        { ...snapshots.job_details!, domAnchors: ["[data-qa='vacancy-response-link-top']", "iframe[src*='recaptcha']"] },
        fingerprints.hh_job_page!
      ).errorCode
    ).toBe("captcha_required");
  });

  it("tracks browser session usability and expiry", () => {
    const sessions = new BrowserSessionManager();
    const valid = sessions.createSession("hh", "account", "encrypted", new Date(Date.now() + 60_000).toISOString());
    const expired = sessions.createSession("hh", "account", "encrypted", new Date(Date.now() - 60_000).toISOString());

    expect(sessions.assertUsable(valid)).toEqual({ usable: true, errorCode: null });
    expect(sessions.assertUsable(expired)).toEqual({ usable: false, errorCode: "session_expired" });
    expect(sessions.assertUsable("missing")).toEqual({ usable: false, errorCode: "session_expired" });
  });

  it("fails canary when required provider metadata is missing", async () => {
    const result = await new CanaryRunner().runProviderCanary("hh", {});
    expect(result.status).toBe("failed");
    expect(result.failures).toContain("selector_pack_missing");
    expect(result.failures).toContain("fingerprints_missing");
    await expect(new CanaryRunner().runProviderCanary("telegram", {})).resolves.toMatchObject({ status: "passed" });
  });

  it("creates replay reports for reproduced and clean runs", () => {
    const replay = new ReplayService();
    expect(replay.replay("flow-1", "page_fingerprint_mismatch")).toMatchObject({
      status: "replayed",
      reproducedError: "page_fingerprint_mismatch",
      recommendedAction: "Update fingerprint or selector pack after review"
    });
    expect(replay.replay("flow-2", null)).toMatchObject({ reproducedError: null, recommendedAction: "No action required" });
  });
});
