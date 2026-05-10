# dll-agent Regression Scenarios

Status: Phase 10.2 required live/manual validation complete. Global status is `GLOBAL-PASS` for required live/manual scenarios.

Phase 10 first validated the 20 final-target scenarios with deterministic and local test evidence. Phase 10.2 then ran the required live/manual validation set. Optional Playwright MCP isolated start/stop remains `optional_not_run` because it requires explicit external process authorization and is not required for the required GLOBAL gate.

## Current Result

| Metric | Value |
|---|---:|
| total scenarios | 20 |
| deterministic_pass | 20 |
| deterministic_fail | 0 |
| false_pass_risk | 0 |
| unnecessary_reviewer_scenarios | 0 |
| human_intervention_scenarios | 2 |
| external not_run | 17 |
| manual_not_run | 2 |
| live_not_run | 1 |

`deterministic_pass` means the runtime capability, routing expectation, gate behavior, evidence requirement, and regression tests are present. It does not mean the scenario was live-executed.

## Live Scenario S1: role-model-set commander minimal request

Purpose: verify that `/role-model-set commander <provider/model> --scope session` changes the true commander runtime model and that a minimal no-tool prompt remains commander-only.

Expected route:

- commander uses the session-scope effective model;
- `source=session`;
- no `reasoning_effort=max`;
- no reviewer, task-completion-archivist, final-auditor, executor auto-verifier, MCP, or tool call;
- `model.routing_decision` records `commander_only` with `trigger_reason=trivial_no_tool_task`;
- global/project role model config is not modified.

Regression status: `live_passed`. The live smoke verified session-scope commander switching, no `reasoning_effort=max`, no reviewer/verifier/MCP/tool false positive, and no global/project pollution.

## Live Scenario S0: ordinary greeting

Purpose: verify that a stateless greeting such as "你好" remains a single commander response and is not escalated by supervisor-generated text.

Expected route:

- commander answers the greeting;
- reviewer count remains zero;
- no long-context-archivist, requirements-inspector, chief-engineer, task-completion-archivist, final-auditor, executor auto-verifier, MCP, repo-doctor, or tool call is triggered;
- no Goal Contract required verification is created for the greeting;
- `model.routing_decision` records `commander_only` with `trigger_reason=stateless_greeting_task`;
- self-generated `<task_result>`, Verification Report, reviewer fallback, subtask resume, Result Ledger, routing evidence, doctor, and TUI/status text does not feed back into trigger metrics.

Regression status: `live_passed`. The live retest session `20260510-120122-08636405` / OpenCode session `ses_1eff3ef6fffe9Oj9FfmjrWe90h` recorded `commander_only` with `trigger_reason=stateless_greeting_task`, zero reviewer dispatch, zero tool parts, zero MCP requests, no repo-doctor activation, and no continuation/block state. OpenCode still generated its normal title request; the task response itself used a single commander call.

## Regression Scenario S0b: ordinary informational question

Purpose: prevent the follow-up false positive where "介绍一下 dll-agent" was treated as long-context / high-risk governance work after generated reports and reviewer prose entered the routing signal scan.

Expected route:

- `TaskIntakeClassifier` returns `task_kind=informational`, `interaction_level=L1`;
- route remains commander-only by default;
- no long-context-archivist, requirements-inspector, chief-engineer, task-completion-archivist, final-auditor, executor auto-verifier, repo-doctor, MCP, or tool call is triggered solely by the informational request;
- generated assistant text mentioning Provider/RoleModel/routing/gate/evidence/Result Ledger cannot turn the task into high-risk;
- no typecheck/test/doctor verification is required for the informational answer.

Regression status: `deterministic_passed`. Covered by `task-intake-classifier.test.ts`, `triggers.test.ts`, and `supervisor.test.ts`. Live retest remains recommended before claiming a new live S0b pass.

### S0c Read-only Engineering Explanation

Purpose: prevent read-only engineering explanations from being treated as verified engineering completion just because the assistant answer contains completion words or copied project TODOs.

Expected route:

- intent is classified by category: explanation/summary intent + engineering subject + no mutation/verification command;
- route remains commander-only after the answer;
- generated answer text cannot trigger task-completion-archivist, final-auditor, requirements-inspector, chief-engineer, cross-review, or executor auto-verifier by itself;
- real correction, repeated failure, doctor failed, reviewer block, high-risk work, code mutation, explicit verification, secrets, destructive operations, or multimodal input still override the read-only finalization path.

Regression status: `deterministic_passed`. Covered by category-combination tests, trigger metrics tests, supervisor routing tests, and intent-consensus participant tests.

## Phase 10.2 Required Live/Manual Status

| Scenario | Status | Evidence |
|---|---|---|
| S0 ordinary greeting live scenario | live_passed | "你好" stayed commander-only with no reviewer/verifier/MCP/tool/repo-doctor false positive |
| S0b ordinary informational question | deterministic_passed | "介绍一下 dll-agent" classifies as L1 informational and stays commander-only in deterministic routing tests |
| S1 ordinary short no-tool role-model-set live scenario | live_passed | Session-scope commander switch plus "只回答 OK，不要执行工具。" stayed commander-only |
| A secrets/permission boundary | manual_passed | Fixture permission dry-run blocked/asked for secret paths; no secret value read or printed |
| B destructive command boundary | manual_passed | Fixture permission dry-run blocked/asked for rm/git push/sudo; no destructive command executed |
| C bug -> test fail -> recovery -> verification | deterministic_passed | Temporary fixture produced test failure, recovery decision, repair, and passing verification |
| D unfinished plan -> continuation -> verified complete | deterministic_passed | Goal Contract blocked premature PASS, generated continuation packet, then assessed VERIFIED_COMPLETE after evidence |
| E MiMo multimodal screenshot packet | live_passed | Safe synthetic screenshot with `mimo-v2.5` produced `multimodal_context_packet` and ResultPacket |
| F Playwright MCP isolated start/stop | optional_not_run | Optional scenario; not required without explicit authorization to start external process |
| G doctor repair-safe cleanup | manual_passed | Inactive session/evidence cleanup ran; active sessions, secrets, and processes were protected |

## Scenario Layers

| Layer | Meaning |
|---|---|
| deterministic | Verified by deterministic unit/integration tests and static scenario invariants |
| local_smoke | Verified by local commands or local runtime behavior without external model/API calls |
| manual | Requires user authorization or secrets/destructive-boundary confirmation; not run in RC |
| live_required | Requires a live external provider or multimodal input; not run in RC |

## Not Run Scenarios

| Scenario | Status | Reason |
|---|---|---|
| Playwright MCP isolated start/stop | optional_not_run | Optional external-process validation, not required for required live/manual GLOBAL-PASS |

## RC Acceptance

RC passes only if:

- deterministic/local scenario checks pass;
- false pass risk is zero;
- live/manual scenarios remain explicitly not run;
- `/regression-status` does not convert `not_run` into `passed`;
- doctor has no failed checks.

Required live/manual validation now supports `GLOBAL-PASS` for required scenarios. Optional external-process validation remains explicitly `optional_not_run` and must not be reported as passed.
