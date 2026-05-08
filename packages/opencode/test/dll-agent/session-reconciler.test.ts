import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { reconcileSessionState } from "../../src/dll-agent/session-reconciler"
import { loadResults, resultLedgerPath } from "../../src/dll-agent/result-ledger"
import { loadState, saveState, stateFile } from "../../src/dll-agent/supervisor"
import type { SupervisorState } from "../../src/dll-agent/interfaces"

const cleanupDirs: string[] = []
const cleanupFiles: string[] = []

function tmpProject(report: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-reconcile-project-"))
  cleanupDirs.push(dir)
  fs.mkdirSync(path.join(dir, "files"), { recursive: true })
  fs.mkdirSync(path.join(dir, "test-screenshots"), { recursive: true })
  fs.writeFileSync(path.join(dir, "test-screenshots", "home.png"), "png")
  fs.writeFileSync(path.join(dir, "files", "full-crm-browser-flow-audit-report.md"), report)
  return dir
}

function baseState(): SupervisorState {
  return {
    version: 1,
    phase: "exec",
    risk: "high",
    required_reviews: [],
    completed_reviews: [],
    blocked_completion: true,
    block_reason: "completion claim without verification evidence",
    reviewer_conflict: false,
    metrics: {
      tool_failures: 0,
      permission_denied: 0,
      user_corrections: 0,
      context_percent: 10,
      context_tokens: 100,
      final_claim: true,
      verification_evidence: true,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    gate_block_retries: {
      "completion claim without verification evidence": 27,
    },
    updated_at: new Date().toISOString(),
  }
}

function uniqueSession() {
  const sid = `test-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}`
  cleanupFiles.push(stateFile(sid), resultLedgerPath(sid))
  cleanupDirs.push(path.dirname(stateFile(sid)))
  return sid
}

afterEach(() => {
  for (const file of cleanupFiles.splice(0)) fs.rmSync(file, { force: true })
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("session-reconciler", () => {
  test("clears stale no-evidence block when artifact evidence is verified", () => {
    const project = tmpProject(`
| Total Tests | 4 |
| ✅ PASS | 4 |
| ❌ FAIL | 0 |
| ⚠️ WARN | 0 |
`)
    const sid = uniqueSession()
    saveState(sid, baseState())

    const result = reconcileSessionState({ sessionID: sid, projectDir: project })
    const state = loadState(sid)

    expect(result.changed).toBe(true)
    expect(state.blocked_completion).toBe(false)
    expect(state.block_reason).toBe(null)
    expect(state.metrics.real_tool_evidence).toBe(true)
    expect(state.gate_block_retries?.["completion claim without verification evidence"]).toBeUndefined()
    expect(loadResults(sid).some((packet) => packet.completion_status === "VERIFIED_COMPLETE")).toBe(true)
  })

  test("reclassifies stale no-evidence block when report has failures", () => {
    const project = tmpProject(`
No blocking issues found.
| Total Tests | 4 |
| ✅ PASS | 3 |
| ❌ FAIL | 1 |
| ⚠️ WARN | 0 |
`)
    const sid = uniqueSession()
    saveState(sid, baseState())

    const result = reconcileSessionState({ sessionID: sid, projectDir: project })
    const state = loadState(sid)

    expect(result.changed).toBe(true)
    expect(state.blocked_completion).toBe(true)
    expect(state.block_reason).toContain("evidence exists")
    expect(loadResults(sid).some((packet) => packet.completion_status === "BLOCKED")).toBe(true)
  })
})
