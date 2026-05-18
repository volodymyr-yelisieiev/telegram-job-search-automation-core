# Provider Auth Expired Runbook

## Trigger

Use this runbook when provider canaries, dry-runs, inbox sync, or submit flows fail with `auth_expired`, `login_required`, `session_expired`, or account lock signals.

## Immediate Actions

1. Disable or downgrade the provider to `read_only`.
2. Move queued apply/reply tasks for that provider to retry or DLQ according to policy.
3. Confirm no CAPTCHA or anti-automation bypass is attempted.
4. Notify the operator responsible for credential rotation.

## Recovery

- Rotate credentials or browser session references in the approved secrets backend.
- Run provider canary and dry-run boundary checks.
- Record `live_credentials_configured` and `live_canary_passed` release evidence if this affects a rollout.
- Re-enable review-first before any controlled automation.
