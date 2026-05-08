# dll-agent Result Handoff System

> **Phase 7**: Multi-model result passing — preventing redundant work, token waste, and result overwriting.

## Overview

When multiple models collaborate (DeepSeek commander, Kimi archivist, GLM inspector, OpenAI auditor), completed work must be passed reliably between them. Without structured handoff, downstream models either:
1. Redo work that was already completed → token waste
2. Trust a natural-language summary as evidence → false completion claims
3. Overwrite correct results without realizing they exist → regression

The Result Handoff System solves this with three layers:

| Layer | Module | What it does |
|-------|--------|-------------|
| **Recording** | `result-ledger.ts` | Structured result storage with CRUD and query |
| **Sufficiency** | `result-sufficiency-gate.ts` | Evaluates if existing results are good enough to reuse |
| **Deduplication** | `deduplication-gate.ts` | Prevents re-execution of already-completed work |

## Result Packet Schema

Every completed subtask produces a `ResultPacket`:

```json
{
  "packet_type": "result_packet",
  "packet_id": "res_1712345678_a1b2c3",
  "executing_role": "requirements-inspector",
  "model": "zai/glm-5.1",
  "user_goal": "检查多模型路由优化",
  "subtask_goal": "Review by requirements-inspector: Chinese requirement alignment",
  "claimed_result": "Review verdict: pass | Score: 92",
  "completion_status": "VERIFIED_COMPLETE",
  "files_changed": [],
  "artifacts_produced": [],
  "commands_run": [],
  "verification_results": [{"name": "reviewer_score", "status": "passed"}],
  "evidence_refs": ["reviewer:requirements-inspector", "score:92"],
  "unresolved_items": [],
  "known_risks": [],
  "reusable": true,
  "stale": false,
  "result_hash": "res_a1b2c3d4",
  "created_at": "2024-05-08T10:00:00.000Z",
  "redaction_status": "redacted"
}
```

## Implementation Status

### ✅ Implemented (code-level enforcement)

| Feature | File | Integration Point |
|---------|------|-------------------|
| ResultLedger storage | `result-ledger.ts` | Session-scoped JSONL at `~/.dll-agent/sessions/{sid}/results.jsonl` |
| ResultPacket write | `result-ledger.ts:writeResult()` | Called by `supervisor.ts:markReviewerCompleted()` |
| ResultPacket query | `result-ledger.ts:queryResults()` | Filterable by role, status, files, timestamp |
| Results summary | `result-ledger.ts:buildResultsSummary()` | Text block for reviewer context |
| Sufficiency check | `result-sufficiency-gate.ts:checkResultSufficiency()` | Returns `sufficient/partial/stale/insufficient` verdict |
| Staleness detection | `result-sufficiency-gate.ts:isResultStale()` | Time-based + explicit stale/invalidated status |
| Deduplication gate | `deduplication-gate.ts:checkDeduplication()` | Returns `redundant/not_redundant` verdict |
| Dedup context injection | `deduplication-gate.ts:buildDedupContextSummary()` | Text block for commander/gate hints |
| Reviewer results recorded | `supervisor.ts:markReviewerCompleted()` | Writes `ResultPacket` when `ReviewerOutput` is available |
| Reviewer context enhanced | `supervisor.ts:buildReviewerContext()` | Includes results summary from ledger |
| Continuation packet populated | `continuation-gate.ts:buildContinuationPacket()` | `already_completed`, `files_involved`, `commands_run` from ledger |
| Gate hints injection | `prompt.ts:gatePendingHints` | Dedup context injected before model continues |
| Evidence types | `interfaces.ts:EvidenceRecordType` | `result.produced`, `result.reused`, `result.invalidated`, `result.dedup_blocked`, `result.dedup_allowed`, `result.stale_detected` |

### ⚠️ Partially Implemented

| Feature | Status | Gap |
|---------|--------|-----|
| File-hash staleness | Time-based only | Git hash / mtime comparison not yet implemented |
| Tool-execution dedup | Prompt-only | subtask dispatch not yet checked via `checkDeduplication()` before execution (dedup context is injected but not enforced at dispatch time) |
| Cross-session result sharing | Session-scoped | Results only visible within one session |

### ❌ Not Yet Implemented

| Feature | Notes |
|---------|-------|
| `artifact-reuse-policy.ts` | Reuse policy rules not yet formalized as a standalone module |
| Cross-session baseline comparison | Kimi cannot yet compare results across sessions |
| Council result integration | Cross-review council does not yet consume result ledger |

## Deduplication Gate Rules

When a model attempts to execute work:
1. **Result exists + VERIFIED_COMPLETE** → `reuse_existing` (BLOCK re-execution)
2. **Result exists + UNVERIFIED** → `verify_existing` (only verify, don't redo)
3. **Result exists + PARTIAL** → `continue_from_existing` (fill gaps only)
4. **Result exists + FAILED** → `repair_existing` (redo allowed with diagnosis)
5. **Result exists + STALE/INVALIDATED** → `redo_allowed` (existing result invalid)
6. **No result exists** → `no_existing_result` (execute normally)

## Doctor Checks

`dll-agent doctor` includes result ledger health checks:

| Check | What it verifies |
|-------|-----------------|
| `result-ledger-size` | Results count per session (warn > 1000) |
| `result-ledger-invalid` | Invalid/unparseable result packets |
| `evidence-refs-valid` | Evidence references are resolvable |
| `stale-results-detect` | Results beyond max age threshold |

## Verification

```bash
bun run --cwd packages/opencode typecheck   # ✅ 0 errors
bun test --cwd packages/opencode test/dll-agent/  # ✅ 356 pass, 0 fail
/Users/dailulu/.local/bin/dll-agent doctor  # ✅ result=warn (non-blocking)
python3 -m py_compile /Users/dailulu/.local/bin/dll-agent  # ✅ ok
git diff --check  # ✅ clean
```

## Design Principles

1. **Extend, don't replace** — built on `evidence.ts`, `ContinuationPacket`, `gates.ts`, `supervisor.ts`
2. **Hard gate, not soft prompt** — dedup rules are enforced in code, not just suggested in text
3. **Structured, not natural language** — `ResultPacket` has typed fields, not free-text summaries
4. **Evidence-backed** — every redo decision is logged to evidence with justification
5. **Best-effort storage** — result ledger failures never block the session loop
6. **Redaction always** — all stored results pass through `redact()` before persistence
