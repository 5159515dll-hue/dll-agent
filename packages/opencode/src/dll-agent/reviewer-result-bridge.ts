/**
 * Bridges structured reviewer output into Result Ledger packets.
 *
 * Supervisor state mutation remains in supervisor.ts; this module owns only the
 * reviewer-output -> result-packet transformation and best-effort ledger write.
 */

import { resolveRoleModel } from "./role-model-registry"
import { buildResultPacket, writeResult as writeResultLedger, type ResultPacket } from "./result-ledger"
import { reviewerToDllRole } from "./routing-policy"
import type { ReviewerOutput, ReviewerRole, SupervisorState } from "./interfaces"

export function buildReviewerResultPacket(input: {
  sessionID: string
  reviewer: ReviewerRole
  output: ReviewerOutput
  state: SupervisorState
}): ResultPacket {
  const dllRole = reviewerToDllRole(input.reviewer)
  const effective = resolveRoleModel(dllRole, input.sessionID)
  return buildResultPacket({
    sessionID: input.sessionID,
    executing_role: input.reviewer,
    model: effective.primary,
    user_goal: input.state.metrics?.final_claim ? "completion claim" : "ongoing task",
    subtask_goal: `Review by ${input.reviewer}: ${input.output.trigger_reason}`,
    claimed_result: `Review verdict: ${input.output.verdict} | Score: ${input.output.score} | Evidence confidence: ${input.output.evidence_confidence}`,
    completion_status: input.output.block_completion ? "BLOCKED" : "VERIFIED_COMPLETE",
    evidence_refs: [`reviewer:${input.reviewer}`, `score:${input.output.score}`],
    unresolved_items: input.output.findings.filter((finding) => finding.severity === "block").map((finding) => finding.summary),
    verification_results: [
      { name: "reviewer_score", status: input.output.score >= 70 ? "passed" : "failed" },
    ],
  })
}

export function writeReviewerResult(input: {
  sessionID: string
  reviewer: ReviewerRole
  output?: ReviewerOutput
  state: SupervisorState
}): ResultPacket | null {
  if (!input.output) return null
  try {
    const packet = buildReviewerResultPacket({
      sessionID: input.sessionID,
      reviewer: input.reviewer,
      output: input.output,
      state: input.state,
    })
    writeResultLedger(input.sessionID, packet)
    return packet
  } catch {
    return null
  }
}
