import { describe, expect, it } from "vitest";
import {
  BrowserSessionManager,
  BrowserAuthStateVault,
  BrowserArtifactAccessLedger,
  CanaryRunner,
  DeterministicFlowRunner,
  FingerprintEngine,
  hhDryRunFlow,
  mapBrowserErrorOutcome,
  ReplayService,
  robotaDryRunFlow,
  SelectorRegistry,
  type BrowserPageSnapshot,
  type FlowDefinition,
  type FlowFingerprint
} from "@job-search/automation";

const fingerprints: Record<string, FlowFingerprint> = {
  hh_results_page: {
    id: "hh_results_page",
    urlPattern: "/search/vacancy",
    titlePattern: "vacancy",
    requiredDomAnchors: ["[data-qa='vacancy-serp__vacancy-title']"],
    requiredTextAnchors: ["Найден"],
    captchaIndicators: ["captcha"]
  },
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
  search_results: {
    url: "https://hh.example/search/vacancy?text=node",
    title: "vacancy search",
    text: "Найден backend вакансии",
    domAnchors: ["[data-qa='vacancy-serp__vacancy-title']"]
  },
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
        job_card: { primary: "[data-qa='vacancy-serp__vacancy-title']", fallbacks: [], required: true },
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
        search_results: ["[data-qa='vacancy-serp__vacancy-title']"],
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
        job_card: { primary: "[data-qa='vacancy-serp__vacancy-title']", fallbacks: [], required: true },
        apply_button: { primary: "[data-qa='vacancy-response-link-top']", fallbacks: [], required: true },
        cover_letter_textarea: { primary: "textarea[name='letter']", fallbacks: [], required: false }
      }),
      snapshots,
      availableSelectorsByState: { search_results: ["[data-qa='vacancy-serp__vacancy-title']"], job_details: ["[data-qa='vacancy-response-link-top']"] },
      guardResults: { ...guards, not_already_applied: false },
      stopBeforeActions: ["submit_application"]
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("job_already_applied");
  });

  it("covers terminal success, missing states, no transitions and stop-boundary success", () => {
    const runner = new DeterministicFlowRunner();
    const registry = new SelectorRegistry({
      job_card: { primary: "[data-qa='vacancy-serp__vacancy-title']", fallbacks: [], required: true },
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
          search_results: ["[data-qa='vacancy-serp__vacancy-title']"],
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
          search_results: ["[data-qa='vacancy-serp__vacancy-title']"],
          job_details: ["[data-qa='vacancy-response-link-top']"],
          application_form: ["textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
        },
        guardResults: guards,
        stopBeforeActions: ["submit_application"]
      })
    ).toMatchObject({ status: "succeeded", reachedSubmitBoundary: true });
  });

  it("maps supported and fallback guard failures through deterministic flows", () => {
    const runner = new DeterministicFlowRunner();
    const guardFingerprint: FlowFingerprint = {
      id: "guard_page",
      urlPattern: "/guard",
      titlePattern: "Guard",
      requiredDomAnchors: [],
      requiredTextAnchors: ["ready"],
      captchaIndicators: ["captcha"]
    };
    const guardSnapshot: BrowserPageSnapshot = {
      url: "https://hh.example/guard",
      title: "Guard",
      text: "ready",
      domAnchors: []
    };
    const guardFlow = (guardName: string): FlowDefinition => ({
      flowId: `guard_${guardName}`,
      provider: "hh",
      version: "v1",
      selectorPackVersion: "v1",
      entryState: "guard",
      states: {
        guard: {
          stateId: "guard",
          expectedFingerprint: "guard_page",
          guards: [guardName],
          actions: [],
          transitions: {},
          terminal: true
        }
      }
    });

    expect(
      runner.run({
        flow: guardFlow("resume_available"),
        fingerprints: { guard_page: guardFingerprint },
        selectorRegistry: new SelectorRegistry({}),
        snapshots: { guard: guardSnapshot },
        availableSelectorsByState: { guard: [] },
        guardResults: { resume_available: false },
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "resume_not_available" });
    expect(
      runner.run({
        flow: guardFlow("unknown_guard"),
        fingerprints: { guard_page: guardFingerprint },
        selectorRegistry: new SelectorRegistry({}),
        snapshots: { guard: guardSnapshot },
        availableSelectorsByState: { guard: [] },
        guardResults: { unknown_guard: false },
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "form_schema_changed" });
    expect(robotaDryRunFlow.states.unsupported_form_variant?.guards).toContain("supported_form_variant");

    const noActionFlow = guardFlow("ready");
    noActionFlow.states.guard!.guards = [];
    noActionFlow.states.guard!.terminal = false;
    expect(
      runner.run({
        flow: noActionFlow,
        fingerprints: { guard_page: guardFingerprint },
        selectorRegistry: new SelectorRegistry({}),
        snapshots: { guard: guardSnapshot },
        availableSelectorsByState: { guard: [] },
        guardResults: {},
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "failed", errorCode: "form_schema_changed" });
    expect(
      runner.run({
        flow: noActionFlow,
        fingerprints: { guard_page: guardFingerprint },
        selectorRegistry: new SelectorRegistry({}),
        snapshots: { guard: { ...guardSnapshot, text: "captcha ready" } },
        availableSelectorsByState: { guard: [] },
        guardResults: {},
        stopBeforeActions: []
      })
    ).toMatchObject({ status: "manual_review_required", errorCode: "captcha_required" });
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
    const vault = new BrowserAuthStateVault();
    const stored = vault.store({ providerId: "hh", accountId: "account", rawState: "{\"cookies\":[]}", secretRef: "vault/browser/hh" });
    expect(stored.encryptedStateKey).toContain("browser-state://hh/account");
    expect(vault.verify({ encryptedStateKey: stored.encryptedStateKey, expectedStateHash: stored.stateHash })).toBe(true);
  });

  it("fails canary when required provider metadata is missing", async () => {
    const result = await new CanaryRunner().runProviderCanary("hh", {});
    expect(result.status).toBe("failed");
    expect(result.failures).toContain("selector_pack_missing");
    expect(result.failures).toContain("fingerprints_missing");
    await expect(
      new CanaryRunner().runProviderCanary("hh", {
        selectorPack: { selectors: { apply_button: "[data-qa='apply']" } },
        fingerprints: [{ id: "hh_job_page" }],
        fixtureSnapshots: snapshots
      })
    ).resolves.toMatchObject({ status: "passed", failures: [], metrics: { fixtureSnapshotCount: 3 } });
    await expect(
      new CanaryRunner().runProviderCanary("hh", {
        selectorPack: { selectors: { apply_button: "[data-qa='apply']" } },
        fingerprints: [{ id: "hh_job_page" }],
        fixtureSnapshots: { search_results: snapshots.search_results! }
      })
    ).resolves.toMatchObject({
      status: "failed",
      failures: expect.arrayContaining(["fixture_snapshot_missing:job_details", "fixture_snapshot_missing:application_form"])
    });
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
    expect(
      replay.replayFromArtifacts({
        flowRunId: "flow-3",
        manifest: {
          flowRunId: "flow-3",
          screenshotKeys: ["proof/flow-3/pre.png"],
          domSnapshotKeys: ["proof/flow-3/before.html"],
          traceKey: null,
          createdAt: "2026-05-18T00:00:00.000Z"
        },
        errorCode: "selector_missing"
      })
    ).toMatchObject({ recommendedAction: "Inspect stored artifacts and update selector/fingerprint after review" });
    expect(
      replay.replayFromArtifacts({
        flowRunId: "flow-4",
        manifest: {
          flowRunId: "flow-4",
          screenshotKeys: [],
          domSnapshotKeys: [],
          traceKey: null,
          createdAt: "2026-05-18T00:00:00.000Z"
        },
        errorCode: null
      })
    ).toMatchObject({ recommendedAction: "No action required" });
    expect(mapBrowserErrorOutcome("captcha_required")).toBe("provider_disabled");
    expect(mapBrowserErrorOutcome("network_error")).toBe("retry_scheduled");
    expect(mapBrowserErrorOutcome("selector_missing")).toBe("dead_lettered");
    expect(mapBrowserErrorOutcome("job_closed")).toBe("read_only_fallback");
    expect(mapBrowserErrorOutcome("resume_not_available")).toBe("manual_review");
    expect(mapBrowserErrorOutcome("page_locale_changed")).toBe("apply_failed");
    expect(mapBrowserErrorOutcome(null)).toBe("apply_failed");
  });

  it("authorizes artifact access against the captured manifest", () => {
    const ledger = new BrowserArtifactAccessLedger();
    const manifest = {
      flowRunId: "flow-1",
      screenshotKeys: ["proof/flow-1/pre.png"],
      domSnapshotKeys: ["proof/flow-1/before.html"],
      traceKey: "proof/flow-1/trace.zip",
      createdAt: "2026-05-18T00:00:00.000Z"
    };
    expect(ledger.authorize({ manifest, artifactKey: "proof/flow-1/pre.png", actor: "ops", purpose: "debug" })).toMatchObject({
      allowed: true
    });
    expect(ledger.authorize({ manifest, artifactKey: "proof/flow-2/pre.png", actor: "ops", purpose: "debug" })).toMatchObject({
      allowed: false
    });
  });
});
