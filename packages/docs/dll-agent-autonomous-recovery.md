# dll-agent Autonomous Recovery

## Runtime Status

| Capability | Status | Notes |
|---|---|---|
| Failure classifier | implemented_runtime_verified | `recovery-loop.ts` classifies command, test, typecheck, lint, build, dependency, permission, config, provider, reasoning parameter, network, doctor, reviewer, final gate, continuation, security, auth, repeated, and unknown failures. |
| Failure fingerprint | implemented_runtime_verified | Fingerprints normalize paths and numbers so repeated failures can be counted without tying the decision to one file line. |
| Recovery decision | implemented_runtime_verified | Decisions produce `continue_local_repair`, `run_verification`, `trigger_reviewer`, `trigger_cross_review`, `request_user_input`, `blocked_budget_exhausted`, or `blocked_security`. |
| Recovery budget | implemented_runtime_verified | Runtime tracks fingerprint, phase, and task attempts through supervisor state. Fingerprint, phase, and task exhaustion produce a blocked report instead of a completion claim. |
| Runtime prompt bridge | implemented_runtime_verified | `prompt.ts` reads the latest tool failure, writes recovery evidence, injects recovery hints, and reuses existing reviewer dispatch for chief-engineer / role-cross escalation. |
| Continuation integration | implemented_runtime_verified | Continuation packets are converted into recovery decisions: missing verification becomes `run_verification`; blocking items become local repair or escalation; user input remains blocked. |
| Role tool policy boundary | implemented_runtime_verified | Recovery does not grant reviewer write access and does not bypass high-risk permission checks. |
| Security/user-input stop | implemented_runtime_verified | Secrets, auth, destructive operations, remote publish, global system modification, and budget exhaustion stop as blocked states instead of blind retries. |

## Failure Types

`command_error`, `test_failure`, `typecheck_failure`, `lint_failure`, `build_failure`, `dependency_missing`, `permission_denied`, `file_not_found`, `config_error`, `provider_error`, `reasoning_param_error`, `network_error`, `doctor_failed`, `reviewer_block`, `final_gate_block`, `continuation_required`, `destructive_action_required`, `secret_or_auth_missing`, `repeated_failure`, `unknown_failure`.

## Budget Rules

- Same failure fingerprint can auto-recover through commander first, then chief-engineer, then role-cross decision before hard exhaustion.
- Same phase has a five-attempt runtime budget.
- Same task has an eight-attempt runtime budget.
- Budget exhaustion writes `recovery.budget_exhausted` and produces `BLOCKED_BUDGET_EXHAUSTED`.

## User Input And Security

Recovery requests user input only for credentials, secrets, login state, destructive actions, remote publishing, global system changes, budget exhaustion, or ambiguous unsafe decisions.

Destructive/security-sensitive paths produce `blocked_security`. They are not converted into automatic shell commands.

## Evidence

Recovery writes redacted evidence:

- `recovery.failure_classified`
- `recovery.decision`
- `recovery.attempt_started`
- `recovery.verification_required`
- `recovery.budget_exhausted`
- `recovery.user_input_required`
- `recovery.security_blocked`
- `recovery.escalated_reviewer`
- existing `recovery.prompt_injected` and `recovery.blocked`

Natural-language repair intent is not evidence. Verification still requires tool output or result/evidence refs.

## Partial / Not Implemented

| Capability | Status | Notes |
|---|---|---|
| Dedicated repair executor | partial_runtime | Recovery injects commander/reviewer instructions and uses existing tool loop; it does not introduce a new repair engine. |
| Cross-session recovery memory | missing | Recovery budget is session/task scoped only. |
| Live doctor execution inside classifier | missing | Doctor failure is classified from existing tool/evidence/result output; the gate does not run doctor by itself. |
