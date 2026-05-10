# dll-agent Model Routing

## Purpose

Correctness-Aware Routing decides when dll-agent should stay with commander, trigger a reviewer, trigger multiple reviewers, call role-cross, or block because a correctness-required review could not run.

This policy is not a cost-only guard. Cost control is allowed only when it removes duplicate, stale, low-value, or already-verified work. It must not skip a reviewer that is required for correctness, safety, evidence sufficiency, or user-goal alignment.

## Runtime Boundary

Role Model Registry remains the single entry point for role-to-model selection. Provider remains responsible for provider metadata, keys, transport, request normalization, capability checks, quota/status, and errors.

Routing may choose a role and record the selected role model, but it does not bypass Provider resolution and it does not rewrite Provider/RoleModel ownership.

## Decision Inputs

Implemented runtime inputs:

- user correction signals;
- repeated failure fingerprint;
- reviewer conflict;
- final completion claim;
- verified tool evidence;
- high-risk task signals for provider, routing, gate, evidence, result ledger, permissions, model switching, doctor, quota/cost, MCP runtime, destructive actions, and secrets/auth;
- Result Ledger sufficiency and dedup state;
- reviewer cooldown and budget state;
- role tool policy constraints.

Partial inputs:

- some low-level tool failures still arrive through message scanning instead of direct tool-state hooks;
- live provider availability is recorded through existing Provider/RoleModel paths, not rechecked inside routing itself.

## Actions

Routing evidence uses these actions:

- `commander_only`: low-risk work continues with commander and no reviewer.
- `trigger_reviewer`: one role is required for correctness or finalization.
- `trigger_multiple_reviewers`: high-risk work may need two or three reviewers under budget/cooldown.
- `trigger_cross_review`: repeated failure, reviewer conflict, or final/gate disagreement needs role-cross arbitration.
- `trigger_final_auditor`: final/high-risk claim needs final audit.
- `skip_reviewer`: reviewer skipped because it is duplicate, cooled down, already completed, or budget-limited.
- `blocked_provider_unavailable`: provider unavailability prevents a correctness-required route.

## Trigger Rules

Implemented runtime rules:

- Ordinary low-risk tasks write `commander_only` routing evidence and trigger zero reviewers.
- `trivial_no_tool_task` covers short, explicit answer-only prompts such as "只回答 OK，不要执行工具。"; it stays commander-only, suppresses reviewer/verifier/task-completion/final-auditor dispatch, and writes `model.routing_decision` with `trigger_reason=trivial_no_tool_task`.
- `stateless_greeting_task` covers short greetings or acknowledgements such as "你好", "hello", "hi", "在吗", "谢谢", "thanks", "ok", and "好的". It is commander-only, does not create verification requirements, does not activate repo-doctor, and writes `model.routing_decision` with `trigger_reason=stateless_greeting_task`.
- `TaskIntakeClassifier` now classifies user-origin input into interaction levels before routing:
  - `L0`: stateless greeting / no-op chat. Commander-only, zero reviewer, no repo-doctor, no complex Goal Contract, no verification, no continuation, no final-auditor, no tools, no MCP.
  - `L1`: informational. Examples: "介绍一下 dll-agent", "什么是 xxx", "explain xxx". Commander-only by default, no tools, no typecheck/test/doctor verification, no full governance stack.
  - `L2`: light engineering analysis. Read-only analysis, code structure explanation, or planning; may read files but does not write by default.
  - `L3`: coding / debugging / verification. Uses Goal Contract, Recovery Loop, Result Ledger, and required verification.
  - `L4`: high risk. Provider/routing/gate/evidence/permission, secrets/auth, destructive commands, push/release, system/global mutation, large refactors, MCP runtime, doctor failed, or high-cost provider work. Reviewer and strict permission/final/evidence gates are required and cannot be downgraded by model classification.
- Intent judgement is category-based, not phrase-based:
  - deterministic intake first checks intent category, subject type, requested side effects, verification needs, and hard safety signals;
  - if deterministic confidence is low, the runtime plan is `single_model_judge` using the primary non-OpenAI commander model;
  - if that single-model judgement is still low confidence, the plan escalates to `multi_model_consensus` across all distinct configured `/role-model-set` effective models except OpenAI, TTS, VoiceClone, and speech/audio models;
  - L4 hard safety rules always win before model judgement and cannot be downgraded by consensus.
- `read_only_answer` finalization applies to user-origin read-only engineering analysis/explanation categories, not to exact sentences. It suppresses task-completion-archivist, final-auditor, and executor auto-verifier only when there is no mutation request, no verification request, no failure, no correction, no reviewer block, no doctor failure, no multimodal input, and no high-risk signal.
- User-origin-only source filtering is mandatory. `/role-model-set`, `/role-models`, `/task-status`, TUI/status text, doctor reports, verification reports, reviewer outputs, fallback reviewer summaries, Result Ledger summaries, routing evidence summaries, rendered ContextHandoffPacket text, `<task_result>`, subtask resume text, model usage reports, and regression reports may be recorded as evidence/trajectory, but they cannot create user-origin routing triggers.
- Policy manifests can extend deterministic intake rules without source changes:
  - global: `~/.dll-agent/config/task-intake-policy.jsonc`;
  - project: `.dll-agent/task-intake-policy.jsonc`;
  - project entries overlay global entries. Supported keys include `greetings`, `informational`, `light_engineering_analysis`, `coding`, `debugging`, `verification`, `planning`, `permission`, `multimodal`, and `high_risk`.
