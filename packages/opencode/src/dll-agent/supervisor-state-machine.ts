import type {
  ReviewerOutput,
  ReviewerRole,
  SupervisorMetricsSnapshot,
  SupervisorState,
  TriggerDecision,
} from "./interfaces"
import { recordGateBlock } from "./gates"
import { assessRisk } from "./routing-policy"
import type { Metrics } from "./triggers"

export function normalizeSupervisorReviewerState(state: SupervisorState) {
  state.completed_reviews = [...new Set(state.completed_reviews ?? [])]
  const completed = new Set(state.completed_reviews)
  state.required_reviews = [...new Set((state.required_reviews ?? []).filter((r) => !completed.has(r)))]
  state.queued_reviewers = [...new Set((state.queued_reviewers ?? []).filter((r) => !completed.has(r as ReviewerRole)))]
    .map((r) => r as ReviewerRole)
  state.running_reviewers = [...new Set((state.running_reviewers ?? []).filter((r) => !completed.has(r as ReviewerRole)))]
    .map((r) => r as ReviewerRole)
  if (completed.has("role-cross") && state.required_reviews.length === 0) state.reviewer_conflict = false
}

export function freshSupervisorState(): SupervisorState {
  return {
    version: 1,
    phase: "default",
    risk: "low",
    required_reviews: [],
    completed_reviews: [],
    blocked_completion: false,
    block_reason: null,
    reviewer_conflict: false,
    metrics: {
      tool_failures: 0,
      permission_denied: 0,
      user_corrections: 0,
      context_percent: 0,
      context_tokens: 0,
      final_claim: false,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    active_skills: [],
    queued_reviewers: [],
    running_reviewers: [],
    gate_block_retries: {},
    updated_at: new Date().toISOString(),
  }
}

export function metricsFromSupervisorSnapshot(snapshot: SupervisorMetricsSnapshot): Metrics {
  return {
    userCorrections: snapshot.user_corrections,
    recentUserCorrection: snapshot.user_corrections > 0,
    toolFailures: snapshot.tool_failures,
    permissionDenied: snapshot.permission_denied,
    repeatedToolFailure: snapshot.repeated_tool_failure,
    contextTokens: snapshot.context_tokens,
    contextPercent: snapshot.context_percent,
    longContextSignal: snapshot.context_percent >= 40,
    finalClaim: snapshot.final_claim,
    verificationEvidence: snapshot.verification_evidence,
    realToolEvidence: snapshot.real_tool_evidence,
    reviewerConflictSignal: snapshot.reviewer_conflict_signal,
    kimiCompletionCheckSignal: snapshot.kimi_completion_check_signal ?? false,
    glmCompletionClaimSignal: snapshot.glm_completion_claim_signal ?? false,
    kimiPreReportSignal: snapshot.kimi_pre_report_signal ?? false,
    scopeExpandedSignal: snapshot.scope_expanded_signal ?? false,
    phaseSwitchSignal: snapshot.phase_switch_signal ?? false,
    multimodalSignal: snapshot.multimodal_signal ?? false,
    highRiskTaskSignal: snapshot.high_risk_task_signal ?? false,
  }
}

export function applySupervisorDecisionToState(state: SupervisorState, decision: TriggerDecision) {
  const risk = assessRisk(metricsFromSupervisorSnapshot(decision.metrics))
  state.phase = state.phase || "default"
  state.risk = risk
  state.metrics = decision.metrics
  state.updated_at = new Date().toISOString()

  for (const reviewer of decision.reviewers) {
    if (!state.required_reviews.includes(reviewer)) state.required_reviews.push(reviewer)
  }

  if (decision.metrics.final_claim && !decision.metrics.verification_evidence) {
    state.blocked_completion = true
    state.block_reason = "completion claim without verification evidence"
  }

  if (state.blocked_completion && state.block_reason) recordGateBlock(state, state.block_reason)
  if (decision.metrics.reviewer_conflict_signal) state.reviewer_conflict = true

  if (decision.metrics.final_claim && !decision.metrics.verification_evidence) {
    state.continuation_count ??= 0
    state.continuation_count++
    state.repair_counts ??= {}
  }

  return state
}

export function reviewerOutputBlocksCompletion(input: {
  output?: ReviewerOutput
  rawText?: string
  reusedFromPacketID?: string
}) {
  if (input.output?.block_completion) {
    return {
      blocks: true,
      reason: `blocked completion: ${input.output.findings.filter((f) => f.severity === "block").map((f) => f.summary).join("; ")}`,
    }
  }
  const fallbackBlocks = !input.output &&
    !input.reusedFromPacketID &&
    /fail_block|block_completion|blocking|blocked|fail(?:ed)?|cannot pass|阻断|失败|未完成|缺少证据|不能通过|不应通过|无法通过/i.test(input.rawText ?? "")
  return {
    blocks: fallbackBlocks,
    reason: fallbackBlocks
      ? "blocked completion: fallback unstructured reviewer output indicates blocking risk"
      : null,
  }
}

export function applyReviewerCompletedToState(
  state: SupervisorState,
  reviewer: ReviewerRole,
  input: {
    output?: ReviewerOutput
    rawText?: string
    reusedFromPacketID?: string
  } = {},
) {
  if (!state.completed_reviews.includes(reviewer)) state.completed_reviews.push(reviewer)
  state.required_reviews = state.required_reviews.filter((r) => r !== reviewer)
  state.queued_reviewers = (state.queued_reviewers ?? []).filter((r) => r !== reviewer)
  state.running_reviewers = (state.running_reviewers ?? []).filter((r) => r !== reviewer)
  if (reviewer === "role-cross" && state.required_reviews.length === 0) state.reviewer_conflict = false

  const block = reviewerOutputBlocksCompletion(input)
  if (block.blocks) {
    state.blocked_completion = true
    state.block_reason = `reviewer ${reviewer} ${block.reason}`
  }

  state.updated_at = new Date().toISOString()
  return {
    state,
    blockCompletion: block.blocks,
  }
}

export function clearResolvedBlockState(state: SupervisorState) {
  if (state.required_reviews.length === 0 && state.blocked_completion) {
    state.blocked_completion = false
    state.block_reason = null
    state.reviewer_conflict = false
    state.updated_at = new Date().toISOString()
  }
  return state
}

export * as SupervisorStateMachine from "./supervisor-state-machine"
