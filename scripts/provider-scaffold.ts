import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProviderScaffoldReport {
  providerId: string;
  root: string;
  files: string[];
  contractTestsIncluded: boolean;
  placeholderPlaybookIncluded: boolean;
}

export function scaffoldProvider(input: { providerId: string; root?: string; force?: boolean }): ProviderScaffoldReport {
  const providerId = normalizeProviderId(input.providerId);
  const root = input.root ?? `packages/providers/generated/${providerId}`;
  const files = [
    join(root, "provider.ts"),
    join(root, "selector-pack.ts"),
    join(root, "fingerprints.ts"),
    join(root, "fixtures", `${providerId}.fixture.json`),
    join(root, `${providerId}.contract.test.ts`),
    join(root, `${providerId}.playbook.md`)
  ];
  if (!input.force) {
    const existingFiles = files.filter((file) => existsSync(file));
    if (existingFiles.length > 0) {
      throw new Error(`Provider scaffold target already exists: ${existingFiles.join(", ")}. Pass force: true to overwrite.`);
    }
  }
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(
    files[0]!,
    `import type { ProviderModule } from "@job-search/domain";\n\nexport function create${pascal(providerId)}Provider(): ProviderModule {\n  throw new Error("${providerId} provider scaffold requires implementation");\n}\n`
  );
  writeFileSync(files[1]!, `export const ${camel(providerId)}SelectorPack = { providerId: "${providerId}", version: "draft", selectors: {} };\n`);
  writeFileSync(files[2]!, `export const ${camel(providerId)}PageFingerprints = [];\n`);
  writeFileSync(files[3]!, JSON.stringify({ providerId, cases: [] }, null, 2));
  writeFileSync(
    files[4]!,
    `import { describe, it, expect } from "vitest";\nimport { normalizedJobSchema, rawJobPayloadSchema, type ProviderModule } from "@job-search/domain";\nimport { create${pascal(providerId)}Provider } from "./provider";\n\ndescribe("${providerId} provider contract", () => {\n  it("implements the ProviderModule read-only contract", async () => {\n    const provider = create${pascal(providerId)}Provider() as ProviderModule;\n    expect(provider.providerId).toBe("${providerId}");\n    expect(provider.capabilities.jobDiscovery).toBe(true);\n    const health = await provider.healthcheck({ now: new Date("2026-05-18T00:00:00.000Z"), environment: "local" });\n    expect(["stable", "degraded", "read_only", "apply_disabled", "blocked", "needs_review", "deprecated"]).toContain(health.status);\n    const plan = await provider.compileSearchPlan({ searchProfileId: "contract", candidateProfileId: "profile", strategy: "balanced", providers: { "${providerId}": { enabled: true, queries: ["backend"], filters: {}, sort: "newest", maxPagesPerRun: 1, maxJobsPerRun: 1 } } });\n    const refs = await provider.discoverJobs(plan);\n    expect(Array.isArray(refs)).toBe(true);\n    if (refs[0]) {\n      const raw = await provider.fetchJob(refs[0]);\n      expect(rawJobPayloadSchema.safeParse(raw).success).toBe(true);\n      const normalized = await provider.normalizeJob(raw);\n      expect(normalizedJobSchema.safeParse(normalized).success).toBe(true);\n    }\n  });\n});\n`
  );
  writeFileSync(
    files[5]!,
    `# ${providerId} Provider Playbook\n\nStatus: scaffolded.\n\nRequired gates: policy review, read-only fixtures, selector pack, fingerprints, dry-run, canary, proof, review-first rollout, controlled automation decision.\n`
  );
  return {
    providerId,
    root,
    files,
    contractTestsIncluded: files.some((file) => file.endsWith(".contract.test.ts")),
    placeholderPlaybookIncluded: files.some((file) => file.endsWith(".playbook.md"))
  };
}

function normalizeProviderId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  if (!normalized) {
    throw new Error("providerId is required");
  }
  return normalized;
}

function camel(value: string): string {
  return value.replace(/[-_]+([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function pascal(value: string): string {
  const cased = camel(value);
  return `${cased.charAt(0).toUpperCase()}${cased.slice(1)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const providerId = process.argv[2];
  if (!providerId) {
    throw new Error("Usage: pnpm provider:scaffold <provider-id>");
  }
  const report = scaffoldProvider({
    providerId,
    ...(process.env.PROVIDER_SCAFFOLD_ROOT ? { root: process.env.PROVIDER_SCAFFOLD_ROOT } : {})
  });
  console.log(JSON.stringify(report, null, 2));
}
