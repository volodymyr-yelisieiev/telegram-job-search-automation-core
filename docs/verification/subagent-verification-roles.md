# Subagent Verification Roles

This pass used four read-only verification roles as an audit swarm. The parent agent owns code changes and final verification.

| Role | Agent | Responsibility | Output Applied |
|---|---|---|---|
| PRD compliance auditor | Ptolemy | Map implemented behavior against `docs/prd/Telegram Job Search Automation v1.0.md`; identify implemented, partial, deferred, and externally blocked areas. | Added compliance matrix, proof/policy/search-run persistence, `/mode` mutation support, non-stub local response/interview reads, package/runtime smoke gaps. |
| Coverage maximizer | Meitner | Find highest-yield uncovered lines/branches and recommend tests to reach the 90-95% range. | Expanded Telegram/API/domain/automation/observability/provider/worker tests and raised global thresholds to 95/95/95/90. |
| Safety/security auditor | Socrates | Check irreversible-action boundaries, proof/audit linkage, CAPTCHA safe-mode, inbox idempotency, redaction, and LLM prompt-injection handling. | Added proof pack audit links, policy check records, CAPTCHA provider safe-mode, inbox dedup/classification records, deeper redaction, and cover-letter injection blocking. |
| Runtime/API/worker auditor | Gauss | Verify manifests, smoke scripts, migration operation, process entrypoints, API surface, worker behavior, and docs. | Added direct package dependencies, `pnpm db:migrate`, `pnpm smoke:local`, broader API smoke, worker smoke coverage, and README updates. |

Definition of done for this pass:

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, and `pnpm build` pass.
- Global coverage is enforced at statements 95%, lines 95%, functions 95%, branches 90%.
- Docker-backed Postgres migration verification passes.
- API and worker local smoke checks pass without live scraping or irreversible actions.
- PRD compliance is documented with explicit deferred/external blockers.
