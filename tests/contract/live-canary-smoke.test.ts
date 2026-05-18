import { describe, expect, it } from "vitest";
import { buildLiveCanarySmokeReport, parseLiveCanarySmokeTargets, type LiveCanarySmokeFetch } from "../../scripts/live-canary-smoke";

describe("live provider canary smoke", () => {
  it("does not call live endpoints without explicit confirmation", async () => {
    let calls = 0;
    const fetchImpl: LiveCanarySmokeFetch = async () => {
      calls += 1;
      throw new Error("should not call");
    };

    const report = await buildLiveCanarySmokeReport({
      targets: [{ providerId: "hh", url: "https://hh.example/jobs", expectedText: "Jobs" }],
      source: "production provider canary workflow 7",
      liveEvidenceAllowed: true,
      confirmLive: false,
      expectedProviderIds: ["hh"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(calls).toBe(0);
    expect(report.canaryApiCalled).toBe(false);
    expect(report.evidenceRecords).toEqual([]);
    expect(report.failures).toContain("live_canary_smoke_confirm_live_required");
    expect(JSON.stringify(report)).not.toContain("https://hh.example/jobs");
    expect(JSON.stringify(report)).not.toContain("Jobs");
  });

  it("runs HTTP and Telegram canaries and emits release evidence without leaking tokens or URLs", async () => {
    const calls: string[] = [];
    const fetchImpl: LiveCanarySmokeFetch = async (url) => {
      calls.push(url);
      if (url.includes("/bottelegram-token/getMe")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { id: 42, username: "job_bot" } }),
          text: async () => JSON.stringify({ ok: true })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "Current jobs and vacancies"
      };
    };

    const report = await buildLiveCanarySmokeReport({
      targets: [
        { providerId: "hh", url: "https://hh.example/jobs", expectedText: "vacancies" },
        { providerId: "robota", url: "https://robota.example/jobs", expectedText: "jobs" },
        { providerId: "telegram", kind: "telegram_get_me" }
      ],
      source: "production provider canary workflow 7",
      liveEvidenceAllowed: true,
      confirmLive: true,
      expectedProviderIds: ["hh", "robota", "telegram"],
      telegramBotToken: "telegram-token",
      telegramApiBaseUrl: "https://api.telegram.example",
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(calls).toHaveLength(3);
    expect(report.failures).toEqual([]);
    expect(report.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
    expect(report.evidenceRecords).toEqual([
      expect.objectContaining({ evidenceType: "live_canary_passed", providerId: "hh", expiresAt: "2026-05-19T00:00:00.000Z" }),
      expect.objectContaining({ evidenceType: "live_canary_passed", providerId: "robota", expiresAt: "2026-05-19T00:00:00.000Z" }),
      expect.objectContaining({ evidenceType: "live_canary_passed", providerId: "telegram", expiresAt: "2026-05-19T00:00:00.000Z" })
    ]);
    expect(JSON.stringify(report)).not.toContain("https://hh.example/jobs");
    expect(JSON.stringify(report)).not.toContain("https://robota.example/jobs");
    expect(JSON.stringify(report)).not.toContain("telegram-token");
    expect(JSON.stringify(report)).not.toContain("vacancies");
  });

  it("fails missing expected text and does not emit evidence for the failed provider", async () => {
    const fetchImpl: LiveCanarySmokeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "maintenance page"
    });

    const report = await buildLiveCanarySmokeReport({
      targets: [{ providerId: "hh", url: "https://hh.example/jobs", expectedText: "vacancies" }],
      source: "production provider canary workflow 7",
      liveEvidenceAllowed: true,
      confirmLive: true,
      expectedProviderIds: ["hh"],
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(report.results[0]).toMatchObject({
      providerId: "hh",
      status: "failed",
      failures: ["expected_text_missing"]
    });
    expect(report.evidenceRecords).toEqual([]);
    expect(report.failures).toContain("live_canary_failed:hh");
  });

  it("parses JSON targets for command-line use", () => {
    expect(
      parseLiveCanarySmokeTargets(
        JSON.stringify([
          { providerId: "hh", url: "https://hh.example/jobs", expectedText: "jobs", forbiddenText: ["captcha"], expectedStatus: 200 },
          { providerId: "telegram", kind: "telegram_get_me", token: "token" }
        ])
      )
    ).toEqual([
      { providerId: "hh", kind: "http", url: "https://hh.example/jobs", expectedText: "jobs", forbiddenText: ["captcha"], expectedStatus: 200 },
      { providerId: "telegram", kind: "telegram_get_me", token: "token" }
    ]);
  });
});
