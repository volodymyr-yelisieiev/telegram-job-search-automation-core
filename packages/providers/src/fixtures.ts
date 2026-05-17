import type { RawJobPayload, RawJobRef } from "@job-search/domain";

const fetchedAt = "2026-05-16T10:30:00.000Z";

export interface FixtureJob {
  ref: RawJobRef;
  raw: RawJobPayload;
}

export const hhFixtureJobs: FixtureJob[] = [
  {
    ref: {
      providerId: "hh",
      externalId: "hh-1001",
      url: "https://hh.example/vacancy/1001",
      discoveredAt: fetchedAt
    },
    raw: {
      providerId: "hh",
      externalId: "hh-1001",
      url: "https://hh.example/vacancy/1001",
      fetchedAt,
      payload: {
        title: "Senior Node.js Backend Developer",
        companyName: "Example GmbH",
        companyExternalId: "company-100",
        location: "Remote, Europe",
        workFormat: "remote",
        compensationMin: 4500,
        compensationMax: 6200,
        compensationCurrency: "EUR",
        compensationPeriod: "month",
        seniority: "senior",
        employmentType: "full_time",
        description:
          "We build payment infrastructure and need a backend engineer with Node.js, TypeScript, NestJS, PostgreSQL, Redis and Docker. Remote collaboration in Europe.",
        requirements: ["Node.js", "TypeScript", "NestJS", "PostgreSQL", "Redis"],
        responsibilities: ["Build APIs", "Improve reliability", "Own backend services"],
        niceToHave: ["AWS", "GraphQL"],
        language: "en",
        contactMethod: "provider_inbox",
        publicationDate: "2026-05-16"
      }
    }
  },
  {
    ref: {
      providerId: "hh",
      externalId: "hh-1002",
      url: "https://hh.example/vacancy/1002",
      discoveredAt: fetchedAt
    },
    raw: {
      providerId: "hh",
      externalId: "hh-1002",
      url: "https://hh.example/vacancy/1002",
      fetchedAt,
      payload: {
        title: "Junior PHP Developer",
        companyName: "Low Fit Ltd",
        location: "Office only, Warsaw",
        workFormat: "office",
        compensationMin: 1500,
        compensationMax: 2200,
        compensationCurrency: "EUR",
        compensationPeriod: "month",
        seniority: "junior",
        employmentType: "full_time",
        description: "Junior PHP role, office only, no remote.",
        requirements: ["PHP"],
        responsibilities: ["Maintain legacy app"],
        niceToHave: [],
        language: "en",
        contactMethod: "provider_inbox",
        publicationDate: "2026-05-15"
      }
    }
  }
];

export const robotaFixtureJobs: FixtureJob[] = [
  {
    ref: {
      providerId: "robota",
      externalId: "robota-2001",
      url: "https://robota.example/jobs/2001",
      discoveredAt: fetchedAt
    },
    raw: {
      providerId: "robota",
      externalId: "robota-2001",
      url: "https://robota.example/jobs/2001",
      fetchedAt,
      payload: {
        title: "Node.js Backend Engineer",
        companyName: "Remote Systems UA",
        companyExternalId: "company-200",
        location: "Remote",
        workFormat: "remote",
        compensationMin: 4000,
        compensationMax: 5200,
        compensationCurrency: "EUR",
        compensationPeriod: "month",
        seniority: "middle_plus",
        employmentType: "contract",
        description:
          "Remote backend contract for TypeScript, Node.js, PostgreSQL, Docker and AWS. Product team, async-friendly process.",
        requirements: ["Node.js", "TypeScript", "PostgreSQL", "Docker"],
        responsibilities: ["Develop product backend", "Write tests", "Support production"],
        niceToHave: ["AWS"],
        language: "en",
        contactMethod: "email",
        publicationDate: "2026-05-16"
      }
    }
  }
];

export const telegramFixtureJobs: FixtureJob[] = [
  {
    ref: {
      providerId: "telegram",
      externalId: "channel-1:3001",
      url: "https://t.me/jobs_channel/3001",
      discoveredAt: fetchedAt
    },
    raw: {
      providerId: "telegram",
      externalId: "channel-1:3001",
      url: "https://t.me/jobs_channel/3001",
      fetchedAt,
      payload: {
        title: "TypeScript Backend Developer",
        companyName: "Telegram Startup",
        location: "Remote",
        workFormat: "remote",
        compensationMin: null,
        compensationMax: null,
        compensationCurrency: null,
        compensationPeriod: "unknown",
        seniority: "middle_plus",
        employmentType: "contract",
        description:
          "Hiring TypeScript Backend Developer. Node.js, PostgreSQL, Redis. Remote. Contact recruiter in Telegram. No automatic Telegram apply is allowed by policy.",
        requirements: ["TypeScript", "Node.js", "PostgreSQL", "Redis"],
        responsibilities: ["Backend product development"],
        niceToHave: ["NestJS"],
        language: "en",
        contactMethod: "telegram_dm",
        publicationDate: "2026-05-16"
      }
    }
  }
];

export const fixtureJobsByProvider: Record<string, FixtureJob[]> = {
  hh: hhFixtureJobs,
  robota: robotaFixtureJobs,
  telegram: telegramFixtureJobs
};
