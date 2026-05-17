import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@job-search/config";
import { localDb, type InMemoryDatabase } from "@job-search/db";
import { renderDigest, renderJobCard, renderPipeline, renderProfile, renderStatus } from "@job-search/telegram-ui";
import { createLogger, MetricsRegistry } from "@job-search/observability";
import { createFixtureProviderRegistry, type ProviderRegistry } from "@job-search/providers";
import { runLocalPipeline } from "./runtime";

export interface ServerDependencies {
  config: RuntimeConfig;
  db?: InMemoryDatabase;
  registry?: ProviderRegistry;
}

export async function buildServer(deps: ServerDependencies) {
  const logger = createLogger("api");
  const metrics = new MetricsRegistry();
  const db = deps.db ?? localDb;
  const registry = deps.registry ?? createFixtureProviderRegistry();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: deps.config.api.corsOrigins });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }
    if (!isAuthorized(request, deps.config.api.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "control-plane-api",
    mode: deps.config.app.mode,
    irreversibleActionsEnabled: deps.config.app.irreversibleActionsEnabled
  }));

  app.get("/status", async () => db.status(deps.config.app.mode));

  app.get("/status/telegram", async () => renderStatus(db.status(deps.config.app.mode)));

  app.post("/ingest/run", async () => {
    const result = await runLocalPipeline({ db, registry, config: deps.config });
    metrics.increment("local_pipeline_runs_total", { status: "completed" });
    logger.info("local_pipeline_completed", result);
    return result;
  });

  app.get("/pipeline", async () => {
    const scores = [...db.jobScores.values()];
    const stats = {
      discovered: db.jobs.size,
      normalized: db.jobs.size,
      shortlisted: scores.filter((score) => score.decision === "shortlisted").length,
      rejected: scores.filter((score) => score.decision === "rejected").length,
      prepared: db.applications.size,
      applied: [...db.applications.values()].filter((application) => application.status === "applied").length,
      interviews: 0
    };
    return {
      stats,
      text: renderPipeline(stats)
    };
  });

  app.get("/providers", async () => {
    const health = await Promise.all(
      registry.list().map((provider) => provider.healthcheck({ now: new Date(), environment: deps.config.app.environment }))
    );
    for (const item of health) {
      db.updateProviderHealth(item);
    }
    return health;
  });

  app.get("/profiles", async () => ({
    active: db.candidateProfile,
    text: renderProfile(db.candidateProfile)
  }));

  app.get("/jobs", async () => [...db.jobs.values()]);

  app.get<{ Params: { id: string } }>("/job/:id", async (request, reply) => {
    const job = db.jobs.get(request.params.id);
    if (!job) {
      await reply.code(404).send({ error: "job_not_found" });
      return;
    }
    return {
      job,
      score: db.jobScores.get(job.id) ?? null,
      text: renderJobCard(job, db.jobScores.get(job.id) ?? null)
    };
  });

  app.get("/applications", async () => [...db.applications.values()]);
  app.get("/manual-review", async () => [...db.manualReviewItems.values()]);
  app.get("/audit", async () => db.auditEvents);
  app.get("/metrics", async () => metrics.snapshot());

  app.get("/responses", async () => ({
    responses: [...db.messageClassifications.values()],
    message: "Inbox sync is fixture-backed and available through worker-inbox."
  }));

  app.get("/interviews", async () => ({
    interviews: [...db.interviewEvents.values()],
    message: "No scheduled interviews in local-safe seed state."
  }));

  app.get("/digest", async () => {
    const pipeline = await app.inject({
      method: "GET",
      url: "/pipeline",
      headers: { authorization: `Bearer ${deps.config.api.token}` }
    });
    const pipelineBody = JSON.parse(pipeline.body) as { text: string };
    return renderDigest({
      responses: 0,
      manualReviewItems: db.manualReviewItems.size,
      interviews: 0,
      providerIssues: [...db.providerHealth.values()].filter((health) => health.status !== "stable").map((health) => health.providerId),
      pipelineStats: pipelineBody.text
    });
  });

  return app;
}

function isAuthorized(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) {
    return true;
  }
  const apiToken = request.headers["x-api-token"];
  return apiToken === token;
}
