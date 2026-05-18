import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { buildCalendarEvidenceReport, isLiveEvidenceSource } from "./calendar-evidence";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface GoogleCalendarSmokeReport {
  schemaVersion: "google-calendar-smoke/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  calendarApiCalled: boolean;
  request: {
    calendarProvider: "google-calendar";
    calendarIdHash: string | null;
    timeMin: string | null;
    timeMax: string | null;
    eventSummaryHash: string | null;
  };
  checks: {
    readCheck: boolean;
    conflictCheck: boolean;
    writeCheck: boolean;
    cleanupCheck: boolean;
  };
  google: {
    insertedEventIdHash: string | null;
    busyWindowCount: number | null;
    deleted: boolean;
  };
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export type GoogleCalendarSmokeFetch = (
  url: string,
  init: {
    method: "POST" | "DELETE";
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export async function buildGoogleCalendarSmokeReport(input: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  eventSummary?: string;
  ttlHours?: number;
  now?: Date;
  fetchImpl?: GoogleCalendarSmokeFetch;
  apiBaseUrl?: string;
}): Promise<GoogleCalendarSmokeReport> {
  const now = input.now ?? new Date();
  const source = input.source.trim();
  const accessToken = input.accessToken.trim();
  const calendarId = input.calendarId.trim();
  const eventSummary = (input.eventSummary ?? "Telegram Job Search Automation calendar smoke").trim();
  const request = {
    calendarProvider: "google-calendar" as const,
    calendarIdHash: calendarId.length > 0 ? stableHash(calendarId) : null,
    timeMin: nonEmptyString(input.timeMin),
    timeMax: nonEmptyString(input.timeMax),
    eventSummaryHash: eventSummary.length > 0 ? stableHash(eventSummary) : null
  };
  const failures = validateInput({
    accessToken,
    calendarId,
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    eventSummary
  });
  if (failures.length > 0) {
    return emptyReport({ now, source, liveEvidenceAllowed: input.liveEvidenceAllowed, confirmLive: input.confirmLive, request, failures });
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      request,
      failures: ["fetch_unavailable"]
    });
  }

  const apiBaseUrl = input.apiBaseUrl ?? "https://www.googleapis.com/calendar/v3";
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const initialBusy = await freeBusy({ fetchImpl, apiBaseUrl, headers, calendarId, timeMin: input.timeMin, timeMax: input.timeMax });
  if (!initialBusy.ok) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      request,
      calendarApiCalled: true,
      failures: initialBusy.failures
    });
  }

  const inserted = await insertEvent({ fetchImpl, apiBaseUrl, headers, calendarId, timeMin: input.timeMin, timeMax: input.timeMax, eventSummary });
  if (!inserted.ok) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      request,
      calendarApiCalled: true,
      failures: inserted.failures
    });
  }

  const conflictBusy = await freeBusy({ fetchImpl, apiBaseUrl, headers, calendarId, timeMin: input.timeMin, timeMax: input.timeMax });
  const deleted = await deleteEvent({ fetchImpl, apiBaseUrl, headers, calendarId, eventId: inserted.eventId });
  const combinedFailures = [
    ...(conflictBusy.ok ? [] : conflictBusy.failures),
    ...(deleted.ok ? [] : deleted.failures),
    ...(conflictBusy.ok && conflictBusy.busyWindowCount < 1 ? ["calendar_conflict_check_missing_busy_window"] : [])
  ];
  const checks = {
    readCheck: true,
    conflictCheck: conflictBusy.ok && conflictBusy.busyWindowCount > 0,
    writeCheck: inserted.ok && deleted.ok,
    cleanupCheck: deleted.ok
  };
  const evidence = buildCalendarEvidenceReport({
    record: {
      calendarProvider: "google-calendar",
      checkedAt: now.toISOString(),
      readCheck: checks.readCheck,
      conflictCheck: checks.conflictCheck,
      writeCheck: checks.writeCheck
    },
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    ...(input.ttlHours ? { ttlHours: input.ttlHours } : {}),
    now
  });

  return {
    schemaVersion: "google-calendar-smoke/v1",
    generatedAt: now.toISOString(),
    source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    calendarApiCalled: true,
    request,
    checks,
    google: {
      insertedEventIdHash: stableHash(inserted.eventId),
      busyWindowCount: conflictBusy.ok ? conflictBusy.busyWindowCount : null,
      deleted: deleted.ok
    },
    evidenceRecord: combinedFailures.length === 0 ? evidence.evidenceRecord : null,
    failures: [...combinedFailures, ...evidence.failures]
  };
}

function validateInput(input: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  eventSummary: string;
}): string[] {
  const failures: string[] = [];
  if (!input.confirmLive) {
    failures.push("google_calendar_smoke_confirm_live_required");
  }
  if (!input.liveEvidenceAllowed) {
    failures.push("calendar_evidence_assert_live_required");
  }
  if (!isLiveEvidenceSource(input.source)) {
    failures.push("live_calendar_source_required");
  }
  if (input.accessToken.length === 0) {
    failures.push("google_calendar_access_token_required");
  }
  if (input.calendarId.length === 0) {
    failures.push("google_calendar_id_required");
  }
  if (!isIsoDateString(input.timeMin)) {
    failures.push("calendar_smoke_time_min_required");
  }
  if (!isIsoDateString(input.timeMax)) {
    failures.push("calendar_smoke_time_max_required");
  }
  if (isIsoDateString(input.timeMin) && isIsoDateString(input.timeMax) && Date.parse(input.timeMax) <= Date.parse(input.timeMin)) {
    failures.push("calendar_smoke_time_max_must_follow_time_min");
  }
  if (input.eventSummary.length === 0) {
    failures.push("calendar_smoke_event_summary_required");
  }
  return failures;
}

