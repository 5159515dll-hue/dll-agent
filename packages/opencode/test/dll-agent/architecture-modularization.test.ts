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
  isDllLocalCommand,
  renderDllLocalCommand,
} from "../../src/dll-agent/session-command-adapter"
import {
  buildObservabilitySummaryLine,
  buildQuotaStatusLine,
  commandLine,
  modeLine,
} from "../../src/dll-agent/tui-status-adapter"
import {
  drainSupervisorDispatchBatch,
  planReviewerDispatchGroups,
} from "../../src/dll-agent/reviewer-dispatch"
import {
  buildContinuationRuntimeActions,
  shouldStopAfterTrivialNoToolAnswer,
} from "../../src/dll-agent/session-runtime-adapter"
import { buildReviewerResultPacket, writeReviewerResult } from "../../src/dll-agent/reviewer-result-bridge"
import { loadResults } from "../../src/dll-agent/result-ledger"
import type { CapabilityOrchestrationResult } from "../../src/dll-agent/capability-orchestrator"
import type { ContinuationGateResult, ContinuationPacket, EvidenceGateResult, ReviewerOutput, SupervisorState } from "../../src/dll-agent/interfaces"
import type { Metrics } from "../../src/dll-agent/triggers"
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

function triggerMetrics(overrides: Partial<Metrics> = {}): Metrics {
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
    trivialNoToolTask: false,
    ...overrides,
  }
}

function continuationPacket(overrides: Partial<ContinuationPacket> = {}): ContinuationPacket {
  return {
    packet_type: "task_continuation",
    packet_id: "cont_arch",
    session_id: "ses_arch",
    user_goal: "finish the requested implementation",
    goal_contract_ref: null,
    current_phase: "default",
    completion_claim: "done",
    completion_status: "PARTIAL_CONTINUED",
    final_status: "CONTINUATION_REQUIRED",
    blocking_unfinished: [{
      id: "verify",
      kind: "blocking_unfinished",
      description: "verification not run",
      why_blocking: "required verification is missing",
      evidence_refs: ["evidence:verification"],
      required_action: "run verification",
      recommended_role: "chief-engineer",
      verification_required: ["typecheck"],
      risk_level: "medium",
    }],
    non_blocking_followup: [],
    requires_user_input: [],
    missing_verification: ["typecheck"],
    blocking_reviewer_findings: [],
    missing_result_refs: [],
    required_actions: ["run verification"],
    recommended_next_role: "commander",
    verification_required: ["typecheck"],
    evidence_refs: ["evidence:verification"],
    context_packet_refs: [],
    budget_state: {
      continuation_count: 0,
      max_continuations: 5,
      max_repairs_per_item: 2,
    },
    already_completed: [],
    files_involved: [],
    commands_run: [],
    verification_results: [],
    reviewer_blocks: [],
    next_execution_plan: [],
    stop_reason: null,
    redaction_status: "redacted",
    ...overrides,
  }
}

function continuationResult(overrides: Partial<ContinuationGateResult> = {}): ContinuationGateResult {
  const packet = continuationPacket()
  return {
    passed: false,
    completion_status: "PARTIAL_CONTINUED",
    has_blocking_unfinished: true,
    has_user_input_required: false,
    has_non_blocking: false,
    blocking_items: packet.blocking_unfinished,
    continuation_packet: packet,
    synthetic_hint: "continue before final PASS",
    block_reason: "continuation required before final completion",
    ...overrides,
  }
}

