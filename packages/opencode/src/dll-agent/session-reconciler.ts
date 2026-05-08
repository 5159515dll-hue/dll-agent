/**
 * Reconciles stale supervisor state with newer structured evidence.
 *
 * This is specifically for resumed/long sessions where an old gate block such
 * as "completion claim without verification evidence" can survive after real
 * artifact evidence or Result Ledger evidence has appeared.
 */

import { loadState, saveState } from "./supervisor"
import { buildEvidenceSnapshot } from "./evidence-normalizer"
import { evaluateCompletionReadiness } from "./completion-readiness"
import { ensureArtifactResults } from "./artifact-result-ledger"
import { write as writeEvidence } from "./evidence"
import type { SupervisorState } from "./interfaces"

export interface SessionReconcileResult {
  changed: boolean
  state: SupervisorState
  actions: string[]
  readiness_status: string
}

const LEGACY_NO_EVIDENCE_REASONS = [
  "completion claim without verification evidence",
  "high-risk completion claim without verification evidence",
  "medium-risk completion without verification and pending reviews",
]

function archiveRetry(state: SupervisorState, reason: string, archiveReason: string) {
  const retries = state.gate_block_retries?.[reason] ?? 0
  if (retries <= 0) return
  state.gate_block_history ??= {}
  state.gate_block_history[reason] = {
    retries,
    archived_at: new Date().toISOString(),
    reason: archiveReason,
  }
  delete state.gate_block_retries?.[reason]
}

function isLegacyNoEvidenceReason(reason: string | null | undefined): reason is string {
  return Boolean(reason && LEGACY_NO_EVIDENCE_REASONS.some((known) => reason.includes(known)))
}

export function reconcileSessionState(input: {
  sessionID: string
  projectDir?: string
  state?: SupervisorState
}): SessionReconcileResult {
  const state = input.state ?? loadState(input.sessionID)
  const actions: string[] = []

  if (input.projectDir) {
    const backfill = ensureArtifactResults(input.sessionID, input.projectDir)
    if (backfill.wrote) actions.push(`backfilled artifact result ${backfill.packet_id}`)
  }

  const snapshot = buildEvidenceSnapshot({
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    toolEvidence: state.metrics.real_tool_evidence,
  })
  const readiness = evaluateCompletionReadiness({ snapshot })
  const legacyReason = isLegacyNoEvidenceReason(state.block_reason) ? state.block_reason : null

  if (snapshot.has_real_tool_evidence && !state.metrics.real_tool_evidence) {
    state.metrics.real_tool_evidence = true
    actions.push("updated supervisor real_tool_evidence from artifact/result evidence")
  }
  if (snapshot.evidence_refs.length > 0 && !state.metrics.verification_evidence) {
    state.metrics.verification_evidence = true
    actions.push("updated supervisor verification_evidence from evidence refs")
  }

  if (legacyReason && snapshot.has_real_tool_evidence) {
    archiveRetry(state, legacyReason, `reconciled with evidence snapshot (${readiness.status})`)
    if (readiness.can_claim_verified) {
      state.blocked_completion = false
      state.block_reason = null
      actions.push("cleared stale no-evidence completion block")
    } else {
      state.blocked_completion = true
      state.block_reason = `evidence exists but completion is not verified: ${readiness.reasons.slice(0, 3).join("; ")}`
      actions.push("reclassified stale no-evidence block to evidence-backed readiness block")
    }
  }

  const currentReason = state.block_reason
  if (currentReason && snapshot.has_real_tool_evidence && state.gate_block_retries?.[currentReason] && state.gate_block_retries[currentReason] > 2) {
    archiveRetry(state, currentReason, "retry count archived after evidence snapshot reconciliation")
    actions.push("archived exhausted retry count for current evidence-backed block")
  }

  if (actions.length > 0) {
    state.updated_at = new Date().toISOString()
    saveState(input.sessionID, state)
    writeEvidence("session.reconciled_gate_state", {
      actions,
      readiness_status: readiness.status,
      has_real_tool_evidence: snapshot.has_real_tool_evidence,
      fail_count: snapshot.fail_count,
      blockers: snapshot.blockers.slice(0, 5),
    }, input.sessionID)
  }

  return {
    changed: actions.length > 0,
    state,
    actions,
    readiness_status: readiness.status,
  }
}
