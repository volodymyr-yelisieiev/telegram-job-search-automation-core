# Runbook: Telegram Webhook Failure

1. Check bot token source and allowed user ids.
2. Verify `/health` on the Control Plane API.
3. Use command handler tests before changing live webhook behavior.
4. Keep outgoing sends disabled if the failure affects approval or manual review flows.
