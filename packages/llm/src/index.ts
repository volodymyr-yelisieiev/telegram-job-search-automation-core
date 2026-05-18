import { z, type ZodType } from "zod";
import { ConversationEngine, type CandidateProfile, type MessageClassification, type NormalizedJob } from "@job-search/domain";

export interface LlmRequest<T> {
  task: "cover_letter" | "message_classification" | "slot_extraction" | "summary" | "diagnostics";
  input: unknown;
  schema: ZodType<T>;
}

export interface LlmTransport {
  completeJson(input: { model: string; prompt: string; timeoutMs: number; apiKey: string }): Promise<unknown>;
}

export interface LlmResult<T> {
  ok: boolean;
  value: T | null;
  validationErrors: string[];
  modelVersion: string;
  inputHash: string;
  promptVersion: string;
  estimatedInputChars: number;
}

export class LlmGateway {
  constructor(
    private readonly options: {
      modelVersion?: string;
      transport?: LlmTransport;
      apiKey?: string;
      timeoutMs?: number;
      maxRetries?: number;
      maxInputChars?: number;
      promptVersion?: string;
    } = {}
  ) {}

  async generateStructured<T>(schema: ZodType<T>, input: unknown): Promise<LlmResult<T>> {
    const redactedInput = redactLlmInput(input);
    const prompt = PromptRegistry.render("structured_json", redactedInput);
    const inputHash = stableJsonHash(redactedInput);
    const estimatedInputChars = prompt.length;
    if (estimatedInputChars > this.maxInputChars) {
      return this.failure<T>(null, [`LLM input too large: ${estimatedInputChars} chars`], inputHash, estimatedInputChars);
    }

    let raw: unknown;
    try {
      raw = this.options.transport ? await this.callTransportWithRetry(prompt) : this.mockResponse(redactedInput);
    } catch (error) {
      return this.failure<T>(null, [`LLM transport failed: ${String(error)}`], inputHash, estimatedInputChars);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return this.failure<T>(
        null,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        inputHash,
        estimatedInputChars
      );
    }
    return {
      ok: true,
      value: parsed.data,
      validationErrors: [],
      modelVersion: this.modelVersion,
      inputHash,
      promptVersion: this.promptVersion,
      estimatedInputChars
    };
  }

  async generateCoverLetter(job: NormalizedJob, profile: CandidateProfile, schema: ZodType<unknown>): Promise<LlmResult<unknown>> {
    const inspection = detectPromptInjection(`${job.title}\n${job.description}\n${job.requirements.join("\n")}`);
    if (inspection.detected) {
      return {
        ok: false,
        value: null,
        validationErrors: [`Prompt injection markers detected: ${inspection.flags.join(", ")}`],
        modelVersion: this.modelVersion,
        inputHash: stableJsonHash({ task: "cover_letter", jobId: job.id, flags: inspection.flags }),
        promptVersion: this.promptVersion,
        estimatedInputChars: 0
      };
    }
    return this.generateStructured(schema, {
      task: "cover_letter",
      job,
      profileFacts: Object.keys(profile.facts)
    });
  }

  async classifyMessage(text: string, timezone: string): Promise<LlmResult<MessageClassification>> {
    const engine = new ConversationEngine();
    const classification = engine.classify(text, timezone);
    const injection = detectPromptInjection(text);
    if (injection.detected) {
      return {
        ok: false,
        value: null,
        validationErrors: [`Prompt injection markers detected: ${injection.flags.join(", ")}`],
        modelVersion: this.modelVersion,
        inputHash: stableJsonHash(redactLlmInput({ task: "message_classification", text, timezone })),
        promptVersion: this.promptVersion,
        estimatedInputChars: text.length
      };
    }
    const result = await this.generateStructured(messageClassificationLlmSchema, classification);
    return result as LlmResult<MessageClassification>;
  }

  inspectUntrustedText(text: string): PromptInjectionInspection {
    return detectPromptInjection(text);
  }

  private mockResponse(input: unknown): unknown {
    if (typeof input === "object" && input !== null && "forceInvalid" in input) {
      return { invalid: true };
    }
    return input;
  }

