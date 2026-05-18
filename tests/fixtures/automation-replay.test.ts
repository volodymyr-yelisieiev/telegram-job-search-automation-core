import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserArtifactCapture,
  DeterministicFlowRunner,
  FingerprintEngine,
  hhDryRunFlow,
  PlaywrightRuntimeFactory,
  ReplayService,
  robotaDryRunFlow,
  SelectorRegistry,
  type BrowserPageSnapshot,
  type FlowFingerprint
} from "@job-search/automation";

const fingerprint: FlowFingerprint = {
  id: "hh_job_page",
  urlPattern: "/vacancy/",
  titlePattern: "Backend",
  requiredDomAnchors: ["[data-qa='vacancy-response-link-top']"],
  requiredTextAnchors: ["Откликнуться"],
  captchaIndicators: ["captcha"]
};

describe("automation fixtures and replay", () => {
  it("defines explicit dry-run state shapes and captures local artifacts", async () => {
    expect(hhDryRunFlow.entryState).toBe("search_results");
    expect(Object.keys(hhDryRunFlow.states)).toEqual(
      expect.arrayContaining(["search_results", "job_details", "application_form", "submit_boundary", "dry_run_complete"])
    );
    expect(Object.keys(robotaDryRunFlow.states)).toEqual(
      expect.arrayContaining(["search_results", "job_details", "application_form", "unsupported_form_variant", "submit_boundary", "dry_run_complete"])
    );
    await expect(
      new PlaywrightRuntimeFactory().createContext({
        providerId: "hh",
        accountId: "account",
        environment: "production",
        headed: true
      })
    ).rejects.toThrow(/Headed\/debug/);
    const root = mkdtempSync(join(tmpdir(), "browser-artifacts-"));
    try {
      const manifest = new BrowserArtifactCapture().captureFixtureArtifacts({
        flowRunId: "flow-1",
        root,
        html: "<html><body>fixture</body></html>",
        traceBytes: new Uint8Array([1, 2, 3])
      });
      expect(manifest.screenshotKeys).toHaveLength(1);
      expect(manifest.domSnapshotKeys).toHaveLength(1);
      expect(manifest.traceKey).toContain("trace.zip");
      const withoutTrace = new BrowserArtifactCapture().captureFixtureArtifacts({
        flowRunId: "flow-2",
        root,
        html: "<html><body>fixture 2</body></html>",
        screenshotBytes: new Uint8Array([1, 2, 3, 4])
      });
      expect(withoutTrace.traceKey).toBeNull();
      expect([...readFileSync(withoutTrace.screenshotKeys[0]!)]).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects fingerprint mismatch", () => {
    const engine = new FingerprintEngine();
    const result = engine.matches(
      {
        url: "https://hh.example/not-a-vacancy",
        title: "Other page",
        text: "No apply",
        domAnchors: []
      },
      fingerprint
    );

    expect(result.matched).toBe(false);
    expect(result.errorCode).toBe("page_fingerprint_mismatch");
  });

  it("maps runner fingerprint and selector failures", () => {
    const runner = new DeterministicFlowRunner();
    const baseInput = {
      flow: hhDryRunFlow,
      fingerprints: {
        hh_results_page: {
          ...fingerprint,
          id: "hh_results_page",
          urlPattern: "/search/vacancy",
          titlePattern: "vacancy",
          requiredDomAnchors: ["[data-qa='vacancy-serp__vacancy-title']"],
          requiredTextAnchors: ["Найден"]
        },
        hh_job_page: fingerprint
      },
      selectorRegistry: new SelectorRegistry({
        job_card: { primary: "[data-qa='vacancy-serp__vacancy-title']", fallbacks: [], required: true },
        apply_button: { primary: "[missing]", fallbacks: [], required: true }
      }),
      snapshots: {
        search_results: {
          url: "https://hh.example/search/vacancy?text=node",
          title: "vacancy search",
          text: "Найден backend вакансии",
          domAnchors: ["[data-qa='vacancy-serp__vacancy-title']"]
        },
        job_details: {
          url: "https://hh.example/vacancy/1001",
          title: "Backend",
          text: "Wrong text",
          domAnchors: ["[data-qa='vacancy-response-link-top']"]
        }
      },
      availableSelectorsByState: {
        search_results: ["[data-qa='vacancy-serp__vacancy-title']"],
        job_details: []
      },
      guardResults: {
        not_already_applied: true,
        vacancy_is_active: true,
        apply_button_exists: true
      },
      stopBeforeActions: []
    };

    expect(runner.run(baseInput).errorCode).toBe("page_fingerprint_mismatch");
    expect(
      runner.run({
        ...baseInput,
        snapshots: {
          ...baseInput.snapshots,
          job_details: {
            url: "https://hh.example/vacancy/1001",
            title: "Backend",
            text: "Откликнуться",
            domAnchors: ["[data-qa='vacancy-response-link-top']"]
          }
        }
      }).errorCode
    ).toBe("selector_missing");
  });

  it("stops dry-run before submit boundary", () => {
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
    const runner = new DeterministicFlowRunner();
    const result = runner.run({
      flow: hhDryRunFlow,
      fingerprints: {
        hh_results_page: {
          ...fingerprint,
          id: "hh_results_page",
          urlPattern: "/search/vacancy",
          titlePattern: "vacancy",
          requiredDomAnchors: ["[data-qa='vacancy-serp__vacancy-title']"],
          requiredTextAnchors: ["Найден"]
        },
        hh_job_page: fingerprint,
        hh_apply_form: {
          ...fingerprint,
          id: "hh_apply_form",
          titlePattern: "Отклик",
          requiredDomAnchors: ["[data-qa='vacancy-response-popup']"]
        }
      },
      selectorRegistry: new SelectorRegistry({
        job_card: {
          primary: "[data-qa='vacancy-serp__vacancy-title']",
          fallbacks: ["a[href*='/vacancy/']"],
          required: true
        },
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
        application_form: ["textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
      },
      guardResults: {
        not_already_applied: true,
        vacancy_is_active: true,
        apply_button_exists: true,
        resume_available: true,
        cover_letter_valid: true,
        no_captcha: true
      },
      stopBeforeActions: ["submit_application"]
    });

    expect(result.status).toBe("succeeded");
    expect(result.reachedSubmitBoundary).toBe(true);
    expect(result.proofPack.postActionScreenshotKey).toBeNull();
  });

  it("creates replay diagnostics for failed browser flows", () => {
    const report = new ReplayService().replay("flow-1", "page_fingerprint_mismatch");

    expect(report.status).toBe("replayed");
    expect(report.recommendedAction).toContain("Update fingerprint");
    expect(
      new ReplayService().replayFromArtifacts({
        flowRunId: "flow-2",
        manifest: {
          flowRunId: "flow-2",
          screenshotKeys: ["proof/flow-2/pre.png"],
          domSnapshotKeys: ["proof/flow-2/before.html"],
          traceKey: "proof/flow-2/trace.zip",
          createdAt: new Date().toISOString()
        },
        errorCode: null
      }).summary
    ).toContain("1 screenshots");
  });

  it("runs robota dry-run to submit boundary", () => {
    const runner = new DeterministicFlowRunner();
    const result = runner.run({
      flow: robotaDryRunFlow,
      fingerprints: {
        robota_search_results: {
          id: "robota_search_results",
          urlPattern: "/jobs",
          titlePattern: "jobs",
          requiredDomAnchors: ["[data-test='job-title']"],
          requiredTextAnchors: ["jobs"],
          captchaIndicators: ["captcha"]
        },
        robota_job_page: {
          id: "robota_job_page",
          urlPattern: "/jobs/",
          titlePattern: "job",
          requiredDomAnchors: ["[data-test='apply-button']"],
          requiredTextAnchors: ["Apply"],
          captchaIndicators: ["captcha"]
        },
        robota_apply_form: {
          id: "robota_apply_form",
          urlPattern: "/jobs/",
          titlePattern: "apply",
          requiredDomAnchors: ["[data-test='apply-form']"],
          requiredTextAnchors: ["Apply"],
          captchaIndicators: ["captcha"]
        }
      },
      selectorRegistry: new SelectorRegistry({
        job_card: {
          primary: "[data-test='job-title']",
          fallbacks: ["a[href*='/jobs/']"],
          required: true
        },
        apply_button: {
          primary: "[data-test='apply-button']",
          fallbacks: ["button:has-text('Apply')"],
          required: true
        }
      }),
      snapshots: {
        search_results: {
          url: "https://robota.example/jobs?q=node",
          title: "jobs",
          text: "jobs Apply",
          domAnchors: ["[data-test='job-title']"]
        },
        job_details: {
          url: "https://robota.example/jobs/2001",
          title: "job",
          text: "Apply",
          domAnchors: ["[data-test='apply-button']"]
        },
        application_form: {
          url: "https://robota.example/jobs/2001",
          title: "apply",
          text: "Apply",
          domAnchors: ["[data-test='apply-form']", "[data-test='apply-button']"]
        }
      },
      availableSelectorsByState: {
        search_results: ["[data-test='job-title']"],
        job_details: ["[data-test='apply-button']"],
        application_form: ["[data-test='apply-button']"]
      },
      guardResults: {
        not_already_applied: true,
        vacancy_is_active: true,
        apply_button_exists: true,
        resume_available: true,
        cover_letter_valid: true,
        no_captcha: true
      },
      stopBeforeActions: ["submit_application"]
    });

    expect(result.status).toBe("succeeded");
    expect(result.reachedSubmitBoundary).toBe(true);
  });
});
