# dll-agent Regression Scenarios

Status: RC deterministic/local evaluation complete. Global status remains `GLOBAL-PARTIAL`.

Phase 10 validates the 20 final-target scenarios with deterministic and local test evidence. It does not run live provider calls, live multimodal calls, MCP/Playwright, GitHub, destructive permission tests, or external API workflows.

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
| S11_SECRET_PERMISSION | manual_not_run | Requires manual secrets/permission boundary verification |
| S12_MULTIMODAL_INPUT | live_not_run | Requires live multimodal input/provider verification |
| S19_USER_INTERVENTION_REQUIRED | manual_not_run | Requires manual external token/login/destructive/release decision |

## RC Acceptance

RC passes only if:

- deterministic/local scenario checks pass;
- false pass risk is zero;
- live/manual scenarios remain explicitly not run;
- `/regression-status` does not convert `not_run` into `passed`;
- doctor has no failed checks.

RC does not claim `GLOBAL-PASS`. `GLOBAL-PARTIAL` remains correct until manual/live scenarios are executed and recorded.

