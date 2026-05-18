import { describe, expect, it } from "vitest";
import { stableHash } from "@job-search/domain";
import { buildTelegramDispatchSmokeReport, type TelegramDispatchFetch } from "../../scripts/telegram-dispatch-smoke";

describe("Telegram dispatch smoke evidence", () => {
  it("does not call Telegram without explicit live confirmation", async () => {
    let calls = 0;
    const fetchImpl: TelegramDispatchFetch = async () => {
      calls += 1;
      throw new Error("should not call");
    };

    const report = await buildTelegramDispatchSmokeReport({
      token: "123456:secret-token",
      chatId: "987654321",
      text: "Approved recruiter reply",
      source: "production telegram dispatch workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: false,
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(calls).toBe(0);
    expect(report.telegramApiCalled).toBe(false);
    expect(report.evidenceRecord).toBeNull();
    expect(report.failures).toContain("telegram_dispatch_confirm_live_required");
    expect(JSON.stringify(report)).not.toContain("Approved recruiter reply");
    expect(JSON.stringify(report)).not.toContain("123456:secret-token");
    expect(JSON.stringify(report)).not.toContain("987654321");
  });

  it("sends a live Telegram proof without leaking raw text into evidence", async () => {
    const sentBodies: unknown[] = [];
    const fetchImpl: TelegramDispatchFetch = async (_url, init) => {
      sentBodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 123,
            date: Date.parse("2026-05-18T00:00:00.000Z") / 1000
          }
        }),
        text: async () => ""
      };
    };

    const report = await buildTelegramDispatchSmokeReport({
      token: "123456:secret-token",
      chatId: "987654321",
      text: "Approved recruiter reply",
      source: "production telegram dispatch workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: true,
      idempotencyKey: "reply:conv-1:msg-1:acknowledgment",
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(sentBodies).toEqual([
      expect.objectContaining({
        chat_id: "987654321",
        text: "Approved recruiter reply"
      })
    ]);
    expect(report).toMatchObject({
      telegramApiCalled: true,
      telegram: {
        ok: true,
        status: 200,
        deliveredAt: "2026-05-18T00:00:00.000Z"
      },
      proof: {
        transport: "telegram",
        status: "sent",
        idempotencyKeyHash: stableHash("reply:conv-1:msg-1:acknowledgment"),
        textHash: stableHash("Approved recruiter reply"),
        deliveredAt: "2026-05-18T00:00:00.000Z"
      },
      evidenceRecord: {
        evidenceType: "outbound_dispatch_proof_ready",
        status: "passed",
        expiresAt: "2026-05-19T00:00:00.000Z",
        metadata: {
          transport: "telegram",
          deliveryStatus: "sent",
          deliveredAt: "2026-05-18T00:00:00.000Z"
        }
      },
      failures: []
    });
    expect(JSON.stringify(report)).not.toContain("Approved recruiter reply");
    expect(JSON.stringify(report)).not.toContain("123456:secret-token");
    expect(JSON.stringify(report)).not.toContain("987654321");
  });

  it("reports Telegram API failures without creating release evidence", async () => {
    const fetchImpl: TelegramDispatchFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ ok: false }),
      text: async () => "forbidden"
    });

    const report = await buildTelegramDispatchSmokeReport({
      token: "123456:secret-token",
      chatId: "987654321",
      text: "Approved recruiter reply",
      source: "production telegram dispatch workflow 42",
      liveEvidenceAllowed: true,
      confirmLive: true,
      now: new Date("2026-05-18T00:00:00.000Z"),
      fetchImpl
    });

    expect(report.telegramApiCalled).toBe(true);
    expect(report.telegram.status).toBe(403);
    expect(report.evidenceRecord).toBeNull();
    expect(report.failures).toEqual(["telegram_send_failed:403"]);
  });
});
