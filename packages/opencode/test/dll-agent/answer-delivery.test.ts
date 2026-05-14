import { describe, expect, test } from "bun:test"
import {
  acceptAnswerOnly,
  acceptPublicResponse,
  answerAlreadyAcceptedForUser,
  buildToolUseSummary,
  canAcceptAnswerOnly,
  publicAnswerClosedForUser,
  shouldSuppressSyntheticContinuation,
} from "../../src/dll-agent/answer-delivery"
import type { SupervisorState } from "../../src/dll-agent/interfaces"
import type { TaskIntakeClassification } from "../../src/dll-agent/task-intake-classifier"

const readOnlyClassification = {
  task_kind: "light_engineering_analysis",
  interaction_level: "L2",
  user_origin_only: true,
  tool_required: false,
  reviewer_required: false,
  verification_required: false,
  goal_contract_required: false,
  repo_doctor_allowed: false,
  continuation_allowed: false,
  final_gate_required: false,
  model_classifier_needed: false,
  confidence: "high",
  reason: "read-only analysis",
  matched_rules: ["test"],
  safety_overrides: [],
  finalization_policy: "read_only_answer",
} satisfies TaskIntakeClassification

const baseState = {
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
  updated_at: new Date().toISOString(),
} satisfies SupervisorState

const baseMetrics = {
  recentUserCorrection: false,
  userCorrections: 0,
  permissionDenied: 0,
  reviewerConflictSignal: false,
  highRiskTaskSignal: false,
  multimodalSignal: false,
  scopeExpandedSignal: false,
  phaseSwitchSignal: false,
} as any

function toolMessage(tool: string, status: "completed" | "error" = "completed", output = "") {
  return {
    info: { id: "msg", role: "assistant" },
    parts: [{
      type: "tool",
      tool,
      callID: `${tool}_1`,
      state: status === "error" ? { status, error: output } : { status, output },
    }],
  } as any
}

describe("answer delivery lifecycle", () => {
  test("accepts L2 read-only answers with only read/glob/list tools", () => {
    expect(canAcceptAnswerOnly({
      classification: readOnlyClassification,
      metrics: baseMetrics,
      state: baseState,
      messages: [
        toolMessage("read"),
        toolMessage("glob"),
        toolMessage("list"),
      ],
    })).toBe(true)
  })

  test("does not accept answer-only when shell/write/MCP tools are present", () => {
    expect(canAcceptAnswerOnly({
      classification: readOnlyClassification,
      metrics: baseMetrics,
      state: baseState,
      messages: [toolMessage("bash")],
    })).toBe(false)
    expect(canAcceptAnswerOnly({
      classification: readOnlyClassification,
      metrics: baseMetrics,
      state: baseState,
      messages: [toolMessage("mcp-start")],
    })).toBe(false)
  })

  test("public answer latch prevents repeated user-visible answers", () => {
    const accepted = acceptAnswerOnly({
      state: baseState,
      userMessageId: "user_1",
      assistantMessageId: "assistant_1",
      classification: readOnlyClassification,
      reason: "read-only answer accepted",
    })

    expect(accepted.answer_delivery?.public_answer_emitted).toBe(true)
    expect(accepted.answer_delivery?.public_followup_allowed).toBe(false)
    expect(answerAlreadyAcceptedForUser(accepted, "user_1")).toBe(true)
    expect(answerAlreadyAcceptedForUser(accepted, "user_2")).toBe(false)
    expect(publicAnswerClosedForUser(accepted, "user_1")).toBe(true)
  })

  test("blocked public response also closes synthetic continuation for the real user", () => {
    const blocked = acceptPublicResponse({
      state: baseState,
      userMessageId: "real_user_1",
      assistantMessageId: "assistant_1",
      mode: "engineering_verification",
      status: "blocked",
      reason: "gate retry exhausted after public blocked report",
    })

    expect(answerAlreadyAcceptedForUser(blocked, "real_user_1")).toBe(false)
    expect(publicAnswerClosedForUser(blocked, "real_user_1")).toBe(true)
    expect(publicAnswerClosedForUser(blocked, "synthetic_user_2")).toBe(false)
    expect(shouldSuppressSyntheticContinuation(blocked, "real_user_1")).toBe(true)
    expect(shouldSuppressSyntheticContinuation(blocked, "synthetic_user_2")).toBe(false)
  })

  test("tool summary treats read-only failures as non-blocking but command failures as blocking", () => {
    expect(buildToolUseSummary([toolMessage("read", "error", "file missing")]).blockingFailures).toBe(0)
    expect(buildToolUseSummary([toolMessage("bash", "error", "FAIL")]).blockingFailures).toBe(1)
  })
})
