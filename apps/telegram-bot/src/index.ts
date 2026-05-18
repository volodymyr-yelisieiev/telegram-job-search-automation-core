import { Bot } from "grammy";
import { loadConfig, isLiveTelegramEnabled } from "@job-search/config";
import {
  createRuntimeDatabase,
  InMemoryTaskRunStore,
  PostgresRuntimeDatabase,
  createRuntimeQueue
} from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createRuntimeProviderRegistryWithOverrides } from "@job-search/providers";
import { createTelegramCommandState, handleTelegramCommand } from "./commands";

const config = loadConfig();
const logger = createLogger("telegram-bot");

if (!isLiveTelegramEnabled(config)) {
  logger.warn("telegram_token_missing", {
    message: "Live Telegram bot is disabled. Command handlers are available for tests and local API integration."
  });
} else {
  const db = await createRuntimeDatabase({
    stateBackend: config.persistence.stateBackend,
    postgresUrl: config.postgres.url
  });
  if (!(db instanceof PostgresRuntimeDatabase)) {
    db.systemMode = config.app.mode;
  }
  const state = createTelegramCommandState(db.systemMode);
  const taskRunStore = db instanceof PostgresRuntimeDatabase ? db.taskRunStore : new InMemoryTaskRunStore();
  const queue = createRuntimeQueue({ backend: config.queue.backend, redisUrl: config.queue.redisUrl, taskRunStore });
  const registry = createRuntimeProviderRegistryWithOverrides(config.providers, process.env);
  const configByProviderId = new Map(config.providers.map((providerConfig) => [providerConfig.providerId, providerConfig]));
  const shutdown = async (): Promise<void> => {
    if (db instanceof PostgresRuntimeDatabase) {
      await db.close();
    }
  };

  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });

  const bot = new Bot(config.telegram.token);
  bot.on("message:text", async (ctx) => {
    const senderId = String(ctx.from?.id ?? "");
    if (config.telegram.allowedUserIds.length > 0 && !config.telegram.allowedUserIds.includes(senderId)) {
      await ctx.reply("Access denied.");
      return;
    }
    state.mode = db.systemMode;
    const response = await handleTelegramCommand({
      text: ctx.message.text,
      db,
      state,
      queue,
      taskRunStore,
      irreversibleActionsEnabled: config.app.irreversibleActionsEnabled,
      sourceCatalog: registry.list().map((provider) => ({
        providerId: provider.providerId,
        mode: db.systemMode,
        enabled: configByProviderId.get(provider.providerId)?.enabled ?? true,
        capabilities: provider.capabilities
      }))
    });
    if (db instanceof PostgresRuntimeDatabase) {
      await db.flushPersistence();
    }
    await ctx.reply(response);
  });

  bot.start({
    onStart: (botInfo) => {
      logger.info("telegram_bot_started", { username: botInfo.username });
    }
  });
}
