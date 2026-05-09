# dll-agent Context Handoff

## Purpose

ContextHandoffPacket v1 is the information handoff protocol between dll-agent roles. It improves reviewer accuracy and token efficiency without adding models, adding reviewers, or increasing multi-model call frequency.

The runtime now builds a structured packet first, then renders a role-specific compressed `<compact-review-context>` for existing reviewer prompts.

## Data Sources

The packet is aggregated from existing runtime state only:

- Goal Contract: original user goal, task id, success criteria, active plan, required verification.
- Result Ledger: result packet refs, verification records, changed files, stale or partial result status.
- Evidence snapshot: evidence refs, verification/blocker summary.
- Supervisor state: risk level, blocked completion reason, pending reviewer state.
- Recent message/tool metadata: fallback user goal and discovered file paths only.

No parallel state store is introduced.

## Implemented Runtime Behavior

Status: `implemented_runtime_verified`.

- Goal Contract user goal is preferred over the latest user message.
- Missing Goal Contract, user goal, or verification summary is recorded in `missing_context`.
- `context_confidence` is lowered when required context is missing or verification is not complete.
- Packet summary is written as `context_handoff.packet_built` evidence.
- Renderer output keeps the existing 5000 character reviewer context limit.
- Renderer prioritizes user goal, blocking findings, failed/not-run verification, required actions, result refs, evidence refs, and changed files.
- Reviewer Result Ledger packets record `context_packet_id` when available; missing packet ids are explicitly marked with `missing_context_packet`.
- Reconciliation and final gates can inspect reviewer result packet context refs; blocking reviewer results without a context packet are treated as audit risk and cannot silently PASS.
- Reviewer model attribution now accepts `projectDir`, so project-scope role model overrides are reflected correctly.
- Reviewer Output Normalization is runtime verified: if a reviewer completes without valid structured JSON, dll-agent writes a low-confidence fallback `ResultPacket` instead of dropping the result.
- Fallback reviewer packets are marked with `structured_output_missing=true`, `confidence=low`, `source_kind=fallback_reviewer_output`, `context_packet_id` when available, and redacted summary metadata.
- Fallback reviewer prose is never treated as verified evidence. Blocking prose becomes `BLOCKED`; non-blocking prose becomes `UNVERIFIED`.
- Role runs now write a `role_run_id`, `role_instance_id`, and `action_fingerprint` into supervisor state and reviewer Result Ledger packets. This keeps the same base model isolated when it serves multiple roles.
- Same-provider different-model identity is tracked as the full `provider/model` string. `mimo/mimo-v2.5-pro` and `mimo/mimo-v2.5` are separate model identities for routing, usage display, and same-model isolation checks.
- Final gate flags same-model multi-role reviewer results when role-run/context metadata is missing, instead of silently accepting potentially contaminated reviewer output.
- Guard decisions are recorded as evidence when runtime checks allow a correctness-required role run; cooldown/cost guards cannot silently skip correctness-required review.

## Role-specific Rendering

- `requirements-inspector`: original goal, success criteria, scope drift, user correction context, blocking unfinished work.
- `chief-engineer`: failures, changed files, verification summary, required actions, stale/partial results.
- `long-context-archivist`: original goal, result refs, missing context, continuation-oriented handoff.
- `task-completion-archivist`: blocking unfinished vs non-blocking follow-up classification.
- `final-auditor`: success criteria, verification, blockers, result refs, evidence refs.
- `role-cross`: conflicting or blocked findings, evidence refs, decision needed.
- `multimodal-context-interpreter`: aligns non-text observations to the current goal without entering coding execution.

## Partial / Not Implemented

Status: `partial_runtime` for these items:

- Result Ledger remains session-scoped; cross-session result reuse is not part of v1.
- Low-level individual tool calls are not globally deduped by ContextHandoffPacket.
- ContextHandoffPacket does not replace Continuation Packet or Result Packet schemas.
- Legacy reviewer result packets created before role-run envelopes may not include `role_run_id`. Gates now report that as an audit risk when the same model served multiple roles.
- Action fingerprinting is currently applied to reviewer role runs and result metadata; it is not yet a global low-level tool-call dedup layer.
- Legacy reviewer completions from before this change may still lack fallback metadata; history is not migrated.

## Test Coverage

Covered by `test/dll-agent/context-handoff-packet.test.ts`:

- Original Goal Contract user goal survives long-task/latest-message drift.
- Criteria, active plan, verification, blockers, required actions, result refs, and evidence refs are included.
- Renderer stays bounded and preserves critical fields.
- Role renderers avoid irrelevant long logs while retaining role-critical fields.
- Missing context lowers confidence.
- Redaction removes secrets.
- Project-scope role model override is honored by reviewer result bridge.
- Same base model serving multiple roles receives distinct role-run envelopes.
- Same provider different model IDs are not collapsed into one model identity.
- Duplicate action fingerprints are detected and correctness-required skips are escalated to an audit/ask decision.
- Cross-review council validation detects packet mismatch, reviewer contamination, insufficient context, and blocking findings without evidence.
- Missing structured reviewer JSON still produces a gate-visible fallback result.
- Fallback summaries are redacted before ledger/evidence write.
