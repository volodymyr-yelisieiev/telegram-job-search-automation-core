import { describe, expect, it } from "vitest";
import { stableHash } from "@job-search/domain";
import { buildGoogleCalendarSmokeReport, type GoogleCalendarSmokeFetch } from "../../scripts/google-calendar-smoke";

describe("Google Calendar smoke evidence", () => {
  it("does not call Google Calendar without explicit live confirmation", async () => {
    let calls = 0;
    const fetchImpl: GoogleCalendarSmokeFetch = async () => {
      calls += 1;
      throw new Error("should not call");
    };

    const report = await buildGoogleCalendarSmokeReport({
      accessToken: "ya29.secret-token",
      calendarId: "primary@example.com",
      timeMin: "2026-05-20T08:00:00.000Z",
      timeMax: "2026-05-20T08:30:00.000Z",
      source: "production calendar smoke workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: false,
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(calls).toBe(0);
    expect(report.calendarApiCalled).toBe(false);
    expect(report.evidenceRecord).toBeNull();
    expect(report.failures).toContain("google_calendar_smoke_confirm_live_required");
    expect(JSON.stringify(report)).not.toContain("ya29.secret-token");
    expect(JSON.stringify(report)).not.toContain("primary@example.com");
  });

  it("reads, writes, verifies conflict, cleans up, and emits calendar evidence", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl: GoogleCalendarSmokeFetch = async (url, init) => {
      calls.push({ url, method: init.method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      if (url.endsWith("/freeBusy") && calls.filter((call) => call.url.endsWith("/freeBusy")).length === 1) {
        return okJson({ calendars: { "primary@example.com": { busy: [] } } });
      }
      if (url.endsWith("/events")) {
        return okJson({ id: "event-123" });
      }
      if (url.endsWith("/freeBusy")) {
        return okJson({ calendars: { "primary@example.com": { busy: [{ start: "2026-05-20T08:00:00.000Z", end: "2026-05-20T08:30:00.000Z" }] } } });
      }
      if (url.endsWith("/events/event-123")) {
        return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };

    const report = await buildGoogleCalendarSmokeReport({
      accessToken: "ya29.secret-token",
      calendarId: "primary@example.com",
      timeMin: "2026-05-20T08:00:00.000Z",
      timeMax: "2026-05-20T08:30:00.000Z",
      source: "production calendar smoke workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: true,
      eventSummary: "Telegram Job Search smoke",
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(report).toMatchObject({
      calendarApiCalled: true,
      checks: {
        readCheck: true,
        conflictCheck: true,
        writeCheck: true,
        cleanupCheck: true
      },
      google: {
        insertedEventIdHash: stableHash("event-123"),
        busyWindowCount: 1,
        deleted: true
      },
      evidenceRecord: {
        evidenceType: "calendar_integration_ready",
        status: "passed",
        expiresAt: "2026-05-19T00:00:00.000Z",
        metadata: {
          calendarProvider: "google-calendar",
          checkedAt: "2026-05-18T00:00:00.000Z",
          readCheck: true,
          conflictCheck: true,
          writeCheck: true
        }
      },
      failures: []
    });
    expect(JSON.stringify(report)).not.toContain("ya29.secret-token");
    expect(JSON.stringify(report)).not.toContain("primary@example.com");
    expect(JSON.stringify(report)).not.toContain("event-123");
    expect(JSON.stringify(report)).not.toContain("Telegram Job Search smoke");
  });

  it("does not emit release evidence when cleanup fails", async () => {
    const fetchImpl: GoogleCalendarSmokeFetch = async (url, init) => {
      if (url.endsWith("/freeBusy") && init.method === "POST") {
        return okJson({ calendars: { "primary@example.com": { busy: [{ start: "2026-05-20T08:00:00.000Z", end: "2026-05-20T08:30:00.000Z" }] } } });
      }
      if (url.endsWith("/events") && init.method === "POST") {
        return okJson({ id: "event-123" });
      }
      if (url.endsWith("/events/event-123") && init.method === "DELETE") {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "delete failed" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };

    const report = await buildGoogleCalendarSmokeReport({
      accessToken: "ya29.secret-token",
      calendarId: "primary@example.com",
      timeMin: "2026-05-20T08:00:00.000Z",
      timeMax: "2026-05-20T08:30:00.000Z",
      source: "production calendar smoke workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: true,
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(report.checks.cleanupCheck).toBe(false);
    expect(report.evidenceRecord).toBeNull();
    expect(report.failures).toContain("google_calendar_delete_failed:500");
  });
});

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
