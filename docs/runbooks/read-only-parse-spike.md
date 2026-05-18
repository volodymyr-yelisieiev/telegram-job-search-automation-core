# Read-Only Parse Spike

Trigger: `read_only_parse_spike`.

1. Check provider fixture/live parse samples and recent selector/fingerprint changes.
2. Compare extraction confidence by provider and language.
3. Disable affected provider write modes; keep read-only only if raw ingest is still reliable.
4. Add failing samples to regression fixtures before re-enabling.
