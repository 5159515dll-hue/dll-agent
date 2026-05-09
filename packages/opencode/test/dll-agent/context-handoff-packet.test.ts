import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  buildContextHandoffPacket,
  renderHandoffForRole,
} from "../../src/dll-agent/context-handoff-packet"
import { buildReviewerContext, buildReviewerContextWithPacket } from "../../src/dll-agent/reviewer-context"
import { buildGoalContract, saveGoalContract, type GoalPlanItem, type GoalSuccessCriterion } from "../../src/dll-agent/goal-contract"
import { buildResultPacket, loadResults, writeResult } from "../../src/dll-agent/result-ledger"
import { buildReviewerResultPacket, writeReviewerResult } from "../../src/dll-agent/reviewer-result-bridge"
import { setRoleModelOverride } from "../../src/dll-agent/role-model-registry"
import { checkReconciliationGate, finalGate } from "../../src/dll-agent/gates"
import { generateSubtasks, loadState } from "../../src/dll-agent/supervisor"
import type { ReviewerOutput, SupervisorMetricsSnapshot, SupervisorState } from "../../src/dll-agent/interfaces"
import type { MessageV2 } from "../../src/session/message-v2"

const cleanupPaths: string[] = []
const cleanupSessions: string[] = []
const previousConfigRoot = process.env.DLL_AGENT_CONFIG_ROOT
const previousEvidenceFile = process.env.DLL_AGENT_EVIDENCE_FILE

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
  for (const file of cleanupPaths.splice(0)) fs.rmSync(file, { recursive: true, force: true })
  if (previousConfigRoot === undefined) delete process.env.DLL_AGENT_CONFIG_ROOT
  else process.env.DLL_AGENT_CONFIG_ROOT = previousConfigRoot
  if (previousEvidenceFile === undefined) delete process.env.DLL_AGENT_EVIDENCE_FILE
  else process.env.DLL_AGENT_EVIDENCE_FILE = previousEvidenceFile
})

function sessionID(name: string) {
  const id = `ses_ctx_handoff_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function isolatedRoot(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dll-agent-${name}-`))
  cleanupPaths.push(root)
  process.env.DLL_AGENT_CONFIG_ROOT = root
  process.env.DLL_AGENT_EVIDENCE_FILE = path.join(root, "evidence.jsonl")
  return root
}

function userMsg(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent: "commander",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    } as any,
    parts: [{ type: "text", text, id: `${id}_part`, messageID: id, sessionID: "ses_test" } as any],
  }
}

function metrics(overrides: Partial<SupervisorMetricsSnapshot> = {}): SupervisorMetricsSnapshot {
  return {
    tool_failures: 0,
    permission_denied: 0,
    user_corrections: 0,
    context_percent: 10,
    context_tokens: 1000,
    final_claim: false,
    verification_evidence: false,
    reviewer_conflict_signal: false,
    repeated_tool_failure: false,
    real_tool_evidence: false,
    ...overrides,
  }
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
    metrics: metrics(),
    updated_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  }
}

function reviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    version: 1,
    reviewer: "requirements-inspector",
    trigger_reason: "user correction",
    verdict: "pass",
    findings: [],
    score: 95,
    block_completion: false,
    next_actions: [],
    evidence_confidence: 90,
    ts: "2026-05-09T00:00:00.000Z",
    ...overrides,
  }
}

