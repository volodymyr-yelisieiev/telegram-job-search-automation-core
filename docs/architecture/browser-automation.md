# Browser Automation

Automation is deterministic and proof-bearing. It is not generic agentic clicking.

## Flow Contract

Each provider flow defines:

- flow id and version;
- selector pack version;
- entry state;
- states;
- expected page fingerprint per state;
- guards;
- actions;
- transitions;
- terminal states.

The dry-run runner stops before irreversible submit actions by passing `stopBeforeActions`.

## Provider Coverage

Current local-safe dry-run flows:

- `hh_auto_apply_v1`
- `robota_auto_apply_v1`

Both flows can reach submit boundary in fixture/snapshot tests. Live submit remains disabled.

## Artifacts

`BrowserArtifactManifest` describes stored proof/replay artifacts:

- screenshot keys;
- DOM snapshot keys;
- trace key;
- creation timestamp.

`ReplayService.replayFromArtifacts` generates diagnostics from artifact manifests. The next production step is to bind this to real Playwright contexts and object storage.

## Safe Failure

CAPTCHA, provider terms blocks, anti-automation detection, selector mismatch, and fingerprint mismatch stop the flow and route to manual review or provider safe mode. There is no CAPTCHA bypass path.
