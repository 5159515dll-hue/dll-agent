/**
 * dll-agent cross-review tests
 */
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, it, expect } from "bun:test"
import {
  shouldConveneCouncil,
  composeCouncil,
  validateCouncilPacket,
  arbitrateConflict,
  checkReviewIndependence,
  summarizeCouncilResultLedger,
  buildCouncilSummary,
} from "../../src/dll-agent/cross-review"
import { checkCrossReviewTrigger } from "../../src/dll-agent/cross-review-bridge"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"
import type { CouncilPacket, CouncilReviewResult, CouncilStatus } from "../../src/dll-agent/cross-review"
import type { SupervisorState } from "../../src/dll-agent/interfaces"

const cleanupSessions: string[] = []

afterEach(() => {
  for (const sessionID of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", sessionID), { recursive: true, force: true })
  }
})

function emptyResultLedger() {
  return summarizeCouncilResultLedger([])
}

function state(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    version: 1,
    phase: "default",
    risk: "medium",
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
    ...overrides,
  }
}

describe("cross-review", () => {
  describe("shouldConveneCouncil", () => {
    it("convenes on repeated failure >= 2", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 2,
        reviewerConflict: false,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 1,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(true)
      expect(result.reason).toBe("repeated_failure")
    })

    it("convenes on reviewer conflict", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 0,
        reviewerConflict: true,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 1,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(true)
      expect(result.reason).toBe("reviewer_conflict")
    })

    it("convenes on high risk completion without evidence", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 0,
        reviewerConflict: false,
        isHighRiskCompletion: true,
        hasInsufficientEvidence: true,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 1,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(true)
      expect(result.reason).toBe("high_risk_completion")
    })

    it("convenes on multiple user corrections", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 0,
        reviewerConflict: false,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 2,
        scopeExpanded: false,
        recoveryAttempts: 1,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(true)
      expect(result.reason).toBe("user_correction")
    })

    it("convenes when recovery exhausted", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 0,
        reviewerConflict: false,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 5,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(true)
      expect(result.reason).toBe("engineering_dead_end")
    })

    it("does not convene for normal operation", () => {
      const result = shouldConveneCouncil({
        repeatedFailureCount: 0,
        reviewerConflict: false,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 0,
        maxRecoveryAttempts: 5,
      })
      expect(result.shouldConvene).toBe(false)
    })
  })

  describe("checkCrossReviewTrigger", () => {
    it("does not reconvene role-cross after role-cross completed a reviewer conflict", () => {
      const result = checkCrossReviewTrigger({
        state: state({ completed_reviews: ["role-cross"], reviewer_conflict: true }),
        repeatedFailureCount: 0,
        reviewerConflict: true,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 1,
        sessionId: "ses_cross_review_test",
        userGoal: "修复重复 reviewer 触发",
      })
      expect(result.shouldConvene).toBe(false)
      expect(result.reviewers).toEqual([])
    })
  })

  describe("composeCouncil", () => {
    it("includes chief-engineer for repeated failure", () => {
      const council = composeCouncil("repeated_failure")
      expect(council.primaryReviewers).toContain("chief-engineer")
    })

    it("includes role-cross for reviewer conflict", () => {
      const council = composeCouncil("reviewer_conflict")
      expect(council.primaryReviewers).toContain("role-cross")
    })

    it("includes final-auditor for high risk completion", () => {
      const council = composeCouncil("high_risk_completion")
      expect(council.primaryReviewers).toContain("final-auditor")
    })
  })

  describe("validateCouncilPacket", () => {
    it("rejects packet without user_goal", () => {
      const packet = {
        id: "pkt_1",
        sessionId: "ses_1",
        createdAt: new Date().toISOString(),
        userGoal: "",
        currentPhase: "implementation",
        currentPlan: null,
        scope: [],
        nonGoals: [],
        constraints: [],
        filesChanged: [],
        commandsRun: [],
        verificationResults: [],
        resultLedger: emptyResultLedger(),
        failures: [{ type: "test", fingerprint: "fp1", attempts: 2 }],
        recoveryAttempts: 1,
        reviewerHistory: [],
        unresolvedBlockers: [],
        evidenceRefs: ["ev1"],
        riskNotes: [],
        costState: { totalUsd: 0, capUsd: 5, exceeded: false },
        allowedActions: [],
        forbiddenActions: [],
        decisionNeeded: "Should we proceed?",
        triggerReason: "repeated_failure",
        riskLevel: "medium",
      } as CouncilPacket

      const result = validateCouncilPacket(packet)
      expect(result.valid).toBe(false)
      expect(result.missingFields).toContain("user_goal")
    })

    it("accepts valid packet", () => {
      const packet: CouncilPacket = {
        id: "pkt_1",
        sessionId: "ses_1",
        createdAt: new Date().toISOString(),
        userGoal: "Fix type errors",
        currentPhase: "implementation",
        currentPlan: null,
        scope: [],
        nonGoals: [],
        constraints: [],
        filesChanged: [],
        commandsRun: [],
        verificationResults: [],
        resultLedger: emptyResultLedger(),
        failures: [{ type: "test", fingerprint: "fp1", attempts: 2 }],
        recoveryAttempts: 1,
        reviewerHistory: [],
        unresolvedBlockers: [],
        evidenceRefs: ["ev1"],
        riskNotes: [],
        costState: { totalUsd: 0, capUsd: 5, exceeded: false },
        allowedActions: [],
        forbiddenActions: [],
        decisionNeeded: "Should we proceed?",
        triggerReason: "repeated_failure",
        riskLevel: "medium",
      }

      const result = validateCouncilPacket(packet)
      expect(result.valid).toBe(true)
      expect(result.missingFields).toEqual([])
    })

    it("summarizes Result Ledger into council packet evidence", () => {
      const snapshot = summarizeCouncilResultLedger([
        buildResultPacket({
          sessionID: "snapshot",
          executing_role: "commander",
          model: "deepseek/deepseek-v4-pro",
          user_goal: "Fix routing",
          subtask_goal: "Fix routing",
          claimed_result: "Done",
          completion_status: "VERIFIED_COMPLETE",
          files_changed: [{ filePath: "src/routing.ts", changeSummary: "patched" }],
          verification_results: [{ name: "typecheck", status: "passed", evidenceRef: "cmd:typecheck" }],
          evidence_refs: ["cmd:typecheck"],
        }),
        buildResultPacket({
          sessionID: "snapshot",
          executing_role: "chief-engineer",
          model: "deepseek/deepseek-v4-pro",
          user_goal: "Fix routing",
          subtask_goal: "Investigate remaining failure",
          claimed_result: "Partial",
          completion_status: "PARTIAL",
          unresolved_items: ["rerun doctor"],
          evidence_refs: ["review:chief"],
        }),
      ])

      expect(snapshot.verifiedResults[0]?.packetId).toBeTruthy()
      expect(snapshot.partialResults[0]?.unresolvedItems).toContain("rerun doctor")
      expect(snapshot.reusablePacketIds.length).toBe(1)
      expect(snapshot.evidenceRefs).toContain("cmd:typecheck")
      expect(snapshot.summary).toContain("verified=1")
    })
  })

  describe("cross-review bridge result-ledger integration", () => {
    it("includes Result Ledger snapshot and evidence refs in council packet", () => {
      const sid = `ses_cross_review_ledger_${Date.now()}_${Math.random().toString(16).slice(2)}`
      cleanupSessions.push(sid)
      writeResult(sid, buildResultPacket({
        sessionID: sid,
        executing_role: "commander",
        model: "deepseek/deepseek-v4-pro",
        user_goal: "Fix repeated provider routing failure",
        subtask_goal: "Fix repeated provider routing failure",
        claimed_result: "Provider routing partially verified",
        completion_status: "VERIFIED_COMPLETE",
        files_changed: [{ filePath: "packages/opencode/src/session/llm.ts", changeSummary: "normalize provider options" }],
        verification_results: [{ name: "typecheck", status: "passed", evidenceRef: "cmd:typecheck" }],
        evidence_refs: ["cmd:typecheck"],
      }))

      const result = checkCrossReviewTrigger({
        state: state({ metrics: { ...state().metrics, repeated_tool_failure: true, tool_failures: 3 } }),
        repeatedFailureCount: 3,
        reviewerConflict: false,
        isHighRiskCompletion: false,
        hasInsufficientEvidence: false,
        userCorrectionCount: 0,
        scopeExpanded: false,
        recoveryAttempts: 2,
        sessionId: sid,
        userGoal: "Fix repeated provider routing failure",
      })

      expect(result.shouldConvene).toBe(true)
      expect(result.packet?.resultLedger.verifiedResults.length).toBe(1)
      expect(result.packet?.evidenceRefs).toContain("cmd:typecheck")
      expect(result.packetValid).toBe(true)
    })
  })

  describe("arbitrateConflict", () => {
    const makeReview = (overrides: Partial<CouncilReviewResult>): CouncilReviewResult => ({
      reviewer: "chief-engineer",
      packetId: "pkt_1",
      contextSufficient: true,
      missingContext: [],
      blocking: false,
      confidence: "medium",
      decision: "pass",
      findings: [],
      recommendedActions: ["Run tests"],
      forbiddenActions: [],
      requiredVerification: [],
      evidenceRefs: [],
      riskNotes: [],
      ...overrides,
    })

    it("prefers reviewer with sufficient context", () => {
      const a = makeReview({ reviewer: "chief-engineer", contextSufficient: false })
      const b = makeReview({ reviewer: "requirements-inspector", contextSufficient: true })
      const result = arbitrateConflict(a, b, [])
      expect(result.resolved).toBe(true)
      expect(result.acceptedReviewer).toBe("requirements-inspector")
    })

    it("prefers higher confidence", () => {
      const a = makeReview({ reviewer: "chief-engineer", confidence: "high" })
      const b = makeReview({ reviewer: "requirements-inspector", confidence: "low" })
      const result = arbitrateConflict(a, b, [])
      expect(result.resolved).toBe(true)
      expect(result.acceptedReviewer).toBe("chief-engineer")
    })

    it("both blocking → not resolved", () => {
      const a = makeReview({ reviewer: "chief-engineer", blocking: true, decision: "block" })
      const b = makeReview({ reviewer: "requirements-inspector", blocking: true, decision: "block" })
      const result = arbitrateConflict(a, b, [])
      expect(result.resolved).toBe(false)
    })

    it("blocking vs pass → blocking wins (safety first)", () => {
      const a = makeReview({ reviewer: "chief-engineer", blocking: true, decision: "block" })
      const b = makeReview({ reviewer: "requirements-inspector", blocking: false, decision: "pass" })
      const result = arbitrateConflict(a, b, [])
      expect(result.resolved).toBe(true)
      expect(result.acceptedReviewer).toBe("chief-engineer")
    })
  })

  describe("checkReviewIndependence", () => {
    const makeReview = (overrides: Partial<CouncilReviewResult>): CouncilReviewResult => ({
      reviewer: "chief-engineer",
      packetId: "pkt_1",
      contextSufficient: true,
      missingContext: [],
      blocking: false,
      confidence: "medium",
      decision: "pass",
      findings: [],
      recommendedActions: [],
      forbiddenActions: [],
      requiredVerification: [],
      evidenceRefs: [],
      riskNotes: [],
      ...overrides,
    })

    it("flags reviews that reference other reviewers (contamination)", () => {
      const a = makeReview({ reviewer: "chief-engineer" })
      const b = makeReview({
        reviewer: "requirements-inspector",
        findings: [{
          severity: "warning",
          type: "contamination",
          description: "chief-engineer already found the same issue",
          evidenceRefs: [],
          requiredAction: null,
        }],
      })
      expect(checkReviewIndependence(b, [a])).toBe(false)
    })

    it("allows role-cross to reference others (its job)", () => {
      const a = makeReview({ reviewer: "chief-engineer" })
      const b = makeReview({
        reviewer: "role-cross",
        findings: [{
          severity: "warning",
          type: "arbitration",
          description: "chief-engineer and requirements-inspector disagree",
          evidenceRefs: [],
          requiredAction: null,
        }],
      })
      expect(checkReviewIndependence(b, [a])).toBe(true)
    })
  })

  describe("buildCouncilSummary", () => {
    it("produces readable summary", () => {
      const status: CouncilStatus = {
        state: "reviewing",
        triggerReason: "repeated_failure",
        convenedAt: new Date().toISOString(),
        reviewersDispatched: ["chief-engineer"],
        reviewsCompleted: [],
        conflicts: [],
        resolutions: [],
        candidateSolutions: [
          {
            id: "sol_1",
            hypothesis: "Missing import causes type error",
            expectedFix: "Add missing import statement",
            risk: "low",
            filesToTouch: ["src/foo.ts"],
            verificationPlan: ["bun typecheck"],
            rollbackPlan: ["git checkout src/foo.ts"],
            whyPreferred: "Minimal change, verified by typecheck",
          },
        ],
        reexecutionRequired: false,
      }

      const summary = buildCouncilSummary(status)
      expect(summary).toContain("cross-review council")
      expect(summary).toContain("repeated_failure")
      expect(summary).toContain("chief-engineer")
      expect(summary).toContain("Missing import")
    })
  })
})
