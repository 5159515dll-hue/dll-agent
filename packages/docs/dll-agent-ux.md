# dll-agent UX / Doctor / Observability

Phase 8 adds a conservative runtime observability slice. It does not redesign the TUI and does not add new model calls.

## Implemented Runtime Verified

| Capability | Status | Runtime path |
|---|---|---|
| Task status command | implemented_runtime_verified | `/task-status` is handled locally in `session/prompt.ts` and renders `task-observability.ts` output without an LLM call |
| Task trajectory / flight recorder | implemented_runtime_verified | `task-observability.ts` reads Goal Contract, Supervisor state, Result Ledger, evidence JSONL, and routing evidence |
| Routing visibility | implemented_runtime_verified | `model.routing_decision` entries are summarized as selected models and skipped reviewers |
| Result visibility | implemented_runtime_verified | Result Ledger totals and unresolved items appear in task status |
| Doctor observability check | implemented_runtime_verified | `dll-doctor.ts` includes `task-observability` health check |
| Safe cleanup next action | implemented_runtime_verified | evidence-session pressure points to `dll-agent doctor --repair-safe` |

## Output Contract

`/task-status` shows:

- current session id;
- goal;
- phase, risk, observable status;
- required/completed/queued/running reviewers;
- Result Ledger totals;
- routing decision summary;
- evidence count and latest trajectory events;
- blockers;
- next actions;
- safe cleanup recommendation when evidence sessions exceed the retention threshold.

The renderer redacts secrets through the shared evidence redaction path. It is a read-only status adapter and must not mutate task state.

## Partial / Missing

| Capability | Status | Reason |
|---|---|---|
| TUI visual redesign | missing | Not in Phase 8 scope; current change is command/doctor observability only |
| Regression dashboard | implemented_runtime_verified | `scenario-evaluation.ts` defines and evaluates 20 real-world acceptance scenarios; doctor reports the suite health |
| Cross-session trajectory comparison | missing | Current trajectory is session-scoped to avoid stale or unsafe reuse |

## Phase 10 Real-World Scenario Evaluation

Phase 10 adds a deterministic regression dashboard for the final dll-agent target. It does not call models and does not mutate task state. The evaluator records, for each scenario:

- goal;
- expected route;
- model roles used;
- evidence required;
- final status;
- whether human intervention is required;
- cost/token tier;
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

Status: implemented_runtime_verified by `test/dll-agent/scenario-evaluation.test.ts` and the `real-world-scenario-evaluation` doctor check.