async function freeBusy(input: {
  fetchImpl: GoogleCalendarSmokeFetch;
  apiBaseUrl: string;
  headers: Record<string, string>;
  calendarId: string;
  timeMin: string;
  timeMax: string;
}): Promise<{ ok: true; busyWindowCount: number } | { ok: false; failures: string[] }> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}/freeBusy`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      items: [{ id: input.calendarId }]
    })
  });
  if (!response.ok) {
    return { ok: false, failures: [`google_calendar_freebusy_failed:${response.status}`] };
  }
  return parseFreeBusyResponse(await response.json(), input.calendarId);
}

async function insertEvent(input: {
  fetchImpl: GoogleCalendarSmokeFetch;
  apiBaseUrl: string;
  headers: Record<string, string>;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  eventSummary: string;
}): Promise<{ ok: true; eventId: string } | { ok: false; failures: string[] }> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}/calendars/${encodeURIComponent(input.calendarId)}/events`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      summary: input.eventSummary,
      start: { dateTime: input.timeMin },
      end: { dateTime: input.timeMax },
      transparency: "opaque"
    })
  });
  if (!response.ok) {
    return { ok: false, failures: [`google_calendar_insert_failed:${response.status}`] };
  }
  return parseInsertResponse(await response.json());
}

async function deleteEvent(input: {
  fetchImpl: GoogleCalendarSmokeFetch;
  apiBaseUrl: string;
  headers: Record<string, string>;
  calendarId: string;
  eventId: string;
}): Promise<{ ok: true } | { ok: false; failures: string[] }> {
  const response = await input.fetchImpl(
    `${input.apiBaseUrl}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    {
      method: "DELETE",
      headers: input.headers
    }
  );
  return response.ok ? { ok: true } : { ok: false, failures: [`google_calendar_delete_failed:${response.status}`] };
}

function parseFreeBusyResponse(body: unknown, calendarId: string): { ok: true; busyWindowCount: number } | { ok: false; failures: string[] } {
  if (!body || typeof body !== "object") {
    return { ok: false, failures: ["google_calendar_freebusy_response_not_object"] };
  }
  const calendars = (body as Record<string, unknown>).calendars;
  if (!calendars || typeof calendars !== "object") {
    return { ok: false, failures: ["google_calendar_freebusy_calendars_missing"] };
  }
  const calendar = (calendars as Record<string, unknown>)[calendarId];
  if (!calendar || typeof calendar !== "object") {
    return { ok: false, failures: ["google_calendar_freebusy_calendar_missing"] };
  }
  const calendarRecord = calendar as Record<string, unknown>;
  if (Array.isArray(calendarRecord.errors) && calendarRecord.errors.length > 0) {
    return { ok: false, failures: ["google_calendar_freebusy_calendar_errors"] };
  }
  if (!Array.isArray(calendarRecord.busy)) {
    return { ok: false, failures: ["google_calendar_freebusy_busy_missing"] };
  }
  return { ok: true, busyWindowCount: calendarRecord.busy.length };
}

function parseInsertResponse(body: unknown): { ok: true; eventId: string } | { ok: false; failures: string[] } {
  if (!body || typeof body !== "object") {
    return { ok: false, failures: ["google_calendar_insert_response_not_object"] };
  }
  const eventId = nonEmptyString((body as Record<string, unknown>).id);
  return eventId ? { ok: true, eventId } : { ok: false, failures: ["google_calendar_insert_event_id_missing"] };
}

function emptyReport(input: {
  now: Date;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  request: GoogleCalendarSmokeReport["request"];
  failures: string[];
  calendarApiCalled?: boolean;
}): GoogleCalendarSmokeReport {
  return {
    schemaVersion: "google-calendar-smoke/v1",
    generatedAt: input.now.toISOString(),
    source: input.source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    calendarApiCalled: input.calendarApiCalled ?? false,
    request: input.request,
    checks: {
      readCheck: false,
      conflictCheck: false,
      writeCheck: false,
      cleanupCheck: false
    },
    google: {
      insertedEventIdHash: null,
      busyWindowCount: null,
      deleted: false
    },
    evidenceRecord: null,
    failures: input.failures
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isIsoDateString(value: string): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && value.includes("T");
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildGoogleCalendarSmokeReport({
    accessToken: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ?? "",
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "",
    timeMin: process.env.GOOGLE_CALENDAR_SMOKE_TIME_MIN ?? "",
    timeMax: process.env.GOOGLE_CALENDAR_SMOKE_TIME_MAX ?? "",
    source: process.env.GOOGLE_CALENDAR_SMOKE_SOURCE ?? process.env.CALENDAR_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.CALENDAR_EVIDENCE_ASSERT_LIVE === "true",
    confirmLive: process.env.GOOGLE_CALENDAR_SMOKE_CONFIRM_LIVE === "true",
    ...(process.env.GOOGLE_CALENDAR_SMOKE_EVENT_SUMMARY ? { eventSummary: process.env.GOOGLE_CALENDAR_SMOKE_EVENT_SUMMARY } : {}),
    ...(process.env.CALENDAR_EVIDENCE_TTL_HOURS ? { ttlHours: parsePositiveNumber(process.env.CALENDAR_EVIDENCE_TTL_HOURS) } : {})
  });
  if (process.env.CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when CALENDAR_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append Google Calendar evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.env.GOOGLE_CALENDAR_SMOKE_OUTPUT_PATH ?? process.env.CALENDAR_EVIDENCE_OUTPUT_PATH;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}