- Self-generated runtime text such as `<task_result>`, `<compact-review-context>`, Verification Report, reviewer fallback summaries, subtask resume text, Result Ledger summaries, routing evidence summaries, doctor reports, and TUI/status text is filtered out of user-origin trigger metrics. It remains valid evidence/trajectory data, but it cannot create high-risk, long-context, final-claim, or requirements-correction triggers.
- User correction triggers `requirements-inspector`.
- Repeated failure escalates from commander repair to `chief-engineer`, then role-cross/cross-review decision.
- Final claim without evidence is blocked by evidence/final gate and may trigger verifier/final audit.
- High-risk provider/routing/gate/evidence/result-ledger/permission/model-switching work can trigger multiple reviewers, bounded by budget and cooldown.
- Verified non-stale Result Ledger packets suppress duplicate reviewer dispatch.
- Stale, partial, failed, or missing-evidence results remain eligible for reviewer/recovery.
- MiMo-V2.5 is not routed into pure text/code tasks.
- TTS/VoiceClone models are excluded from coding routes.
- OpenAI is not default for ordinary tasks; it is on-demand final/high-risk audit only.

## Trivial No-tool Guard

`trivial_no_tool_task` and `stateless_greeting_task` are narrow live-smoke guards, not general cost reduction rules.

It can suppress reviewers only when the latest user message is short, explicitly asks for a simple text answer, explicitly says not to use tools/commands, and the recent session has no file path, code-change request, verification request, error log, user correction, repeated failure, high-risk operation, multimodal input, final completion claim, doctor failure, or unresolved blocking reviewer state.

For `stateless_greeting_task`, the explicit no-tool phrase is not required, but the same safety conditions apply: no active blocking state, no engineering intent, no code/file/test/doctor request, no error log, no high-risk keyword, no multimodal input, no repeated failure, no user correction, and no unresolved reviewer block.

It never suppresses correctness-required review for:

- user correction or scope drift;
- repeated failure;
- active blocking plan or unresolved reviewer block;
- continuation required;
- final claim missing evidence;
- doctor failed;
- high-risk provider/routing/gate/evidence/result-ledger/permission/model-switching work;
- code modification, file analysis, command execution, or verification requests;
- secrets, permission, or destructive-operation boundaries.

## Routing Evidence

Every commander/reviewer/fallback/skip route should write `model.routing_decision` evidence with:

- role;
- action;
- selected_model;
- candidate_models;
- trigger_reason;
- correctness_reason;
- cost_reason;
- skipped_reviewers;
- structured `skipped_reviewer_details`;
- evidence_refs;
- result_refs;
- provider_unavailable_reason;
- fallback_reason;
- whether_required_for_correctness;
- unresolved_routing_risk when a correctness-required reviewer is skipped without a completed equivalent.

Final gate reads unresolved routing risks from evidence and blocks PASS when a correctness-required reviewer was skipped without completion.

## Cost Guard

The cost guard may skip:

- duplicate reviewer review of the same evidence;
- repeated reviewer inside cooldown;
- reviewer already queued/running/completed;
- verified non-stale result that can be reused;
- no-trigger multi-model meetings.

The cost guard must not skip:

- user correction requirements check;
- repeated failure escalation;
- final claim with missing evidence;
- high-risk provider/routing/gate/evidence/permission review;
- doctor failed continuation;
- stale result revalidation;
- blocking reviewer reconciliation.

## Status

Implemented_runtime_verified:

- low-risk commander-only evidence;
- live-smoke false-positive guard for explicit short no-tool prompts;
- live-smoke false-positive guard for stateless greetings and acknowledgements;
- task intake classifier with L0/L1/L2/L3/L4 interaction levels;
- user-origin-only source filter for routing-relevant signals;
- configurable task-intake policy manifest;
- repo-doctor activation guard so repository markers alone do not activate repo-doctor for stateless chat;
- self-generated text filtering before trigger metrics are computed;
- high-risk multi-reviewer routing within budget;
- unresolved correctness-required skip risk;
- final gate visibility for unresolved routing risk;
- Result Ledger dedup skip evidence;
- routing evidence fields for correctness and cost reasons.

Partial_runtime:

- routing still depends on existing supervisor message stream rather than a dedicated tool-event bus;
- model-based ambiguous classifier is a placeholder only; deterministic classification is implemented, but no live model classifier is called;
- `trigger_multiple_reviewers` is represented by per-reviewer dispatch evidence plus high-risk supervisor metrics, not a separate central dispatch packet.

Missing:

- cross-session routing memory;
- provider live health probing inside routing itself.
