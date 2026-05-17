# Runbook: CAPTCHA Or Blocking Detected

1. Stop irreversible actions for the provider account.
2. Save screenshot, DOM snapshot, URL, timestamp, and flow run id.
3. Set provider/account to `degraded`, `read_only`, or `blocked`.
4. Create manual review item.
5. Do not bypass CAPTCHA or anti-automation controls.
6. Resume only after explicit operator review.
