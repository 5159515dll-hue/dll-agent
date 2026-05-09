import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  assessGoalCompletion,
  buildGoalContract,
  ensureGoalContract,
  goalContractPath,
  loadGoalContract,
  refineGoalContract,
  updateGoalPlan,
} from "../../src/dll-agent/goal-contract"
import { checkContinuationGate } from "../../src/dll-agent/continuation-gate"
import { finalGate } from "../../src/dll-agent/gates"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"
import { buildTaskStateSnapshot } from "../../src/dll-agent/task-state"

let root = ""
let originalRoot: string | undefined
let originalEvidenceFile: string | undefined

beforeEach(() => {
  originalRoot = process.env.DLL_AGENT_CONFIG_ROOT
  originalEvidenceFile = process.env.DLL_AGENT_EVIDENCE_FILE
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-goal-contract-"))
  process.env.DLL_AGENT_CONFIG_ROOT = root
  process.env.DLL_AGENT_EVIDENCE_FILE = path.join(root, "evidence.jsonl")
})

afterEach(() => {
  if (originalRoot === undefined) delete process.env.DLL_AGENT_CONFIG_ROOT
  else process.env.DLL_AGENT_CONFIG_ROOT = originalRoot
  if (originalEvidenceFile === undefined) delete process.env.DLL_AGENT_EVIDENCE_FILE
  else process.env.DLL_AGENT_EVIDENCE_FILE = originalEvidenceFile
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", "session-final-ledger-pass"), {
    recursive: true,
    force: true,
  })
})

function freshState() {
  return {
    version: 1 as const,
    phase: "phase-1.1",
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
      verification_evidence: true,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: true,
    },
    updated_at: new Date().toISOString(),
  }
}

