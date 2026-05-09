import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { write as writeEvidence } from "../../src/dll-agent/evidence"
import { saveCostStatus } from "../../src/dll-agent/cost-cap"
import { buildModelUsageReport, renderModelUsageReport, renderRoutingReport } from "../../src/dll-agent/model-usage-report"

const cleanupFiles: string[] = []
const cleanupSessions: string[] = []

afterEach(() => {
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  for (const file of cleanupFiles.splice(0)) fs.rmSync(file, { force: true })
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
})

function sessionID(prefix: string) {
  const id = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

describe("model-usage-report", () => {
  test("reads routing evidence and preserves correctness/cost reasons", () => {
    const sid = sessionID("model_usage")
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    saveCostStatus(sid, {
      session_total_usd: 0.42,
      by_provider: { mimo: 0.4 },
      session_cap_exceeded: false,
      provider_cap_exceeded: {},
      last_warning: null,
    })

    writeEvidence("model.routing_decision", {
      role: "final-auditor",
      selected_model: "mimo/mimo-v2.5-pro",
      candidate_models: ["mimo/mimo-v2.5-pro", "openai/gpt-5.5-pro"],
      trigger_reason: "final claim missing evidence",
      correctness_reason: "high-risk final audit required",
      cost_reason: "lowest sufficient model",
      skipped_reviewers: ["requirements-inspector"],
      skipped_reviewer_details: [{
        role: "requirements-inspector",
        skip_reason: "budget_unavailable",
        correctness_required: true,
      }],
      whether_required_for_correctness: true,
      unresolved_routing_risk: true,
      result_refs: ["rp-1"],
    }, sid)

    const report = buildModelUsageReport({ sessionID: sid, evidenceFile })
    expect(report.total_decisions).toBe(1)
    expect(report.items[0]?.correctness_reason).toBe("high-risk final audit required")
    expect(report.items[0]?.cost_reason).toBe("lowest sufficient model")
    expect(report.items[0]?.unresolved_routing_risk).toBe(true)
    expect(report.unresolved_routing_risks).toBe(1)
    expect(report.total_estimated_cost_usd).toBe(0.42)
  })

  test("renders bounded usage and routing reports without model calls", () => {
    const sid = sessionID("model_usage_render")
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    writeEvidence("model.routing_decision", {
      role: "commander",
      selected_model: "deepseek/deepseek-v4-pro",
      trigger_reason: "low-risk task",
      correctness_reason: "commander is sufficient",
      cost_reason: null,
    }, sid)

    expect(renderModelUsageReport({ sessionID: sid, evidenceFile })).toContain("correctness=commander is sufficient")
    expect(renderRoutingReport({ sessionID: sid, evidenceFile })).toContain("dll-agent routing report")
  })
})
