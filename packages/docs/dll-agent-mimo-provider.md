# dll-agent MiMo Provider Status

MiMo is an optional provider/model source for dll-agent roles. It must remain visible in status UI even when no public quota endpoint is available.

## Responsibilities

Role Model Registry may assign MiMo to a role and report the source/scope of that assignment.

OpenCode Provider remains responsible for MiMo provider existence, model metadata, API key/baseURL, transport, request body compatibility, multimodal capability, quota/status, and provider errors.

## Status And Quota

MiMo status is not the same as MiMo quota. If no official quota endpoint is available, dll-agent must not fabricate a quota request.

The quota/status file and TUI panels may show:

- `missing_key`
- `configured`
- `expired`
- `quota_unavailable`
- `no_quota_endpoint`
- `unavailable`
- `local_estimate_only`

When a MiMo key is configured but no quota endpoint is known, the expected display is `configured; quota unavailable` or `quota unavailable`, with local cost estimates only.

## Coding Loop Guard

- `mimo-v2.5-pro` may be used as an agentic fallback or high-risk cross-review candidate when explicitly routed.
- `mimo-v2.5` is for multimodal input understanding.
- TTS/voice/audio-style MiMo models must not be assigned to coding roles or enter pure text/code tasks.
- Pure text/code tasks must not trigger the multimodal reviewer without an actual non-text attachment.

## Reasoning Effort Compatibility

MiMo is OpenAI-compatible and may reject `reasoning_effort=max`. The final request options normalization maps unsupported `max` to `high` or removes the field before SDK/provider invocation.

This is verified in tests with registry/wrapper-style `reasoningEffort=max`; no illegal `reasoning_effort=max` should reach the request body.

## Verification Status

- Status UI visibility: implemented for TUI home/sidebar and quota status file.
- Quota endpoint: partial, no public endpoint assumed.
- Live quota: not live verified unless a real endpoint/key is available.
- Request compatibility: mock verified through ProviderTransform tests.
