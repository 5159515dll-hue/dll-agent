# dll-agent Cross Review

## Purpose

Cross review is dll-agent's evidence-backed arbitration path for repeated failure, reviewer conflict, high-risk completion disagreement, or final/gate conflict. It is not a general meeting mechanism and must not run on ordinary low-risk work.

## Runtime Shape

Implemented minimum council packet fields:

- `issue`;
- `user_goal`;
- `participants`;
- `evidence_refs`;
- `result_ledger` snapshot;
- `competing_findings`;
- `arbitration`;
- `recommended_solution`;
- `required_verification`;
- `risk`;
- `commander_action_required`.

The council packet is built from existing state: supervisor signals, evidence refs, Result Ledger snapshot, reviewer state, and ContextHandoffPacket lineage. It does not introduce persistent agents or a new provider stack.

## Trigger Conditions

Implemented triggers:

- repeated failure at escalation threshold;
- reviewer conflict;
- high-risk completion claim without evidence;
- multiple user corrections;
- recovery budget exhaustion;
- final/gate disagreement.

Non-goals:

- no unconditional cross-review;
- no extra reviewer roles;
- no cross-session council memory;
- no execution by role-cross.

## Reviewer Output Protocol

Reviewers must provide structured output when available:

- reviewer;
- context_packet_id;
- context_sufficient;
- decision;
- blocking;
- confidence;
- findings;
- evidence_refs;
- required_actions;
- recommended_next_role;
- verification_required;
- missing_context;
- risk_notes.

If the reviewer only returns prose, Reviewer Output Normalization writes a low-confidence fallback ResultPacket with `structured_output_missing=true`. That fallback is visible to gates but is not verified evidence.

## Reconciliation Gate

Commander must reconcile blocking reviewer or council findings before final PASS.

Reconciliation must record:

- accepted findings;
- rejected findings;
- rejection evidence;
- next action;
- required verification;
- remaining blockers.

Rejecting a reviewer without evidence is not valid reconciliation. Final gate blocks unresolved reviewer/council risk.

## Result Ledger Integration

Cross-review council packets include a Result Ledger snapshot:

- verified reusable packet ids;
- partial results;
- failed results;
- stale results;
- unresolved items;
- evidence refs.

This prevents reviewers from repeating already verified work and prevents partial or stale packets from being treated as complete.

## Status

Implemented_runtime_verified:

- council packet validation with arbitration fields;
- Result Ledger snapshot in council packet;
- role-cross arbitration protocol;
- reviewer independence checks;
- fallback reviewer result visibility to final/reconciliation gate;
- context_packet_id lineage for reviewer outputs.

Partial_runtime:

- council dispatch remains a minimal supervisor bridge, not a standalone council runtime;
- council decisions feed commander through existing reviewer/reconciliation paths.

Missing:

- separate council metrics dashboard;
- cross-session council history;
- deeper live provider availability arbitration.

