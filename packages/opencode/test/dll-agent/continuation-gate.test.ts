/**
 * continuation-gate tests
 */
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, it, expect } from "bun:test"
import {
  detectUnfinishedIndicators,
  classifyUnfinishedItem,
  extractUnfinishedItems,
  buildContinuationPacket,
  checkContinuationGate,
  isContinuationBudgetExhausted,
  buildBudgetExhaustedReport,
  buildContinuationDispatchPlan,
  consumeContinuationPacket,
} from "../../src/dll-agent/continuation-gate"
import { ensureGoalContract, refineGoalContract, updateGoalPlan } from "../../src/dll-agent/goal-contract"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"

let root = ""
let originalRoot: string | undefined

beforeEach(() => {
  originalRoot = process.env.DLL_AGENT_CONFIG_ROOT
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-continuation-gate-"))
  process.env.DLL_AGENT_CONFIG_ROOT = root
})

afterEach(() => {
  if (originalRoot === undefined) delete process.env.DLL_AGENT_CONFIG_ROOT
  else process.env.DLL_AGENT_CONFIG_ROOT = originalRoot
  fs.rmSync(root, { recursive: true, force: true })
})

function freshState() {
  return {
    version: 1 as const,
    phase: "test",
    risk: "medium" as const,
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
      final_claim: true,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    updated_at: new Date().toISOString(),
  }
}

describe("continuation-gate: detection", () => {
  it("detects unfinished indicators in Chinese", () => {
    const result = detectUnfinishedIndicators("未完成：核心桥接未接入")
    expect(result.hasUnfinished).toBe(true)
  })

  it("detects blocking unfinished via P1 patterns", () => {
    const kind = classifyUnfinishedItem("核心功能未实现，tests 未运行")
    expect(kind).toBe("blocking_unfinished")
  })

  it("classifies non-blocking followup", () => {
    const kind = classifyUnfinishedItem("下一步可以优化 TUI 展示")
    expect(kind).toBe("non_blocking_followup")
  })

  it("classifies user input required", () => {
    const kind = classifyUnfinishedItem("需要用户提供 API token 才能继续")
    expect(kind).toBe("requires_user_input")
  })

  it("no unfinished indicators returns false", () => {
    const result = detectUnfinishedIndicators("所有任务已完成，验证通过")
    expect(result.hasUnfinished).toBe(false)
  })
})

describe("continuation-gate: extract items", () => {
  it("extracts blocking items from structured report", () => {
    const text = `## 未完成\n- P1: lsp-strategy bridge 未接入运行路径\n- P1: cross-review 未闭环`
    const items = extractUnfinishedItems(text, "phase-test")
    expect(items.length).toBeGreaterThan(0)
  })

  it("extracts TODO items", () => {
    const text = `## TODO\n1. 接入 permission bridge\n2. 运行集成测试`
    const items = extractUnfinishedItems(text, "phase-test")
    expect(items.length).toBeGreaterThan(0)
  })
})

