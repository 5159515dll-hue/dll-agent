import { describe, expect, test } from "bun:test"
import {
  applySupervisorTriggerRules,
  needsAutoVerifier,
} from "../../src/dll-agent/supervisor-trigger-rules"
import type { ReviewerRole } from "../../src/dll-agent/interfaces"
import type { Metrics } from "../../src/dll-agent/triggers"
import type { MessageV2 } from "../../src/session/message-v2"

function baseMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    userCorrections: 0,
    recentUserCorrection: false,
    toolFailures: 0,
    permissionDenied: 0,
    repeatedToolFailure: false,
    contextTokens: 1000,
    contextPercent: 10,
    longContextSignal: false,
    finalClaim: false,
    verificationEvidence: false,
    realToolEvidence: false,
    reviewerConflictSignal: false,
    kimiCompletionCheckSignal: false,
    glmCompletionClaimSignal: false,
    kimiPreReportSignal: false,
    scopeExpandedSignal: false,
    phaseSwitchSignal: false,
    multimodalSignal: false,
    highRiskTaskSignal: false,
    statelessGreetingTask: false,
    statelessChatTask: false,
    readOnlyAnswerTask: false,
    readOnlyToolAnswerTask: false,
    trivialNoToolTask: false,
    ...overrides,
  }
}

function textMessage(text: string): MessageV2.WithParts {
  return {
    info: {
      id: "msg_test",
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
    } as any,
    parts: [{ type: "text", text } as any],
  }
}

function collectReviewers(metrics: Metrics, messages: MessageV2.WithParts[] = [textMessage("test")]) {
  const reviewers: ReviewerRole[] = []
  let tokenAware = 0
  let multimodalSkip = 0
  applySupervisorTriggerRules({
    metrics,
    messages,
    risk: metrics.highRiskTaskSignal ? "high" : "low",
    contextLimit: 10_000,
  }, {
    addReviewer: (reviewer) => {
      if (!reviewers.includes(reviewer)) reviewers.push(reviewer)
    },
    hasReviewer: (reviewer) => reviewers.includes(reviewer),
    writeTokenAwareEvidence: () => tokenAware++,
    writeMultimodalSkip: () => multimodalSkip++,
  })
  return { reviewers, tokenAware, multimodalSkip }
}

describe("supervisor trigger rules", () => {
  test("user correction triggers requirements-inspector", () => {
    const result = collectReviewers(baseMetrics({ recentUserCorrection: true, userCorrections: 1 }))
    expect(result.reviewers).toEqual(["requirements-inspector"])
  })

  test("repeated failure triggers chief-engineer and escalates to role-cross after repeated failures", () => {
    const second = collectReviewers(baseMetrics({ repeatedToolFailure: true, toolFailures: 2 }))
    expect(second.reviewers).toContain("chief-engineer")
    expect(second.reviewers).not.toContain("role-cross")

    const third = collectReviewers(baseMetrics({ repeatedToolFailure: true, toolFailures: 4 }))
    expect(third.reviewers).toContain("chief-engineer")
    expect(third.reviewers).toContain("role-cross")
  })

  test("high-risk task requests multiple correctness reviewers", () => {
    const result = collectReviewers(baseMetrics({ highRiskTaskSignal: true, finalClaim: true }))
    expect(result.reviewers).toContain("requirements-inspector")
    expect(result.reviewers).toContain("chief-engineer")
    expect(result.reviewers).toContain("final-auditor")
  })

  test("pure text multimodal signal is skipped instead of triggering multimodal reviewer", () => {
    const result = collectReviewers(baseMetrics({ multimodalSignal: true }), [textMessage("检查截图这个词，但没有图片附件")])
    expect(result.reviewers).not.toContain("multimodal-context-interpreter")
    expect(result.multimodalSkip).toBe(1)
  })

  test("token-aware evidence is emitted for high context without changing reviewer list", () => {
    const result = collectReviewers(baseMetrics({ contextPercent: 65, contextTokens: 7000 }))
    expect(result.tokenAware).toBe(1)
    expect(result.reviewers).toEqual([])
  })

  test("auto verifier remains limited to final claims without real evidence or failures", () => {
    expect(needsAutoVerifier(baseMetrics({ finalClaim: true, realToolEvidence: false, toolFailures: 0 }))).toBe(true)
    expect(needsAutoVerifier(baseMetrics({ finalClaim: true, realToolEvidence: true, toolFailures: 0 }))).toBe(false)
    expect(needsAutoVerifier(baseMetrics({ finalClaim: true, realToolEvidence: false, toolFailures: 1 }))).toBe(false)
  })

  test("trivial no-tool task suppresses no-value reviewer and verifier triggers", () => {
    const result = collectReviewers(baseMetrics({
      trivialNoToolTask: true,
    }), [textMessage("只回答 OK，不要执行工具。")])
    expect(result.reviewers).toEqual([])
    expect(needsAutoVerifier(baseMetrics({ trivialNoToolTask: true, realToolEvidence: false, toolFailures: 0 }))).toBe(false)
  })

  test("stateless greeting suppresses no-value reviewer and verifier triggers", () => {
    const result = collectReviewers(baseMetrics({
      statelessGreetingTask: true,
      statelessChatTask: true,
    }), [textMessage("你好")])
    expect(result.reviewers).toEqual([])
    expect(needsAutoVerifier(baseMetrics({
      statelessGreetingTask: true,
      statelessChatTask: true,
      realToolEvidence: false,
      toolFailures: 0,
    }))).toBe(false)
  })

  test("trivial flag cannot suppress correctness-required high-risk state", () => {
    const result = collectReviewers(baseMetrics({
      trivialNoToolTask: true,
      statelessChatTask: true,
      highRiskTaskSignal: true,
      finalClaim: true,
    }), [textMessage("只回答 OK，不要执行工具。")])
    expect(result.reviewers).toContain("requirements-inspector")
    expect(result.reviewers).toContain("chief-engineer")
    expect(result.reviewers).toContain("final-auditor")
    expect(needsAutoVerifier(baseMetrics({
      trivialNoToolTask: true,
      finalClaim: true,
      highRiskTaskSignal: true,
      realToolEvidence: false,
      toolFailures: 0,
    }))).toBe(true)
  })

  test("read-only analysis answer suppresses completion-claim reviewers and auto-verifier", () => {
    const userText = ["介绍", "工程", "不修改内容"].join(" ")
    const result = collectReviewers(baseMetrics({
      readOnlyAnswerTask: true,
      finalClaim: true,
      glmCompletionClaimSignal: true,
      kimiCompletionCheckSignal: true,
      realToolEvidence: false,
    }), [textMessage(userText)])
    expect(result.reviewers).toEqual([])
    expect(needsAutoVerifier(baseMetrics({
      readOnlyAnswerTask: true,
      finalClaim: true,
      realToolEvidence: false,
      toolFailures: 0,
    }))).toBe(false)
  })
})
