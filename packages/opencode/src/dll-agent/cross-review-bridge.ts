/**
 * dll-agent cross-review-bridge.ts
 *
 * Bridge between cross-review council and the supervisor/prompt.ts session loop.
 *
 * When the supervisor detects conditions that warrant a multi-model council,
 * this bridge provides the council composition and structured review dispatch.
 *
 * Principle: council only on repeated failure, conflict, or high-risk completion.
 * Independent reviewers see same evidence. Role-cross arbitrates conflicts.
 * Cost guard + cooldown prevent abuse.
 */
import {
  shouldConveneCouncil,
  composeCouncil,
  summarizeCouncilResultLedger,
  validateCouncilPacket,
  type CouncilPacket,
  type CouncilTriggerReason,
  type CouncilState,
} from "./cross-review"
import type { ReviewerRole, SupervisorState } from "./interfaces"
import { write as writeEvidence } from "./evidence"
import { loadResults } from "./result-ledger"

export interface CrossReviewBridgeResult {
  /** Whether a council should be convened */
  shouldConvene: boolean
  /** Trigger reason if convening */
  reason: CouncilTriggerReason | null
  /** Reviewers to dispatch (primary + optional, subject to cost guard) */
  reviewers: ReviewerRole[]
  /** Council packet for evidence sharing */
  packet: CouncilPacket | null
  /** Packet validation result */
  packetValid: boolean
  /** Missing fields if packet invalid */
  packetMissingFields: string[]
}

/**
 * Check if a cross-review council should be convened based on current state.
 * Called by the supervisor during its decision cycle.
 */
export function checkCrossReviewTrigger(params: {
  state: SupervisorState
  repeatedFailureCount: number
  reviewerConflict: boolean
  isHighRiskCompletion: boolean
  hasInsufficientEvidence: boolean
  userCorrectionCount: number
  scopeExpanded: boolean
  recoveryAttempts: number
  maxRecoveryAttempts?: number
  /** Current council state to check cooldown */
  currentCouncilState?: CouncilState
  /** Session ID for packet population */
  sessionId?: string
  /** User goal for packet population */
  userGoal?: string
  /** Recently changed files for packet population */
  filesChanged?: string[]
  /** Current plan for packet population */
  currentPlan?: string | null
}): CrossReviewBridgeResult {
  const maxRecovery = params.maxRecoveryAttempts ?? 5

  // Don't convene if a council is already active
  if (params.currentCouncilState && params.currentCouncilState !== "idle" && params.currentCouncilState !== "resolved") {
    return {
      shouldConvene: false,
      reason: null,
      reviewers: [],
      packet: null,
      packetValid: false,
      packetMissingFields: [],
    }
  }

  const result = shouldConveneCouncil({
    repeatedFailureCount: params.repeatedFailureCount,
    reviewerConflict: params.reviewerConflict,
    isHighRiskCompletion: params.isHighRiskCompletion,
    hasInsufficientEvidence: params.hasInsufficientEvidence,
    userCorrectionCount: params.userCorrectionCount,
    scopeExpanded: params.scopeExpanded,
    recoveryAttempts: params.recoveryAttempts,
    maxRecoveryAttempts: maxRecovery,
  })

  if (!result.shouldConvene || !result.reason) {
    return {
      shouldConvene: false,
      reason: null,
      reviewers: [],
      packet: null,
      packetValid: false,
      packetMissingFields: [],
    }
  }

  if (result.reason === "reviewer_conflict" && params.state.completed_reviews.includes("role-cross")) {
    writeEvidence("cross_review.skipped", {
      reason: "role_cross_already_completed_for_conflict",
      phase: params.state.phase,
      completed_reviews: params.state.completed_reviews,
    }, params.sessionId)
    return {
      shouldConvene: false,
      reason: null,
      reviewers: [],
      packet: null,
      packetValid: false,
      packetMissingFields: [],
    }
  }

  const council = composeCouncil(result.reason)
  const reviewers = [...council.primaryReviewers].filter((reviewer) => !params.state.completed_reviews.includes(reviewer))
  if (reviewers.length === 0) {
    writeEvidence("cross_review.skipped", {
      reason: "all_primary_reviewers_already_completed",
      trigger_reason: result.reason,
      phase: params.state.phase,
      completed_reviews: params.state.completed_reviews,
    }, params.sessionId)
    return {
      shouldConvene: false,
      reason: null,
      reviewers: [],
      packet: null,
      packetValid: false,
      packetMissingFields: [],
    }
  }

  const resultLedger = loadCouncilResults(params.sessionId)

  // Build minimal council packet for dispatch. The Result Ledger snapshot is
  // included so all council reviewers reason from the same already-known work.
  const packet: CouncilPacket = {
    id: `council_${Date.now()}`,
    sessionId: params.sessionId ?? "",
    createdAt: new Date().toISOString(),
    userGoal: params.userGoal ?? "",
    currentPhase: params.state.phase,
    currentPlan: params.currentPlan ?? null,
    scope: [],
    nonGoals: [],
    constraints: [],
    filesChanged: [...new Set([...(params.filesChanged ?? []), ...resultLedger.filesChanged])].slice(0, 20),
    commandsRun: [],
    verificationResults: [],
    resultLedger,
    failures: [{
      type: "repeated_failure",
      fingerprint: `council_${Date.now()}`,
      attempts: params.recoveryAttempts,
    }],
    recoveryAttempts: params.recoveryAttempts,
    reviewerHistory: params.state.required_reviews.map((r) => ({
      reviewer: r,
      verdict: "pending" as const,
      completed: params.state.completed_reviews.includes(r),
    })),
    unresolvedBlockers: [...new Set([
      ...(params.state.block_reason ? [params.state.block_reason] : []),
      ...resultLedger.unresolvedItems,
    ])],
    evidenceRefs: resultLedger.evidenceRefs,
    riskNotes: [],
    costState: { totalUsd: 0, capUsd: 5, exceeded: false },
    allowedActions: [],
    forbiddenActions: [],
    decisionNeeded: `Resolve: ${result.reason}`,
    triggerReason: result.reason,
    riskLevel: params.state.risk,
  }

  const validation = validateCouncilPacket(packet)

  writeEvidence("cross_review.council_triggered", {
    reason: result.reason,
    reviewers,
    packetId: packet.id,
    packetValid: validation.valid,
    result_ledger: resultLedger,
  })

  return {
    shouldConvene: true,
    reason: result.reason,
    reviewers,
    packet,
    packetValid: validation.valid,
    packetMissingFields: validation.missingFields,
  }
}

function loadCouncilResults(sessionId?: string) {
  try {
    return summarizeCouncilResultLedger(sessionId ? loadResults(sessionId) : [])
  } catch {
    return summarizeCouncilResultLedger([])
  }
}
