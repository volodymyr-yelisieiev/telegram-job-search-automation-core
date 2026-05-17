import { describe, expect, it } from "vitest";
import { loadConfig } from "@job-search/config";
import { InMemoryDatabase } from "@job-search/db";
import { createFixtureProviderRegistry } from "@job-search/providers";
import { buildServer } from "../../apps/api/src/server";

describe("API local pipeline", () => {
  it("boots healthcheck and runs fixture ingest without submitting applications", async () => {
    const config = loadConfig({ APP_MODE: "review_first", IRREVERSIBLE_ACTIONS_ENABLED: "false" });
    const db = new InMemoryDatabase();
    const server = await buildServer({ config, db, registry: createFixtureProviderRegistry() });

    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", irreversibleActionsEnabled: false });

    const unauthenticated = await server.inject({ method: "POST", url: "/ingest/run" });
    expect(unauthenticated.statusCode).toBe(401);

    const ingest = await server.inject({
      method: "POST",
      url: "/ingest/run",
      headers: { authorization: `Bearer ${config.api.token}` }
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json()).toMatchObject({ normalized: 4 });

    const applications = await server.inject({
      method: "GET",
      url: "/applications",
      headers: { authorization: `Bearer ${config.api.token}` }
    });
    expect(applications.json().every((application: { status: string }) => application.status !== "applied")).toBe(true);

    await server.close();
  });
});
