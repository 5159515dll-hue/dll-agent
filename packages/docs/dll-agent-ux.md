# dll-agent UX / Doctor / Observability

Phase 8 adds a conservative runtime observability slice. The TUI layout slice keeps this strictly read-only: it reorganizes existing state without changing routing, gates, recovery, permissions, provider behavior, MCP runtime, LSP, multimodal handling, or Capability Acquisition semantics.

## Implemented Runtime Verified

| Capability | Status | Runtime path |
|---|---|---|
| Task status command | implemented_runtime_verified | `/task-status` is handled locally in `session/prompt.ts` and renders `task-observability.ts` output without an LLM call |
| Task trajectory / flight recorder | implemented_runtime_verified | `task-observability.ts` reads Goal Contract, Supervisor state, Result Ledger, evidence JSONL, and routing evidence |
| Final status visibility | implemented_runtime_verified | `/task-status` exposes `VERIFIED_COMPLETE` / `CONTINUATION_REQUIRED` / `BLOCKED_USER_REQUIRED` / `BLOCKED_BUDGET_EXHAUSTED` / `UNVERIFIED_PARTIAL` / `FAILED` / `UNKNOWN` from existing runtime state |
| Verification visibility | implemented_runtime_verified | Required verification, passed/failed/not_run/unknown counts, and doctor status are rendered without running commands |
| Continuation visibility | implemented_runtime_verified | Last continuation packet id, continuation count, blocking unfinished count, user-input count, and budget exhausted state are displayed when evidence exists |
| Routing visibility | implemented_runtime_verified | `model.routing_decision` entries are summarized as selected models and skipped reviewers |
| Result visibility | implemented_runtime_verified | Result Ledger totals distinguish verified, partial, failed, blocked, unverified, stale, missing-evidence, reusable, and low-confidence results |
| Doctor observability check | implemented_runtime_verified | `dll-doctor.ts` includes `task-observability` health check |
| TUI status panel visibility | implemented_runtime_verified | The panel shows bounded task/final status, verification/doctor, Result Ledger/continuation, active model/role, capability summary, and command activity lines; it keeps terminal foreground/background colors |
| Safe cleanup next action | implemented_runtime_verified | evidence-session pressure points to `dll-agent doctor --repair-safe` |

## Output Contract

`/task-status` shows:

- current session id;
- goal;
- phase, risk, final status taxonomy;
- verification and doctor status;
- continuation packet state;
- required/completed/queued/running reviewers;
- Result Ledger totals, including unverified/stale/low-confidence counts;
- routing decision summary;
- evidence count and latest trajectory events;
- blockers;
- next actions;
- safe cleanup recommendation when evidence sessions exceed the retention threshold.

The renderer redacts secrets through the shared evidence redaction path. It is a read-only status adapter and must not mutate task state, run doctor, start MCP, trigger reviewers, or call a model.

## Partial / Missing

| Capability | Status | Reason |
|---|---|---|
| TUI layout redesign | implemented_runtime_verified | The session panel is organized as global status, task overview, model/capability summary, and command activity mini window |
| Regression dashboard | implemented_runtime_verified | `scenario-evaluation.ts` defines and evaluates 20 real-world acceptance scenarios; doctor reports the suite health |
| Cross-session trajectory comparison | missing | Current trajectory is session-scoped to avoid stale or unsafe reuse |

## Phase 10 Real-World Scenario Evaluation

Phase 10 adds a deterministic/local regression dashboard for the final dll-agent target. It does not call models, does not start MCP/Playwright, does not make live multimodal/provider calls, and does not mutate task state. The evaluator records, for each scenario:

- goal;
- expected route;
- model roles used;
- evidence required;
- final status;
- whether human intervention is required;
- cost/token tier;
- evaluation layer: deterministic / local_smoke / manual / live_required;
- external status: not_run / manual_not_run / live_not_run;
- acceptance refs.

The suite covers 20 scenarios:

1. ordinary short code task;
2. user correction;
3. test failure recovery;
4. typecheck failure recovery;
5. repeated failure escalation;
6. final claim without evidence;
7. unfinished active plan;
8. verified result reuse;
9. stale result revalidation;
10. high-risk provider routing change;
11. secret or permission boundary;
12. MiMo multimodal input;
13. MiMo expired fallback for pure text work;
14. `/role-model-set` model switching;
15. doctor failed blocks PASS;
16. `doctor --repair-safe`;
17. verified final report;
18. normal recoverable problem without user intervention;
19. external user input required;
20. multi-model reviewer conflict.

Status: implemented_runtime_verified for deterministic/local capability mapping by `test/dll-agent/scenario-evaluation.test.ts` and the `real-world-scenario-evaluation` doctor check. Live-only or manual scenarios are intentionally reported as not run; they are not marked as live passed. The global RC status is therefore `GLOBAL-PARTIAL`, not `GLOBAL-PASS`.

## Phase 8.2 Observability Reports

Phase 8.2 adds read-only observability commands and compact TUI status. These
surfaces do not trigger models, reviewers, MCP, MiMo, quota refresh, or repair.

| Capability | Status | Runtime path |
|---|---|---|
| Task trajectory command | implemented_runtime_verified | `/task-trajectory` renders `task-trajectory.ts` events from evidence and Result Ledger refs |
| Model usage report | implemented_runtime_verified | `/model-usage` reads `model.routing_decision`, cost state, and result refs |
| Routing report | implemented_runtime_verified | `/routing-report` shows correctness/cost reasons, skipped reviewers, fallback, and unresolved routing risk |
| Doctor next action | implemented_runtime_verified | `/doctor-next` runs doctor in no-evidence-write mode and maps warn/fail checks to safe next actions |
| Regression status | implemented_runtime_verified | `/regression-status` exposes the 20 acceptance scenarios as `not_run` until actually executed |
| TUI observability line | implemented_runtime_verified | Session panel displays trajectory count, routing count, doctor status, and regression status summary |

Unknown or unavailable data is rendered explicitly as `unknown` or
`not_available`; summaries never claim `passed` without a recorded scenario
result.

## TUI Layout Slice

The dll-agent session panel uses three read-only regions:

- Global status bar: project/session, final status, commander model/source, active role, doctor, quota/cost.
- Task overview: goal, phase/risk, plan blockers, next action, verification, Result Ledger, continuation status.
- Model/capability summary: reviewer state, routing count/model summary, tools/skills/MCP/software counts, running/on-demand/blocked status.

Default TUI language is Chinese for dll-agent-owned labels. Runtime role names,
model ids, provider ids, and evidence refs stay literal so the displayed value
matches runtime state exactly.

For stateless chat or greeting sessions where no Goal Contract, required
verification, Result Ledger packet, reviewer, continuation, or blocker exists,
the panel displays `待命` / `普通对话/待命` / `计划：未建立` instead of showing
engineering completion states such as `UNVERIFIED_PARTIAL`. Detailed state is
still available through `/task-status`.

The command activity mini window is a read-only view over evidence, task trajectory, and Result Ledger command refs. It defaults to compact mode with the latest 3-5 command/tool summaries. Mouse click expands it; `Esc` collapses it. Expanded mode supports scrolling recent command rows and still hides long output and secret values.

Theme policy:

- no forced dll-agent background;
- no global foreground override;
- semantic emphasis only where needed;
- blocked/failed/warn/unknown states remain visible as text;
- no model call, MCP start, command execution, quota refresh, or state mutation during render.

Partial:

- mouse click is the supported expand path; keyboard Enter/Space expansion is intentionally not used to avoid prompt-submit conflicts.
- detailed evidence/result ledger inspection remains in the existing slash commands rather than the default panel.
