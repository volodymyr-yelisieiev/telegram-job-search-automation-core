import type { InMemoryDatabase } from "@job-search/db";
import { renderDigest, renderPipeline } from "@job-search/telegram-ui";

export function runDigestWorker(db: InMemoryDatabase): string {
  const scores = [...db.jobScores.values()];
  return renderDigest({
    responses: 0,
    manualReviewItems: db.manualReviewItems.size,
    interviews: 0,
    providerIssues: [...db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
    pipelineStats: renderPipeline({
      discovered: db.jobs.size,
      normalized: db.jobs.size,
      shortlisted: scores.filter((score) => score.decision === "shortlisted").length,
      rejected: scores.filter((score) => score.decision === "rejected").length,
      prepared: db.applications.size,
      applied: [...db.applications.values()].filter((application) => application.status === "applied").length,
      interviews: 0
    })
  });
}
