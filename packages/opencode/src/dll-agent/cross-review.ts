/**
 * dll-agent cross-review.ts
 *
 * Multi-model adversarial cross-review council system.
 *
 * When a single model cannot solve a problem, multiple models form a
 * structured "technical review council" to cross-examine the issue
 * from different angles (requirements, engineering, context, security, cost).
 *
 * Core principles:
 * 1. Council only triggers on repeated failure, reviewer conflict, or high-risk completion
 * 2. All reviewers see the same evidence packet
 * 3. Reviewers are independent (no cross-contamination)
 * 4. Output is structured, not free text
 * 5. Role-cross arbitrates conflicts
 * 6. Cost guard and cooldown prevent abuse
 * 7. Voting is NOT the decider — evidence is
 */

import type { ReviewerRole, RiskLevel, ReviewerOutput, TriggerDecision } from "./interfaces"

// ─── Council Trigger Types ──────────────────────────────────────────────────

export type CouncilTriggerReason =
  | "repeated_failure"
  | "reviewer_conflict"
  | "high_risk_completion"
  | "evidence_insufficient"
  | "user_correction"
  | "scope_expansion"
  | "engineering_dead_end"
  | "security_concern"

export interface CouncilPacket {
  id: string
  sessionId: string
  createdAt: string
  userGoal: string
  currentPhase: string
  currentPlan: string | null
  scope: string[]
  nonGoals: string[]
  constraints: string[]
  filesChanged: string[]
  commandsRun: { command: string; result: string }[]
  verificationResults: { command: string; status: "passed" | "failed" | "not_run"; output?: string }[]
  failures: { type: string; fingerprint: string; attempts: number }[]
  recoveryAttempts: number
  reviewerHistory: { reviewer: ReviewerRole; verdict: string; completed: boolean }[]
  unresolvedBlockers: string[]
  evidenceRefs: string[]
  riskNotes: string[]
  costState: { totalUsd: number; capUsd: number; exceeded: boolean }
  allowedActions: string[]
  forbiddenActions: string[]
  decisionNeeded: string
  triggerReason: CouncilTriggerReason
  riskLevel: RiskLevel
}

// ─── Council Review Request ─────────────────────────────────────────────────

export interface CouncilReviewRequest {
  reviewer: ReviewerRole
  packetId: string
  reviewFocus: string[]
  forbiddenActions: string[]
  evidenceRefs: string[]
}

export interface CouncilReviewResult {
  reviewer: ReviewerRole
  packetId: string
  contextSufficient: boolean
  missingContext: string[]
  blocking: boolean
  confidence: "high" | "medium" | "low"
  decision: "pass" | "block" | "needs_reexecution" | "needs_more_evidence" | "needs_user_input" | "needs_cross_review"
  findings: CouncilFinding[]
  recommendedActions: string[]
  forbiddenActions: string[]
  requiredVerification: string[]
  evidenceRefs: string[]
  riskNotes: string[]
}

export interface CouncilFinding {
  severity: "info" | "warning" | "blocker"
  type: string
  description: string
  evidenceRefs: string[]
  requiredAction: string | null
}

// ─── Candidate Solution ─────────────────────────────────────────────────────

export interface CandidateSolution {
  id: string
  hypothesis: string
  expectedFix: string
  risk: RiskLevel
  filesToTouch: string[]
  verificationPlan: string[]
  rollbackPlan: string[]
  whyPreferred: string
}

// ─── Council State Machine ──────────────────────────────────────────────────

export type CouncilState =
  | "idle"
  | "convening"
  | "reviewing"
  | "arbitrating"
  | "resolved"
  | "deadlocked"

export interface CouncilStatus {
  state: CouncilState
  triggerReason: CouncilTriggerReason | null
  convenedAt: string | null
  reviewersDispatched: ReviewerRole[]
  reviewsCompleted: ReviewerRole[]
  conflicts: string[]
  resolutions: string[]
  candidateSolutions: CandidateSolution[]
  reexecutionRequired: boolean
}

// ─── Trigger Logic ──────────────────────────────────────────────────────────

