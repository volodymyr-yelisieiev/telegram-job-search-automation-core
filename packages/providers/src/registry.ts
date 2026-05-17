import type { ProviderModule } from "@job-search/domain";
import { fixtureJobsByProvider } from "./fixtures";
import { FixtureProviderModule, hhCapabilities, robotaCapabilities, telegramCapabilities } from "./provider";

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
