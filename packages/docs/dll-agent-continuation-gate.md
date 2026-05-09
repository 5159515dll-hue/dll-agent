# dll-agent Continuation Gate

## Runtime Status

| Capability | Status | Notes |
|---|---|---|
| Markdown unfinished-item detection | implemented_runtime_verified | Existing parser detects blocking unfinished work, non-blocking follow-up, and user-input blockers. |
| Final report status-table false-positive guard | implemented_runtime_verified | PASS/PARTIAL/FAIL status tables are not treated as blocking work by themselves. |
| Goal Contract integration | implemented_runtime_verified | `checkContinuationGate()` reads `goal-contract.json` and blocks completion when active plan or success criteria remain pending/blocked. |
| Continuation packet generation | implemented_runtime_verified | Blocking Goal Contract items generate a structured `ContinuationPacket`. |
| Required verification enforcement | implemented_runtime_verified | If Goal Contract requires verification and no real verification evidence is present, the gate returns `PARTIAL_CONTINUED`. |
| Doctor/reviewer blocker enforcement | implemented_runtime_verified | `blocked_completion` and `block_reason` are treated as blocking continuation evidence. |
| Result Ledger blocker aggregation | implemented_runtime_verified | `BLOCKED` / `FAILED` / unresolved `PARTIAL` ResultPackets become continuation blockers; reviewer blocking packets carry context refs into the packet. |
| Runtime final path hard block | implemented_runtime_verified | Both prompt final exit paths run continuation checks before exit and append a final-gate block when continuation is required. |
| Automatic continuation dispatch | implemented_runtime_verified | `ContinuationPacket` becomes dispatcher-ready actions for commander, chief-engineer, and requirements-inspector. |
| Budget exhausted report | implemented_runtime_verified | Exhausted continuation budget yields `BLOCKED_BUDGET_EXHAUSTED` and explicitly prevents `VERIFIED_COMPLETE`. |

## Phase 1.1 Contract Rules

- A final report can be blocked even when the text itself has no unfinished markers if the Goal Contract still has pending or blocked runtime state.
- `non_blocking` plan items and follow-ups do not block verified completion.
- Missing required verification is classified as unverified/partial by the Goal Contract and cannot become verified complete without evidence.
- Continuation gate evidence uses `continuation_gate.blocked`; Goal Contract evaluation evidence uses `goal_contract.evaluated`.

## Phase 2 Dispatch Rules

- Low-risk blocking continuation defaults to `commander`.
- High-risk blocking continuation uses the packet's reviewer role, usually `chief-engineer`.
- Requirements drift or user correction entries can dispatch to `requirements-inspector`.
- `BLOCKED_USER_REQUIRED` does not auto-dispatch; it stops with a user-input blocker.
- Budget exhaustion produces a blocked report rather than a completion claim.

## Phase 2 Packet Schema

The runtime packet remains `packet_type: "task_continuation"` and now includes:

- `goal_contract_ref`, `final_status`, `missing_verification`, `missing_result_refs`, and `blocking_reviewer_findings`.
- `required_actions`, `recommended_next_role`, and `verification_required` for dispatch.
- `evidence_refs` and `context_packet_refs` so the next role can continue from evidence instead of prose.
- `budget_state` with current continuation count and configured limits.

All packet payloads are redacted before evidence writes. Natural language “next steps” are not treated as evidence.

## Final PASS Blocking Conditions

`VERIFIED_COMPLETE` is blocked when any of these are true:

- Goal Contract success criteria or active plan has blocking unfinished work.
- Required verification is `not_run` or failed.
- Result Ledger has blocking, failed, partial-with-unresolved, unverified, stale, or insufficient required results.
- Reviewer blocking findings have not been reconciled.
- Doctor failed evidence/result is present, or doctor verification is required but missing.
- Continuation budget is exhausted, in which case the final status is `BLOCKED_BUDGET_EXHAUSTED`.

## Non-goals

- This phase does not add new reviewer roles.
- This phase does not change model routing or Provider/RoleModel boundaries.
- This phase does not implement a new repair engine; concrete fixes still run through existing commander/reviewer tool loops.
- This phase does not run `dll-agent doctor` inside the gate; it consumes existing doctor evidence/result state and requests missing doctor verification when required.
