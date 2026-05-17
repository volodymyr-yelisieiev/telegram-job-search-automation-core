import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@job-search/db";

describe("Postgres migration verification", () => {
  it("runs migrations and exposes required indexes when Docker Postgres is available", async () => {
    const pool = createPool(process.env.DATABASE_URL ?? "postgres://job_search:job_search@127.0.0.1:5432/job_search");
    try {
      await pool.query("SELECT 1");
    } catch {
      await pool.end();
      console.warn("Skipping Postgres migration verification because DATABASE_URL is unavailable");
      return;
    }

    try {
      await runMigrations(pool);
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      const indexes = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(["normalized_jobs", "dedup_jobs", "applications", "audit_logs", "manual_review_items"])
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining(["dedup_jobs_provider_job_key_uidx", "dedup_jobs_canonical_url_key_uidx", "applications_idempotency_key_uidx"])
      );
    } finally {
      await pool.end();
    }
  });
});
