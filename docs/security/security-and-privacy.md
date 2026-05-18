# Security and Privacy

## Defaults

- API routes except `/health` require token auth.
- Live Telegram requires `TELEGRAM_ALLOWED_USER_IDS`; the API webhook also requires `TELEGRAM_WEBHOOK_SECRET` and checks Telegram's `X-Telegram-Bot-Api-Secret-Token` header before command handling.
- Secrets and idempotency keys are redacted from logs and queue payloads.
- LLM inputs are redacted before prompt rendering.
- Raw provider credentials are not stored in code or logs.
- Production irreversible actions require an external `SECRETS_BACKEND`; the env backend is only acceptable for local-safe or non-irreversible operation.
- `SecretReferencePolicy` validates secret references and returns only hashed safe references for display/logging.
- `LocalEncryptedFileSecretStore` provides a production-shaped `local_encrypted_file` backend for controlled environments: it stores AES-GCM ciphertext on disk, returns only `SecretReference` handles, supports rotation/deletion/probe, and is covered by tests that reject plaintext-at-rest leakage. Production irreversible use requires `LOCAL_SECRET_STORE_ROOT` and a `LOCAL_SECRET_STORE_MASTER_KEY` of at least 16 characters.
- `pnpm secrets:probe` verifies the configured `local_encrypted_file` store by reading/decrypting existing references and can generate short-lived `external_secrets_backend` release evidence without outputting raw secret values. It also inventories current safe `SecretReference` handles and emits short-lived `live_credentials_configured` evidence only when all expected providers plus the Telegram bot credential are covered.
- `pnpm secrets:evidence` ingests externally captured managed secret-store probes for `vault`, `aws_secrets_manager`, `gcp_secret_manager`, or `local_encrypted_file`. It requires an asserted live source, hashes backend scope values, rejects raw secret-like fields, and can append expiring `external_secrets_backend` plus `live_credentials_configured` records from safe secret-reference handles.
- `RetentionPolicyEngine` evaluates raw payloads, DOM/screenshots/traces, prompts, recruiter messages, proof packs, and audit logs for purge/retain/legal-hold decisions.

## Required Before Live Rollout

- External secrets-manager provisioning or an explicitly approved `local_encrypted_file` store with protected master-key handling.
- Credential rotation procedure.
- Artifact/proof access controls.
- Scheduled retention job execution for raw payloads, DOM, screenshots, traces, and prompts.
- Dependency and license audit.
- Provider policy checklist sign-off.

## Forbidden

- CAPTCHA bypass.
- Generic agentic browser clicking.
- LLM-triggered send/submit/confirm.
- Unsupported facts in outbound messages.
