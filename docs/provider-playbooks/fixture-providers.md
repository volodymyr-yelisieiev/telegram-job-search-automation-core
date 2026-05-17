# Fixture Provider Playbook

The first provider modules are intentionally local-safe:

- `hh`: fixture read-only discovery, inbox sync, dry-run apply boundary, selector pack and fingerprints.
- `robota`: fixture read-only discovery, inbox sync, dry-run apply boundary.
- `telegram`: fixture channel ingest only; no auto-apply or recruiter reply.

Live provider enablement requires:

- provider onboarding checklist from PRD section 8.4;
- real fixture corpus;
- canaries;
- dry-run success rate at or above 95%;
- proof pack verification;
- explicit review of provider terms and blocking behavior.
