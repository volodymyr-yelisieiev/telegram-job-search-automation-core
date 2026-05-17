# Runbook: Provider Selector Update

1. Move provider status to `needs_review` or `apply_disabled`.
2. Capture failing fixture, screenshot, DOM snapshot, URL, and error code.
3. Update selector pack version.
4. Add or update page fingerprint anchors.
5. Run selector/fingerprint regression tests.
6. Run dry-run canary without submit.
7. Restore provider only after proof capture and replay pass.
