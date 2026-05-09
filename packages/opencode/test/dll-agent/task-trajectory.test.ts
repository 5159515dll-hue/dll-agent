import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { write as writeEvidence } from "../../src/dll-agent/evidence"
import { buildTaskTrajectory, renderTaskTrajectory } from "../../src/dll-agent/task-trajectory"

const cleanupFiles: string[] = []

afterEach(() => {
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  for (const file of cleanupFiles.splice(0)) fs.rmSync(file, { force: true })
})

describe("task-trajectory", () => {
  test("builds redacted trajectory events from evidence", () => {
    const sid = `trajectory_${Date.now()}`
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile

    writeEvidence("model.routing_decision", {
      task_id: "task-1",
      role: "requirements-inspector",
      selected_model: "zai/glm-5.1",
      correctness_reason: "user correction",
      token: "secret-value",
      evidence_refs: ["ev-1"],
      result_refs: ["rp-1"],
      risk_level: "medium",
    }, sid)

    const events = buildTaskTrajectory({ sessionID: sid, evidenceFile })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("routing.decision")
    expect(events[0]?.task_id).toBe("task-1")
    expect(events[0]?.risk_level).toBe("medium")
    expect(JSON.stringify(events)).not.toContain("secret-value")
    expect(events[0]?.redaction_status).toBe("redacted")
  })

  test("rendered trajectory is bounded and does not mark completion", () => {
    const sid = `trajectory_render_${Date.now()}`
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile

    writeEvidence("doctor.run", { overall: "WARN", passCount: 10, warnCount: 1, failCount: 0 }, sid)
    const text = renderTaskTrajectory({ sessionID: sid, evidenceFile, maxChars: 500 })
    expect(text).toContain("dll-agent task trajectory")
    expect(text).toContain("doctor.run")
    expect(text).not.toContain("VERIFIED_COMPLETE")
    expect(text.length).toBeLessThanOrEqual(500)
  })
})
