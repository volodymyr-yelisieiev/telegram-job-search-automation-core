# Deployment and Rollback

## Environments

- `local`: default fixture/memory mode.
- `dev`: Postgres/Redis with fixture providers.
- `staging`: provider credentials may exist, irreversible actions disabled unless explicitly approved.
- `production`: API token required, Telegram allowlist required, live providers only behind rollout gates.
- Production irreversible actions require `SECRETS_BACKEND` to be an external store such as `vault`, `aws_secrets_manager`, `gcp_secret_manager`, or explicitly approved `local_encrypted_file`; `env` is blocked for that mode. `local_encrypted_file` requires protected `LOCAL_SECRET_STORE_ROOT` and `LOCAL_SECRET_STORE_MASTER_KEY` values.

## Deploy

1. Build image from `Dockerfile`.
2. Run `pnpm db:migrate`.
3. Start API with `STATE_BACKEND=postgres`.
4. Start workers with the same config.
5. Run provider canaries.
6. Record external release evidence with `/release-evidence`.
7. Verify `/queues`, `/dlq`, `/availability`, `/retention`, provider readiness, `/release-evidence`, and `/release-gates`.
8. Keep mode `read_only` or `review_first` until release gate sign-off.

## Rollback

1. Switch mode to `paused`.
2. Stop irreversible queues.
3. Deploy previous image.
4. Re-run health and canary checks.
5. Resume only read-only queues first.

Schema rollback uses expand/contract rules. Do not drop columns or tables in the same release that introduces them.
