import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { buildGoalContract, saveGoalContract } from "../../src/dll-agent/goal-contract"
import { stateFile } from "../../src/dll-agent/supervisor"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"
import { write as writeEvidence } from "../../src/dll-agent/evidence"
import { buildTaskObservabilityReport, renderTaskStatus } from "../../src/dll-agent/task-observability"

const cleanupSessions: string[] = []
const cleanupFiles: string[] = []

function sessionID(prefix: string) {
  const id = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

afterEach(() => {
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
  for (const file of cleanupFiles.splice(0)) {
    fs.rmSync(file, { force: true })
  }
})

function writeSupervisorState(id: string) {
  const file = stateFile(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    phase: "implementation",
    risk: "high",
    required_reviews: ["requirements-inspector"],
    completed_reviews: ["chief-engineer"],
    queued_reviewers: ["requirements-inspector"],
    running_reviewers: [],
    blocked_completion: true,
    block_reason: "required verification not_run",
    reviewer_conflict: false,
    metrics: {
      tool_failures: 1,
      permission_denied: 0,
      user_corrections: 0,
      context_percent: 12,
      context_tokens: 1200,
      final_claim: false,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    updated_at: new Date().toISOString(),
  }, null, 2))
}

describe("task-observability", () => {
  test("builds task status from goal, supervisor, result ledger, and routing evidence", () => {
    const sid = sessionID("task_observability")
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile

    saveGoalContract(buildGoalContract({
      sessionID: sid,
      userGoal: "Fix provider routing without leaking token=secret-value",
      activePlan: [{ id: "verify", description: "Run typecheck", status: "pending", evidence_refs: [] }],
    }))
    writeSupervisorState(sid)
    writeResult(sid, buildResultPacket({
      sessionID: sid,
      executing_role: "executor",
      model: "dll-agent-test",
      user_goal: "Fix provider routing",
      subtask_goal: "Run Phase 8 smoke",
      claimed_result: "Partial smoke complete",
      completion_status: "PARTIAL",
      verification_results: [{ name: "typecheck", status: "not_run" }],
      evidence_refs: ["task-observability-test"],
      unresolved_items: ["typecheck not_run"],
    }))
    writeEvidence("model.routing_decision", {
      role: "requirements-inspector",
      selected_model: "zai/glm-5.1",
      skipped_reviewers: ["final-auditor"],
    }, sid)

    const report = buildTaskObservabilityReport({
      sessionID: sid,
      projectDir: process.cwd(),
      evidenceFile,
    })

    expect(report.goal).toContain("REDACTED")
    expect(report.phase).toBe("implementation")
    expect(report.blockers).toContain("required verification not_run")
    expect(report.results.partial).toBe(1)
    expect(report.routing.selected_models).toContain("zai/glm-5.1")
    expect(report.routing.skipped_reviewers).toContain("final-auditor")
    expect(report.next_actions.join("\n")).toContain("Resolve blocking items")
  })

  test("renderTaskStatus is bounded and includes trajectory lines", () => {
    const sid = sessionID("task_status_render")
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    writeEvidence("gate.blocked_completion", { block_reason: "missing evidence" }, sid)

    const text = renderTaskStatus({
      sessionID: sid,
      projectDir: process.cwd(),
      evidenceFile,
    })

    expect(text).toContain("dll-agent task status")
    expect(text).toContain("trajectory:")
    expect(text).toContain("missing evidence")
    expect(text.length).toBeLessThan(4000)
  })
})