export function shouldConveneCouncil(params: {
  repeatedFailureCount: number
  reviewerConflict: boolean
  isHighRiskCompletion: boolean
  hasInsufficientEvidence: boolean
  userCorrectionCount: number
  scopeExpanded: boolean
  recoveryAttempts: number
  maxRecoveryAttempts: number
}): { shouldConvene: boolean; reason: CouncilTriggerReason | null } {
  // Trigger: repeated failure with same fingerprint
  if (params.repeatedFailureCount >= 2) {
    return { shouldConvene: true, reason: "repeated_failure" }
  }

  // Trigger: reviewer conflict
  if (params.reviewerConflict) {
    return { shouldConvene: true, reason: "reviewer_conflict" }
  }

  // Trigger: high-risk completion without evidence
  if (params.isHighRiskCompletion && params.hasInsufficientEvidence) {
    return { shouldConvene: true, reason: "high_risk_completion" }
  }

  // Trigger: multiple user corrections
  if (params.userCorrectionCount >= 2) {
    return { shouldConvene: true, reason: "user_correction" }
  }

  // Trigger: scope expanded significantly
  if (params.scopeExpanded && params.recoveryAttempts > 1) {
    return { shouldConvene: true, reason: "scope_expansion" }
  }

  // Trigger: recovery exhausted
  if (params.recoveryAttempts >= params.maxRecoveryAttempts) {
    return { shouldConvene: true, reason: "engineering_dead_end" }
  }

  return { shouldConvene: false, reason: null }
}

// ─── Council Composition ────────────────────────────────────────────────────

/**
 * Determine which reviewers to include in a council based on the trigger reason.
 */
export function composeCouncil(reason: CouncilTriggerReason): {
  primaryReviewers: ReviewerRole[]
  optionalReviewers: ReviewerRole[]
} {
  switch (reason) {
    case "repeated_failure":
      return {
        primaryReviewers: ["chief-engineer"],
        optionalReviewers: ["requirements-inspector", "long-context-archivist"],
      }
    case "reviewer_conflict":
      return {
        primaryReviewers: ["role-cross"],
        optionalReviewers: ["final-auditor"],
      }
    case "high_risk_completion":
    case "evidence_insufficient":
      return {
        primaryReviewers: ["final-auditor", "chief-engineer"],
        optionalReviewers: ["requirements-inspector"],
      }
    case "user_correction":
      return {
        primaryReviewers: ["requirements-inspector"],
        optionalReviewers: ["long-context-archivist"],
      }
    case "scope_expansion":
      return {
        primaryReviewers: ["requirements-inspector", "chief-engineer"],
        optionalReviewers: ["final-auditor"],
      }
    case "engineering_dead_end":
      return {
        primaryReviewers: ["chief-engineer", "role-cross"],
        optionalReviewers: ["final-auditor", "requirements-inspector"],
      }
    case "security_concern":
      return {
        primaryReviewers: ["chief-engineer"],
        optionalReviewers: ["final-auditor"],
      }
  }
}

// ─── Council Packet Validation ──────────────────────────────────────────────

export function validateCouncilPacket(packet: CouncilPacket): {
  valid: boolean
  missingFields: string[]
} {
  const missing: string[] = []

  if (!packet.userGoal) missing.push("user_goal")
  if (!packet.currentPhase) missing.push("current_phase")
  if (packet.failures.length === 0 && packet.triggerReason !== "user_correction") {
    missing.push("failures (expected for non-correction trigger)")
  }
  if (!packet.decisionNeeded) missing.push("decision_needed")
  if (packet.evidenceRefs.length === 0 && packet.triggerReason !== "user_correction") {
    missing.push("evidence_refs")
  }

  return { valid: missing.length === 0, missingFields: missing }
}

// ─── Review Independence Check ──────────────────────────────────────────────

/**
 * Check that a reviewer's output is based on the packet, not on another reviewer.
 * Returns true if the review appears independent (no cross-contamination).
 */
export function checkReviewIndependence(
  review: CouncilReviewResult,
  otherReviews: CouncilReviewResult[],
): boolean {
  // A review that references another reviewer's specific findings may be contaminated
  for (const other of otherReviews) {
    if (other.reviewer === review.reviewer) continue
    for (const finding of review.findings) {
      if (finding.description.includes(other.reviewer)) {
        // The finding mentions another reviewer — potential contamination
        // Only flag if it's not a role-cross review (which is expected to reference others)
        if (review.reviewer !== "role-cross") return false
      }
    }
  }
  return true
}

// ─── Conflict Arbitration ───────────────────────────────────────────────────

export interface ArbitrationResult {
  resolved: boolean
  acceptedReviewer: ReviewerRole | null
  reason: string
  evidenceRefs: string[]
  recommendedAction: string
}

