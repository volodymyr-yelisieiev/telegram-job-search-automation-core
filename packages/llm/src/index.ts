import { z, type ZodType } from "zod";
import { ConversationEngine, type CandidateProfile, type MessageClassification, type NormalizedJob } from "@job-search/domain";

export interface LlmRequest<T> {
  task: "cover_letter" | "message_classification" | "slot_extraction" | "summary" | "diagnostics";
  input: unknown;
  schema: ZodType<T>;
}

export interface LlmResult<T> {
  ok: boolean;
  value: T | null;
  validationErrors: string[];
  modelVersion: string;
  inputHash: string;
}

export class LlmGateway {
  constructor(private readonly modelVersion = "mock-local-v1") {}

  async generateStructured<T>(schema: ZodType<T>, input: unknown): Promise<LlmResult<T>> {
    const raw = this.mockResponse(input);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        value: null,
        validationErrors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        modelVersion: this.modelVersion,
        inputHash: stableJsonHash(input)
      };
    }
    return {
      ok: true,
      value: parsed.data,
      validationErrors: [],
      modelVersion: this.modelVersion,
      inputHash: stableJsonHash(input)
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
        inputHash: stableJsonHash({ task: "cover_letter", jobId: job.id, flags: inspection.flags })
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
      classification.allowedAutoReply = false;
      classification.reasons.push(`Prompt injection markers detected: ${injection.flags.join(", ")}`);
    }
    return this.generateStructured(messageClassificationLlmSchema, classification);
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
}

function stableJsonHash(value: unknown): string {
  const json = canonicalJson(value);
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 31 + json.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
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
    requiresReply: z.boolean(),
    deadline: z.string().nullable(),
    containsInterviewLink: z.boolean(),
    proposedSlots: z.array(
      z.object({
        date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1)
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
