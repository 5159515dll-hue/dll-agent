import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  appendGateBlock,
  buildCapabilityGateBlock,
  buildDedupGateBlock,
} from "../../src/dll-agent/session-gate-orchestrator"
import {
  drainSupervisorDispatchBatch,
  planReviewerDispatchGroups,
} from "../../src/dll-agent/reviewer-dispatch"
import { buildReviewerResultPacket, writeReviewerResult } from "../../src/dll-agent/reviewer-result-bridge"
import { loadResults } from "../../src/dll-agent/result-ledger"
import type { CapabilityOrchestrationResult } from "../../src/dll-agent/capability-orchestrator"
import type { EvidenceGateResult, ReviewerOutput, SupervisorState } from "../../src/dll-agent/interfaces"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const cleanupSessions: string[] = []

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
})

function sessionID(name: string) {
  const id = `ses_dll_agent_arch_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function gateResult(overrides: Partial<EvidenceGateResult> = {}): EvidenceGateResult {
  return {
    passed: true,
    needs_evidence: false,
    needs_review: false,
    block_reason: null,
    synthetic_hint: null,
    ...overrides,
  }
}

function supervisorTask(agent: string): MessageV2.SubtaskPart {
  return {
    type: "subtask",
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_arch"),
    agent,
    description: agent,
    command: "dll-agent-supervisor",
    prompt: agent,
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

function supervisorState(overrides: Partial<SupervisorState> = {}): SupervisorState {
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
      user_corrections: 1,
      context_percent: 10,
      context_tokens: 1000,
      final_claim: false,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    updated_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  }
}

describe("Phase 9 architecture modularization helpers", () => {
  test("appendGateBlock composes block reasons and hints without losing existing gate output", () => {
    const result = appendGateBlock(
      gateResult({ block_reason: "evidence missing", synthetic_hint: "run tests" }),
      buildDedupGateBlock({ packetId: "res_1", hint: "reuse res_1" }),
    )

    expect(result.passed).toBe(false)
    expect(result.block_reason).toContain("evidence missing")
    expect(result.block_reason).toContain("res_1")
    expect(result.synthetic_hint).toContain("run tests")
    expect(result.synthetic_hint).toContain("reuse res_1")
  })

  test("buildCapabilityGateBlock returns a block only when completion has unresolved capability requirements", () => {
    const runtime = {
      fingerprint: "cap_1",
      unresolvedGaps: [{ tag: "browser-automation" }],
      blockedReasons: ["missing token"],
    } as unknown as CapabilityOrchestrationResult

    const block = buildCapabilityGateBlock(runtime, true)
    expect(block?.reason).toContain("browser-automation")
    expect(block?.reason).toContain("missing token")
    expect(buildCapabilityGateBlock(runtime, false)).toBeNull()
  })

  test("reviewer dispatch planner groups adjacent read-only reviewers and serializes write-capable reviewers", () => {
    const groups = planReviewerDispatchGroups(
      [
        supervisorTask("requirements-inspector"),
        supervisorTask("long-context-archivist"),
        supervisorTask("chief-engineer"),
        supervisorTask("final-auditor"),
      ],
      (agent) => agent !== "chief-engineer",
    )

    expect(groups.map((group) => group.mode)).toEqual(["parallel-read", "serial-write", "parallel-read"])
    expect(groups[0].tasks.map((task) => task.agent)).toEqual(["requirements-inspector", "long-context-archivist"])
    expect(groups[1].tasks.map((task) => task.agent)).toEqual(["chief-engineer"])
  })

  test("drainSupervisorDispatchBatch drains only trailing supervisor subtasks", () => {
    const tasks: MessageV2.Part[] = [
      { type: "text", id: PartID.ascending(), messageID: MessageID.ascending(), sessionID: SessionID.make("ses_arch"), text: "normal" },
      supervisorTask("requirements-inspector"),
      supervisorTask("final-auditor"),
    ]

    const batch = drainSupervisorDispatchBatch(tasks)
    expect(batch.map((task) => task.agent)).toEqual(["final-auditor", "requirements-inspector"])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].type).toBe("text")
  })

  test("reviewer result bridge builds and writes Result Ledger packets", () => {
    const sid = sessionID("reviewer_result")
    const output = reviewerOutput()
    const state = supervisorState()
    const packet = buildReviewerResultPacket({
      sessionID: sid,
      reviewer: "requirements-inspector",
      output,
      state,
    })

    expect(packet.executing_role).toBe("requirements-inspector")
    expect(packet.completion_status).toBe("VERIFIED_COMPLETE")
    expect(packet.evidence_refs).toContain("reviewer:requirements-inspector")

    writeReviewerResult({ sessionID: sid, reviewer: "requirements-inspector", output, state })
    const results = loadResults(sid)
    expect(results).toHaveLength(1)
    expect(results[0].executing_role).toBe("requirements-inspector")
  })
})