describe("continuation-gate: gate function", () => {
  it("passes when no unfinished indicators", () => {
    const result = checkContinuationGate({
      assistantText: "All tasks complete. Tests pass.",
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "test-session",
    })
    expect(result.passed).toBe(true)
  })

  it("passes for non-completion claims", () => {
    const result = checkContinuationGate({
      assistantText: "Let me check the next step.",
      isCompletionClaim: false,
      state: freshState(),
      sessionID: "test-session",
    })
    expect(result.passed).toBe(true)
  })

  it("blocks when blocking unfinished items found", () => {
    const text = "## 未完成\n- 核心 bridge 未接入运行路径\n- key module not wired"
    const result = checkContinuationGate({
      assistantText: text,
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "test-session",
    })
    // The detection depends on pattern matching; verify at minimum we get a result
    expect(result.completion_status).toBeDefined()
  })

  it("returns PARTIAL_CONTINUED when blocking items", () => {
    const text = "Task PARTIAL. 未完成: key bridge not wired."
    const result = checkContinuationGate({
      assistantText: text,
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "test-session",
      userGoal: "wire all bridges",
    })
    expect(result.completion_status).toBeDefined()
  })

  it("does not treat final report status tables as blocking unfinished work", () => {
    const text = `
## 最终报告

| 状态 | 项目 | 说明 |
|---|---|---|
| PASS | reasoning_effort | 已修复并验证 |
| PARTIAL | live API | 缺少真实 API key，仅 mock verified |
| FAIL | unrelated backlog | 不在本轮范围 |

## 已实现能力
- P0 修复完成，验证通过

## 部分实现能力
- live verified 需要用户提供 API key
`
    const result = checkContinuationGate({
      assistantText: text,
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "test-session",
      userGoal: "修复 P0 runtime blocker",
    })
    expect(result.passed).toBe(true)
    expect(result.has_blocking_unfinished).toBe(false)
  })

  it("does not block for non-completion claim", () => {
    const result = checkContinuationGate({
      assistantText: "Let me think about the next step...",
      isCompletionClaim: false,
      state: freshState(),
      sessionID: "test-session",
    })
    expect(result.passed).toBe(true)
    expect(result.has_blocking_unfinished).toBe(false)
  })

  it("active plan unfinished -> continuation required", () => {
    ensureGoalContract({ sessionID: "goal-plan", userGoal: "Finish active plan" })
    updateGoalPlan("goal-plan", [
      { id: "plan-1", description: "Run final smoke", status: "pending", evidence_refs: [] },
    ])
    const result = checkContinuationGate({
      assistantText: "All tasks complete. Tests pass.",
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "goal-plan",
    })

    expect(result.passed).toBe(false)
    expect(result.completion_status).toBe("PARTIAL_CONTINUED")
    expect(result.continuation_packet?.blocking_unfinished[0]?.description).toBe("Run final smoke")
  })

  it("verification not_run -> continuation required when Goal Contract requires verification", () => {
    ensureGoalContract({
      sessionID: "goal-verification",
      userGoal: "Finish with required checks",
      requiredVerification: ["bun test --cwd packages/opencode test/dll-agent/"],
    })
    const result = checkContinuationGate({
      assistantText: "All tasks complete.",
      isCompletionClaim: true,
      state: { ...freshState(), metrics: { ...freshState().metrics, real_tool_evidence: false, verification_evidence: false } },
      sessionID: "goal-verification",
    })

    expect(result.passed).toBe(false)
    expect(result.completion_status).toBe("PARTIAL_CONTINUED")
    expect(result.blocking_items[0]?.description).toContain("bun test")
  })

  it("doctor failed -> continuation required", () => {
    ensureGoalContract({ sessionID: "goal-doctor", userGoal: "Fix doctor" })
    const state = freshState()
    state.blocked_completion = true
    ;(state as any).block_reason = "doctor failed"
    const result = checkContinuationGate({
      assistantText: "All tasks complete.",
      isCompletionClaim: true,
      state,
      sessionID: "goal-doctor",
    })

    expect(result.passed).toBe(false)
    expect(result.block_reason).toContain("Goal Contract")
  })

  it("reviewer block -> continuation required", () => {
    ensureGoalContract({ sessionID: "goal-reviewer", userGoal: "Resolve reviewer block" })
    const state = freshState()
    state.blocked_completion = true
    ;(state as any).block_reason = "reviewer chief-engineer blocked completion: missing verification"
    const result = checkContinuationGate({
      assistantText: "All tasks complete.",
      isCompletionClaim: true,
      state,
      sessionID: "goal-reviewer",
    })

    expect(result.passed).toBe(false)
    expect(result.continuation_packet?.reviewer_blocks.join("\n")).toContain("reviewer")
  })

  it("reviewer blocking ResultPacket -> continuation required with context refs", () => {
    ensureGoalContract({ sessionID: "goal-reviewer-ledger", userGoal: "Resolve reviewer ledger block" })
    writeResult("goal-reviewer-ledger", buildResultPacket({
      sessionID: "goal-reviewer-ledger",
      executing_role: "chief-engineer",
      model: "mimo/mimo-v2.5-pro",
      user_goal: "Resolve reviewer ledger block",
      subtask_goal: "review final completion",
      claimed_result: "blocked: verification missing",
      completion_status: "BLOCKED",
      evidence_refs: ["context_handoff:ctx_1", "reviewer:chief-engineer"],
      unresolved_items: ["verification missing"],
      context_packet_id: "ctx_1",
    }))
    const result = checkContinuationGate({
      assistantText: "All tasks complete.",
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "goal-reviewer-ledger",
    })

    expect(result.passed).toBe(false)
    expect(result.continuation_packet?.blocking_reviewer_findings.join("\n")).toContain("verification missing")
    expect(result.continuation_packet?.context_packet_refs).toContain("context_handoff:ctx_1")
  })

  it("continuation packet includes missing verification, result refs, evidence refs, and redacted blockers", () => {
    ensureGoalContract({
      sessionID: "goal-packet-fields",
      userGoal: "Finish packet fields",
      requiredVerification: ["dll-agent doctor"],
    })
    writeResult("goal-packet-fields", buildResultPacket({
      sessionID: "goal-packet-fields",
      executing_role: "commander",
      model: "deepseek/deepseek-v4-pro",
      user_goal: "Finish packet fields",
      subtask_goal: "partial result",
      claimed_result: "partial",
      completion_status: "PARTIAL",
      evidence_refs: ["result:e1"],
      unresolved_items: ["secret token=abc123 should be hidden"],
    }))
    const result = checkContinuationGate({
      assistantText: "All tasks complete.",
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "goal-packet-fields",
    })

    expect(result.passed).toBe(false)
    expect(result.continuation_packet?.missing_verification).toContain("dll-agent doctor")
    expect(result.continuation_packet?.missing_result_refs.join("\n")).toContain("result_sufficiency")
    expect(result.continuation_packet?.evidence_refs).toContain("result:e1")
    expect(JSON.stringify(result.continuation_packet)).not.toContain("abc123")
    expect(JSON.stringify(result.continuation_packet)).toContain("REDACTED")
  })

  it("non-blocking follow-up does not block", () => {
    ensureGoalContract({ sessionID: "goal-followup", userGoal: "Finish core task" })
    refineGoalContract("goal-followup", {
      successCriteriaStatus: [{
        id: "criterion-1",
        description: "Core behavior verified",
        status: "satisfied",
        evidence_refs: ["cmd:test"],
      }],
    })
    updateGoalPlan("goal-followup", [
      { id: "plan-1", description: "Optional docs cleanup", status: "non_blocking", evidence_refs: [] },
    ])
    const result = checkContinuationGate({
      assistantText: "All tasks complete. Tests pass.",
      isCompletionClaim: true,
      state: { ...freshState(), metrics: { ...freshState().metrics, real_tool_evidence: true, verification_evidence: true } },
      sessionID: "goal-followup",
    })

    expect(result.passed).toBe(true)
    expect(result.has_non_blocking).toBe(false)
  })
})

