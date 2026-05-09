import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  buildActionFingerprint,
  buildGuardDecision,
  checkActionFingerprintDuplicate,
} from "../../src/dll-agent/action-fingerprint-gate"
import {
  buildRoleRunEnvelope,
  findSameModelResultRisks,
  findSameModelRoleRunRisks,
} from "../../src/dll-agent/role-run-envelope"
import { finalGate } from "../../src/dll-agent/gates"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"
import { generateSubtasks, loadState, markReviewerCompleted } from "../../src/dll-agent/supervisor"
import type { ReviewerOutput, SupervisorMetricsSnapshot, SupervisorState } from "../../src/dll-agent/interfaces"
import type { MessageV2 } from "../../src/session/message-v2"

const cleanupSessions: string[] = []
const cleanupPaths: string[] = []
const previousEvidenceFile = process.env.DLL_AGENT_EVIDENCE_FILE
const previousConfigRoot = process.env.DLL_AGENT_CONFIG_ROOT

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
  for (const file of cleanupPaths.splice(0)) fs.rmSync(file, { recursive: true, force: true })
  if (previousEvidenceFile === undefined) delete process.env.DLL_AGENT_EVIDENCE_FILE
  else process.env.DLL_AGENT_EVIDENCE_FILE = previousEvidenceFile
  if (previousConfigRoot === undefined) delete process.env.DLL_AGENT_CONFIG_ROOT
  else process.env.DLL_AGENT_CONFIG_ROOT = previousConfigRoot
})

function sessionID(name: string) {
  const id = `ses_mm_guard_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function isolatedRoot(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dll-agent-mm-${name}-`))
  cleanupPaths.push(root)
  process.env.DLL_AGENT_CONFIG_ROOT = root
  process.env.DLL_AGENT_EVIDENCE_FILE = path.join(root, "evidence.jsonl")
  return root
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

