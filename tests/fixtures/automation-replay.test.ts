import { describe, expect, it } from "vitest";
import {
  DeterministicFlowRunner,
  FingerprintEngine,
  hhDryRunFlow,
  ReplayService,
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

  it("stops dry-run before submit boundary", () => {
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
    const runner = new DeterministicFlowRunner();
    const result = runner.run({
      flow: hhDryRunFlow,
      fingerprints: {
        hh_job_page: fingerprint,
        hh_apply_form: {
          ...fingerprint,
          id: "hh_apply_form",
          titlePattern: "Отклик",
          requiredDomAnchors: ["[data-qa='vacancy-response-popup']"]
        }
      },
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
  });
});
