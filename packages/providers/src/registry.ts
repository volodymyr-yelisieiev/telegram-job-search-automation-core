import type { ProviderHealth, ProviderModule, ProviderSearchPlan, ProviderStatus, SearchProfile } from "@job-search/domain";
import { fixtureJobsByProvider } from "./fixtures";
import { ExternalLiveSubmitProviderModule, FixtureProviderModule, hhCapabilities, robotaCapabilities, telegramCapabilities } from "./provider";

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderModule>();

  register(provider: ProviderModule): void {
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): ProviderModule {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${providerId}`);
    }
    return provider;
  }

  list(): ProviderModule[] {
    return [...this.providers.values()];
  }
}

export function createFixtureProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new FixtureProviderModule("hh", hhCapabilities, fixtureJobsByProvider.hh ?? []));
  registry.register(new FixtureProviderModule("robota", robotaCapabilities, fixtureJobsByProvider.robota ?? []));
  registry.register(new FixtureProviderModule("telegram", telegramCapabilities, fixtureJobsByProvider.telegram ?? []));
  return registry;
}

export interface ProviderRegistryOverride {
  providerId: string;
  enabled?: boolean | undefined;
  runtimeKind?: "fixture" | "live" | undefined;
  statusOverride?: ProviderStatus | undefined;
  message?: string | undefined;
  queries?: string[] | undefined;
  filters?: Record<string, unknown> | undefined;
  maxPagesPerRun?: number | undefined;
  maxJobsPerRun?: number | undefined;
  concurrency?: number | undefined;
  liveSubmitEndpoint?: string | undefined;
  liveSubmitAuthTokenEnv?: string | undefined;
  liveSubmitAuthHeader?: string | undefined;
  liveSubmitTimeoutMs?: number | undefined;
}

export function createFixtureProviderRegistryWithOverrides(overrides: ProviderRegistryOverride[]): ProviderRegistry {
  const overrideByProvider = new Map(overrides.map((override) => [override.providerId, override]));
  const registry = new ProviderRegistry();
  for (const provider of createFixtureProviderRegistry().list()) {
    const override = overrideByProvider.get(provider.providerId);
    if (override?.enabled === false) {
      continue;
    }
    registry.register(override ? withProviderOverride(provider, override) : provider);
  }
  return registry;
}

export function createRuntimeProviderRegistryWithOverrides(overrides: ProviderRegistryOverride[], env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const overrideByProvider = new Map(overrides.map((override) => [override.providerId, override]));
  const registry = new ProviderRegistry();
  for (const provider of createFixtureProviderRegistryWithOverrides(overrides).list()) {
    const override = overrideByProvider.get(provider.providerId);
    if (override?.runtimeKind === "live" && override.liveSubmitEndpoint) {
      registry.register(
        new ExternalLiveSubmitProviderModule(provider, {
          endpoint: override.liveSubmitEndpoint,
          authHeader: override.liveSubmitAuthHeader,
          authToken: override.liveSubmitAuthTokenEnv ? env[override.liveSubmitAuthTokenEnv] : undefined,
          timeoutMs: override.liveSubmitTimeoutMs
        })
      );
    } else {
      registry.register(provider);
    }
  }
  return registry;
}

function withProviderOverride(provider: ProviderModule, override: ProviderRegistryOverride): ProviderModule {
  return {
    ...provider,
    providerId: provider.providerId,
    ...(provider.runtimeKind ? { runtimeKind: provider.runtimeKind } : {}),
    capabilities: provider.capabilities,
    healthcheck: async (ctx) => ({
      ...((await provider.healthcheck(ctx)) as ProviderHealth),
      ...(override.statusOverride
        ? {
            status: override.statusOverride,
            message: override.message ?? `status overridden to ${override.statusOverride}`
          }
        : {})
    }),
    compileSearchPlan: async (profile: SearchProfile): Promise<ProviderSearchPlan> => {
      const base = await provider.compileSearchPlan(profile);
      return {
        ...base,
        query: override.queries?.[0] ?? base.query,
        filters: override.filters ?? base.filters,
        maxPagesPerRun: override.maxPagesPerRun ?? base.maxPagesPerRun,
        maxJobsPerRun: override.maxJobsPerRun ?? base.maxJobsPerRun
      };
    },
    authenticate: provider.authenticate.bind(provider),
    discoverJobs: provider.discoverJobs.bind(provider),
    fetchJob: provider.fetchJob.bind(provider),
    normalizeJob: provider.normalizeJob.bind(provider),
    deduplicateKey: provider.deduplicateKey.bind(provider),
    prepareApplication: provider.prepareApplication.bind(provider),
    dryRunApplication: provider.dryRunApplication.bind(provider),
    submitApplication: provider.submitApplication.bind(provider),
    syncInbox: provider.syncInbox.bind(provider),
    replayFlow: provider.replayFlow.bind(provider)
  };
}
