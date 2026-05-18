# Runbook: Telegram Webhook Failure

1. Check bot token source, allowed user ids, and `TELEGRAM_WEBHOOK_SECRET` rotation history.
2. Verify `/health` on the Control Plane API.
3. Confirm Telegram is sending `X-Telegram-Bot-Api-Secret-Token` and that the API returns `401 unauthorized_telegram_webhook` for missing or stale secrets.
4. Use command handler and webhook tests before changing live webhook behavior.
5. Keep outgoing sends disabled if the failure affects approval or manual review flows.
