import type { MessageV2 } from "@/session/message-v2"
import type { SupervisorState } from "./interfaces"
import type { Metrics } from "./triggers"
import {
  canUseAnswerOnlyFinalization,
  type TaskFinalizationPolicy,
  type TaskIntakeClassification,
} from "./task-intake-classifier"

export type AnswerDeliveryMode = NonNullable<SupervisorState["answer_delivery"]>["mode"]

const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "webfetch"])
const MCP_TOOL_PATTERN = /mcp/i

export function answerModeFromClassification(classification: TaskIntakeClassification | undefined): AnswerDeliveryMode {
  const policy = classification?.finalization_policy
  if (policy === "stateless_answer") return "stateless_answer"
  if (policy === "informational_answer") return "informational_answer"
  if (policy === "read_only_answer") return "read_only_answer"
  if (policy === "high_risk_governance") return "high_risk_governance"
  return "engineering_verification"
}

export function isAnswerOnlyPolicy(policy: TaskFinalizationPolicy | undefined) {
  return policy === "stateless_answer" || policy === "informational_answer" || policy === "read_only_answer"
}

export function currentAnswerClassification(input: {
  state: SupervisorState
  userMessageId: string
  fallback: TaskIntakeClassification
}) {
  return input.state.intent_judgement?.message_id === input.userMessageId
    ? input.state.intent_judgement.classification
    : input.fallback
}

export function buildToolUseSummary(messages: MessageV2.WithParts[]) {
  let readOnlyTools = 0
  let writeOrCommandTools = 0
  let mcpTools = 0
  let blockingFailures = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (MCP_TOOL_PATTERN.test(part.tool)) mcpTools++
      const state = part.state
      const isReadOnly = READ_ONLY_TOOLS.has(part.tool.toLowerCase())
      if (isReadOnly) readOnlyTools++
      else writeOrCommandTools++
      if (state.status === "error" && !isReadOnly) blockingFailures++
      if (state.status === "completed" && !isReadOnly && /fail|error|exception|traceback|失败|错误/i.test(state.output ?? "")) {
        blockingFailures++
      }
    }
  }
  return { readOnlyTools, writeOrCommandTools, mcpTools, blockingFailures }
}

export function canAcceptAnswerOnly(input: {
  classification: TaskIntakeClassification | undefined
  metrics: Metrics
  state: SupervisorState
  messages: MessageV2.WithParts[]
}) {
  if (!canUseAnswerOnlyFinalization(input.classification)) return false
  if (input.metrics.recentUserCorrection || input.metrics.userCorrections > 0) return false
  if (input.metrics.permissionDenied > 0) return false
  if (input.metrics.reviewerConflictSignal) return false
  if (input.metrics.highRiskTaskSignal) return false
  if (input.metrics.multimodalSignal) return false
  if (input.metrics.scopeExpandedSignal || input.metrics.phaseSwitchSignal) return false
  if (input.state.blocked_completion || input.state.reviewer_conflict) return false
  if (input.state.required_reviews.length > 0) return false
  if ((input.state.queued_reviewers ?? []).length > 0) return false
  if ((input.state.running_reviewers ?? []).length > 0) return false
  const tools = buildToolUseSummary(input.messages)
  if (tools.writeOrCommandTools > 0 || tools.mcpTools > 0 || tools.blockingFailures > 0) return false
  return true
}

export function answerAlreadyAcceptedForUser(state: SupervisorState, userMessageId: string) {
  return state.answer_delivery?.user_message_id === userMessageId &&
    state.answer_delivery.public_answer_emitted &&
    state.answer_delivery.status === "accepted" &&
    !state.answer_delivery.public_followup_allowed
}

export function publicAnswerClosedForUser(state: SupervisorState, userMessageId: string) {
  return state.answer_delivery?.user_message_id === userMessageId &&
    state.answer_delivery.public_answer_emitted &&
    (state.answer_delivery.status === "accepted" || state.answer_delivery.status === "blocked") &&
    !state.answer_delivery.public_followup_allowed
}

export function shouldSuppressSyntheticContinuation(state: SupervisorState, userMessageId: string) {
  return publicAnswerClosedForUser(state, userMessageId)
}

export function acceptPublicResponse(input: {
  state: SupervisorState
  userMessageId: string
  assistantMessageId?: string
  mode: AnswerDeliveryMode
  status?: "accepted" | "blocked"
  evidenceRefs?: string[]
  reason: string
  internalReviewAllowed?: boolean
  councilAllowed?: boolean
}) {
  const now = new Date().toISOString()
  return {
    ...input.state,
    answer_delivery: {
      user_message_id: input.userMessageId,
      assistant_message_id: input.assistantMessageId,
      mode: input.mode,
      status: input.status ?? "accepted",
      public_answer_emitted: true,
      internal_review_allowed: input.internalReviewAllowed ?? false,
      council_allowed: input.councilAllowed ?? false,
      public_followup_allowed: false,
      accepted_reason: input.reason,
      evidence_refs: input.evidenceRefs ?? [],
      updated_at: now,
    },
    updated_at: now,
  } satisfies SupervisorState
}

export function acceptAnswerOnly(input: {
  state: SupervisorState
  userMessageId: string
  assistantMessageId?: string
  classification: TaskIntakeClassification
  evidenceRefs?: string[]
  reason: string
}) {
  return acceptPublicResponse({
    state: input.state,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    mode: answerModeFromClassification(input.classification),
    status: "accepted",
    evidenceRefs: input.evidenceRefs,
    reason: input.reason,
  })
}

export * as AnswerDelivery from "./answer-delivery"
