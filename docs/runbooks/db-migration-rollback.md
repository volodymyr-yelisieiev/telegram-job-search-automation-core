# DB Migration Rollback Runbook

## Trigger

Use this runbook when a migration fails, a schema change blocks API/worker startup, or runtime state cannot hydrate after deploy.

## Immediate Actions

1. Stop deploy and keep workers paused.
2. Snapshot the database or confirm the latest backup restore point.
3. Identify the failed migration version and whether it is expand-only or destructive.
4. Keep API in maintenance or `paused` mode until state hydration succeeds.

## Recovery

- Prefer forward fixes for expand-only migrations.
- For destructive changes, restore from backup or run the documented rollback SQL for the affected version.
- Re-run migration smoke and repository contract tests.
- Confirm `/status`, `/queues`, `/release-evidence`, and `/release-gates` respond before resuming workers.