describe("Phase 9 architecture modularization helpers", () => {
  test("session-command-adapter recognizes local no-LLM commands", () => {
    expect(isDllLocalCommand("task-status")).toBe(true)
    expect(isDllLocalCommand("task-trajectory")).toBe(true)
    expect(isDllLocalCommand("model-usage")).toBe(true)
    expect(isDllLocalCommand("routing-report")).toBe(true)
    expect(isDllLocalCommand("doctor-next")).toBe(true)
    expect(isDllLocalCommand("regression-status")).toBe(true)
    expect(isDllLocalCommand("permissions")).toBe(true)
    expect(isDllLocalCommand("team-review")).toBe(false)
  })

  test("session-command-adapter renders local status without prompt orchestration", () => {
    const text = renderDllLocalCommand({
      command: "regression-status",
      arguments: "",
      sessionID: sessionID("local_command"),
      projectDir: process.cwd(),
    })
    expect(text).toContain("dll-agent regression status")
    expect(text).toContain("not_run=20")
  })

  test("session-command-adapter keeps invalid permissions local and explicit", () => {
    const text = renderDllLocalCommand({
      command: "permissions",
      arguments: "unsafe",
      sessionID: sessionID("permissions"),
      projectDir: process.cwd(),
    })
    expect(text).toContain("Invalid permission mode")
    expect(text).toContain("default|auto-review|full-access")
  })

  test("tui-status-adapter preserves compact status lines", () => {
    expect(commandLine(true)).toContain("/task-status")
    expect(modeLine()).toContain("quality=")
    expect(buildQuotaStatusLine({
      quota: {
        providers: {
          mimo: { status: "no_quota_endpoint" },
        },
      },
      width: 160,
    })).toContain("M:quota n/a")
    expect(buildObservabilitySummaryLine({
      report: undefined,
      width: 120,
    })).toContain("observability trajectory:unknown")
  })

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

  test("session-runtime-adapter returns no continuation actions when gate passes", () => {
    const actions = buildContinuationRuntimeActions({
      sessionID: sessionID("runtime_pass"),
      state: supervisorState(),
      continuationResult: continuationResult({
        passed: true,
        blocking_items: [],
        continuation_packet: null,
        synthetic_hint: null,
        block_reason: null,
      }),
      userGoal: "finish task",
      assistantText: "verified complete",
    })

    expect(actions).toEqual([])
  })

  test("session-runtime-adapter turns continuation block into structured runtime actions", () => {
    const actions = buildContinuationRuntimeActions({
      sessionID: sessionID("runtime_actions"),
      state: supervisorState(),
      continuationResult: continuationResult(),
      userGoal: "finish task",
      assistantText: "done",
      path: "first-break",
    })

    expect(actions.map((action) => action.type)).toEqual([
      "save_supervisor_state",
      "write_evidence",
      "write_recovery_decision",
      "inject_synthetic_hint",
      "inject_synthetic_hint",
      "queue_task_completion_check",
    ])
    expect(actions.find((action) => action.type === "write_evidence")).toMatchObject({
      event: "continuation_gate.attempt_recorded",
    })
    expect(actions.find((action) => action.type === "queue_task_completion_check")).toMatchObject({
      userGoal: "finish task",
      assistantText: "done",
    })
  })

  test("session-runtime-adapter emits budget exhausted action without queueing a reviewer", () => {
    const actions = buildContinuationRuntimeActions({
      sessionID: sessionID("runtime_budget"),
      state: supervisorState({ continuation_count: 5 }),
      continuationResult: continuationResult(),
      userGoal: "finish task",
      assistantText: "done",
      path: "second-break",
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: "continuation_budget_exhausted",
      reason: expect.stringContaining("Maximum continuation count"),
    })
  })

  test("session-runtime-adapter stops after trivial no-tool answer only when no blocking state exists", () => {
    expect(shouldStopAfterTrivialNoToolAnswer({
      metrics: triggerMetrics({ trivialNoToolTask: true }),
      state: supervisorState(),
    })).toBe(true)
    expect(shouldStopAfterTrivialNoToolAnswer({
      metrics: triggerMetrics(),
      explicitNoToolPrompt: true,
      state: supervisorState(),
    })).toBe(true)
    expect(shouldStopAfterTrivialNoToolAnswer({
      metrics: triggerMetrics({ trivialNoToolTask: true, highRiskTaskSignal: true }),
      state: supervisorState(),
    })).toBe(false)
    expect(shouldStopAfterTrivialNoToolAnswer({
      metrics: triggerMetrics({ trivialNoToolTask: true }),
      state: supervisorState({ required_reviews: ["requirements-inspector"] }),
    })).toBe(false)
    expect(shouldStopAfterTrivialNoToolAnswer({
      metrics: triggerMetrics({ statelessGreetingTask: true, statelessChatTask: true }),
      state: supervisorState(),
    })).toBe(true)
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
