# LLM Gateway

The LLM path is structured-output only and cannot execute tools, browser actions, sends, submits, or confirmations.

## Providers

| Provider | Config | Behavior |
|---|---|---|
| `mock` | default | Deterministic local-safe echo through schema validation |
| `openai-compatible` | `LLM_API_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | HTTP JSON completion adapter behind the same schema boundary |

`pnpm llm:smoke` is the explicit-confirm live diagnostic for this boundary. It requires `LLM_SMOKE_CONFIRM_LIVE=true` and `LLM_SMOKE_ASSERT_LIVE=true`, performs one structured JSON diagnostics call, and writes only model, prompt version, input hash, latency, and validation status.

## Controls

- `LLM_TIMEOUT_MS`
- `LLM_MAX_RETRIES`
- `LLM_MAX_INPUT_CHARS`
- prompt version via `PromptRegistry.version`
- redaction via `redactLlmInput`
- schema validation through Zod
- prompt-injection inspection before cover-letter generation and message classification

## Stored Evidence

LLM result objects include:

- `modelVersion`;
- `inputHash`;
- `promptVersion`;
- `estimatedInputChars`;
- validation errors.

Production persistence should store hashes, versions, validation result, latency, and cost estimates, not raw secrets or full credentials.

The live smoke report follows that rule: it stores hashes for `LLM_API_BASE_URL` and `LLM_API_KEY`, never the raw endpoint, key, prompt, or model response body.

## Non-Executor Rule

Prompts instruct the model to return JSON only. Provider actions are performed only by deterministic code after policy, validation, idempotency, and proof checks.
