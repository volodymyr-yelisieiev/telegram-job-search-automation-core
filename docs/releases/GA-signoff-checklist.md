# GA Sign-Off Checklist

Checklist version: `ga-signoff/v1`.

This artifact is attached to the R8 acceptance package. Local-safe runs should leave the live sign-off checks blocked until external evidence exists.

The machine-readable template is `docs/examples/ga-signoff.example.json`. Copy it to `ga-signoff.json`, replace every example value with the real decision record, and run the live acceptance bundle plus completion audit with `GA_SIGNOFF_PATH=ga-signoff.json`, `RELEASE_EVIDENCE_PATH=release-evidence.json`, and `RUNTIME_PREFLIGHT_PATH=runtime-preflight.json`. The runtime preflight must match the current production env and be fresh within the audit window, 24 hours by default. Example signer names, notes, or evidence references are treated as blockers.

When `LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true`, the final live acceptance command must also set `LIVE_PROOF_INPUTS_ASSERT_LIVE=true` and pass the six prerequisite live proof inputs plus their source URLs:

```bash
LIVE_PROOF_INPUTS_ASSERT_LIVE=true EXTERNAL_SECRETS_EVIDENCE_INPUT_PATH=live-secrets-probe.json EXTERNAL_SECRETS_EVIDENCE_SOURCE=<live-workflow-url> CANARY_EVIDENCE_RESULTS_PATH=live-canary-results.json CANARY_EVIDENCE_SOURCE=<live-workflow-url> PROVIDER_SUBMIT_EVIDENCE_INPUT_PATH=live-provider-submit-proof.json PROVIDER_SUBMIT_EVIDENCE_SOURCE=<live-workflow-url> CALENDAR_EVIDENCE_INPUT_PATH=live-calendar-smoke.json CALENDAR_EVIDENCE_SOURCE=<live-workflow-url> OUTBOUND_EVIDENCE_INPUT_PATH=live-dispatch-proof.json OUTBOUND_EVIDENCE_SOURCE=<live-workflow-url> SOAK_EVIDENCE_INPUT_PATH=live-7-day-soak.json SOAK_EVIDENCE_SOURCE=<live-workflow-url> RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true pnpm roadmap:live-acceptance
RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 pnpm roadmap:completion-audit
```

## Required Checks

- P0/P1 issues closed.
- P2/P3 issues have owner and timeline.
- Critical runbooks reviewed or drilled.
- Residual risks accepted by product/engineering/ops.
- Post-GA maintenance plan ready.
- `evidenceRefs.issueRegister`, `evidenceRefs.runbookDrillReport`, `evidenceRefs.residualRiskRecord`, and `evidenceRefs.maintenancePlan` point to the real release record artifacts.
- `LIVE_PROOF_INPUTS_ASSERT_LIVE=true ... LIVE_ACCEPTANCE_VALIDATE_INPUT_BUNDLE=true pnpm roadmap:live-acceptance` passes.
- `RELEASE_EVIDENCE_PATH=release-evidence.json GA_SIGNOFF_PATH=ga-signoff.json RUNTIME_PREFLIGHT_PATH=runtime-preflight.json ACCEPTANCE_ITERATIONS=7 pnpm roadmap:completion-audit` passes.

## Sign-Off

| Role | Name | Date | Decision | Notes |
|---|---|---|---|---|
| Product owner | TBD | TBD | TBD | |
| Engineering | TBD | TBD | TBD | |
| Operations | TBD | TBD | TBD | |
| Security | TBD | TBD | TBD | |