describe("goal-contract", () => {
  test("creates and loads a redacted session goal contract", () => {
    const contract = ensureGoalContract({
      sessionID: "session-a",
      userGoal: "Fix dll-agent startup and run verification",
    })

    expect(contract?.user_goal).toBe("Fix dll-agent startup and run verification")
    expect(fs.existsSync(goalContractPath("session-a"))).toBe(true)

    const loaded = loadGoalContract("session-a")
    expect(loaded?.task_id).toBe(contract?.task_id)
    expect(loaded?.success_criteria.length).toBeGreaterThan(0)
    expect(loaded?.success_criteria_status).toEqual([])
    expect(loaded?.non_goals).toEqual([])
    expect(loaded?.required_verification.length).toBeGreaterThan(0)
    expect(loaded?.redaction_status).toBe("redacted")
  })

  test("does not overwrite an existing contract on later prompt turns", () => {
    const first = ensureGoalContract({ sessionID: "session-b", userGoal: "Original user goal" })
    const second = ensureGoalContract({ sessionID: "session-b", userGoal: "Later unrelated message" })

    expect(second?.task_id).toBe(first?.task_id)
    expect(loadGoalContract("session-b")?.user_goal).toBe("Original user goal")
  })

  test("refines contract without overwriting original goal", () => {
    ensureGoalContract({ sessionID: "session-refine", userGoal: "Original goal" })
    refineGoalContract("session-refine", {
      successCriteria: ["New criterion"],
      nonGoals: ["Do not change TUI"],
      constraints: ["Keep Provider boundary"],
      requiredVerification: ["bun test --cwd packages/opencode test/dll-agent/"],
    })

    const loaded = loadGoalContract("session-refine")
    expect(loaded?.user_goal).toBe("Original goal")
    expect(loaded?.success_criteria).toContain("New criterion")
    expect(loaded?.non_goals).toContain("Do not change TUI")
    expect(loaded?.constraints).toContain("Keep Provider boundary")
  })

  test("assesses verified completion only after plan and verification pass", () => {
    const contract = buildGoalContract({
      sessionID: "session-c",
      userGoal: "Ship the fix",
      activePlan: [
        { id: "plan-1", description: "Patch code", status: "completed", evidence_refs: ["diff"] },
      ],
    })

    const result = assessGoalCompletion({
      contract,
      verificationResults: [{ name: "typecheck", status: "passed", evidenceRef: "cmd:typecheck" }],
      resultStatuses: ["VERIFIED_COMPLETE"],
    })

    expect(result.final_status).toBe("VERIFIED_COMPLETE")
    expect(result.can_claim_complete).toBe(true)
  })

  test("classifies unfinished active plan as continuation required", () => {
    const contract = buildGoalContract({
      sessionID: "session-d",
      userGoal: "Complete all phases",
      activePlan: [
        { id: "plan-1", description: "Run smoke verification", status: "pending", evidence_refs: [] },
      ],
    })

    const result = assessGoalCompletion({
      contract,
      verificationResults: [{ name: "typecheck", status: "passed" }],
    })

    expect(result.final_status).toBe("CONTINUATION_REQUIRED")
    expect(result.blocking_items).toContain("Run smoke verification")
  })

  test("classifies unmet success criteria as continuation required", () => {
    const contract = buildGoalContract({
      sessionID: "session-criteria",
      userGoal: "Complete gated goal",
      successCriteriaStatus: [{
        id: "criterion-1",
        description: "Final gate reads Goal Contract",
        status: "pending",
        evidence_refs: [],
      }],
    })

    const result = assessGoalCompletion({
      contract,
      verificationResults: [{ name: "typecheck", status: "passed" }],
    })

    expect(result.final_status).toBe("CONTINUATION_REQUIRED")
    expect(result.blocking_items).toContain("Final gate reads Goal Contract")
  })

  test("classifies missing verification as unverified partial", () => {
    const contract = buildGoalContract({ sessionID: "session-e", userGoal: "Make a small change" })
    const result = assessGoalCompletion({ contract })

    expect(result.final_status).toBe("UNVERIFIED_PARTIAL")
    expect(result.can_claim_complete).toBe(false)
  })

  test("doctor failure blocks final status as failed", () => {
    const contract = buildGoalContract({ sessionID: "session-f", userGoal: "Repair runtime" })
    const result = assessGoalCompletion({ contract, doctorFailed: true })

    expect(result.final_status).toBe("FAILED")
    expect(result.required_next_actions.join("\n")).toContain("doctor")
  })

  test("non-blocking follow-up does not block verified completion", () => {
    const contract = buildGoalContract({
      sessionID: "session-followup",
      userGoal: "Finish core behavior",
      activePlan: [
        { id: "plan-1", description: "Optional docs polish", status: "non_blocking", evidence_refs: [] },
      ],
      successCriteriaStatus: [{
        id: "criterion-1",
        description: "Core behavior verified",
        status: "satisfied",
        evidence_refs: ["cmd:test"],
      }],
    })
    const result = assessGoalCompletion({
      contract,
      verificationResults: [{ name: "typecheck", status: "passed" }],
    })

    expect(result.final_status).toBe("VERIFIED_COMPLETE")
    expect(result.can_claim_complete).toBe(true)
  })

  test("Goal Contract evidence is written and redacted", () => {
    ensureGoalContract({
      sessionID: "session-evidence",
      userGoal: "Use token sk-123456789012345 while fixing task",
    })
    refineGoalContract("session-evidence", {
      constraints: ["Never print github_pat_1234567890"],
    })

    const evidence = fs.readFileSync(path.join(root, "evidence.jsonl"), "utf8")
    expect(evidence).toContain("goal_contract.created")
    expect(evidence).toContain("goal_contract.refined")
    expect(evidence).not.toContain("sk-123456789012345")
    expect(evidence).not.toContain("github_pat_1234567890")
    expect(evidence).toContain("sk-REDACTED")
  })

  test("task-state exposes goal contract blockers", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-goal-project-"))
    try {
      ensureGoalContract({ sessionID: "session-g", userGoal: "Finish all checks" })
      updateGoalPlan("session-g", [
        { id: "plan-1", description: "Run smoke verification", status: "pending", evidence_refs: [] },
      ])

      const state = buildTaskStateSnapshot({ sessionID: "session-g", projectDir: project })
      expect(state.goal).toBe("Finish all checks")
      expect(state.goal_status).toBe("CONTINUATION_REQUIRED")
      expect(state.status).toBe("blocked")
      expect(state.blockers).toContain("Run smoke verification")
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  test("final gate blocks PASS when Goal Contract success criteria are unmet", () => {
    ensureGoalContract({ sessionID: "session-final", userGoal: "Wire goal into final gate" })
    refineGoalContract("session-final", {
      successCriteriaStatus: [{
        id: "criterion-1",
        description: "Final gate uses contract",
        status: "pending",
        evidence_refs: [],
      }],
    })

    const result = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: freshState(),
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: "session-final",
    })

    expect(result.allowed).toBe(false)
    expect(result.reasons.join("\n")).toContain("goal contract CONTINUATION_REQUIRED")
  })

  test("final gate blocks PASS when Goal Contract lacks a verified result packet", () => {
    ensureGoalContract({ sessionID: "session-final-ledger", userGoal: "Wire result ledger into final gate" })

    const result = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: freshState(),
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: "session-final-ledger",
    })

    expect(result.allowed).toBe(false)
    expect(result.reasons.join("\n")).toContain("result ledger missing verified result")
  })

  test("final gate accepts Goal Contract only when matching verified result exists", () => {
    ensureGoalContract({ sessionID: "session-final-ledger-pass", userGoal: "Wire result ledger into final gate" })
    writeResult("session-final-ledger-pass", buildResultPacket({
      sessionID: "session-final-ledger-pass",
      executing_role: "commander",
      model: "deepseek/deepseek-v4-pro",
      user_goal: "Wire result ledger into final gate",
      subtask_goal: "Wire result ledger into final gate",
      claimed_result: "Result ledger final gate wiring is verified",
      completion_status: "VERIFIED_COMPLETE",
      commands_run: [{ command: "bun test", result: "passed", exitCode: 0, evidenceRef: "cmd:test" }],
      verification_results: [{ name: "bun test", status: "passed", evidenceRef: "cmd:test" }],
      evidence_refs: ["cmd:test"],
    }))

    const result = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: freshState(),
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: "session-final-ledger-pass",
    })

    expect(result.allowed).toBe(true)
  })

  test("continuation gate reads Goal Contract even when final report text has no unfinished markers", () => {
    ensureGoalContract({ sessionID: "session-continuation", userGoal: "Run final smoke" })
    updateGoalPlan("session-continuation", [
      { id: "plan-1", description: "Run final smoke", status: "pending", evidence_refs: [] },
    ])

    const result = checkContinuationGate({
      assistantText: "All tasks complete. Tests pass.",
      isCompletionClaim: true,
      state: freshState(),
      sessionID: "session-continuation",
    })

    expect(result.passed).toBe(false)
    expect(result.completion_status).toBe("PARTIAL_CONTINUED")
    expect(result.continuation_packet?.blocking_unfinished[0]?.description).toBe("Run final smoke")
  })
})
