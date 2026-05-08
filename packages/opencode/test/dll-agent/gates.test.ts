import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { checkEvidenceGate, checkReconciliationGate, recordGateBlock, isGateRetryExhausted, GATE_MAX_RETRIES, buildGateBlockSummary } from "../../src/dll-agent/gates"
import type { EvidenceGateInput } from "../../src/dll-agent/interfaces"
import type { MessageV2 } from "../../src/session/message-v2"

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function auditProjectWithFails() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-gate-artifacts-"))
  cleanup.push(dir)
  fs.mkdirSync(path.join(dir, "files"), { recursive: true })
  fs.mkdirSync(path.join(dir, "test-screenshots"), { recursive: true })
  fs.writeFileSync(path.join(dir, "test-screenshots", "home.png"), "png")
  fs.writeFileSync(path.join(dir, "files", "full-crm-browser-flow-audit-report.md"), `
> No blocking issues found during this audit session.
| Total Tests | 67 |
| ✅ PASS | 53 |
| ❌ FAIL | 5 |
| ⚠️ WARN | 9 |
`)
  return dir
}

function base(over: Partial<EvidenceGateInput> = {}): EvidenceGateInput {
  return {
    assistantText: "",
    isCompletionClaim: false,
    hasVerificationEvidence: false,
    risk: "low",
    allReviewsCompleted: true,
    hasUnresolvedConflict: false,
    costExceeded: false,
    ...over,
  }
}

function bashTool(command: string, output: string): MessageV2.WithParts {
  return {
    info: {
      id: "m",
      sessionID: "s",
      role: "assistant",
      time: { created: 0 },
      agent: "x",
      model: { providerID: "p", modelID: "m" },
    } as any,
    parts: [
      {
        type: "tool",
        callID: "c",
        tool: "bash",
        state: {
          status: "completed",
          input: { command },
          output,
          title: command,
          metadata: {},
          time: { start: 0, end: 1 },
        },
        id: "p",
        messageID: "mm",
        sessionID: "s",
      } as any,
    ],
  }
}

describe("DllAgentGates.checkEvidenceGate", () => {
  test("non-completion → pass", () => {
    const r = checkEvidenceGate(base({ assistantText: "thinking..." }))
    expect(r.passed).toBe(true)
  })

  test("high risk completion w/o evidence → blocked", () => {
    const r = checkEvidenceGate(
      base({ isCompletionClaim: true, risk: "high", hasVerificationEvidence: false }),
    )
    expect(r.passed).toBe(false)
    expect(r.block_reason).toMatch(/verification/)
  })

  test("real tool evidence overrides regex (high risk)", () => {
    const messages = [bashTool("bun typecheck", "exited with code 0")]
    const r = checkEvidenceGate(
      base({
        isCompletionClaim: true,
        risk: "high",
        hasVerificationEvidence: false,
        assistantText: "task complete",
      }),
      messages,
    )
    expect(r.passed).toBe(true)
  })

  test("plain text 'tests passed' without tool output is NOT real evidence (high risk blocks)", () => {
    const r = checkEvidenceGate(
      base({
        isCompletionClaim: true,
        risk: "high",
        hasVerificationEvidence: true,
        assistantText: "all tests pass, done",
      }),
      [],
    )
    expect(r.passed).toBe(false)
  })

  test("artifact evidence with FAIL count blocks verified completion", () => {
    const projectDir = auditProjectWithFails()
    const r = checkEvidenceGate(
      base({
        isCompletionClaim: true,
        risk: "high",
        hasVerificationEvidence: true,
        assistantText: "审计完成，没有阻断问题。",
        projectDir,
      }),
      [bashTool("node audit-full-browser.mjs", "Report saved to: files/full-crm-browser-flow-audit-report.md\nScreenshots captured: 55")],
    )
    expect(r.passed).toBe(false)
    expect(r.block_reason).toContain("not verified")
    expect(r.synthetic_hint).toContain("FAIL")
  })

  test("explicit unverified marker passes", () => {
    const r = checkEvidenceGate(
      base({
        isCompletionClaim: true,
        risk: "low",
        assistantText: "Implementation done. This claim is unverified.",
      }),
    )
    expect(r.passed).toBe(true)
  })
})