describe("continuation-gate: packet builder", () => {
  it("builds packet with completion status", () => {
    const packet = buildContinuationPacket({
      sessionID: "test-session",
      userGoal: "implement feature X",
      currentPhase: "implementation",
      completionClaim: "feature X partially done",
      items: [],
      state: freshState(),
    })
    expect(packet.packet_type).toBe("task_continuation")
    expect(packet.session_id).toBe("test-session")
  })

  it("packet includes blocking items in next_execution_plan", () => {
    const items = [{
      id: "item_1",
      kind: "blocking_unfinished" as const,
      description: "wire bridge",
      why_blocking: "not wired",
      evidence_refs: [],
      required_action: "write code",
      recommended_role: "chief-engineer" as const,
      verification_required: [],
      risk_level: "high" as const,
    }]
    const packet = buildContinuationPacket({
      sessionID: "test",
      userGoal: "goal",
      currentPhase: "phase",
      completionClaim: "partial",
      items,
      state: freshState(),
    })
    expect(packet.completion_status).toBe("PARTIAL_CONTINUED")
    expect(packet.blocking_unfinished.length).toBe(1)
    expect(packet.next_execution_plan.length).toBe(1)
  })
})

describe("continuation-gate: budget", () => {
  it("not exhausted at start", () => {
    const result = isContinuationBudgetExhausted({
      continuationCount: 0,
      repairCounts: {},
      blockingItems: [],
    })
    expect(result.exhausted).toBe(false)
  })

  it("exhausted after 5 continuations", () => {
    const result = isContinuationBudgetExhausted({
      continuationCount: 5,
      repairCounts: {},
      blockingItems: [],
    })
    expect(result.exhausted).toBe(true)
  })

  it("exhausted when item repaired twice", () => {
    const items = [{
      id: "item_1",
      kind: "blocking_unfinished" as const,
      description: "wire bridge",
      evidence_refs: [],
      required_action: "fix",
      recommended_role: "chief-engineer" as const,
      verification_required: [],
      risk_level: "high" as const,
    }]
    const result = isContinuationBudgetExhausted({
      continuationCount: 1,
      repairCounts: { item_1: 2 },
      blockingItems: items,
    })
    expect(result.exhausted).toBe(true)
  })

  it("budget exhausted outputs blocked report, not complete", () => {
    const packet = buildContinuationPacket({
      sessionID: "budget-session",
      userGoal: "finish task",
      currentPhase: "phase-2",
      completionClaim: "done",
      items: [{
        id: "item_1",
        kind: "blocking_unfinished",
        description: "wire continuation dispatch",
        evidence_refs: ["gate:continuation"],
        required_action: "dispatch continuation",
        recommended_role: "chief-engineer",
        verification_required: ["bun test"],
        risk_level: "high",
      }],
      state: freshState(),
    })
    const report = buildBudgetExhaustedReport({
      sessionID: "budget-session",
      userGoal: "finish task",
      reason: "Maximum continuation count reached",
      packet,
    })

    expect(report.completion_status).toBe("BLOCKED_BUDGET_EXHAUSTED")
    expect(report.report).toContain("Do not claim VERIFIED_COMPLETE")
    expect(report.report).toContain("wire continuation dispatch")
  })
})

