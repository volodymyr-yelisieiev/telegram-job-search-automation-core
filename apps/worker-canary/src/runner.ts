import { CanaryRunner } from "@job-search/automation";
import type { InMemoryDatabase } from "@job-search/db";
import type { ProviderRegistry } from "@job-search/providers";
import { pageFingerprints, selectorPacks } from "@job-search/providers";

export async function runCanaryWorker(input: {
  registry: ProviderRegistry;
  canary?: CanaryRunner;
  db?: InMemoryDatabase;
}): Promise<Array<{ providerId: string; status: "passed" | "failed"; checks: string[]; failures: string[] }>> {
  const canary = input.canary ?? new CanaryRunner();
  const results = [];
  for (const provider of input.registry.list()) {
    const canaryInput: { selectorPack?: { selectors: Record<string, unknown> }; fingerprints?: unknown[] } = {};
    const selectorPack = selectorPacks[provider.providerId];
    const fingerprints = pageFingerprints[provider.providerId];
    if (selectorPack) {
      canaryInput.selectorPack = selectorPack;
    }
    if (fingerprints) {
      canaryInput.fingerprints = fingerprints;
    }
    const result = await canary.runProviderCanary(provider.providerId, canaryInput);
    input.db?.recordCanaryRun(result);
    results.push(result);
  }
  return results;
}
