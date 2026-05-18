# 7-Day Soak Template

For local-safe preflight, run:

```bash
SOAK_ITERATIONS=7 pnpm soak:fixture
```

This accelerated soak does not replace a dated 7-day staging/production run, but it verifies duplicate prevention, proof coverage, canaries, dry-run execution, data quality, and funnel metrics against fixture providers.

To generate the R8 acceptance JSON after the soak:

```bash
ACCEPTANCE_ITERATIONS=7 pnpm acceptance:package
```

Use `RELEASE_EVIDENCE_PATH` with the `GET /release-evidence` output when validating a live sign-off package.

## Run Metadata

| Field | Value |
|---|---|
| Start | TBD |
| End | TBD |
| Environment | TBD |
| Mode | TBD |
| Providers | TBD |
| Operator | TBD |

## Daily Evidence

| Day | Jobs processed | Applications prepared | Submitted | Responses | Interviews | DLQ | Incidents |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |

## Acceptance

- No duplicate applications.
- 100% irreversible actions have policy, validation, idempotency, audit, and proof.
- No unsupported facts in outbound text.
- No unbounded provider hangs.
- Rollback drill completed.
- Acceptance package attached and the fail-closed acceptance checks pass for the signed release.

The `seven_day_soak_passed` release-evidence record must include the run duration plus the acceptance counters:

```json
{
  "evidenceType": "seven_day_soak_passed",
  "status": "passed",
  "expiresAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
  "source": "production-soak",
  "metadata": {
    "startedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
    "completedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
    "duplicateApplicationCount": 0,
    "proofCoveragePercent": 100,
    "stateLossDetected": false,
    "unsupportedFactCount": 0,
    "incidentDrillPassed": true,
    "rollbackDrillPassed": true
  }
}
```
