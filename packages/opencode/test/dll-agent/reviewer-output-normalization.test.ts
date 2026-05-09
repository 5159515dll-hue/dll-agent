import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { checkReconciliationGate, finalGate } from "../../src/dll-agent/gates"
import { loadPackets } from "../../src/dll-agent/multimodal-context"
import { loadResults } from "../../src/dll-agent/result-ledger"
import {
  generateSubtasks,
  loadState,
  markReviewerCompleted,
  saveState,
} from "../../src/dll-agent/supervisor"
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
  const id = `ses_reviewer_norm_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function isolatedRoot(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dll-agent-reviewer-norm-${name}-`))
  cleanupPaths.push(root)
  process.env.DLL_AGENT_CONFIG_ROOT = root
  process.env.DLL_AGENT_EVIDENCE_FILE = path.join(root, "evidence.jsonl")
  return root
}

function metrics(overrides: Partial<SupervisorMetricsSnapshot> = {}): SupervisorMetricsSnapshot {
  return {
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
    ...overrides,
  }
}

function supervisorState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    version: 1,
    phase: "default",
    risk: "medium",
    required_reviews: ["requirements-inspector"],
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

function seedReviewerState(sessionID: string, withContext = true) {
  const state = supervisorState()
  if (withContext) {
    state.reviewer_context_packets = {
      "requirements-inspector": { context_packet_id: "ctx_norm_1", built_at: "2026-05-09T00:00:00.000Z" },
    }
  }
  state.role_run_envelopes = {
    "requirements-inspector": {
      role_run_id: "rr_norm_1",
      role_instance_id: "role_instance_norm_1",
      model: "deepseek/deepseek-v4-pro",
      context_packet_id: withContext ? "ctx_norm_1" : null,
      action_fingerprint: "act_norm_1",
      independence_mode: "isolated",
      built_at: "2026-05-09T00:00:00.000Z",
    },
  }
  saveState(sessionID, state)
}

function seedMultimodalReviewerState(sessionID: string, withContext = true) {
  const state = supervisorState({
    required_reviews: ["multimodal-context-interpreter"],
    risk: "medium",
    metrics: metrics(),
  })
  if (withContext) {
    state.reviewer_context_packets = {
      "multimodal-context-interpreter": { context_packet_id: "ctx_mm_1", built_at: "2026-05-09T00:00:00.000Z" },
    }
  }
  state.role_run_envelopes = {
    "multimodal-context-interpreter": {
      role_run_id: "rr_mm_1",
      role_instance_id: "role_instance_mm_1",
      model: "mimo/mimo-v2.5-pro",
      context_packet_id: withContext ? "ctx_mm_1" : null,
      action_fingerprint: "act_mm_1",
      independence_mode: "isolated",
      built_at: "2026-05-09T00:00:00.000Z",
    },
  }
  saveState(sessionID, state)
}

