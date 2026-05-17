# Runbook: LLM Schema Validation Spike

1. Keep generated outputs out of execution paths.
2. Inspect schema validation failures and prompt/input hashes.
3. Check whether scraped content attempted prompt injection.
4. Add stricter fixtures or schema guards.
5. Resume only after invalid output remains rejected by tests.