export function arbitrateConflict(
  reviewA: CouncilReviewResult,
  reviewB: CouncilReviewResult,
  evidenceRefs: string[],
): ArbitrationResult {
  // Conflict resolution logic based on evidence

  // If one has context_sufficient=false and the other doesn't, prefer the one with context
  if (!reviewA.contextSufficient && reviewB.contextSufficient) {
    return {
      resolved: true,
      acceptedReviewer: reviewB.reviewer,
      reason: `${reviewA.reviewer} had insufficient context`,
      evidenceRefs,
      recommendedAction: reviewB.recommendedActions[0] ?? "Follow the context-sufficient reviewer's recommendation",
    }
  }
  if (!reviewB.contextSufficient && reviewA.contextSufficient) {
    return {
      resolved: true,
      acceptedReviewer: reviewA.reviewer,
      reason: `${reviewB.reviewer} had insufficient context`,
      evidenceRefs,
      recommendedAction: reviewA.recommendedActions[0] ?? "Follow the context-sufficient reviewer's recommendation",
    }
  }

  // If one has higher confidence, prefer it
  if (reviewA.confidence === "high" && reviewB.confidence !== "high") {
    return {
      resolved: true,
      acceptedReviewer: reviewA.reviewer,
      reason: `${reviewA.reviewer} has higher confidence (${reviewA.confidence})`,
      evidenceRefs: [...evidenceRefs, ...reviewA.evidenceRefs],
      recommendedAction: reviewA.recommendedActions[0] ?? "Follow the higher-confidence reviewer",
    }
  }
  if (reviewB.confidence === "high" && reviewA.confidence !== "high") {
    return {
      resolved: true,
      acceptedReviewer: reviewB.reviewer,
      reason: `${reviewB.reviewer} has higher confidence (${reviewB.confidence})`,
      evidenceRefs: [...evidenceRefs, ...reviewB.evidenceRefs],
      recommendedAction: reviewB.recommendedActions[0] ?? "Follow the higher-confidence reviewer",
    }
  }

  // If both block, require reexecution
  if (reviewA.blocking && reviewB.blocking) {
    return {
      resolved: false,
      acceptedReviewer: null,
      reason: "Both reviewers block — reexecution required",
      evidenceRefs,
      recommendedAction: "Re-execute with both reviewers' feedback incorporated",
    }
  }

  // If one blocks and the other passes, the blocking one wins (safety first)
  if (reviewA.blocking && !reviewB.blocking) {
    return {
      resolved: true,
      acceptedReviewer: reviewA.reviewer,
      reason: `${reviewA.reviewer} blocks — safety-first: blocking review takes precedence`,
      evidenceRefs,
      recommendedAction: reviewA.recommendedActions[0] ?? "Address the blocking reviewer's concerns",
    }
  }
  if (reviewB.blocking && !reviewA.blocking) {
    return {
      resolved: true,
      acceptedReviewer: reviewB.reviewer,
      reason: `${reviewB.reviewer} blocks — safety-first: blocking review takes precedence`,
      evidenceRefs,
      recommendedAction: reviewB.recommendedActions[0] ?? "Address the blocking reviewer's concerns",
    }
  }

  // Default: need more evidence
  return {
    resolved: false,
    acceptedReviewer: null,
    reason: "Unable to resolve conflict — both reviewers pass but disagree on details",
    evidenceRefs,
    recommendedAction: "Gather more evidence and re-convene the council",
  }
}

// ─── Council Summary ────────────────────────────────────────────────────────

export function buildCouncilSummary(status: CouncilStatus): string {
  const lines = [
    `[dll-agent cross-review council]`,
    `State: ${status.state}`,
    status.triggerReason ? `Trigger: ${status.triggerReason}` : null,
    status.convenedAt ? `Convened: ${status.convenedAt}` : null,
    ``,
    `Reviewers dispatched: [${status.reviewersDispatched.join(", ")}]`,
    `Reviews completed: [${status.reviewsCompleted.join(", ")}]`,
    status.conflicts.length > 0 ? `Conflicts: ${status.conflicts.join("; ")}` : "No conflicts",
    status.reexecutionRequired ? "REEXECUTION REQUIRED" : "No reexecution needed",
    ``,
    status.candidateSolutions.length > 0
      ? `Candidate solutions (${status.candidateSolutions.length}):\n${
          status.candidateSolutions.map(
            (s, i) => `  ${i + 1}. [${s.risk}] ${s.hypothesis} → ${s.expectedFix}`,
          ).join("\n")
        }`
      : "No candidate solutions yet",
    ``,
    status.resolutions.length > 0
      ? `Resolutions: ${status.resolutions.join("; ")}`
      : "Not yet resolved",
  ].filter(Boolean).join("\n")

  return lines
}
