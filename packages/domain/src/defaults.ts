import type { CandidateProfile, SearchProfile } from "./types";

const reviewedAt = "2026-05-16T00:00:00.000Z";

export function createDefaultCandidateProfile(): CandidateProfile {
  return {
    id: "backend-node-main",
    userId: "user-001",
    displayName: "Backend Node.js Profile",
    active: true,
    targetTitles: ["Backend Developer", "Node.js Developer", "TypeScript Backend Engineer"],
    primaryStack: ["Node.js", "TypeScript", "NestJS", "PostgreSQL"],
    secondaryStack: ["AWS", "Docker", "Redis", "GraphQL"],
    yearsOfExperience: 5,
    seniorityTargets: ["middle_plus", "senior"],
    languages: {
      communicationDefault: "en",
      allowed: ["en", "ru", "uk"]
    },
    geography: {
      currentLocation: "Vienna, Austria",
      allowedWorkFormats: ["remote", "hybrid"],
      relocation: {
        allowed: false
      }
    },
    compensation: {
      minMonthlyEur: 4000,
      targetMonthlyEur: 5500,
      discloseMode: "range_only"
    },
    employment: {
      types: ["full_time", "contract"]
    },
    resumes: [
      {
        resumeId: "resume_backend_node_en_v4",
        filename: "backend-node-en-v4.pdf",
        language: "en",
        targetStack: ["Node.js", "TypeScript", "NestJS", "PostgreSQL"],
        targetSeniority: ["middle_plus", "senior"],
        allowedProviders: ["hh", "robota", "telegram"],
        objectStorageKey: "resumes/backend-node-en-v4.pdf",
        version: "v4",
        active: true,
        checksum: "fixture-checksum-backend-node-en-v4",
        lastReviewedAt: reviewedAt
      },
      {
        resumeId: "resume_backend_general_en_v2",
        filename: "backend-general-en-v2.pdf",
        language: "en",
        targetStack: ["Backend", "PostgreSQL", "Redis"],
        targetSeniority: ["middle_plus", "senior"],
        allowedProviders: ["hh", "robota", "telegram"],
        objectStorageKey: "resumes/backend-general-en-v2.pdf",
        version: "v2",
        active: true,
        checksum: "fixture-checksum-backend-general-en-v2",
        lastReviewedAt: reviewedAt
      }
    ],
    facts: {
      current_location: {
        value: "Vienna, Austria",
        disclosure: "allowed",
        categories: ["location_reply", "scheduling_reply"]
      },
      salary_expectation: {
        value: {
          min: 4000,
          max: 5500,
          currency: "EUR",
          period: "month"
        },
        disclosure: "range_only",
        categories: ["salary_range_reply"]
      },
      citizenship: {
        value: null,
        disclosure: "forbidden_without_user_approval",
        categories: []
      },
      notice_period: {
        value: "2 weeks",
        disclosure: "allowed",
        categories: ["notice_period_reply"]
      }
    },
    blacklists: {
      companies: ["Scam Recruiting LLC"],
      keywords: ["unpaid", "intern", "junior only"]
    },
    whitelists: {
      companies: []
    },
    strategies: {
      default: "balanced",
      allowed: ["aggressive", "balanced", "selective"]
    },
    availability: {
      timezone: "Europe/Vienna",
      defaultWindows: {
        monday: ["10:00-13:00", "15:00-18:00"],
        tuesday: ["10:00-13:00", "15:00-18:00"],
        wednesday: ["10:00-13:00"],
        thursday: ["15:00-18:00"],
        friday: ["10:00-13:00"]
      },
      bufferMinutesBefore: 15,
      bufferMinutesAfter: 15,
      maxInterviewsPerDay: 2,
      minNoticeHours: 24
    },
    userConsent: {
      autoApply: false,
      autoReply: false,
      interviewScheduling: false
    },
    rateLimits: {
      applicationsPerDay: 80,
      applicationsPerHour: 10,
      maxPerCompanyPerDay: 1,
      maxPerCompanyPerWeek: 3
    }
  };
}

export function createDefaultSearchProfile(): SearchProfile {
  return {
    searchProfileId: "backend_node_balanced",
    candidateProfileId: "backend-node-main",
    strategy: "balanced",
    providers: {
      hh: {
        enabled: true,
        queries: ["Node.js backend", "NestJS backend", "TypeScript backend"],
        filters: {
          remote: ["remote", "hybrid"],
          salaryMin: 4000,
          currency: "EUR",
          experience: ["3-6", "6+"]
        },
        sort: "newest",
        maxPagesPerRun: 5,
        maxJobsPerRun: 100
      },
      robota: {
        enabled: true,
        queries: ["Node.js", "Backend Developer"],
        filters: {
          remote: true,
          country: ["Ukraine", "remote_global"]
        },
        sort: "newest",
        maxPagesPerRun: 5,
        maxJobsPerRun: 100
      },
      telegram: {
        enabled: true,
        queries: ["Node.js", "Backend", "TypeScript", "NestJS"],
        filters: {
          includeKeywords: ["Node.js", "Backend", "TypeScript", "NestJS"],
          excludeKeywords: ["junior", "intern", "unpaid"]
        },
        sort: "newest",
        maxPagesPerRun: 1,
        maxJobsPerRun: 100
      }
    }
  };
}
