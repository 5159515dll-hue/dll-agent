import { write as writeEvidence } from "./evidence"
import type { ReviewerRole, RiskLevel } from "./interfaces"

export function writeRoutingEvidence(input: {
  sessionID: string
  taskID: string
  role: ReviewerRole | "commander"
  selectedModel?: string
  candidateModels: string[]
  riskLevel: RiskLevel
  triggerReason: string
  skippedReviewers?: string[]
  skipReason?: string | null
  correctnessReason: string
  costReason?: string | null
  evidenceRefs?: string[]
  fallbackReason?: string | null
  requiredForCorrectness: boolean
}) {
  writeEvidence("model.routing_decision", {
    task_id: input.taskID,
    role: input.role,
    selected_model: input.selectedModel ?? null,
    candidate_models: input.candidateModels,
    risk_level: input.riskLevel,
    trigger_reason: input.triggerReason,
    skipped_reviewers: input.skippedReviewers ?? [],
    skip_reason: input.skipReason ?? null,
    correctness_reason: input.correctnessReason,
    cost_reason: input.costReason ?? null,
    evidence_refs: input.evidenceRefs ?? [],
    fallback_reason: input.fallbackReason ?? null,
    whether_required_for_correctness: input.requiredForCorrectness,
  }, input.sessionID)
}

