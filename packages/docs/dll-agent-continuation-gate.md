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

## Non-goals

- This phase does not add new reviewer roles.
- This phase does not change model routing or Provider/RoleModel boundaries.
- This phase does not implement actual repair execution; Phase 3 adds recovery policy, while concrete fixes still run through commander/reviewer tool loops.
