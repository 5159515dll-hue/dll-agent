import { write as writeEvidence } from "./evidence"
import type { ReviewerRole, RiskLevel } from "./interfaces"

export type RoutingAction =
  | "commander_only"
  | "trigger_reviewer"
  | "trigger_multiple_reviewers"
  | "trigger_cross_review"
  | "trigger_final_auditor"
  | "skip_reviewer"
  | "blocked_provider_unavailable"

export type SkippedReviewer = {
  role: string
  skip_reason: string
  correctness_required: boolean
}

export function writeRoutingEvidence(input: {
  sessionID: string
  taskID: string
  role: ReviewerRole | "commander"
  action?: RoutingAction
  selectedModel?: string
  candidateModels: string[]
  riskLevel: RiskLevel
  triggerReason: string
  skippedReviewers?: string[]
  skippedReviewerDetails?: SkippedReviewer[]
  skipReason?: string | null
  correctnessReason: string
  costReason?: string | null
  evidenceRefs?: string[]
  resultRefs?: string[]
  providerUnavailableReason?: string | null
  fallbackReason?: string | null
  requiredForCorrectness: boolean
}) {
  const skipReason = input.skipReason ?? null
  const skippedReviewers = input.skippedReviewerDetails ?? (input.skippedReviewers ?? []).map((role) => ({
    role,
    skip_reason: skipReason ?? "not_dispatched",
    correctness_required: input.requiredForCorrectness,
  }))
  const unresolvedRisk = skippedReviewers.some((item) =>
    item.correctness_required &&
    !["reviewer_already_completed_this_phase", "reviewer_already_queued_or_running", "verified_result_reused"].includes(item.skip_reason)
  )
  const action: RoutingAction = input.action ?? (
    skippedReviewers.length > 0
      ? input.providerUnavailableReason ? "blocked_provider_unavailable" : "skip_reviewer"
      : input.role === "commander"
      ? "commander_only"
      : input.role === "role-cross"
      ? "trigger_cross_review"
      : input.role === "final-auditor"
      ? "trigger_final_auditor"
      : "trigger_reviewer"
  )
  writeEvidence("model.routing_decision", {
    action,
    task_id: input.taskID,
    role: input.role,
    selected_model: input.selectedModel ?? null,
    candidate_models: input.candidateModels,
    risk_level: input.riskLevel,
    trigger_reason: input.triggerReason,
    skipped_reviewers: skippedReviewers.map((item) => item.role),
    skipped_reviewer_details: skippedReviewers,
    skip_reason: skipReason,
    correctness_reason: input.correctnessReason,
    cost_reason: input.costReason ?? null,
    evidence_refs: input.evidenceRefs ?? [],
    result_refs: input.resultRefs ?? [],
    provider_unavailable_reason: input.providerUnavailableReason ?? null,
    fallback_reason: input.fallbackReason ?? null,
    whether_required_for_correctness: input.requiredForCorrectness,
    unresolved_routing_risk: unresolvedRisk,
  }, input.sessionID)
}
