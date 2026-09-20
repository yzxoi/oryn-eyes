# Qwen3.8-27B on the SII vLLM endpoint

## Context

The GLM Coding Plan endpoint is a paid external dependency. An SII-hosted vLLM endpoint serving `Qwen3.8-27B` (an OpenAI-compatible `/v1` chat API with a ~1M-token window, `max_model_len=1,010,000`) is available inside the same infrastructure as the deployment host, so the service should run on it with configuration plus small model-definition changes.

## Decision

Keep `glm-5.3-flash` as the packaged default and add `Qwen3.8-27B` as a first-class model definition selected through `ORYN_BASE_URL` / `ORYN_API_KEY` / `ORYN_MODEL`. Verified against the live endpoint: image input through data-URL attachments, tool calls, `response_format: json_object`, and streaming.

Endpoint-specific mappings:

- `reasoning_effort` accepts only `none/low/medium`. The service-level `high`/`xhigh` is rejected by the app layer and `max` by request validation, while omitting the field selects the endpoint's strongest built-in level with thinking enabled by default (confirmed: the `reasoning` field carries chain-of-thought). Oryn's `max` variant therefore omits `reasoning_effort`, and `high` maps to `medium`.
- `chat_template_kwargs` is NOT used: Core does not forward unknown model options, and the endpoint already thinks by default without it.
- Thinking output arrives in the `reasoning` field; the OpenAI-compatible provider normalizes `reasoning_content` and `reasoning` alike, so no interleaved configuration is required for parsing.
- The endpoint rejects multiple or mid-conversation system messages ("System message must be at the beginning"). Core's system aggregation is opt-in, so the worker enables the `mergeSystemMessages` provider option, which joins all system prompts into one leading system message.
- The `/health` ready log derives context and multimodality from the model definition instead of hardcoding GLM values.
- The runner executes the built `.runtime/worker.js` bundle, not the worker source. `bun run worker:build` must be re-run after changing `src/worker.ts` or `src/model.ts`; an outdated bundle silently applies stale model definitions and provider options.

## Verification

Endpoint capability probes covered effort mapping, dual-system rejection, tool calls, image parts, `json_object` with tools, streaming, and the omitted-effort default. A mock-provider smoke run with `ORYN_MODEL=Qwen3.8-27B` exercises the real Core against the model definition (request assertions derive from it), and deployment validation runs the real service end to end against the live endpoint on the deployment host.

## Sources

- SII inference endpoint `/v1/models` and `/v1/chat/completions` probes (2026-09-20): model metadata, effort acceptance, capability checks.
- Synergy Core `provider/transform.js` / `session/llm.js`: `mergeSystemMessages` is an opt-in provider option that collapses leading system messages into one.
