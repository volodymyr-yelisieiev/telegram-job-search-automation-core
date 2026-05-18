import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ReleaseDocumentationPackFile {
  path: string;
  present: boolean;
  nonEmpty: boolean;
  bytes: number;
  sha256: string | null;
}

export interface ReleaseDocumentationPackGroup {
  id: string;
  title: string;
  requiredFiles: ReleaseDocumentationPackFile[];
  passed: boolean;
  blockers: string[];
}

export interface ReleaseDocumentationPackReport {
  schemaVersion: "release-documentation-pack/v1";
  generatedAt: string;
  baseDir: string;
  groups: ReleaseDocumentationPackGroup[];
  fileCount: number;
  missingFiles: string[];
  emptyFiles: string[];
  valid: boolean;
  blockers: string[];
}

const requiredGroups = [
  {
    id: "prd_and_roadmap",
    title: "PRD and roadmap",
    files: ["docs/prd/Telegram Job Search Automation v1.0.md", "docs/roadmap/Telegram Job Search Automation Roadmap v1.0.md"]
  },
  {
    id: "adrs",
    title: "Architecture decision records",
    files: [
      "docs/adr/README.md",
      "docs/adr/ADR-001-purpose-built-core.md",
      "docs/adr/ADR-002-deterministic-provider-flows.md",
      "docs/adr/ADR-003-llm-boundaries.md",
      "docs/adr/ADR-004-proof-bearing-actions.md",
      "docs/adr/ADR-005-provider-onboarding.md",
      "docs/adr/ADR-006-local-safe-first.md"
    ]
  },
  {
    id: "runbooks",
    title: "Critical incident runbooks",
    files: [
      "docs/runbooks/captcha-detected.md",
      "docs/runbooks/db-migration-rollback.md",
      "docs/runbooks/dedup-anomaly.md",
      "docs/runbooks/dlq-triage.md",
      "docs/runbooks/duplicate-application.md",
      "docs/runbooks/llm-schema-validation-spike.md",
      "docs/runbooks/outbound-reply-failure.md",
      "docs/runbooks/proof-missing.md",
      "docs/runbooks/provider-auth-expired.md",
      "docs/runbooks/provider-selector-update.md",
      "docs/runbooks/read-only-parse-spike.md",
      "docs/runbooks/stuck-queue.md",
      "docs/runbooks/telegram-webhook-failure.md"
    ]
  },
  {
    id: "provider_playbooks",
    title: "Provider playbooks",
    files: [
      "docs/provider-playbooks/fixture-providers.md",
      "docs/provider-playbooks/hh.md",
      "docs/provider-playbooks/robota.md",
      "docs/provider-playbooks/telegram.md",
      "docs/provider-playbooks/provider-scorecard-board.md",
      "docs/provider-playbooks/selector-fingerprint-maintenance.md",
      "docs/provider-playbooks/templates/provider-onboarding.md"
    ]
  },
  {
    id: "security_and_deployment",
    title: "Security, deployment, and operations",
    files: [
      "docs/security/security-and-privacy.md",
      "docs/deployment/deployment-and-rollback.md",
      "docs/deployment/release-gates.md",
      "docs/architecture/data-model.md",
      "docs/architecture/queues-and-workers.md",
      "docs/architecture/control-plane.md"
    ]
  },
  {
    id: "release_notes",
    title: "Release notes R0-R8 and post-GA",
    files: [
      "docs/releases/R0-baseline.md",
      "docs/releases/R1-profile-policy.md",
      "docs/releases/R2-read-only.md",
      "docs/releases/R3-dry-run.md",
      "docs/releases/R4-auto-apply.md",
      "docs/releases/R5-conversation.md",
      "docs/releases/R6-interview.md",
      "docs/releases/R7-production-readiness.md",
      "docs/releases/R8-ga.md",
      "docs/releases/GA-signoff-checklist.md",
      "docs/releases/post-ga-provider-scale.md"
    ]
  },
  {
    id: "verification_and_live_handoff",
    title: "Verification and live handoff",
    files: [
      "docs/verification/ROADMAP_COMPLIANCE_MATRIX.md",
      "docs/verification/PRD_COMPLIANCE_MATRIX.md",
      "docs/soak/7-day-soak-template.md",
      "docs/soak/final-7-day-soak-report.md",
      "docs/examples/release-evidence.example.json",
      "docs/examples/ga-signoff.example.json",
      "docs/examples/runtime-preflight.example.json",
      "docs/examples/live-secrets-probe.example.json",
      "docs/examples/live-canary-results.example.json",
      "docs/examples/live-provider-submit-proof.example.json",
      "docs/examples/live-calendar-smoke.example.json",
      "docs/examples/live-dispatch-proof.example.json",
      "docs/examples/live-7-day-soak.example.json"
    ]
  }
] as const;

export function buildReleaseDocumentationPack(input: { baseDir?: string; now?: Date } = {}): ReleaseDocumentationPackReport {
  const baseDir = input.baseDir ?? process.cwd();
  const groups = requiredGroups.map((group) => {
    const requiredFiles = group.files.map((path) => inspectFile(baseDir, path));
    const blockers = [
      ...requiredFiles.filter((file) => !file.present).map((file) => `missing:${file.path}`),
      ...requiredFiles.filter((file) => file.present && !file.nonEmpty).map((file) => `empty:${file.path}`)
    ];
    return {
      id: group.id,
      title: group.title,
      requiredFiles,
      passed: blockers.length === 0,
      blockers
    };
  });
  const missingFiles = groups.flatMap((group) => group.requiredFiles.filter((file) => !file.present).map((file) => file.path));
  const emptyFiles = groups.flatMap((group) => group.requiredFiles.filter((file) => file.present && !file.nonEmpty).map((file) => file.path));
  const blockers = groups.flatMap((group) => group.blockers.map((blocker) => `${group.id}:${blocker}`));
  return {
    schemaVersion: "release-documentation-pack/v1",
    generatedAt: (input.now ?? new Date()).toISOString(),
    baseDir,
    groups,
    fileCount: groups.reduce((count, group) => count + group.requiredFiles.length, 0),
    missingFiles,
    emptyFiles,
    valid: blockers.length === 0,
    blockers
  };
}

function inspectFile(baseDir: string, path: string): ReleaseDocumentationPackFile {
  const fullPath = join(baseDir, path);
  if (!existsSync(fullPath)) {
    return { path, present: false, nonEmpty: false, bytes: 0, sha256: null };
  }
  const stats = statSync(fullPath);
  if (!stats.isFile()) {
    return { path, present: false, nonEmpty: false, bytes: 0, sha256: null };
  }
  const content = readFileSync(fullPath);
  return {
    path,
    present: true,
    nonEmpty: content.toString("utf8").trim().length > 0,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildReleaseDocumentationPack();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RELEASE_DOCUMENTATION_PACK_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.RELEASE_DOCUMENTATION_PACK_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.RELEASE_DOCUMENTATION_PACK_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.valid) {
    process.exitCode = 1;
  }
}
