import { Bot } from "grammy";
import { loadConfig, isLiveTelegramEnabled } from "@job-search/config";
import { localDb } from "@job-search/db";
import { createLogger } from "@job-search/observability";
import { createTelegramCommandState, handleTelegramCommand } from "./commands";

const config = loadConfig();
const logger = createLogger("telegram-bot");
const state = createTelegramCommandState(config.app.mode);

if (!isLiveTelegramEnabled(config)) {
  logger.warn("telegram_token_missing", {
    message: "Live Telegram bot is disabled. Command handlers are available for tests and local API integration."
  });
} else {
  const bot = new Bot(config.telegram.token);
  bot.on("message:text", async (ctx) => {
    const senderId = String(ctx.from?.id ?? "");
    if (config.telegram.allowedUserIds.length > 0 && !config.telegram.allowedUserIds.includes(senderId)) {
      await ctx.reply("Access denied.");
      return;
    }
    const response = await handleTelegramCommand({ text: ctx.message.text, db: localDb, state });
    await ctx.reply(response);
  });

  bot.start({
    onStart: (botInfo) => {
      logger.info("telegram_bot_started", { username: botInfo.username });
    }
  });
}