describe("DllAgentGates.checkReconciliationGate (Phase 4)", () => {
  function st(completed: string[] = []): any {
    return {
      version: 1,
      phase: "exec",
      risk: "medium",
      required_reviews: [],
      completed_reviews: completed,
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 10,
        context_tokens: 100,
        final_claim: false,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    }
  }

  test("non-completion claim always passes", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: false,
      assistantText: "working on it",
      state: st(["chief-engineer"]),
    })
    expect(r.passed).toBe(true)
  })

  test("no completed reviewers → no recon required", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "done",
      state: st([]),
    })
    expect(r.passed).toBe(true)
  })

  test("completion claim WITHOUT absorption keyword is blocked", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "已完成所有修改，测试通过。",
      state: st(["chief-engineer", "requirements-inspector"]),
    })
    expect(r.passed).toBe(false)
    expect(r.block_reason).toContain("chief-engineer")
    expect(r.synthetic_hint).toContain("reconciliation")
  })

  test("Chinese absorption keyword unblocks", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "已采纳 reviewer 的建议，按 reviewer 修正了边界。",
      state: st(["chief-engineer"]),
    })
    expect(r.passed).toBe(true)
  })

  test("English absorption keyword unblocks", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "Done. Addressed reviewer findings about scope drift.",
      state: st(["chief-engineer"]),
    })
    expect(r.passed).toBe(true)
  })

  test("evidence-rejection language unblocks", () => {
    const r = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "完成。拒绝 reviewer 的某项建议（理由：与现有契约不兼容，见 src/x.ts）。",
      state: st(["chief-engineer"]),
    })
    expect(r.passed).toBe(true)
  })
})

describe("DllAgentGates gate retry limit (P0-loop)", () => {
  function stateWithRetries(retries: Record<string, number> = {}): any {
    return {
      version: 1,
      phase: "exec",
      risk: "high",
      required_reviews: [],
      completed_reviews: [],
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      gate_block_retries: retries,
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 10,
        context_tokens: 100,
        final_claim: false,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    }
  }

  test("recordGateBlock increments retry count", () => {
    const state = stateWithRetries()
    recordGateBlock(state, "high-risk completion claim without verification evidence")
    expect(state.gate_block_retries?.["high-risk completion claim without verification evidence"]).toBe(1)
    recordGateBlock(state, "high-risk completion claim without verification evidence")
    expect(state.gate_block_retries?.["high-risk completion claim without verification evidence"]).toBe(2)
  })

  test("isGateRetryExhausted returns false below limit", () => {
    const state = stateWithRetries({ "test-reason": 1 })
    expect(isGateRetryExhausted(state, "test-reason")).toBe(false)
    expect(isGateRetryExhausted(state, "unknown-reason")).toBe(false)
  })

  test("isGateRetryExhausted returns true above limit", () => {
    const state = stateWithRetries({ "test-reason": GATE_MAX_RETRIES + 1 })
    expect(isGateRetryExhausted(state, "test-reason")).toBe(true)
  })

  test("isGateRetryExhausted returns false at exact limit", () => {
    const state = stateWithRetries({ "test-reason": GATE_MAX_RETRIES })
    expect(isGateRetryExhausted(state, "test-reason")).toBe(false)
  })

  test("buildGateBlockSummary includes exhausted flag", () => {
    const state = stateWithRetries({ "test-reason": GATE_MAX_RETRIES + 1 })
    const gateResult = checkEvidenceGate(base({ isCompletionClaim: true, risk: "high", hasVerificationEvidence: false }))
    const summary = buildGateBlockSummary("test-reason", gateResult, state, true)
    expect(summary).toContain("HARD STOP")
    expect(summary).toContain("Maximum retries")
    expect(summary).toContain("test-reason")
  })

  test("buildGateBlockSummary with retries not exhausted", () => {
    const state = stateWithRetries({ "test-reason": 1 })
    const gateResult = checkEvidenceGate(base({ isCompletionClaim: true, risk: "high", hasVerificationEvidence: false }))
    const summary = buildGateBlockSummary("test-reason", gateResult, state, false)
    expect(summary).toContain("Next:")
    expect(summary).not.toContain("HARD STOP")
  })
})
