import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLiveCompletionPlan } from "./live-completion-plan";
import { runQueueResilienceCheck, type QueueResilienceReport } from "./queue-resilience-check";
import { buildReleaseDocumentationPack } from "./release-documentation-pack";
import { buildRoadmapComplianceReport } from "./roadmap-compliance-check";

const expectedActionGroupIds = ["runtime_preflight", "release_evidence", "ga_signoff", "final_acceptance_audit"] as const;

export interface RoadmapLocalGatesReport {
  schemaVersion: "roadmap-local-gates/v1";
  generatedAt: string;
  passed: boolean;
  roadmapCompliance: {
    passed: boolean;
    roadmapSprintCount: number;
    matrixSprintCount: number;
    boardSprintCount: number;
    failures: string[];
  };
  documentationPack: {
    valid: boolean;
    fileCount: number;
    missingFileCount: number;
    emptyFileCount: number;
    blockers: string[];
  };
  liveHandoff: {
    generated: boolean;
    auditComplete: boolean;
    status: "complete" | "pending_external_evidence";
    missingArtifactCount: number;
    missingCheckCount: number;
    actionGroupIds: string[];
    missingActionGroupIds: string[];
  };
  queueResilience: QueueResilienceReport;
  failures: string[];
}

export async function buildRoadmapLocalGatesReport(input: {
  baseDir?: string;
  roadmapPath?: string;
  roadmapMatrixPath?: string;
  roadmapBoardPath?: string;
  releaseEvidencePath?: string;
  gaSignoffPath?: string;
  runtimePreflightPath?: string;
  acceptanceIterations?: number;
  env?: NodeJS.ProcessEnv;
  queueResilienceRedisUrl?: string;
  now?: Date;
} = {}): Promise<RoadmapLocalGatesReport> {
  const now = input.now ?? new Date();
  const roadmapCompliance = buildRoadmapComplianceReport({
    ...(input.roadmapPath ? { roadmapPath: input.roadmapPath } : {}),
    ...(input.roadmapMatrixPath ? { matrixPath: input.roadmapMatrixPath } : {}),
    ...(input.roadmapBoardPath ? { boardPath: input.roadmapBoardPath } : {})
  });
  const documentationPack = buildReleaseDocumentationPack({
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
    now
  });
  const liveHandoff = await buildLiveCompletionPlan({
    ...(input.releaseEvidencePath ? { releaseEvidencePath: input.releaseEvidencePath } : {}),
    ...(input.gaSignoffPath ? { gaSignoffPath: input.gaSignoffPath } : {}),
    ...(input.runtimePreflightPath ? { runtimePreflightPath: input.runtimePreflightPath } : {}),
    acceptanceIterations: input.acceptanceIterations ?? 1,
    env: input.env ?? process.env,
    now
  });
  const queueResilienceRedisUrl = input.queueResilienceRedisUrl ?? input.env?.QUEUE_RESILIENCE_REDIS_URL;
  const queueResilience = await runQueueResilienceCheck({
    ...(queueResilienceRedisUrl ? { redisUrl: queueResilienceRedisUrl } : {})
  });
  const actionGroupIds = liveHandoff.actionGroups.map((group) => group.id);
  const missingActionGroupIds = expectedActionGroupIds.filter((id) => !actionGroupIds.includes(id));
  const failures = [
    ...roadmapCompliance.failures.map((failure) => `roadmap_compliance:${failure}`),
    ...documentationPack.blockers.map((blocker) => `documentation_pack:${blocker}`),
    ...missingActionGroupIds.map((id) => `live_handoff_missing_action_group:${id}`),
    ...queueResilience.failures.map((failure) => `queue_resilience:${failure}`)
  ];

  return {
    schemaVersion: "roadmap-local-gates/v1",
    generatedAt: now.toISOString(),
    passed: failures.length === 0,
    roadmapCompliance: {
      passed: roadmapCompliance.passed,
      roadmapSprintCount: roadmapCompliance.roadmapSprintCount,
      matrixSprintCount: roadmapCompliance.matrixSprintCount,
      boardSprintCount: roadmapCompliance.boardSprintCount,
      failures: roadmapCompliance.failures
    },
    documentationPack: {
      valid: documentationPack.valid,
      fileCount: documentationPack.fileCount,
      missingFileCount: documentationPack.missingFiles.length,
      emptyFileCount: documentationPack.emptyFiles.length,
      blockers: documentationPack.blockers
    },
    liveHandoff: {
      generated: true,
      auditComplete: liveHandoff.auditComplete,
      status: liveHandoff.auditComplete ? "complete" : "pending_external_evidence",
      missingArtifactCount: liveHandoff.missingArtifacts.length,
      missingCheckCount: liveHandoff.missingChecks.length,
      actionGroupIds,
      missingActionGroupIds
    },
    queueResilience,
    failures
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildRoadmapLocalGatesReport({
    ...(process.env.RELEASE_EVIDENCE_PATH ? { releaseEvidencePath: process.env.RELEASE_EVIDENCE_PATH } : {}),
    ...(process.env.GA_SIGNOFF_PATH ? { gaSignoffPath: process.env.GA_SIGNOFF_PATH } : {}),
    ...(process.env.RUNTIME_PREFLIGHT_PATH ? { runtimePreflightPath: process.env.RUNTIME_PREFLIGHT_PATH } : {}),
    ...(process.env.ACCEPTANCE_ITERATIONS ? { acceptanceIterations: Number(process.env.ACCEPTANCE_ITERATIONS) } : {}),
    ...(process.env.QUEUE_RESILIENCE_REDIS_URL ? { queueResilienceRedisUrl: process.env.QUEUE_RESILIENCE_REDIS_URL } : {})
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.ROADMAP_LOCAL_GATES_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.ROADMAP_LOCAL_GATES_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.ROADMAP_LOCAL_GATES_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}
