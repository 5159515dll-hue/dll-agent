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
- User correction triggers `requirements-inspector`.
- Repeated failure escalates from commander repair to `chief-engineer`, then role-cross/cross-review decision.
- Final claim without evidence is blocked by evidence/final gate and may trigger verifier/final audit.
- High-risk provider/routing/gate/evidence/result-ledger/permission/model-switching work can trigger multiple reviewers, bounded by budget and cooldown.
- Verified non-stale Result Ledger packets suppress duplicate reviewer dispatch.
- Stale, partial, failed, or missing-evidence results remain eligible for reviewer/recovery.
- MiMo-V2.5 is not routed into pure text/code tasks.
- TTS/VoiceClone models are excluded from coding routes.
- OpenAI is not default for ordinary tasks; it is on-demand final/high-risk audit only.

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
- high-risk multi-reviewer routing within budget;
- unresolved correctness-required skip risk;
- final gate visibility for unresolved routing risk;
- Result Ledger dedup skip evidence;
- routing evidence fields for correctness and cost reasons.

Partial_runtime:

- routing still depends on existing supervisor message stream rather than a dedicated tool-event bus;
- `trigger_multiple_reviewers` is represented by per-reviewer dispatch evidence plus high-risk supervisor metrics, not a separate central dispatch packet.

Missing:

- cross-session routing memory;
- provider live health probing inside routing itself.

