# Dedup Anomaly

Trigger: `dedup_anomaly`.

1. Inspect canonical URL, content hash, and company-role duplicate rates by provider.
2. Sample false positives and false negatives against the fixture regression set.
3. Move affected provider to `read_only` or `apply_disabled` if duplicate risk can affect submits.
4. Update dedup fixtures and threshold notes before restoring controlled auto-apply.
