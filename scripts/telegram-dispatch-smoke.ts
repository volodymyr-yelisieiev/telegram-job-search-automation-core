import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash, type ReleaseEvidenceRecord } from "@job-search/domain";
import { buildOutboundDispatchEvidenceReport, isLiveEvidenceSource, type OutboundDispatchEvidenceInput } from "./outbound-evidence";
import { upsertReleaseEvidenceRecords } from "./secret-store-probe";

export interface TelegramDispatchSmokeReport {
  schemaVersion: "telegram-dispatch-smoke/v1";
  generatedAt: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  telegramApiCalled: boolean;
  request: {
    chatIdHash: string | null;
    textHash: string | null;
    textLength: number;
    idempotencyKeyHash: string | null;
  };
  telegram: {
    ok: boolean;
    status: number | null;
    messageIdHash: string | null;
    deliveredAt: string | null;
  };
  proof: OutboundDispatchEvidenceInput | null;
  evidenceRecord: ReleaseEvidenceRecord | null;
  failures: string[];
}

export type TelegramDispatchFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export async function buildTelegramDispatchSmokeReport(input: {
  token: string;
  chatId: string;
  text: string;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  idempotencyKey?: string;
  ttlHours?: number;
  now?: Date;
  fetchImpl?: TelegramDispatchFetch;
  apiBaseUrl?: string;
}): Promise<TelegramDispatchSmokeReport> {
  const now = input.now ?? new Date();
  const source = input.source.trim();
  const token = input.token.trim();
  const chatId = input.chatId.trim();
  const text = input.text.trim();
  const textHash = text.length > 0 ? stableHash(text) : null;
  const idempotencyKey = input.idempotencyKey ?? (textHash ? `telegram-dispatch:${stableHash(`${chatId}:${textHash}`)}` : "");
  const request = {
    chatIdHash: chatId.length > 0 ? stableHash(chatId) : null,
    textHash,
    textLength: text.length,
    idempotencyKeyHash: idempotencyKey.length > 0 ? stableHash(idempotencyKey) : null
  };
  const failures: string[] = [];

  if (!input.confirmLive) {
    failures.push("telegram_dispatch_confirm_live_required");
  }
  if (!input.liveEvidenceAllowed) {
    failures.push("outbound_dispatch_evidence_assert_live_required");
  }
  if (!isLiveEvidenceSource(source)) {
    failures.push("live_dispatch_source_required");
  }
  if (token.length === 0) {
    failures.push("telegram_bot_token_required");
  }
  if (chatId.length === 0) {
    failures.push("telegram_chat_id_required");
  }
  if (text.length === 0) {
    failures.push("telegram_text_required");
  }

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

  let responseStatus: number | null = null;
  try {
    const response = await fetchImpl(`${input.apiBaseUrl ?? "https://api.telegram.org"}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });
    responseStatus = response.status;
    if (!response.ok) {
      return emptyReport({
        now,
        source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        confirmLive: input.confirmLive,
        request,
        telegramApiCalled: true,
        telegramStatus: responseStatus,
        failures: [`telegram_send_failed:${response.status}`]
      });
    }

    const body = await response.json();
    const telegramResult = parseTelegramSendMessageResult(body);
    if (!telegramResult.ok) {
      return emptyReport({
        now,
        source,
        liveEvidenceAllowed: input.liveEvidenceAllowed,
        confirmLive: input.confirmLive,
        request,
        telegramApiCalled: true,
        telegramStatus: responseStatus,
        failures: telegramResult.failures
      });
    }

    const deliveredAt = telegramResult.date ? new Date(telegramResult.date * 1000).toISOString() : now.toISOString();
    const proof: OutboundDispatchEvidenceInput = {
      proofId: `telegram-dispatch-${stableHash(`${idempotencyKey}:${telegramResult.messageId}:${deliveredAt}`)}`,
      transport: "telegram",
      status: "sent",
      idempotencyKeyHash: stableHash(idempotencyKey),
      textHash: textHash!,
      deliveredAt
    };
    const evidence = buildOutboundDispatchEvidenceReport({
      proof,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
      now
    });
    return {
      schemaVersion: "telegram-dispatch-smoke/v1",
      generatedAt: now.toISOString(),
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      telegramApiCalled: true,
      request,
      telegram: {
        ok: true,
        status: responseStatus,
        messageIdHash: stableHash(String(telegramResult.messageId)),
        deliveredAt
      },
      proof,
      evidenceRecord: evidence.evidenceRecord,
      failures: evidence.failures
    };
  } catch (error) {
    return emptyReport({
      now,
      source,
      liveEvidenceAllowed: input.liveEvidenceAllowed,
      confirmLive: input.confirmLive,
      request,
      telegramApiCalled: true,
      telegramStatus: responseStatus,
      failures: [`telegram_send_exception:${safeFailureMessage(error)}`]
    });
  }
}

function emptyReport(input: {
  now: Date;
  source: string;
  liveEvidenceAllowed: boolean;
  confirmLive: boolean;
  request: TelegramDispatchSmokeReport["request"];
  failures: string[];
  telegramApiCalled?: boolean;
  telegramStatus?: number | null;
}): TelegramDispatchSmokeReport {
  return {
    schemaVersion: "telegram-dispatch-smoke/v1",
    generatedAt: input.now.toISOString(),
    source: input.source,
    liveEvidenceAllowed: input.liveEvidenceAllowed,
    confirmLive: input.confirmLive,
    telegramApiCalled: input.telegramApiCalled ?? false,
    request: input.request,
    telegram: {
      ok: false,
      status: input.telegramStatus ?? null,
      messageIdHash: null,
      deliveredAt: null
    },
    proof: null,
    evidenceRecord: null,
    failures: input.failures
  };
}

function parseTelegramSendMessageResult(body: unknown): { ok: true; messageId: number; date: number | null } | { ok: false; failures: string[] } {
  if (!body || typeof body !== "object") {
    return { ok: false, failures: ["telegram_response_not_object"] };
  }
  const object = body as Record<string, unknown>;
  if (object.ok !== true) {
    return { ok: false, failures: ["telegram_response_not_ok"] };
  }
  const result = object.result;
  if (!result || typeof result !== "object") {
    return { ok: false, failures: ["telegram_result_missing"] };
  }
  const resultObject = result as Record<string, unknown>;
  const messageId = resultObject.message_id;
  if (typeof messageId !== "number" || !Number.isFinite(messageId)) {
    return { ok: false, failures: ["telegram_message_id_missing"] };
  }
  const date = resultObject.date;
  return { ok: true, messageId, date: typeof date === "number" && Number.isFinite(date) ? date : null };
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^a-z0-9._:-]+/gi, "_").slice(0, 120);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ttlHours = process.env.OUTBOUND_EVIDENCE_TTL_HOURS ? parsePositiveNumber(process.env.OUTBOUND_EVIDENCE_TTL_HOURS) : undefined;
  const report = await buildTelegramDispatchSmokeReport({
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_DISPATCH_CHAT_ID ?? "",
    text: process.env.TELEGRAM_DISPATCH_TEXT ?? "",
    source: process.env.TELEGRAM_DISPATCH_SOURCE ?? process.env.OUTBOUND_EVIDENCE_SOURCE ?? "",
    liveEvidenceAllowed: process.env.OUTBOUND_EVIDENCE_ASSERT_LIVE === "true",
    confirmLive: process.env.TELEGRAM_DISPATCH_CONFIRM_LIVE === "true",
    ...(ttlHours !== undefined ? { ttlHours } : {}),
    ...(process.env.TELEGRAM_DISPATCH_IDEMPOTENCY_KEY ? { idempotencyKey: process.env.TELEGRAM_DISPATCH_IDEMPOTENCY_KEY } : {})
  });
  if (process.env.OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE === "true") {
    if (!process.env.RELEASE_EVIDENCE_PATH) {
      throw new Error("RELEASE_EVIDENCE_PATH is required when OUTBOUND_EVIDENCE_APPEND_RELEASE_EVIDENCE=true");
    }
    if (!report.evidenceRecord) {
      throw new Error(`Cannot append Telegram dispatch evidence: ${report.failures.join(", ") || "no_evidence_record"}`);
    }
    upsertReleaseEvidenceRecords({ path: process.env.RELEASE_EVIDENCE_PATH, records: [report.evidenceRecord] });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.env.TELEGRAM_DISPATCH_OUTPUT_PATH ?? process.env.OUTBOUND_EVIDENCE_OUTPUT_PATH;
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

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }
  return parsed;
}