describe("multi-model collaboration guards", () => {
  test("role-run envelopes isolate same base model across different roles", () => {
    const a = buildRoleRunEnvelope({
      sessionID: "ses",
      role: "requirements-inspector",
      model: "mimo/mimo-v2.5-pro",
      contextPacketID: "ctx_req",
      triggerReason: "user correction",
      riskLevel: "medium",
      allowedActions: ["read"],
      forbiddenActions: ["write"],
      now: new Date("2026-05-09T00:00:00.000Z"),
    })
    const b = buildRoleRunEnvelope({
      sessionID: "ses",
      role: "role-cross",
      model: "mimo/mimo-v2.5-pro",
      contextPacketID: "ctx_cross",
      triggerReason: "reviewer conflict",
      riskLevel: "high",
      allowedActions: ["read"],
      forbiddenActions: ["write"],
      now: new Date("2026-05-09T00:00:01.000Z"),
    })

    expect(a.role_instance_id).not.toBe(b.role_instance_id)
    expect(a.independence_mode).toBe("isolated")
    expect(b.independence_mode).toBe("arbitration")
    expect(findSameModelRoleRunRisks([a, b])).toEqual([])
  })

  test("same model multi-role risk is reported when context packet is missing or reused", () => {
    const a = buildRoleRunEnvelope({
      sessionID: "ses",
      role: "requirements-inspector",
      model: "deepseek/deepseek-v4-pro",
      contextPacketID: "ctx_shared",
      triggerReason: "check scope",
      riskLevel: "medium",
      allowedActions: ["read"],
      forbiddenActions: ["write"],
    })
    const b = buildRoleRunEnvelope({
      sessionID: "ses",
      role: "chief-engineer",
      model: "deepseek/deepseek-v4-pro",
      contextPacketID: "ctx_shared",
      triggerReason: "fix failure",
      riskLevel: "medium",
      allowedActions: ["read"],
      forbiddenActions: ["write"],
    })
    const c = buildRoleRunEnvelope({
      sessionID: "ses",
      role: "final-auditor",
      model: "deepseek/deepseek-v4-pro",
      triggerReason: "final audit",
      riskLevel: "high",
      allowedActions: ["read"],
      forbiddenActions: ["write"],
    })

    const risks = findSameModelRoleRunRisks([a, b, c])
    expect(risks.some((risk) => risk.includes("missing context packet"))).toBe(true)
    expect(risks.some((risk) => risk.includes("reused context packet ctx_shared"))).toBe(true)
  })

  test("action fingerprint detects duplicate low-value work without blocking correctness-required guards silently", () => {
    const fingerprint = buildActionFingerprint({
      role: "requirements-inspector",
      model: "glm/glm-5.1",
      contextPacketID: "ctx_1",
      intendedAction: "user correction",
      files: ["packages/opencode/src/dll-agent/supervisor.ts"],
    })
    const duplicate = checkActionFingerprintDuplicate({
      fingerprint,
      now: new Date("2026-05-09T00:10:00.000Z"),
      records: [{
        fingerprint,
        role: "requirements-inspector",
        model: "glm/glm-5.1",
        ts: "2026-05-09T00:00:00.000Z",
        context_packet_id: "ctx_1",
      }],
    })
    const guard = buildGuardDecision({
      guard: "action_fingerprint",
      action: "skip",
      requiredForCorrectness: true,
      reason: "duplicate reviewer action",
    })

    expect(duplicate.duplicate).toBe(true)
    expect(guard.effective_action).toBe("ask")
    expect(guard.audit_risk).toBe("correctness_required_action_was_about_to_be_skipped")
  })

  test("supervisor records role-run envelope and reviewer result carries role-run metadata", () => {
    isolatedRoot("supervisor")
    const sid = sessionID("supervisor")
    const decision = {
      should_review: true,
      reviewers: ["requirements-inspector"],
      reasons: { "requirements-inspector": "user correction" },
      metrics: metrics({ user_corrections: 1 }),
    } as any
    const subtasks = generateSubtasks(decision, sid, [userMsg("u1", "不对，请重新对齐目标")])
    const roleRun = loadState(sid).role_run_envelopes?.["requirements-inspector"]

    markReviewerCompleted(sid, "requirements-inspector", reviewerOutput())
    const resultText = fs.readFileSync(path.join(os.homedir(), ".dll-agent", "sessions", sid, "results.jsonl"), "utf8")

    expect(subtasks).toHaveLength(1)
    expect(roleRun?.role_run_id).toStartWith("rr_")
    expect(roleRun?.action_fingerprint).toStartWith("act_")
    expect(resultText).toContain(roleRun!.role_run_id)
    expect(resultText).toContain(roleRun!.action_fingerprint)
  })

  test("final gate flags same-model reviewer results when role-run/context isolation is missing", () => {
    isolatedRoot("final-risk")
    const sid = sessionID("final-risk")
    writeResult(sid, buildResultPacket({
      sessionID: sid,
      executing_role: "requirements-inspector",
      model: "deepseek/deepseek-v4-pro",
      user_goal: "goal",
      subtask_goal: "review requirements",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      evidence_refs: ["context_handoff:ctx_req"],
      context_packet_id: "ctx_req",
    }))
    writeResult(sid, buildResultPacket({
      sessionID: sid,
      executing_role: "chief-engineer",
      model: "deepseek/deepseek-v4-pro",
      user_goal: "goal",
      subtask_goal: "review failure",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      evidence_refs: ["context_handoff:ctx_eng"],
      context_packet_id: "ctx_eng",
    }))

    const result = finalGate({
      evidenceGate: { passed: true, needs_evidence: false, needs_review: false, block_reason: null, synthetic_hint: null },
      supervisorState: state(),
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: sid,
    })

    expect(result.allowed).toBe(false)
    expect(result.reasons.some((reason) => reason.includes("same-model multi-role isolation audit risk"))).toBe(true)
  })

  test("same-model results with distinct envelopes and context packets do not create audit risk", () => {
    const req = buildResultPacket({
      sessionID: "ses",
      executing_role: "requirements-inspector",
      model: "mimo/mimo-v2.5-pro",
      user_goal: "goal",
      subtask_goal: "requirements review",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      context_packet_id: "ctx_req",
      role_run_id: "rr_req",
      action_fingerprint: "act_req",
    })
    const eng = buildResultPacket({
      sessionID: "ses",
      executing_role: "chief-engineer",
      model: "mimo/mimo-v2.5-pro",
      user_goal: "goal",
      subtask_goal: "engineering review",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      context_packet_id: "ctx_eng",
      role_run_id: "rr_eng",
      action_fingerprint: "act_eng",
    })

    expect(findSameModelResultRisks([req, eng])).toEqual([])
  })

  test("same provider different models are separate identities for isolation checks", () => {
    const pro = buildResultPacket({
      sessionID: "ses",
      executing_role: "requirements-inspector",
      model: "mimo/mimo-v2.5-pro",
      user_goal: "goal",
      subtask_goal: "requirements review",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      context_packet_id: "ctx_req",
      role_run_id: "rr_req",
      action_fingerprint: "act_req",
    })
    const base = buildResultPacket({
      sessionID: "ses",
      executing_role: "multimodal-context-interpreter",
      model: "mimo/mimo-v2.5",
      user_goal: "goal",
      subtask_goal: "multimodal read",
      claimed_result: "pass",
      completion_status: "VERIFIED_COMPLETE",
      context_packet_id: "ctx_mm",
      role_run_id: "rr_mm",
      action_fingerprint: "act_mm",
    })

    expect(findSameModelResultRisks([pro, base])).toEqual([])
  })
})
