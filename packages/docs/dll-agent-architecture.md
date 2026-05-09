# dll-agent Architecture

dll-agent remains a governance layer above OpenCode. OpenCode owns providers, sessions, tools, MCP, LSP, transport, and TUI foundations. dll-agent adds role models, gates, evidence, result handoff, routing, permissions, doctor/status, and operational policy.

## Runtime Path

```text
User Goal
  -> Goal Contract
  -> Session Prompt Adapter
  -> Supervisor / Routing Policy
  -> Role Model Registry
  -> Role Model Runtime Bridge
  -> OpenCode Provider
  -> Tools / MCP / Session
  -> Evidence / Result Ledger
  -> Gates
  -> Final Status
```

## Module Boundaries

| Layer | Owns | Must not own |
|---|---|---|
| Role Model Registry | role -> provider/model, session/project/global overrides, fallback, source/scope | provider metadata, keys, request transport, request body normalization |
| Role Model Runtime Bridge | EffectiveRoleModel -> Provider model validation | hardcoded model defaults outside registry |
| Provider / ProviderTransform | provider existence, model metadata, baseURL/key, transport, reasoning compatibility | dll-agent role policy |
| Supervisor / Routing Policy | reviewer routing, risk, failure/reviewer signals, routing evidence | provider request formatting |
| Gates | final/evidence/continuation/reconciliation decisions | model selection or tool execution |
| Evidence / Result Ledger | redacted evidence and reusable result packets | natural-language completion claims |
| Session Adapter | MessageV2 shaping for dll-agent local command responses | provider/model resolution or gate logic |
| Doctor / Status | read-only health and next actions | hiding failed checks or mutating secrets |

## Phase 9 Extraction

`session-adapter.ts` is the first conservative architecture cut in this phase. It centralizes MessageV2 construction for local dll-agent command responses:

- `/role-models`;
- `/role-model-set`;
- `/task-status`.

The adapter is intentionally narrow. It does not parse role model commands, validate providers, inspect gates, read evidence, or decide routing. `prompt.ts` still performs Effect orchestration and session persistence.

## Current Partial Areas

| Area | Status | Reason |
|---|---|---|
| prompt.ts capability/recovery/gate orchestration | partial_runtime | Still in prompt loop; should be extracted in small behavior-preserving cuts |
| supervisor modularization | partial_runtime | Routing policy already extracted, but reviewer dispatch/result wiring remains concentrated |
| gate decision pure functions | partial_runtime | Several gates are pure, but prompt loop still owns merge/injection behavior |
| TUI summary adapter | partial_runtime | Status adapters exist; no TUI redesign in Phase 9 |

## Non-goals

- no provider rewrite;
- no role registry rewrite;
- no TUI redesign;
- no new roles;
- no new model routing behavior;
- no change to `/role-model-set` behavior;
- no change to `reasoning_effort` normalization.