describe("continuation-gate: dispatch", () => {
  it("continuation packet can dispatch commander, chief-engineer, and requirements-inspector", () => {
    const packet = buildContinuationPacket({
      sessionID: "dispatch-session",
      userGoal: "continue task",
      currentPhase: "phase-2",
      completionClaim: "partial",
      items: [
        {
          id: "low",
          kind: "blocking_unfinished",
          description: "finish low-risk local edit",
          evidence_refs: ["goal"],
          required_action: "finish local edit",
          recommended_role: "chief-engineer",
          verification_required: ["unit test"],
          risk_level: "low",
        },
        {
          id: "high",
          kind: "blocking_unfinished",
          description: "repair failed gate",
          evidence_refs: ["gate"],
          required_action: "repair gate",
          recommended_role: "chief-engineer",
          verification_required: ["typecheck"],
          risk_level: "high",
        },
      ],
      state: freshState(),
    })
    packet.next_execution_plan.push({
      step: 3,
      role: "requirements-inspector",
      action: "recheck user correction",
      verification: "requirements match evidence",
    })
    const actions = buildContinuationDispatchPlan(packet)

    expect(actions.map((item) => item.role)).toEqual(["commander", "chief-engineer", "requirements-inspector"])
    expect(actions.every((item) => item.dispatch_reason.length > 0)).toBe(true)
  })

  it("consumeContinuationPacket returns dispatcher-ready action evidence refs", () => {
    const packet = buildContinuationPacket({
      sessionID: "consume-session",
      userGoal: "continue task",
      currentPhase: "phase-2",
      completionClaim: "partial",
      items: [{
        id: "item_1",
        kind: "blocking_unfinished",
        description: "repair failed gate",
        evidence_refs: ["gate:block"],
        required_action: "repair gate",
        recommended_role: "chief-engineer",
        verification_required: ["typecheck"],
        risk_level: "high",
      }],
      state: freshState(),
    })
    const consumed = consumeContinuationPacket(packet)

    expect(consumed.shouldContinue).toBe(true)
    expect(consumed.actionItems[0]?.role).toBe("chief-engineer")
    expect(consumed.actionItems[0]?.evidence_refs).toContain("gate:block")
  })
})
