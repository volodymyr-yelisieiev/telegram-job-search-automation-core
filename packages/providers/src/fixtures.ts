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

export const providerRegressionFixturesByProvider: Record<string, FixtureJob[]> = {
  hh: generateProviderRegressionFixtures("hh", 24),
  robota: generateProviderRegressionFixtures("robota", 24),
  telegram: generateTelegramRegressionFixtures()
};

export function generateStressFixtureJobs(total: number): FixtureJob[] {
  const providers = ["hh", "robota", "telegram"];
  return Array.from({ length: total }, (_, index) => {
    const providerId = providers[index % providers.length]!;
    return makeFixtureJob(providerId, `${providerId}-stress-${index}`, {
      title: index % 11 === 0 ? "Junior PHP Developer" : `Senior Node.js Backend Developer ${index}`,
      companyName: `Stress Company ${index % 500}`,
      workFormat: index % 7 === 0 ? "hybrid" : "remote",
      compensationMin: 4200,
      compensationMax: 6500,
      description:
        "Backend TypeScript Node.js PostgreSQL Redis Docker production systems with reliable APIs, observability, tests and cloud deployment.",
      requirements: ["Node.js", "TypeScript", "PostgreSQL", "Redis", "Docker"],
      language: index % 13 === 0 ? "uk" : "en"
    });
  });
}

function generateProviderRegressionFixtures(providerId: "hh" | "robota", count: number): FixtureJob[] {
  const variants = [
    { suffix: "normal", title: "Senior Node.js Backend Developer", salary: [4500, 6200], workFormat: "remote", language: "en" },
    { suffix: "closed", title: "Closed Backend Developer", salary: [4500, 6200], workFormat: "remote", language: "en" },
    { suffix: "already-applied", title: "Already Applied Node.js Engineer", salary: [4500, 6200], workFormat: "remote", language: "en" },
    { suffix: "missing-salary", title: "TypeScript Backend Engineer", salary: [null, null], workFormat: "remote", language: "en" },
    { suffix: "remote-ambiguity", title: "Backend Engineer Remote Hybrid", salary: [4200, 5400], workFormat: "unknown", language: "en" },
    { suffix: "multilingual", title: "Node.js Backend Engineer Англійська", salary: [4200, 5600], workFormat: "hybrid", language: "uk" }
  ] as const;
  return Array.from({ length: count }, (_, index) => {
    const variant = variants[index % variants.length]!;
    return makeFixtureJob(providerId, `${providerId}-regression-${index}`, {
      title: `${variant.title} ${index}`,
      companyName: `${providerId.toUpperCase()} Regression ${index % 5}`,
      workFormat: variant.workFormat,
      compensationMin: variant.salary[0],
      compensationMax: variant.salary[1],
      description: `Regression case ${variant.suffix}. Node.js TypeScript PostgreSQL Redis Docker. ${
        variant.suffix === "closed" ? "This vacancy is closed." : ""
      } ${variant.suffix === "already-applied" ? "Already applied indicator visible." : ""}`,
      requirements: ["Node.js", "TypeScript", "PostgreSQL", "Redis"],
      language: variant.language
    });
  });
}

function generateTelegramRegressionFixtures(): FixtureJob[] {
  const variants = [
    "clean vacancy",
    "noisy post",
    "repost",
    "agency post",
    "scam-like post",
    "salary missing",
    "contact-only post"
  ];
  return variants.map((variant, index) =>
    makeFixtureJob("telegram", `channel-regression:${index}`, {
      title: `Telegram ${variant} TypeScript Backend`,
      companyName: variant.includes("scam") ? null : `Telegram Company ${index}`,
      workFormat: "remote",
      compensationMin: variant === "salary missing" ? null : 3500,
      compensationMax: variant === "salary missing" ? null : 5000,
      description: `${variant}. Node.js TypeScript PostgreSQL. Contact recruiter in Telegram. ${
        variant.includes("scam") ? "Crypto upfront payment required." : ""
      }`,
      requirements: ["TypeScript", "Node.js", "PostgreSQL"],
      language: "en"
    })
  );
}

function makeFixtureJob(
  providerId: string,
  externalId: string,
  input: {
    title: string;
    companyName: string | null;
    workFormat: string;
    compensationMin: number | null;
    compensationMax: number | null;
    description: string;
    requirements: string[];
    language: string;
  }
): FixtureJob {
  const url = providerId === "telegram" ? `https://t.me/jobs_channel/${externalId}` : `https://${providerId}.example/jobs/${externalId}`;
  return {
    ref: {
      providerId,
      externalId,
      url,
      discoveredAt: fetchedAt
    },
    raw: {
      providerId,
      externalId,
      url,
      fetchedAt,
      payload: {
        title: input.title,
        companyName: input.companyName,
        companyExternalId: input.companyName ? `company-${providerId}-${externalId}` : null,
        location: input.workFormat === "remote" ? "Remote" : "Vienna",
        workFormat: input.workFormat,
        compensationMin: input.compensationMin,
        compensationMax: input.compensationMax,
        compensationCurrency: input.compensationMax === null ? null : "EUR",
        compensationPeriod: input.compensationMax === null ? "unknown" : "month",
        seniority: input.title.toLowerCase().includes("junior") ? "junior" : "senior",
        employmentType: "full_time",
        description: input.description,
        requirements: input.requirements,
        responsibilities: ["Build backend services", "Write tests"],
        niceToHave: ["AWS"],
        language: input.language,
        contactMethod: providerId === "telegram" ? "telegram_dm" : "provider_inbox",
        publicationDate: "2026-05-16"
      }
    }
  };
}
