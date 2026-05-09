import { describe, expect, test } from "bun:test"
import {
  applyReviewerCompletedToState,
  applySupervisorDecisionToState,
  clearResolvedBlockState,
  freshSupervisorState,
  metricsFromSupervisorSnapshot,
  reviewerOutputBlocksCompletion,
} from "../../src/dll-agent/supervisor-state-machine"
import type { ReviewerOutput, TriggerDecision } from "../../src/dll-agent/interfaces"

function decision(overrides: Partial<TriggerDecision> = {}): TriggerDecision {
  return {
    should_review: true,
    reviewers: ["requirements-inspector"],
    reasons: { "requirements-inspector": "user correction" } as TriggerDecision["reasons"],
    metrics: {
      tool_failures: 0,
      permission_denied: 0,
      user_corrections: 1,
      context_percent: 10,
      context_tokens: 1000,
      final_claim: false,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    ...overrides,
  }
}

function reviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    version: 1,
    reviewer: "requirements-inspector",
    trigger_reason: "review",
    verdict: "pass",
    findings: [],
    score: 100,
    block_completion: false,
    next_actions: [],
    evidence_confidence: 100,
    ts: "2026-05-09T00:00:00.000Z",
    ...overrides,
  }
}

describe("supervisor state machine", () => {
  test("fresh state keeps supervisor defaults isolated from filesystem persistence", () => {
    const state = freshSupervisorState()
    expect(state.version).toBe(1)
    expect(state.risk).toBe("low")
    expect(state.required_reviews).toEqual([])
    expect(state.completed_reviews).toEqual([])
    expect(state.blocked_completion).toBe(false)
  })

  test("metrics snapshot converts to trigger metrics without changing semantics", () => {
    const metrics = metricsFromSupervisorSnapshot({
      tool_failures: 3,
      permission_denied: 1,
      user_corrections: 2,
      context_percent: 50,
      context_tokens: 5000,
      final_claim: true,
      verification_evidence: false,
      reviewer_conflict_signal: true,
      repeated_tool_failure: true,
      real_tool_evidence: false,
    })
    expect(metrics.toolFailures).toBe(3)
    expect(metrics.recentUserCorrection).toBe(true)
    expect(metrics.longContextSignal).toBe(true)
    expect(metrics.finalClaim).toBe(true)
  })

  test("decision application records required reviewers and blocks unverified final claims", () => {
    const state = freshSupervisorState()
    applySupervisorDecisionToState(state, decision({
      reviewers: ["final-auditor"],
      reasons: { "final-auditor": "final claim without verification" } as TriggerDecision["reasons"],
      metrics: {
        ...decision().metrics,
        final_claim: true,
        verification_evidence: false,
      },
    }))

    expect(state.required_reviews).toContain("final-auditor")
    expect(state.blocked_completion).toBe(true)
    expect(state.block_reason).toBe("completion claim without verification evidence")
    expect(state.continuation_count).toBe(1)
  })

  test("reviewer completion removes pending state and clears role-cross conflict when resolved", () => {
    const state = freshSupervisorState()
    state.required_reviews = ["role-cross"]
    state.queued_reviewers = ["role-cross"]
    state.running_reviewers = ["role-cross"]
    state.reviewer_conflict = true

    const result = applyReviewerCompletedToState(state, "role-cross")
    expect(result.blockCompletion).toBe(false)
    expect(state.completed_reviews).toContain("role-cross")
    expect(state.required_reviews).toEqual([])
    expect(state.queued_reviewers).toEqual([])
    expect(state.running_reviewers).toEqual([])
    expect(state.reviewer_conflict).toBe(false)
  })

  test("blocking reviewer output and unstructured fallback both block completion", () => {
    const structured = reviewerOutputBlocksCompletion({
      output: reviewerOutput({
        verdict: "fail_block",
        block_completion: true,
        findings: [{
          severity: "block",
          category: "evidence_missing",
          summary: "verification evidence is missing",
          citations: ["evidence:not_run"],
        }],
      }),
    })
    expect(structured.blocks).toBe(true)
    expect(structured.reason).toContain("verification evidence is missing")

    const fallback = reviewerOutputBlocksCompletion({ rawText: "blocking: 缺少证据，不能通过" })
    expect(fallback.blocks).toBe(true)
    expect(fallback.reason).toContain("fallback unstructured reviewer output")
  })

  test("clearResolvedBlockState only clears blocked completion after required reviews are resolved", () => {
    const state = freshSupervisorState()
    state.required_reviews = ["chief-engineer"]
    state.blocked_completion = true
    state.block_reason = "reviewer chief-engineer blocked completion"
    clearResolvedBlockState(state)
    expect(state.blocked_completion).toBe(true)

    state.required_reviews = []
    clearResolvedBlockState(state)
    expect(state.blocked_completion).toBe(false)
    expect(state.block_reason).toBeNull()
  })
})
