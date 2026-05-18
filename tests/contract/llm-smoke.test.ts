import { describe, expect, it } from "vitest";
import { loadConfig } from "@job-search/config";
import { buildLlmSmokeReport } from "../../scripts/llm-smoke";

describe("LLM smoke diagnostics", () => {
  const liveConfig = loadConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_API_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: "live-llm-key",
    LLM_MODEL: "prod-model"
  });

  it("does not call the transport without explicit live confirmation", async () => {
    let calls = 0;
    const report = await buildLlmSmokeReport({
      config: liveConfig,
      confirmLive: false,
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z"),
      transport: {
        completeJson: async () => {
          calls += 1;
          return { ok: true };
        }
      }
    });

    expect(calls).toBe(0);
    expect(report.llmApiCalled).toBe(false);
    expect(report.failures).toContain("llm_smoke_confirm_live_required");
    expect(JSON.stringify(report)).not.toContain("live-llm-key");
    expect(JSON.stringify(report)).not.toContain("https://llm.example/v1");
  });

  it("emits schema-validated model and prompt evidence without raw credentials", async () => {
    let promptSeen = "";
    const report = await buildLlmSmokeReport({
      config: liveConfig,
      confirmLive: true,
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z"),
      transport: {
        completeJson: async (input) => {
          promptSeen = input.prompt;
          expect(input.apiKey).toBe("live-llm-key");
          return { ok: true };
        }
      }
    });

    expect(promptSeen).toContain("diagnostics");
    expect(report).toMatchObject({
      llmApiCalled: true,
      configSummary: {
        provider: "openai-compatible",
        model: "prod-model",
        apiBaseUrlHash: expect.any(String),
        apiKeyHash: expect.any(String)
      },
      result: {
        ok: true,
        modelVersion: "prod-model",
        inputHash: expect.any(String),
        estimatedInputChars: expect.any(Number),
        validationErrors: []
      },
      failures: []
    });
    expect(JSON.stringify(report)).not.toContain("live-llm-key");
    expect(JSON.stringify(report)).not.toContain("https://llm.example/v1");
    expect(JSON.stringify(report)).not.toContain(promptSeen);
  });

  it("reports schema failures as smoke failures", async () => {
    const report = await buildLlmSmokeReport({
      config: liveConfig,
      confirmLive: true,
      liveEvidenceAllowed: true,
      now: new Date("2026-05-18T00:00:00.000Z"),
      transport: {
        completeJson: async () => ({ invalid: true })
      }
    });

    expect(report.llmApiCalled).toBe(true);
    expect(report.result.ok).toBe(false);
    expect(report.failures.some((failure) => failure.startsWith("llm_diagnostics_failed:"))).toBe(true);
  });
});
