import {
  DeterministicFlowRunner,
  hhDryRunFlow,
  SelectorRegistry,
  type BrowserPageSnapshot,
  type FlowFingerprint,
  type FlowRunResult
} from "@job-search/automation";
import type { InMemoryDatabase } from "@job-search/db";
import { pageFingerprints, selectorPacks } from "@job-search/providers";

export function runApplyWorker(input: { db?: InMemoryDatabase; guardResults?: Record<string, boolean> } = {}): FlowRunResult {
  const selectorPack = selectorPacks.hh;

  if (!selectorPack) {
    throw new Error("hh selector pack missing");
  }

  const fingerprints = Object.fromEntries(
    (pageFingerprints.hh ?? []).map((fingerprint) => [
      fingerprint.id,
      {
        id: fingerprint.id,
        urlPattern: fingerprint.urlPattern,
        titlePattern: fingerprint.titlePattern,
        requiredDomAnchors: fingerprint.requiredDomAnchors,
        requiredTextAnchors: fingerprint.requiredTextAnchors,
        captchaIndicators: fingerprint.captchaIndicators
      } satisfies FlowFingerprint
    ])
  );

  const snapshots: Record<string, BrowserPageSnapshot> = {
    job_details: {
      url: "https://hh.example/vacancy/1001",
      title: "Senior Node.js Backend Developer",
      text: "Откликнуться Senior Node.js Backend Developer",
      domAnchors: ["[data-qa='vacancy-response-link-top']"]
    },
    application_form: {
      url: "https://hh.example/vacancy/1001",
      title: "Отклик на вакансию",
      text: "Откликнуться cover letter",
      domAnchors: ["[data-qa='vacancy-response-popup']", "textarea[name='letter']", "[data-qa='vacancy-response-link-top']"]
    }
  };

  const result = new DeterministicFlowRunner().run({
    flow: hhDryRunFlow,
    fingerprints,
    selectorRegistry: new SelectorRegistry(selectorPack.selectors),
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
      no_captcha: true,
      ...input.guardResults
    },
    stopBeforeActions: ["submit_application"]
  });
  if (result.errorCode && ["captcha_required", "provider_rate_limited", "provider_terms_block", "anti_automation_detected"].includes(result.errorCode)) {
    input.db?.markProviderNeedsReview({ providerId: "hh", errorCode: result.errorCode, entityId: result.flowRunId });
  }
  input.db?.recordProofPack({
    proofPack: result.proofPack,
    entityType: "provider_flow_run",
    entityId: result.flowRunId,
    actor: "worker-apply"
  });
  return result;
}
