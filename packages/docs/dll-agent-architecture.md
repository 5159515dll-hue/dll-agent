# dll-agent Architecture

dll-agent remains a governance layer above OpenCode. OpenCode owns providers, sessions, tools, MCP, LSP, transport, and TUI foundations. dll-agent adds role models, gates, evidence, result handoff, routing, permissions, doctor/status, and operational policy.

Current RC status: `GLOBAL-PARTIAL`. Deterministic/local Phase 10 evaluation passed, but manual/live scenarios are not run and must not be reported as passed.

## Runtime Path

```text
User Goal
  -> Goal Contract
  -> Session Prompt Adapter
  -> Supervisor / Routing Policy
  -> Role Model Registry
  -> Role Provider Bridge
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
| Role Provider Bridge | EffectiveRoleModel -> Provider.Service validation, metadata snapshot, fallback/default resolution | hardcoded model defaults outside registry, provider request transformation |
| Provider / ProviderTransform | provider existence, model metadata, baseURL/key, transport, reasoning compatibility | dll-agent role policy |
| Supervisor / Routing Policy | reviewer routing, risk, failure/reviewer signals, routing evidence | provider request formatting |
| Gates | final/evidence/continuation/reconciliation decisions | model selection or tool execution |
| Evidence / Result Ledger | redacted evidence and reusable result packets | natural-language completion claims |
| Session Adapter | MessageV2 shaping for dll-agent local command responses | provider/model resolution or gate logic |
| Session Gate Orchestrator | composing existing gate block reasons and synthetic hints for session loop paths | deciding gate policy or reading provider state |
| Reviewer Dispatch Planner | grouping supervisor subtasks into read-only parallel and write-capable serial batches | executing subtasks or mutating supervisor state |
| Reviewer Result Bridge | converting structured reviewer output into Result Ledger packets | deciding reviewer completion or final gate pass/fail |
| Doctor / Status | read-only health and next actions | hiding failed checks or mutating secrets |

## Phase 9 Extraction

`session-adapter.ts` is the first conservative architecture cut in this phase. It centralizes MessageV2 construction for local dll-agent command responses:

- `/role-models`;
- `/role-model-set`;
- `/task-status`.

The adapter is intentionally narrow. It does not parse role model commands, validate providers, inspect gates, read evidence, or decide routing. `prompt.ts` still performs Effect orchestration and session persistence.

The follow-up Phase 9.1 cut extracts three more narrow seams without changing behavior:

- `session-gate-orchestrator.ts` composes already-computed gate blocks for dedup, capability, and reconciliation checks;
- `reviewer-dispatch.ts` plans supervisor reviewer batch dispatch so read-only reviewers can still run together while write-capable reviewers remain serial;
- `reviewer-result-bridge.ts` converts structured reviewer output into Result Ledger packets.

The Phase 9.2 cut extracts three more adapter seams:

- `session-command-adapter.ts` owns local no-LLM command rendering for task, routing, model usage, doctor next action, regression status, and permissions commands;
- `tui-status-adapter.ts` owns TUI status line building and bounded runtime state reads, leaving the Solid component as layout/refresh glue;
- `doctor-checks.ts` owns observability and scenario doctor checks while `dll-doctor.ts` remains the stable public doctor entrypoint.

These modules are deliberately small. They do not change TUI behavior, provider resolution, role model resolution, routing policy, default models, or gate pass/fail semantics.

The Phase 9.2 Role Provider Bridge cut adds `role-provider-bridge.ts` as the single runtime boundary between Role Model Registry and OpenCode Provider:

- Role Model Registry still owns role -> provider/model, override scope, fallback list, and user-visible source/scope;
- Role Provider Bridge resolves `EffectiveRoleModel`, validates candidates with `Provider.Service.getModel()`, records provider metadata, handles fallback/default model decisions, and writes a provider-validated session snapshot;
- `role-model-runtime.ts` remains as a compatibility wrapper so older call sites can migrate without behavior changes;
- `prompt.ts`, `agent.ts`, reviewer result metadata, TUI status, and doctor status now consume the bridge or bridge snapshot instead of each inventing a final runtime model path.

This cut does not change default commander, `/role-model-set`, reasoning normalization, ProviderTransform, MiMo status, routing, gates, recovery, result ledger, quota, or reviewer trigger behavior.

The Phase 9.3 Session Runtime Adapter cut adds `session-runtime-adapter.ts` as the small boundary between dll-agent runtime decisions and the OpenCode session loop:

- continuation gate results are converted into structured session actions for supervisor state save, evidence write, recovery decision write, synthetic hint injection, Kimi task-completion queueing, or budget-exhausted reporting;
- `prompt.ts` still owns Effect execution, session mutation, model calls, provider transport, tool execution, MCP/LSP runtime calls, and subtask execution;
- the adapter does not change gate semantics, routing, reviewer frequency, Provider/RoleModel resolution, reasoning normalization, MiMo status, permission policy, or Result Ledger behavior.

The Phase 9.4 Supervisor Decomposition cut extracts three supervisor-internal seams without changing reviewer routing behavior:

- `supervisor-trigger-rules.ts` owns the pure trigger-rule ordering used by `decide()`, while `supervisor.ts` keeps cooldown, routing evidence, and session state side effects;
- `supervisor-state-machine.ts` owns supervisor state normalization, reviewer completion state transitions, final-claim block tracking, and metrics snapshot conversion;
- `reviewer-prompt-templates.ts` owns reviewer prompt text and structured JSON examples, while `buildSubtask()` still resolves role/provider, builds ContextHandoffPacket, writes role-run envelope evidence, and returns OpenCode SubtaskPart values.

This cut does not change reviewer trigger conditions, prompt wording, model selection, cooldown, gate strictness, role-tool-policy, Result Ledger semantics, or provider behavior.

## Current Partial Areas

| Area | Status | Reason |
|---|---|---|
| prompt.ts capability/recovery/gate orchestration | partial_runtime | Local command rendering, gate block composition, reviewer dispatch planning, and continuation action composition are extracted; capability action execution, MCP connect, and most supervisor/recovery orchestration still run in prompt loop |
| supervisor modularization | partial_runtime | Result Ledger bridge, trigger rules, prompt templates, and state transitions are extracted; dispatch/result wiring and subtask envelope assembly still remain in supervisor.ts |
| gate decision pure functions | partial_runtime | Several gates are pure, but prompt loop still owns merge/injection behavior |
| TUI summary adapter | implemented_runtime_verified | Status line builders and read adapters are extracted; no TUI redesign in Phase 9 |
| doctor check groups | partial_runtime | Observability/scenario checks are extracted; resource/capability/gate checks remain in dll-doctor.ts for now |
| Role Provider Bridge | implemented_runtime_verified | Runtime role model selection now goes through a bridge that validates via Provider.Service and records a session snapshot |
| Session Runtime Adapter | implemented_runtime_verified | Continuation gate outcomes are now converted to structured runtime actions before prompt.ts executes side effects |

## RC Boundaries

- Deterministic/local checks are release-candidate evidence, not live provider verification.
- Live multimodal/MiMo screenshot evaluation remains `live_not_run`.
- Manual secrets/permission/destructive-boundary evaluation remains `manual_not_run`.
- Architecture modularization is partial by design: `prompt.ts` and `supervisor.ts` still own selected OpenCode runtime side effects to avoid risky rewrites.

## Non-goals

- no provider rewrite;
- no role registry rewrite;
- no TUI redesign;
- no new roles;
- no new model routing behavior;
- no change to `/role-model-set` behavior;
- no change to `reasoning_effort` normalization.