function evidenceEntries() {
  const file = process.env.DLL_AGENT_EVIDENCE_FILE
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

describe("Reviewer Output Normalization", () => {
  test("structured reviewer output writes the existing ResultPacket path", () => {
    isolatedRoot("structured")
    const sid = sessionID("structured")
    seedReviewerState(sid)

    markReviewerCompleted(sid, "requirements-inspector", reviewerOutput())
    const result = loadResults(sid)[0]

    expect(result.completion_status).toBe("VERIFIED_COMPLETE")
    expect(result.structured_output_missing).toBe(false)
    expect(result.source_kind).toBe("structured_reviewer_output")
    expect(result.context_packet_id).toBe("ctx_norm_1")
  })

  test("unstructured reviewer output generates low-confidence fallback ResultPacket", () => {
    isolatedRoot("fallback")
    const sid = sessionID("fallback")
    seedReviewerState(sid)

    markReviewerCompleted(sid, "requirements-inspector", undefined, {
      rawText: "Looks mostly okay, but this is prose only. api_key=secret12345",
    })
    const result = loadResults(sid)[0]

    expect(result.completion_status).toBe("UNVERIFIED")
    expect(result.structured_output_missing).toBe(true)
    expect(result.confidence).toBe("low")
    expect(result.source_kind).toBe("fallback_reviewer_output")
    expect(result.context_packet_id).toBe("ctx_norm_1")
    expect(result.evidence_refs).toContain("context_handoff:ctx_norm_1")
    expect(result.redacted_summary).toContain("api_key=REDACTED")
    expect(result.redacted_summary).not.toContain("secret12345")
    expect(result.known_risks).toContain("structured_output_missing")
    expect(evidenceEntries().some((entry) => entry.type === "reviewer.fallback_result_normalized")).toBe(true)
  })

  test("fallback missing context is explicitly marked", () => {
    isolatedRoot("missing-context")
    const sid = sessionID("missing-context")
    seedReviewerState(sid, false)

    markReviewerCompleted(sid, "requirements-inspector", undefined, { rawText: "No structured output." })
    const result = loadResults(sid)[0]

    expect(result.context_packet_id).toBeNull()
    expect(result.missing_context_packet).toBe(true)
    expect(result.known_risks).toContain("missing_context_packet")
  })

  test("fallback blocking reviewer is visible to final gate", () => {
    isolatedRoot("blocking")
    const sid = sessionID("blocking")
    seedReviewerState(sid)

    markReviewerCompleted(sid, "requirements-inspector", undefined, {
      rawText: "BLOCKING: verification is missing and cannot pass.",
    })
    const state = loadState(sid)
    const gate = finalGate({
      evidenceGate: { passed: true, needs_evidence: false, needs_review: false, block_reason: null, synthetic_hint: null },
      supervisorState: state,
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: sid,
    })

    expect(loadResults(sid)[0].completion_status).toBe("BLOCKED")
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.some((reason) => reason.includes("result ledger has"))).toBe(true)
  })

  test("reconciliation gate can see fallback reviewer result and audit risk", () => {
    isolatedRoot("reconciliation")
    const sid = sessionID("reconciliation")
    seedReviewerState(sid)

    markReviewerCompleted(sid, "requirements-inspector", undefined, { rawText: "Prose-only reviewer output." })
    const result = checkReconciliationGate({
      isCompletionClaim: true,
      assistantText: "已完成。",
      state: loadState(sid),
      sessionID: sid,
    })

    expect(result.passed).toBe(false)
    expect(result.context_packet_refs).toContain("ctx_norm_1")
    expect(result.audit_risks.some((risk) => risk.includes("structured_output_missing"))).toBe(true)
  })

  test("dedup reuse completion writes structured reuse result, not low-confidence fallback", () => {
    isolatedRoot("dedup")
    const sid = sessionID("dedup")
    seedReviewerState(sid)

    markReviewerCompleted(sid, "requirements-inspector", undefined, { reusedFromPacketID: "res_existing_1" })
    const result = loadResults(sid)[0]

    expect(result.completion_status).toBe("VERIFIED_COMPLETE")
    expect(result.source_kind).toBe("dedup_reuse")
    expect(result.structured_output_missing).toBe(false)
    expect(result.reused_from).toBe("res_existing_1")
  })

  test("reviewer normalization does not increase reviewer dispatch count", () => {
    isolatedRoot("dispatch")
    const sid = sessionID("dispatch")
    const decision = {
      should_review: true,
      reviewers: ["requirements-inspector"],
      reasons: { "requirements-inspector": "user correction" },
      metrics: metrics({ user_corrections: 1 }),
    } as any

    const subtasks = generateSubtasks(decision, sid, [userMsg("u1", "不对，请重新对齐目标")])
    expect(subtasks).toHaveLength(1)
  })

  test("multimodal structured output writes multimodal packet and ResultPacket", () => {
    isolatedRoot("multimodal-structured")
    const sid = sessionID("multimodal-structured")
    seedMultimodalReviewerState(sid)
    const rawText = [
      "```json",
      JSON.stringify({
        packet_type: "multimodal_context_packet",
        packet_id: "mmctx_test_1",
        source_hash: "sourcehash123456",
        role: "multimodal-context-interpreter",
        model: "mimo/mimo-v2.5-pro",
        input_type: "screenshot",
        user_goal: "Inspect the screenshot for UI errors",
        source_ref: "screenshot.png",
        task_relevance: "The screenshot shows the current UI state.",
        observations: [{ description: "A validation error is visible", category: "error", confidence: "high" }],
        detected_text: "Error: required field missing",
        visual_structure: "Form panel with error banner",
        errors_or_warnings: ["required field missing"],
        important_details: ["Submit button is disabled"],
        uncertainties: [],
        overall_confidence: "high",
        context_sufficient: true,
        recommended_next_role: "commander",
        evidence_refs: ["screenshot:e1"],
        redaction_status: "redacted",
        created_at: "2026-05-09T00:00:00.000Z",
      }),
      "```",
    ].join("\n")

    markReviewerCompleted(sid, "multimodal-context-interpreter", undefined, { rawText })
    const packet = loadPackets(sid)[0]
    const result = loadResults(sid)[0]

    expect(packet.packet_id).toBe("mmctx_test_1")
    expect(packet.context_sufficient).toBe(true)
    expect(result.executing_role).toBe("multimodal-context-interpreter")
    expect(result.completion_status).toBe("VERIFIED_COMPLETE")
    expect(result.structured_output_missing).toBe(false)
    expect(result.evidence_refs).toContain("multimodal_context:mmctx_test_1")
    expect(evidenceEntries().some((entry) => entry.type === "multimodal.context.produced")).toBe(true)
  })

  test("multimodal malformed output becomes low-confidence fallback packet", () => {
    isolatedRoot("multimodal-fallback")
    const sid = sessionID("multimodal-fallback")
    seedMultimodalReviewerState(sid)

    markReviewerCompleted(sid, "multimodal-context-interpreter", undefined, {
      rawText: "I can see a screenshot, but this is prose only. Authorization: Bearer abcdefghijk",
    })
    const packet = loadPackets(sid)[0]
    const result = loadResults(sid)[0]

    expect(packet.context_sufficient).toBe(false)
    expect(packet.overall_confidence).toBe("low")
    expect(packet.observations[0].description).not.toContain("Bearer abcdefghijk")
    expect(result.completion_status).toBe("UNVERIFIED")
    expect(result.structured_output_missing).toBe(true)
    expect(result.confidence).toBe("low")
    expect(result.known_risks).toContain("structured_output_missing")
    expect(result.evidence_refs).toContain(`multimodal_context:${packet.packet_id}`)
    expect(evidenceEntries().some((entry) => entry.type === "multimodal.context.low_confidence")).toBe(true)
  })
})
