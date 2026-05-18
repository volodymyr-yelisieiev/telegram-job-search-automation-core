# Post-GA Provider Scale

Provider expansion must use the onboarding template and cannot mark a provider `stable` until read-only fixtures, selector packs, fingerprints, canary, replay, rate limits, and disable switch are complete.

## Maintenance SLOs

- Broken selector triage: same business day.
- Provider safe-mode review: within 24 hours.
- Critical duplicate-apply incident: immediate pause and incident review.
- Provider deprecation: disable provider before removing code.

## Tooling And Board

- Scaffold command: `pnpm provider:scaffold <provider-id>`.
- Scorecard board: [provider-scorecard-board.md](../provider-playbooks/provider-scorecard-board.md).
- New providers must ship contract tests and placeholder playbook before implementation starts.
