import { rawJobPayloadSchema, type RawJobPayload } from "@job-search/domain";

export interface TelegramPostInput {
  channelId: string;
  messageId: string;
  text: string;
  url: string | null;
  postedAt: string;
}

export interface TelegramVacancyParseDecision {
  status: "vacancy" | "non_vacancy" | "manual_review";
  confidence: number;
  reasons: string[];
  repostOrForward: boolean;
  manualReviewReason: string | null;
  rawJob: RawJobPayload | null;
}

export function parseTelegramVacancyPost(input: TelegramPostInput): RawJobPayload | null {
  return parseTelegramVacancyPostDecision(input).rawJob;
}

export function parseTelegramVacancyPostDecision(input: TelegramPostInput): TelegramVacancyParseDecision {
  const text = input.text.trim();
  if (!isVacancyPost(text)) {
    return {
      status: "non_vacancy",
      confidence: 0.1,
      reasons: ["message_does_not_match_vacancy_keywords"],
      repostOrForward: isRepostOrForward(text),
      manualReviewReason: null,
      rawJob: null
    };
  }

  const title = firstMatch(text, [/^(.+developer.+)$/im, /^(.+engineer.+)$/im, /hiring[:\s]+(.+)$/im]) ?? "Untitled Telegram vacancy";
  const compensation = extractCompensation(text);
  const remote = /remote|viddaleno|udalen/i.test(text);
  const requirements = [...new Set((text.match(/node\.?js|typescript|nestjs|postgresql|redis|docker|aws/gi) ?? []).map(normalizeSkill))];
  const qualitySignals = telegramQualitySignals(text);
  const confidence = Math.max(0.2, Math.min(0.95, 0.65 + requirements.length * 0.04 + (compensation ? 0.08 : 0) - qualitySignals.length * 0.12));
  const manualReviewReason = confidence < 0.72 ? `telegram_low_confidence:${qualitySignals.join(",") || "weak_structure"}` : null;

  const rawJob = rawJobPayloadSchema.parse({
    providerId: "telegram",
    externalId: `${input.channelId}:${input.messageId}`,
    url: input.url,
    fetchedAt: input.postedAt,
    payload: {
      title,
      companyName: firstMatch(text, [/company[:\s]+([^\n]+)/i]) ?? null,
      location: remote ? "Remote" : firstMatch(text, [/location[:\s]+([^\n]+)/i]) ?? null,
      workFormat: remote ? "remote" : "unknown",
      compensationMin: compensation?.min ?? null,
      compensationMax: compensation?.max ?? null,
      compensationCurrency: compensation ? "EUR" : null,
      compensationPeriod: compensation ? "month" : "unknown",
      seniority: /senior/i.test(text) ? "senior" : /middle|mid/i.test(text) ? "middle_plus" : null,
      employmentType: /contract|b2b/i.test(text) ? "contract" : "full_time",
      description: text,
      requirements,
      responsibilities: [],
      niceToHave: [],
      language: "en",
      contactMethod: "telegram_dm",
      publicationDate: input.postedAt.slice(0, 10),
      qualitySignals,
      parseConfidence: Number(confidence.toFixed(2)),
      repostOrForward: isRepostOrForward(text),
      manualReviewReason
    }
  });
  return {
    status: manualReviewReason ? "manual_review" : "vacancy",
    confidence: Number(confidence.toFixed(2)),
    reasons: [
      "message_matches_vacancy_keywords",
      requirements.length > 0 ? "technical_requirements_detected" : "technical_requirements_weak",
      compensation ? "compensation_detected" : "compensation_missing"
    ],
    repostOrForward: isRepostOrForward(text),
    manualReviewReason,
    rawJob
  };
}

function extractCompensation(text: string): { min: number; max: number } | null {
  const match = text.match(/(?:€\s?)?(\d{3,6})\s?[-–]\s?(?:€\s?)?(\d{3,6})\s?(?:eur)?/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { min: Number(match[1]), max: Number(match[2]) };
}

function isVacancyPost(text: string): boolean {
  return /(hiring|vacancy|job|developer|engineer)/i.test(text) && /(node|typescript|backend|nestjs|postgres)/i.test(text);
}

function isRepostOrForward(text: string): boolean {
  return /\b(repost|forwarded|via @|перепост|репост)\b/i.test(text);
}

function telegramQualitySignals(text: string): string[] {
  const signals = new Set<string>();
  if (isRepostOrForward(text)) {
    signals.add("repost");
  }
  if (/\bagency\b|staffing|recruitment agency/i.test(text)) {
    signals.add("agency_post");
  }
  if (/guaranteed income|crypto|pay upfront|registration fee|scam/i.test(text)) {
    signals.add("scam_like");
  }
  if (/dm for details|contact only|details in dm/i.test(text)) {
    signals.add("contact_only");
  }
  if (text.length < 220) {
    signals.add("short_description");
  }
  return [...signals];
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeSkill(skill: string): string {
  const normalized = skill.toLowerCase().replace(/\./g, "");
  const mapping: Record<string, string> = {
    nodejs: "Node.js",
    typescript: "TypeScript",
    nestjs: "NestJS",
    postgresql: "PostgreSQL",
    redis: "Redis",
    docker: "Docker",
    aws: "AWS"
  };
  return mapping[normalized] ?? skill;
}
