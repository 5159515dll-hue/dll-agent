# dll-agent Observability

Status: Phase 8.2 `implemented_runtime_verified`.

This layer is read-only. It does not change routing, gates, recovery, permission,
Provider/RoleModel resolution, MCP state, or model calls.

RC note: Phase 10 deterministic/local scenario evaluation is available through the scenario evaluator and doctor check, but `/regression-status` remains conservative and shows scenarios as `not_run` until a real/manual scenario run records a result. This prevents deterministic pass from being confused with live pass.

## Runtime Surfaces

| Surface | Status | Notes |
|---|---|---|
| Task Trajectory | implemented_runtime_verified | `task-trajectory.ts` builds redacted flight-recorder events from evidence and Result Ledger refs |
| Model Usage Report | implemented_runtime_verified | `model-usage-report.ts` reads `model.routing_decision` evidence, cost state, and result refs |
| Routing Report | implemented_runtime_verified | Same read model as model usage, focused on correctness/cost reasons and unresolved routing risks |
| Doctor Next Action | implemented_runtime_verified | `doctor-next-action.ts` maps doctor warn/fail checks to safe next actions without running repair |
| Regression Scenario Tracker | implemented_runtime_verified | `regression-scenarios.ts` exposes the 20 acceptance scenarios as `not_run` status records |
| Scenario Evaluation Dashboard | implemented_deterministic_verified | `scenario-evaluation.ts` checks deterministic/local acceptance invariants and separately reports manual/live not-run status |
| Local commands | implemented_runtime_verified | `/task-trajectory`, `/model-usage`, `/routing-report`, `/doctor-next`, `/regression-status` are local command responses |
| TUI summary | implemented_runtime_verified | Session panel shows compact trajectory/routing/doctor/regression counts from runtime state |

## Safety Rules

- No report triggers a model call.
- No report starts MCP, Playwright, LSP, or multimodal runtime.
- No report refreshes quota or runs live provider smoke.
- Doctor next actions recommend cleanup or quota refresh, but do not execute them.
- Secret values are redacted by the shared evidence redaction path.
- Unknown data is rendered as `unknown` / `not_available`, never as passed.

## Command Semantics

| Command | Behavior |
|---|---|
| `/task-trajectory` | Shows bounded task flight-recorder events and evidence/result refs |
| `/model-usage` | Shows selected models, roles, correctness/cost reasons, skipped reviewers, and local cost estimate |
| `/routing-report` | Shows routing evidence with candidate models, fallback, skip, and unresolved risk fields |
| `/doctor-next` | Runs doctor in no-evidence-write mode and renders recommended next actions |
| `/regression-status` | Shows the 20 core regression scenarios as `not_run` until a real/manual scenario run records a result |

## Partial / Missing

| Capability | Status | Reason |
|---|---|---|
| Persistent scenario run history | partial_runtime | The registry/status model exists; per-scenario persisted live run results are not implemented in Phase 8.2 |
| Live/manual scenario execution | manual_not_run | RC does not run secrets/permission, destructive, provider live, or multimodal live workflows |
| Cross-session model usage analytics | missing | Current report is session-scoped to avoid stale cross-session attribution |
| Full TUI observability dashboard | missing | Phase 8.2 only adds a compact summary line |
