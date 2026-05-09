import type { MessageV2 } from "@/session/message-v2"
import type { ReviewerRole, RiskLevel } from "./interfaces"
import type { Metrics } from "./triggers"
import { hasNonTextInput } from "./routing-policy"

export interface SupervisorTriggerRuleCallbacks {
  addReviewer: (reviewer: ReviewerRole, reason: string) => void
  hasReviewer: (reviewer: ReviewerRole) => boolean
  writeTokenAwareEvidence: () => void
  writeMultimodalSkip: () => void
}

export function applySupervisorTriggerRules(input: {
  metrics: Metrics
  messages: MessageV2.WithParts[]
  risk: RiskLevel
  contextLimit?: number
}, callbacks: SupervisorTriggerRuleCallbacks) {
  const metrics = input.metrics

  if (metrics.recentUserCorrection || metrics.userCorrections >= 1) {
    callbacks.addReviewer(
      "requirements-inspector",
      metrics.recentUserCorrection
        ? "user correction detected in most recent message"
        : `user corrections detected in ${metrics.userCorrections} recent messages`,
    )
  }

  if (metrics.longContextSignal) {
    callbacks.addReviewer(
      "long-context-archivist",
      metrics.contextPercent >= 40
        ? `context at ${metrics.contextPercent}% of limit`
        : "long-context or document-task signal detected in messages",
    )
  }

  if (metrics.kimiPreReportSignal && !callbacks.hasReviewer("long-context-archivist")) {
    callbacks.addReviewer(
      "long-context-archivist",
      `pre-report context compression: context at ${metrics.contextPercent}% with final claim`,
    )
  }

  if (metrics.phaseSwitchSignal) {
    callbacks.addReviewer("long-context-archivist", "phase switch or task direction change detected")
  }

  if (metrics.repeatedToolFailure || metrics.toolFailures >= 3) {
    callbacks.addReviewer(
      "chief-engineer",
      metrics.repeatedToolFailure
        ? "repeated tool failure detected (same error pattern)"
        : `${metrics.toolFailures} tool failures in recent messages`,
    )
    if (metrics.toolFailures >= 4 || metrics.reviewerConflictSignal) {
      callbacks.addReviewer("role-cross", "third repeated failure or reviewer conflict requires cross-review")
    }
  }

  if (metrics.permissionDenied >= 1 && !callbacks.hasReviewer("chief-engineer")) {
    callbacks.addReviewer("chief-engineer", `permission denied detected in ${metrics.permissionDenied} tool call(s)`)
  }

  if (metrics.reviewerConflictSignal) {
    callbacks.addReviewer("role-cross", "reviewer conflict signal detected")
  }

  if (metrics.highRiskTaskSignal) {
    callbacks.addReviewer("requirements-inspector", "high-risk governance/runtime task requires requirements and scope alignment review")
    callbacks.addReviewer("chief-engineer", "high-risk governance/runtime task requires engineering risk review")
    if (metrics.finalClaim || metrics.reviewerConflictSignal || metrics.repeatedToolFailure) {
      callbacks.addReviewer("final-auditor", "high-risk governance/runtime completion needs final audit")
    }
  }

  if (metrics.finalClaim && !metrics.verificationEvidence && input.risk === "high") {
    callbacks.addReviewer("final-auditor", "high-risk final claim without verification evidence")
  }

  if (metrics.glmCompletionClaimSignal && !callbacks.hasReviewer("requirements-inspector")) {
    callbacks.addReviewer(
      "requirements-inspector",
      metrics.realToolEvidence
        ? "completion claim with suspected contradiction (correction pattern in claim text)"
        : "completion claim without real tool evidence — requirements check needed",
    )
  }

  if (metrics.kimiCompletionCheckSignal) {
    callbacks.addReviewer("task-completion-archivist", "completion claim with unfinished indicators detected")
  }

  if (metrics.scopeExpandedSignal && !callbacks.hasReviewer("requirements-inspector")) {
    callbacks.addReviewer("requirements-inspector", "scope expansion or feature creep detected")
  }

  if (input.contextLimit && (metrics.contextPercent >= 60 || metrics.contextTokens > input.contextLimit * 0.6)) {
    callbacks.writeTokenAwareEvidence()
  }

  if (metrics.multimodalSignal && hasNonTextInput(input.messages)) {
    callbacks.addReviewer(
      "multimodal-context-interpreter",
      "multimodal input detected (screenshot, image, video, audio, PPT figure, chart, etc.)",
    )
    return
  }

  if (metrics.multimodalSignal) callbacks.writeMultimodalSkip()
}

export function needsAutoVerifier(metrics: Metrics) {
  return metrics.finalClaim && !metrics.realToolEvidence && metrics.toolFailures === 0
}

export * as SupervisorTriggerRules from "./supervisor-trigger-rules"