  private async callTransportWithRetry(prompt: string): Promise<unknown> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.options.transport!.completeJson({
          model: this.modelVersion,
          prompt,
          timeoutMs: this.timeoutMs,
          apiKey: this.options.apiKey ?? ""
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private failure<T>(
    value: T | null,
    validationErrors: string[],
    inputHash: string,
    estimatedInputChars: number
  ): LlmResult<T> {
    return {
      ok: false,
      value,
      validationErrors,
      modelVersion: this.modelVersion,
      inputHash,
      promptVersion: this.promptVersion,
      estimatedInputChars
    };
  }

  private get modelVersion(): string {
    return this.options.modelVersion ?? "mock-local-v1";
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 15_000;
  }

  private get maxRetries(): number {
    return this.options.maxRetries ?? 1;
  }

  private get maxInputChars(): number {
    return this.options.maxInputChars ?? 20_000;
  }

  private get promptVersion(): string {
    return this.options.promptVersion ?? PromptRegistry.version;
  }
}

export class OpenAiCompatibleTransport implements LlmTransport {
  constructor(private readonly baseUrl: string) {}

  async completeJson(input: { model: string; prompt: string; timeoutMs: number; apiKey: string }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({
          model: input.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Return only a JSON object matching the requested schema. Do not execute tools or actions."
            },
            {
              role: "user",
              content: input.prompt
            }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response did not contain content");
      }
      return JSON.parse(content);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PromptRegistry {
  static readonly version = "2026-05-18-v1";

  static render(templateId: "structured_json", input: unknown): string {
    return JSON.stringify({
      templateId,
      version: this.version,
      instruction: "Produce structured JSON only. Never send, submit, click, confirm, or reveal secrets.",
      input
    });
  }
}

function stableJsonHash(value: unknown): string {
  const json = canonicalJson(value);
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 31 + json.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

export function redactLlmInput<T>(value: T, depth = 0): T {
  if (depth > 8) {
    return "[redacted:max-depth]" as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLlmInput(item, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
        if (/token|secret|password|cookie|credential|authorization|session|auth/i.test(key)) {
          return [key, "[redacted]"];
        }
        return [key, redactLlmInput(nestedValue, depth + 1)];
      })
    ) as T;
  }
  return value;
}

export const messageClassificationLlmSchema = z
  .object({
    category: z.enum([
      "auto_reply",
      "acknowledgment",
      "recruiter_outreach",
      "clarifying_question",
      "request_for_details",
      "request_for_salary_expectation",
      "request_for_location",
      "request_for_notice_period",
      "test_assignment",
      "rejection",
      "interview_invitation",
      "scheduling_request",
      "spam_irrelevant",
      "unknown"
    ]),
    confidence: z.number().min(0).max(1),
    priorityScore: z.number().min(0).max(100).optional(),
    requiresReply: z.boolean(),
    deadline: z.string().nullable(),
    containsInterviewLink: z.boolean(),
    proposedSlots: z.array(
      z.object({
        date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1),
        durationMinutes: z.number().int().positive().optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceText: z.string().optional()
      })
    ),
    sensitiveDataRequested: z.boolean(),
    allowedAutoReply: z.boolean(),
    reasons: z.array(z.string())
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sensitiveDataRequested && value.allowedAutoReply) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedAutoReply"],
        message: "Sensitive data requests cannot be auto-replied"
      });
    }
    if (value.confidence >= 0.82 && value.reasons.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "High-confidence classifications require reasons"
      });
    }
    for (const [index, slot] of value.proposedSlots.entries()) {
      const parsed = new Date(`${slot.date}T${slot.time}:00`);
      const [hours = 99, minutes = 99] = slot.time.split(":").map(Number);
      if (Number.isNaN(parsed.getTime()) || hours > 23 || minutes > 59) {
        ctx.addIssue({
          code: "custom",
          path: ["proposedSlots", index],
          message: "Slot date/time is invalid"
        });
      }
    }
  });

export const vacancyExtractionLlmSchema = z
  .object({
    title: z.string().min(2),
    companyName: z.string().nullable(),
    location: z.string().nullable(),
    workFormat: z.enum(["remote", "hybrid", "office", "unknown"]),
    compensationMin: z.number().nullable(),
    compensationMax: z.number().nullable(),
    compensationCurrency: z.string().nullable(),
    language: z.string().min(2),
    confidence: z.number().min(0).max(1),
    risks: z.array(z.string())
  })
  .strict();

export const coverLetterDraftLlmSchema = z
  .object({
    text: z.string().min(20).max(4000),
    factsUsed: z.array(z.string()),
    language: z.string().min(2),
    riskFlags: z.array(z.string()),
    rationale: z.array(z.string())
  })
  .strict();