function readEvidence() {
  const file = process.env.DLL_AGENT_EVIDENCE_FILE
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function writeContract(sessionID: string, userGoal = "Original CRM browser audit goal") {
  const criteria: GoalSuccessCriterion[] = [
    {
      id: "crit_1",
      description: "CRM audit is complete",
      status: "pending",
      evidence_refs: [],
    },
    {
      id: "crit_2",
      description: "Verification was run",
      status: "satisfied",
      evidence_refs: ["verification:typecheck"],
    },
  ]
  const plan: GoalPlanItem[] = [
    {
      id: "plan_1",
      description: "Run browser click-through audit",
      status: "in_progress",
      evidence_refs: [],
    },
    {
      id: "plan_2",
      description: "Optional polish follow-up",
      status: "non_blocking",
      evidence_refs: [],
    },
  ]
  const contract = buildGoalContract({
    sessionID,
    userGoal,
    successCriteria: ["CRM audit is complete", "Verification was run"],
    successCriteriaStatus: criteria,
    requiredVerification: ["bun test --cwd packages/opencode test/dll-agent/"],
    activePlan: plan,
    evidenceRefs: ["goal_contract.created"],
  })
  saveGoalContract(contract)
  return contract
}

describe("ContextHandoffPacket v1", () => {
  test("reviewer context prefers original Goal Contract user_goal over latest user message", () => {
    isolatedRoot("context-goal")
    const sid = sessionID("goal")
    writeContract(sid, "Original user goal: finish the CRM audit safely")

    const ctx = buildReviewerContext(
      "requirements-inspector",
      "user correction",
      metrics({ user_corrections: 1 }),
      [
        userMsg("u1", "Original user goal should be persisted"),
        userMsg("u2", "latest small correction only"),
      ],
      sid,
      { state: state(), maxChars: 5_000 },
    )

    expect(ctx).toContain("context-handoff-packet v1")
    expect(ctx).toContain("Original user goal: finish the CRM audit safely")
    expect(ctx).not.toContain("Recent user goal/message")
  })

  test("packet includes criteria, active plan, verification, blockers, actions, result refs, and evidence refs", () => {
    isolatedRoot("context-fields")
    const sid = sessionID("fields")
    writeContract(sid)
    const packet = buildResultPacket({
      sessionID: sid,
      executing_role: "chief-engineer",
      model: "mimo/mimo-v2.5-pro",
      user_goal: "Original CRM browser audit goal",
      subtask_goal: "Repair audit failure",
      claimed_result: "Partial repair",
      completion_status: "PARTIAL",
      files_changed: [{ filePath: "packages/opencode/src/a.ts", changeSummary: "patched failure" }],
      verification_results: [{ name: "dll-agent doctor", status: "failed", evidenceRef: "doctor:failed" }],
      evidence_refs: ["evidence:doctor"],
      unresolved_items: ["doctor still warns"],
    })
    writeResult(sid, packet)

    const handoff = buildContextHandoffPacket({
      sessionID: sid,
      targetRole: "chief-engineer",
      routingReason: "repeated failure",
      riskLevel: "high",
      metrics: metrics({ tool_failures: 3 }),
      fallbackUserGoal: "fallback",
      changedFiles: [{ path: "packages/opencode/src/b.ts" }],
      state: state({ blocked_completion: true, block_reason: "reviewer blocked completion" }),
    })

    expect(handoff.user_goal).toBe("Original CRM browser audit goal")
    expect(handoff.success_criteria_status.unsatisfied).toContain("CRM audit is complete")
    expect(handoff.active_plan_status.blocking_unfinished).toContain("Run browser click-through audit")
    expect(handoff.verification_summary.some((item) => item.name === "dll-agent doctor" && item.status === "failed")).toBe(true)
    expect(handoff.blocking_findings.some((item) => item.finding.includes("reviewer blocked completion"))).toBe(true)
    expect(handoff.required_actions.length).toBeGreaterThan(0)
    expect(handoff.result_packet_refs).toContain(packet.packet_id)
    expect(handoff.evidence_refs).toContain("evidence:doctor")
    expect(handoff.stale_or_partial_results).toContain(`${packet.packet_id}:PARTIAL`)
  })

  test("role renderers stay bounded and preserve goal, blockers, verification, and refs", () => {
    isolatedRoot("context-render")
    const sid = sessionID("render")
    writeContract(sid, `Important goal ${"x".repeat(1000)}`)
    const packet = buildContextHandoffPacket({
      sessionID: sid,
      targetRole: "final-auditor",
      routingReason: "final claim without evidence",
      riskLevel: "high",
      metrics: metrics({ final_claim: true }),
      fallbackUserGoal: "fallback",
      changedFiles: Array.from({ length: 30 }, (_, i) => ({ path: `packages/opencode/src/file-${i}.ts` })),
      state: state({ blocked_completion: true, block_reason: "missing verification output" }),
    })

    const rendered = renderHandoffForRole(packet, "final-auditor", 1_800)
    expect(rendered.length).toBeLessThanOrEqual(1_800)
    expect(rendered).toContain("Important goal")
    expect(rendered).toContain("Verification summary")
    expect(rendered).toContain("missing verification output")
    expect(rendered).toContain("Result packet refs")
  })

  test("requirements renderer avoids unrelated long logs while chief-engineer includes changed files", () => {
    isolatedRoot("context-role-render")
    const sid = sessionID("role-render")
    writeContract(sid)
    const packet = buildContextHandoffPacket({
      sessionID: sid,
      targetRole: "chief-engineer",
      routingReason: `tool failed ${"LOG ".repeat(1000)}`,
      riskLevel: "medium",
      metrics: metrics({ tool_failures: 2 }),
      fallbackUserGoal: "fallback",
      changedFiles: [{ path: "packages/opencode/src/dll-agent/reviewer-context.ts", summary: "context change" }],
      state: state(),
    })

    const requirements = renderHandoffForRole(packet, "requirements-inspector", 2_000)
    const engineer = renderHandoffForRole(packet, "chief-engineer", 2_000)
    expect(requirements).not.toContain("LOG LOG LOG LOG LOG LOG LOG LOG LOG LOG")
    expect(engineer).toContain("packages/opencode/src/dll-agent/reviewer-context.ts")
  })

  test("missing context lowers confidence and redaction prevents secret leakage", () => {
    isolatedRoot("context-redaction")
    const sid = sessionID("redaction")
    const handoff = buildContextHandoffPacket({
      sessionID: sid,
      targetRole: "final-auditor",
      routingReason: "final claim",
      riskLevel: "medium",
      metrics: metrics(),
      fallbackUserGoal: "Use api_key=abc123SECRET and Authorization: Bearer token12345",
    })

    expect(handoff.missing_context).toContain("goal_contract")
    expect(handoff.context_confidence).not.toBe("high")
    const serialized = JSON.stringify(handoff)
    expect(serialized).not.toContain("abc123SECRET")
    expect(serialized).not.toContain("Bearer token12345")
    expect(serialized).toContain("REDACTED")
  })

  test("reviewer-result-bridge honors project-scope role model override and records context packet ref", () => {
    isolatedRoot("context-project-model")
    const sid = sessionID("project-model")
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-project-model-"))
    cleanupPaths.push(projectDir)
    setRoleModelOverride("requirements-inspector", "mimo/mimo-v2.5-pro", "project", undefined, projectDir)

    const packet = buildReviewerResultPacket({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output: reviewerOutput(),
      state: state(),
      projectDir,
      contextPacketID: "ctx_test_1",
    })

    expect(packet.model).toBe("mimo/mimo-v2.5-pro")
    expect(packet.evidence_refs).toContain("context_handoff:ctx_test_1")
    expect(packet.context_packet_id).toBe("ctx_test_1")
    expect(packet.missing_context_packet).toBe(false)
  })

  test("reviewer-result-bridge marks missing context packet instead of omitting it", () => {
    isolatedRoot("context-missing-result")
    const sid = sessionID("missing-result")
    const packet = buildReviewerResultPacket({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output: reviewerOutput(),
      state: state(),
    })

    expect(packet.context_packet_id).toBeNull()
    expect(packet.missing_context_packet).toBe(true)
    expect(packet.evidence_refs).toContain("missing_context_packet:requirements-inspector")
    expect(packet.known_risks).toContain("missing_context_packet")
  })

  test("writeReviewerResult evidence associates reviewer result with context packet", () => {
    isolatedRoot("context-result-evidence")
    const sid = sessionID("result-evidence")
    writeReviewerResult({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output: reviewerOutput(),
      state: state(),
      contextPacketID: "ctx_evidence_1",
    })

    const result = loadResults(sid)[0]
    expect(result.context_packet_id).toBe("ctx_evidence_1")
    expect(result.evidence_refs).toContain("context_handoff:ctx_evidence_1")
    const produced = readEvidence().find((entry) => entry.type === "result.produced")
    expect(produced.payload.context_packet_id).toBe("ctx_evidence_1")
    expect(produced.payload.missing_context_packet).toBe(false)
  })

  test("supervisor records context packet id for dispatched reviewer without increasing context length", () => {
    isolatedRoot("context-supervisor-state")
    const sid = sessionID("supervisor-state")
    writeContract(sid)
    const decision = {
      should_review: true,
      reviewers: ["requirements-inspector"],
      reasons: { "requirements-inspector": "user correction" },
      metrics: metrics({ user_corrections: 1 }),
    } as any
    const subtasks = generateSubtasks(decision, sid, [userMsg("u1", "不对，请按原始目标继续")])
    const recorded = loadState(sid).reviewer_context_packets?.["requirements-inspector"]?.context_packet_id

    expect(subtasks).toHaveLength(1)
    expect(recorded).toStartWith("ctx_")
    expect(subtasks[0].prompt.length).toBeLessThan(8_000)
    expect(subtasks[0].prompt).toContain(recorded!)
  })

  test("reconciliation gate can reference context packet ids from reviewer results", () => {
    isolatedRoot("context-reconciliation")
    const sid = sessionID("reconciliation")
    writeReviewerResult({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output: reviewerOutput(),
      state: state({ completed_reviews: ["requirements-inspector"] }),
      contextPacketID: "ctx_recon_1",
    })

    const result = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "已完成所有工作。",
      state: state({ completed_reviews: ["requirements-inspector"] }),
      sessionID: sid,
    })

    expect(result.passed).toBe(false)
    expect(result.context_packet_refs).toContain("ctx_recon_1")
    expect(result.synthetic_hint).toContain("ctx_recon_1")
  })

  test("final gate blocks silent PASS when blocking reviewer result is missing context packet id", () => {
    isolatedRoot("context-final-gate")
    const sid = sessionID("final-gate")
    writeReviewerResult({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output: reviewerOutput({
        verdict: "fail_block",
        block_completion: true,
        findings: [{
          severity: "block",
          category: "evidence_missing",
          summary: "verification missing",
          citations: [],
        }],
      }),
      state: state(),
    })

    const result = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: state(),
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: sid,
    })

    expect(result.allowed).toBe(false)
    expect(result.reasons.some((reason) => reason.includes("missing context_handoff packet_id"))).toBe(true)
  })

  test("buildReviewerContextWithPacket returns packet id and bounded context", () => {
    isolatedRoot("context-with-packet")
    const sid = sessionID("with-packet")
    writeContract(sid)
    const result = buildReviewerContextWithPacket(
      "final-auditor",
      "final claim without evidence",
      metrics({ final_claim: true }),
      [userMsg("u1", "latest message")],
      sid,
      { state: state({ risk: "high" }), maxChars: 5_000 },
    )

    expect(result.contextPacketID).toStartWith("ctx_")
    expect(result.text.length).toBeLessThanOrEqual(5_000)
    expect(result.text).toContain(result.contextPacketID!)
  })
})
