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
| Regression dashboard | missing | Planned for Phase 10 real-world scenario evaluation |
| Cross-session trajectory comparison | missing | Current trajectory is session-scoped to avoid stale or unsafe reuse |
