import { z } from "zod";
import {
  appModes,
  applicationStatuses,
  compensationPeriods,
  messageCategories,
  providerStatuses,
  workFormats
} from "./types";

export const resumeSchema = z.object({
  resumeId: z.string().min(1),
  filename: z.string().min(1),
  language: z.string().min(2),
  targetStack: z.array(z.string()).default([]),
  targetSeniority: z.array(z.string()).default([]),
  allowedProviders: z.array(z.string()).default([]),
  objectStorageKey: z.string().min(1),
  version: z.string().min(1),
  active: z.boolean(),
  checksum: z.string().min(1),
  lastReviewedAt: z.string().datetime()
});

export const factSchema = z.object({
  value: z.unknown(),
  disclosure: z.enum(["allowed", "range_only", "forbidden_without_user_approval", "forbidden"]),
  categories: z.array(z.string())
});

export const candidateProfileSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  displayName: z.string().min(1),
  active: z.boolean(),
  targetTitles: z.array(z.string()).min(1),
  primaryStack: z.array(z.string()).min(1),
  secondaryStack: z.array(z.string()).default([]),
  yearsOfExperience: z.number().int().nonnegative(),
  seniorityTargets: z.array(z.string()).min(1),
  languages: z.object({
    communicationDefault: z.string().min(2),
    allowed: z.array(z.string().min(2)).min(1)
  }),
  geography: z.object({
    currentLocation: z.string().min(1),
    allowedWorkFormats: z.array(z.enum(workFormats)).min(1),
    relocation: z.object({
      allowed: z.boolean()
    })
  }),
  compensation: z.object({
    minMonthlyEur: z.number().int().nonnegative(),
    targetMonthlyEur: z.number().int().nonnegative(),
    discloseMode: z.enum(["range_only", "never", "exact"])
  }),
  employment: z.object({
    types: z.array(z.string()).min(1)
  }),
  resumes: z.array(resumeSchema).min(1),
  facts: z.record(z.string(), factSchema),
  blacklists: z.object({
    companies: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([])
  }),
  whitelists: z.object({
    companies: z.array(z.string()).default([])
  }),
  strategies: z.object({
    default: z.enum(["aggressive", "balanced", "selective"]),
    allowed: z.array(z.enum(["aggressive", "balanced", "selective"])).min(1)
  }),
  availability: z.object({
    timezone: z.string().min(1),
    defaultWindows: z.record(z.string(), z.array(z.string())),
    bufferMinutesBefore: z.number().int().nonnegative(),
    bufferMinutesAfter: z.number().int().nonnegative(),
    maxInterviewsPerDay: z.number().int().positive(),
    minNoticeHours: z.number().int().nonnegative()
  }),
  userConsent: z.object({
    autoApply: z.boolean(),
    autoReply: z.boolean(),
    interviewScheduling: z.boolean()
  }),
  rateLimits: z.object({
    applicationsPerDay: z.number().int().positive(),
    applicationsPerHour: z.number().int().positive(),
    maxPerCompanyPerDay: z.number().int().positive(),
    maxPerCompanyPerWeek: z.number().int().positive()
  })
});

export const searchProfileSchema = z.object({
  searchProfileId: z.string().min(1),
  candidateProfileId: z.string().min(1),
  strategy: z.enum(["aggressive", "balanced", "selective"]),
  providers: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      queries: z.array(z.string()),
      filters: z.record(z.string(), z.unknown()).default({}),
      sort: z.string().default("newest"),
      maxPagesPerRun: z.number().int().positive().default(5),
      maxJobsPerRun: z.number().int().positive().default(100)
    })
  )
});

export const rawJobRefSchema = z.object({
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url().nullable(),
  discoveredAt: z.string().datetime()
});

export const rawJobPayloadSchema = z.object({
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url().nullable(),
  fetchedAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown())
});

export const normalizedJobSchema = z.object({
  id: z.string().min(1),
  sourceProvider: z.string().min(1),
  externalId: z.string().min(1),
  canonicalUrl: z.string().url().nullable(),
  title: z.string().min(1),
  companyName: z.string().nullable(),
  companyExternalId: z.string().nullable(),
  location: z.string().nullable(),
  workFormat: z.enum(workFormats),
  compensationMin: z.number().nullable(),
  compensationMax: z.number().nullable(),
  compensationCurrency: z.string().nullable(),
  compensationPeriod: z.enum(compensationPeriods),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  description: z.string().min(1),
  requirements: z.array(z.string()),
  responsibilities: z.array(z.string()),
  niceToHave: z.array(z.string()),
  language: z.string().min(2),
  contactMethod: z.string().nullable(),
  publicationDate: z.string().nullable(),
  availabilityStatus: z.enum(["open", "closed", "unknown"]).optional(),
  alreadyApplied: z.boolean().optional(),
  qualitySignals: z.array(z.string()).optional(),
  rawPayloadId: z.string().min(1),
  extractionConfidence: z.number().min(0).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const providerHealthSchema = z.object({
  providerId: z.string().min(1),
  status: z.enum(providerStatuses),
  checkedAt: z.string().datetime(),
  latencyMs: z.number().int().nonnegative(),
  message: z.string()
});

export const coverLetterSchema = z.object({
  jobId: z.string().min(1),
  resumeId: z.string().min(1),
  language: z.string().min(2),
  text: z.string().min(1),
  factsUsed: z.array(z.string()),
  riskFlags: z.array(z.string()),
  validationStatus: z.enum(["passed", "failed"]),
  modelVersion: z.string().min(1),
  createdAt: z.string().datetime()
});

export const applicationDraftSchema = z.object({
  draftId: z.string().min(1),
  jobId: z.string().min(1),
  providerId: z.string().min(1),
  externalJobId: z.string().min(1),
  candidateProfileId: z.string().min(1),
  resumeId: z.string().min(1),
  coverLetterId: z.string().min(1),
  coverLetterText: z.string().min(1),
  status: z.enum(applicationStatuses),
  idempotencyKey: z.string().startsWith("apply:"),
  createdAt: z.string().datetime()
});

export const inboundMessageDraftSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().min(1),
  externalMessageId: z.string().min(1),
  conversationExternalId: z.string().min(1),
  receivedAt: z.string().datetime(),
  senderName: z.string().nullable(),
  text: z.string().min(1),
  linkedJobExternalId: z.string().nullable()
});

export const outboundMessageSchema = z.object({
  conversationId: z.string().min(1),
  inboundMessageId: z.string().min(1),
  category: z.enum(messageCategories),
  language: z.string().min(2),
  text: z.string().min(1),
  factsUsed: z.array(z.string()),
  idempotencyKey: z.string().startsWith("reply:")
});

export const appConfigSchema = z.object({
  mode: z.enum(appModes),
  timezone: z.string().min(1),
  environment: z.enum(["local", "dev", "staging", "production"]),
  irreversibleActionsEnabled: z.boolean()
});