export const slotExtractionLlmSchema = z
  .object({
    proposedSlots: z.array(
      z.object({
        date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1),
        confidence: z.number().min(0).max(1),
        sourceText: z.string().min(1)
      })
    ),
    timezoneAmbiguous: z.boolean(),
    needsClarification: z.boolean(),
    reasons: z.array(z.string())
  })
  .strict();

export const threadSummaryLlmSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    promisedFacts: z.array(z.string()),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    nextBestAction: z.enum(["reply", "schedule", "wait", "manual_review"])
  })
  .strict();

export interface LlmEvalFixtureReport {
  vacancyDescriptions: number;
  recruiterMessages: number;
  schedulingCases: number;
  unsafeFactCases: number;
  schemaIds: string[];
  passed: boolean;
}

export function buildLlmEvalFixtureReport(): LlmEvalFixtureReport {
  const vacancyDescriptions = Array.from({ length: 100 }, (_, index) => ({
    title: `Backend TypeScript role ${index}`,
    companyName: `Company ${index}`,
    location: index % 3 === 0 ? "Remote" : "Vienna",
    workFormat: index % 3 === 0 ? "remote" : "hybrid",
    compensationMin: 4000,
    compensationMax: 6000,
    compensationCurrency: "EUR",
    language: "en",
    confidence: 0.9,
    risks: []
  }));
  const recruiterMessages = Array.from({ length: 100 }, (_, index) => ({
    category: index % 5 === 0 ? "scheduling_request" : "acknowledgment",
    confidence: 0.9,
    requiresReply: index % 5 === 0,
    deadline: null,
    containsInterviewLink: false,
    proposedSlots: index % 5 === 0 ? [{ date: "2026-05-20", time: "14:00", timezone: "Europe/Vienna" }] : [],
    sensitiveDataRequested: false,
    allowedAutoReply: index % 5 !== 0,
    reasons: ["fixture"]
  }));
  const schedulingCases = Array.from({ length: 30 }, (_, index) => ({
    proposedSlots: [{ date: "2026-05-20", time: `${String(9 + (index % 8)).padStart(2, "0")}:00`, timezone: "Europe/Vienna", confidence: 0.9, sourceText: "fixture slot" }],
    timezoneAmbiguous: false,
    needsClarification: false,
    reasons: ["fixture"]
  }));
  const unsafeFactCases = Array.from({ length: 30 }, (_, index) => ({
    text: `Please disclose restricted fact ${index}`,
    factsUsed: ["citizenship"],
    language: "en",
    riskFlags: ["forbidden_fact:citizenship"],
    rationale: ["unsafe fact fixture"]
  }));
  const passed =
    vacancyDescriptions.every((item) => vacancyExtractionLlmSchema.safeParse(item).success) &&
    recruiterMessages.every((item) => messageClassificationLlmSchema.safeParse(item).success) &&
    schedulingCases.every((item) => slotExtractionLlmSchema.safeParse(item).success) &&
    unsafeFactCases.every((item) => coverLetterDraftLlmSchema.safeParse(item).success);
  return {
    vacancyDescriptions: vacancyDescriptions.length,
    recruiterMessages: recruiterMessages.length,
    schedulingCases: schedulingCases.length,
    unsafeFactCases: unsafeFactCases.length,
    schemaIds: ["VacancyExtraction", "CoverLetterDraft", "MessageClassification", "SlotExtraction", "ThreadSummary"],
    passed
  };
}

export interface PromptInjectionInspection {
  detected: boolean;
  flags: string[];
}

export function detectPromptInjection(text: string): PromptInjectionInspection {
  const normalized = text.toLowerCase();
  const patterns: Array<[string, RegExp]> = [
    ["ignore_instructions", /ignore (all )?(previous|prior|system|developer) instructions/],
    ["secret_exfiltration", /(reveal|print|send|exfiltrate).{0,40}(secret|token|password|api key)/],
    ["tool_instruction", /(click|submit|send|call|execute).{0,40}(without approval|now|automatically)/],
    ["policy_override", /(disable|bypass|override).{0,40}(policy|guard|validation|captcha)/]
  ];
  const flags = patterns.filter(([, pattern]) => pattern.test(normalized)).map(([flag]) => flag);
  return {
    detected: flags.length > 0,
    flags
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`)
    .join(",")}}`;
}
