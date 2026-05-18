import type { ProviderCapabilities } from "@job-search/domain";

export interface ProviderOnboardingInput {
  providerId: string;
  owner: string | null;
  capabilities: ProviderCapabilities;
  fixtureCount: number;
  selectorPackVersion: string | null;
  fingerprintCount: number;
  canaryPassed: boolean;
  dryRunSubmitBoundaryPassed: boolean;
  replayAvailable: boolean;
  manualFallbackAvailable: boolean;
  disableSwitchAvailable: boolean;
  providerPolicyReviewed: boolean;
  snippetReviewComplete: boolean;
}

export interface ProviderOnboardingChecklistItem {
  code: string;
  passed: boolean;
  requiredForStable: boolean;
  detail: string;
}

export interface ProviderOnboardingReport {
  providerId: string;
  canMarkStable: boolean;
  checklist: ProviderOnboardingChecklistItem[];
  scaffold: Array<{ path: string; purpose: string }>;
}

export function createProviderOnboardingChecklist(input: ProviderOnboardingInput): ProviderOnboardingReport {
  const checklist: ProviderOnboardingChecklistItem[] = [
    item("owner_assigned", Boolean(input.owner), true, "Provider has an accountable owner"),
    item("fixtures_present", input.fixtureCount >= 10 || (!input.capabilities.autoApply && input.fixtureCount > 0), true, "Fixture corpus exists"),
    item("selector_pack_present", !input.capabilities.browserRequired || Boolean(input.selectorPackVersion), true, "Selector pack exists when browser automation is required"),
    item("fingerprints_present", !input.capabilities.browserRequired || input.fingerprintCount > 0, true, "Page fingerprints exist when browser automation is required"),
    item("canary_passed", input.canaryPassed, true, "Provider canary passed"),
    item(
      "dry_run_boundary_passed",
      !input.capabilities.autoApply || input.dryRunSubmitBoundaryPassed,
      true,
      "Apply-capable provider reaches submit boundary in dry-run"
    ),
    item("replay_available", input.replayAvailable, true, "Replay diagnostics are available"),
    item("manual_fallback_available", input.manualFallbackAvailable, true, "Manual fallback path exists"),
    item("disable_switch_available", input.disableSwitchAvailable, true, "Provider can be degraded or disabled quickly"),
    item("no_captcha_bypass", input.capabilities.captchaExpected !== true, true, "Provider plan does not require CAPTCHA bypass"),
    item("provider_policy_reviewed", input.providerPolicyReviewed, true, "Provider policy/terms checklist is reviewed"),
    item("snippet_review_complete", input.snippetReviewComplete, true, "External snippet reuse is tracked and reviewed")
  ];
  return {
    providerId: input.providerId,
    canMarkStable: checklist.filter((candidate) => candidate.requiredForStable).every((candidate) => candidate.passed),
    checklist,
    scaffold: createProviderScaffoldPlan(input.providerId)
  };
}

export function createProviderScaffoldPlan(providerId: string): ProviderOnboardingReport["scaffold"] {
  return [
    { path: `packages/providers/src/${providerId}.ts`, purpose: "ProviderModule implementation" },
    { path: `packages/providers/src/fixtures/${providerId}.ts`, purpose: "Read-only fixture corpus" },
    { path: `packages/providers/src/${providerId}.test.ts`, purpose: "Provider contract and normalization tests" },
    { path: `docs/provider-playbooks/${providerId}.md`, purpose: "Provider onboarding playbook and release decision" },
    { path: `packages/providers/src/selector-packs/${providerId}.ts`, purpose: "Selector pack and page fingerprints when browserRequired=true" }
  ];
}

function item(code: string, passed: boolean, requiredForStable: boolean, detail: string): ProviderOnboardingChecklistItem {
  return { code, passed, requiredForStable, detail };
}
