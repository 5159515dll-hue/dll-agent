/**
 * Computes whether a final completion claim may be stated as verified.
 */

import type { SupervisorState } from "./interfaces"
import type { EvidenceSnapshot } from "./evidence-normalizer"

export type CompletionReadinessStatus = "VERIFIED_COMPLETE" | "PARTIAL" | "BLOCKED" | "UNVERIFIED"

export interface CompletionReadiness {
  status: CompletionReadinessStatus
  can_claim_verified: boolean
  reasons: string[]
  required_next_actions: string[]
  evidence_refs: string[]
}

export function evaluateCompletionReadiness(input: {
  snapshot: EvidenceSnapshot
  state?: SupervisorState
}): CompletionReadiness {
  const reasons: string[] = []
  const actions: string[] = []

  if (!input.snapshot.has_real_tool_evidence) {
    reasons.push("missing real tool or artifact evidence")
    actions.push("run required verification or produce verifiable task artifacts")
  }

  if (input.snapshot.fail_count > 0) {
    reasons.push(`${input.snapshot.fail_count} failing result(s) found in evidence`)
    actions.push("fix failures or disclose PARTIAL/BLOCKED status")
  }

  if (input.snapshot.blockers.length > 0) {
    reasons.push(...input.snapshot.blockers)
    actions.push("resolve blockers or write a blocked report")
  }

  if (input.state?.blocked_completion) {
    reasons.push(input.state.block_reason ?? "supervisor blocks completion")
    actions.push("clear supervisor block with evidence-backed remediation")
  }

  if ((input.state?.required_reviews.length ?? 0) > 0) {
    reasons.push(`pending reviews: ${input.state!.required_reviews.join(", ")}`)
    actions.push("wait for or resolve pending reviewer outputs")
  }

  if (reasons.length === 0 && input.snapshot.verification_passed) {
    return {
      status: "VERIFIED_COMPLETE",
      can_claim_verified: true,
      reasons: [],
      required_next_actions: [],
      evidence_refs: input.snapshot.evidence_refs,
    }
  }

  const status: CompletionReadinessStatus = input.state?.blocked_completion || input.snapshot.blockers.length > 0
    ? "BLOCKED"
    : input.snapshot.has_real_tool_evidence
    ? "PARTIAL"
    : "UNVERIFIED"

  return {
    status,
    can_claim_verified: false,
    reasons: [...new Set(reasons)],
    required_next_actions: [...new Set(actions)],
    evidence_refs: input.snapshot.evidence_refs,
  }
}
