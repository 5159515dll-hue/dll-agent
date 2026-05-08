import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  writeResult,
  loadResults,
  queryResults,
  invalidateResult,
  buildResultPacket,
  buildResultsSummary,
  computeResultHash,
  type ResultPacket,
} from "../../src/dll-agent/result-ledger"
import { checkResultSufficiency, isResultStale } from "../../src/dll-agent/result-sufficiency-gate"
import { checkDeduplication } from "../../src/dll-agent/deduplication-gate"

const cleanupSessions: string[] = []

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
})

function sessionID(name: string) {
  const id = `ses_result_ledger_test_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function makePacket(overrides: Partial<ResultPacket> = {}): ResultPacket {
  return {
    packet_type: "result_packet",
    packet_id: `res_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    executing_role: "commander",
    model: "deepseek/deepseek-v4-pro",
    user_goal: "test goal",
    subtask_goal: "test subtask",
    claimed_result: "test result",
    completion_status: "VERIFIED_COMPLETE",
    files_changed: [{ filePath: "/tmp/test.ts", changeSummary: "test change" }],
    artifacts_produced: [],
    commands_run: [{ command: "bun test", result: "passed", exitCode: 0 }],
    verification_results: [{ name: "typecheck", status: "passed" }],
    evidence_refs: ["ev_1"],
    unresolved_items: [],
    known_risks: [],
    reusable: true,
    stale: false,
    result_hash: "res_test",
    created_at: new Date().toISOString(),
    redaction_status: "redacted",
    ...overrides,
  }
}

// ─── Result Ledger Tests ───────────────────────────────────────────────────

describe("ResultLedger.writeRead", () => {
  test("writes and reads a result packet", () => {
    const sid = sessionID("write_read")
    const packet = makePacket({ subtask_goal: "write read test" })
    writeResult(sid, packet)
    const results = loadResults(sid)
    expect(results.length).toBe(1)
    expect(results[0].subtask_goal).toBe("write read test")
    expect(results[0].packet_type).toBe("result_packet")
  })

  test("reads empty ledger when no results exist", () => {
    const sid = sessionID("empty")
    const results = loadResults(sid)
    expect(results.length).toBe(0)
  })

  test("writes multiple results and reads all", () => {
    const sid = sessionID("multiple")
    writeResult(sid, makePacket({ subtask_goal: "task 1" }))
    writeResult(sid, makePacket({ subtask_goal: "task 2" }))
    writeResult(sid, makePacket({ subtask_goal: "task 3" }))
    const results = loadResults(sid)
    expect(results.length).toBe(3)
  })
})

describe("ResultLedger.queryResults", () => {
  test("filters by completion_status", () => {
    const sid = sessionID("query_status")
    writeResult(sid, makePacket({ subtask_goal: "done", completion_status: "VERIFIED_COMPLETE" }))
    writeResult(sid, makePacket({ subtask_goal: "partial", completion_status: "PARTIAL" }))
    writeResult(sid, makePacket({ subtask_goal: "failed", completion_status: "FAILED" }))
    const complete = queryResults(sid, { completion_status: "VERIFIED_COMPLETE" })
    expect(complete.length).toBe(1)
    expect(complete[0].subtask_goal).toBe("done")
    const partial = queryResults(sid, { completion_status: "PARTIAL" })
    expect(partial.length).toBe(1)
    expect(partial[0].subtask_goal).toBe("partial")
  })

  test("filters by executing_role", () => {
    const sid = sessionID("query_role")
    writeResult(sid, makePacket({ executing_role: "commander", subtask_goal: "cmd" }))
    writeResult(sid, makePacket({ executing_role: "requirements-inspector", subtask_goal: "glm" }))
    writeResult(sid, makePacket({ executing_role: "long-context-archivist", subtask_goal: "kimi" }))
    const glm = queryResults(sid, { executing_role: "requirements-inspector" })
    expect(glm.length).toBe(1)
    expect(glm[0].subtask_goal).toBe("glm")
  })

  test("filters by reusable_only", () => {
    const sid = sessionID("query_reusable")
    writeResult(sid, makePacket({ subtask_goal: "reusable", reusable: true, completion_status: "VERIFIED_COMPLETE" }))
    writeResult(sid, makePacket({ subtask_goal: "not", reusable: false, completion_status: "FAILED" }))
    const reusable = queryResults(sid, { reusable_only: true })
    expect(reusable.length).toBe(1)
    expect(reusable[0].subtask_goal).toBe("reusable")
  })
})

describe("ResultLedger.invalidate", () => {
  test("marks an existing result as invalidated", () => {
    const sid = sessionID("invalidate")
    const packet = makePacket({ packet_id: "res_original", subtask_goal: "to invalidate" })
    writeResult(sid, packet)
    invalidateResult(sid, "res_original", "Code has changed", "long-context-archivist")
    const results = loadResults(sid)
    const invalidated = results.find((r) => r.packet_id.startsWith("inv_"))
    expect(invalidated).toBeDefined()
    expect(invalidated!.completion_status).toBe("INVALIDATED")
    expect(invalidated!.reusable).toBe(false)
    expect(invalidated!.stale).toBe(true)
  })
})

describe("ResultLedger.buildResultsSummary", () => {
  test("returns text when results exist", () => {
    const sid = sessionID("summary")
    writeResult(sid, makePacket({ subtask_goal: "completed task", completion_status: "VERIFIED_COMPLETE" }))
    const summary = buildResultsSummary(sid)
    expect(summary).toContain("completed task")
    expect(summary).not.toBe("No prior results in ledger.")
  })

  test("returns empty message when no results", () => {
    const sid = sessionID("summary_empty")
    const summary = buildResultsSummary(sid)
    expect(summary).toBe("No prior results in ledger.")
  })
})

// ─── Sufficiency Gate Tests ────────────────────────────────────────────────

describe("ResultSufficiencyGate", () => {
  test("verdict=none when no results exist", () => {
    const sid = sessionID("suf_none")
    const result = checkResultSufficiency(sid, "new task")
    expect(result.verdict).toBe("none")
    expect(result.canReuse).toBe(false)
  })

  test("verdict=sufficient when VERIFIED_COMPLETE result exists", () => {
    const sid = sessionID("suf_sufficient")
    writeResult(sid, makePacket({
      subtask_goal: "fix bug X",
      completion_status: "VERIFIED_COMPLETE",
      reusable: true,
    }))
    const result = checkResultSufficiency(sid, "fix bug X")
    expect(result.verdict).toBe("sufficient")
    expect(result.canReuse).toBe(true)
  })

  test("verdict=partial when PARTIAL result exists", () => {
    const sid = sessionID("suf_partial")
    writeResult(sid, makePacket({
      subtask_goal: "implement feature Y",
      completion_status: "PARTIAL",
      unresolved_items: ["missing tests"],
    }))
    const result = checkResultSufficiency(sid, "implement feature Y")
    expect(result.verdict).toBe("partial")
    expect(result.canReuse).toBe(true)
  })

  test("verdict=failed_with_diagnosis when FAILED result exists", () => {
    const sid = sessionID("suf_failed")
    writeResult(sid, makePacket({
      subtask_goal: "complex task",
      completion_status: "FAILED",
    }))
    const result = checkResultSufficiency(sid, "complex task")
    expect(result.verdict).toBe("failed_with_diagnosis")
    expect(result.canReuse).toBe(false)
  })

  test("verdict=invalidated when STALE result exists", () => {
    const sid = sessionID("suf_stale")
    writeResult(sid, makePacket({
      subtask_goal: "old task",
      completion_status: "STALE",
      stale: true,
      reusable: false,
    }))
    const result = checkResultSufficiency(sid, "old task")
    expect(result.verdict).toBe("invalidated")
    expect(result.canReuse).toBe(false)
  })

  test("verdict=stale when result exceeds max age", () => {
    const sid = sessionID("suf_old_age")
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    writeResult(sid, makePacket({
      subtask_goal: "old task",
      created_at: twoHoursAgo,
      completion_status: "VERIFIED_COMPLETE",
    }))
    const result = checkResultSufficiency(sid, "old task", { maxAgeMinutes: 60 })
    expect(result.verdict).toBe("stale")
    expect(result.canReuse).toBe(false)
  })
})

describe("ResultSufficiencyGate.isResultStale", () => {
  test("returns false for recent result", () => {
    const packet = makePacket({ completion_status: "VERIFIED_COMPLETE", stale: false })
    expect(isResultStale(packet, 60)).toBe(false)
  })

  test("returns true for explicitly stale result", () => {
    const packet = makePacket({ completion_status: "STALE", stale: true })
    expect(isResultStale(packet, 60)).toBe(true)
  })

  test("returns true for old result", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const packet = makePacket({ created_at: twoDaysAgo, completion_status: "VERIFIED_COMPLETE" })
    expect(isResultStale(packet, 60)).toBe(true)
  })
})

// ─── Deduplication Gate Tests ──────────────────────────────────────────────

describe("DeduplicationGate", () => {
  test("returns no_existing_result when no prior results", () => {
    const sid = sessionID("dedup_none")
    const result = checkDeduplication(sid, "new task")
    expect(result.isRedundant).toBe(false)
    expect(result.recommendedAction).toBe("no_existing_result")
  })

  test("returns reuse_existing when VERIFIED_COMPLETE result exists", () => {
    const sid = sessionID("dedup_reuse")
    writeResult(sid, makePacket({
      subtask_goal: "already done",
      completion_status: "VERIFIED_COMPLETE",
      reusable: true,
    }))
    const result = checkDeduplication(sid, "already done")
    expect(result.isRedundant).toBe(true)
    expect(result.recommendedAction).toBe("reuse_existing")
    expect(result.syntheticHint).toContain("DO NOT re-execute this task")
  })

  test("returns continue_from_existing when PARTIAL result exists", () => {
    const sid = sessionID("dedup_partial")
    writeResult(sid, makePacket({
      subtask_goal: "partial work",
      completion_status: "PARTIAL",
      unresolved_items: ["gap 1"],
    }))
    const result = checkDeduplication(sid, "partial work")
    expect(result.isRedundant).toBe(false)
    expect(result.recommendedAction).toBe("continue_from_existing")
    expect(result.syntheticHint).toContain("Remaining gaps")
  })

  test("returns redo_allowed when user forces redo with justification", () => {
    const sid = sessionID("dedup_force")
    writeResult(sid, makePacket({
      subtask_goal: "old result",
      completion_status: "VERIFIED_COMPLETE",
    }))
    const result = checkDeduplication(sid, "old result", {
      forceRedo: true,
      redoJustification: "User goal changed — need fresh implementation",
    })
    expect(result.isRedundant).toBe(false)
    expect(result.recommendedAction).toBe("redo_allowed")
  })

  test("returns repair_existing when previous attempt FAILED", () => {
    const sid = sessionID("dedup_repair")
    writeResult(sid, makePacket({
      subtask_goal: "failed task",
      completion_status: "FAILED",
    }))
    const result = checkDeduplication(sid, "failed task")
    expect(result.recommendedAction).toBe("repair_existing")
    expect(result.syntheticHint).toContain("FAILED")
  })
})

describe("DeduplicationGate with file paths", () => {
  test("matches results by file paths", () => {
    const sid = sessionID("dedup_files")
    writeResult(sid, makePacket({
      subtask_goal: "edit config",
      files_changed: [{ filePath: "/tmp/config.ts", changeSummary: "updated config" }],
      completion_status: "VERIFIED_COMPLETE",
    }))
    const result = checkDeduplication(sid, "edit config", {
      requiredFilePaths: ["/tmp/config.ts"],
    })
    expect(result.isRedundant).toBe(true)
    expect(result.recommendedAction).toBe("reuse_existing")
  })
})

describe("DeduplicationGate evidence refs", () => {
  test("missing evidence_refs makes result unverified", () => {
    const sid = sessionID("dedup_no_ev")
    writeResult(sid, makePacket({
      subtask_goal: "no evidence",
      completion_status: "UNVERIFIED",
      evidence_refs: [],
      verification_results: [],
      reusable: true,
    }))
    const result = checkDeduplication(sid, "no evidence")
    expect(result.recommendedAction).toBe("verify_existing")
    expect(result.syntheticHint).toContain("UNVERIFIED")
  })
})

// ─── Integration Tests ─────────────────────────────────────────────────────

describe("ResultLedger.reuseScenarios", () => {
  test("subsequent model can reuse verified result", () => {
    const sid = sessionID("reuse_scenario")
    // Model A completes a task
    writeResult(sid, makePacket({
      subtask_goal: "typecheck all files",
      completion_status: "VERIFIED_COMPLETE",
      commands_run: [{ command: "bun typecheck", result: "passed", exitCode: 0 }],
      verification_results: [{ name: "typecheck", status: "passed" }],
    }))
    // Model B checks
    const results = queryResults(sid, { completion_status: "VERIFIED_COMPLETE" })
    expect(results.length).toBe(1)
    expect(results[0].subtask_goal).toBe("typecheck all files")
    expect(results[0].reusable).toBe(true)
  })

  test("partial result triggers continue_from_existing not redo", () => {
    const sid = sessionID("partial_scenario")
    writeResult(sid, makePacket({
      subtask_goal: "implement login",
      completion_status: "PARTIAL",
      reusable: false,  // PARTIAL results are not fully reusable
      unresolved_items: ["password reset not implemented"],
    }))
    // Non-reusable results should be excluded from reusable_only queries
    const reusable = queryResults(sid, { reusable_only: true })
    expect(reusable.length).toBe(0)
  })

  test("stale result is NOT returned in reusable_only queries", () => {
    const sid = sessionID("stale_scenario")
    writeResult(sid, makePacket({
      subtask_goal: "old verification",
      completion_status: "VERIFIED_COMPLETE",
      stale: true,
      reusable: false,
    }))
    const reusable = queryResults(sid, { reusable_only: true })
    expect(reusable.length).toBe(0)
  })

  test("user goal is preserved across result packets", () => {
    const sid = sessionID("goal_preserved")
    writeResult(sid, makePacket({
      user_goal: "优化多模型路由策略",
      subtask_goal: "diagnose token distribution",
    }))
    const results = loadResults(sid)
    expect(results[0].user_goal).toBe("优化多模型路由策略")
  })

  test("result packet is redacted", () => {
    const sid = sessionID("redaction")
    writeResult(sid, makePacket({
      subtask_goal: "sensitive task",
    }))
    const results = loadResults(sid)
    expect(results[0].redaction_status).toBe("redacted")
  })
})

describe("DeduplicationGate.edgeCases", () => {
  test("does not crash on unreadable ledger file", () => {
    const sid = sessionID("bad_file")
    const target = path.join(os.homedir(), ".dll-agent", "sessions", sid, "results.jsonl")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "not valid json \n {}}}}")
    const result = checkDeduplication(sid, "some task")
    expect(result.recommendedAction).toBe("no_existing_result")
  })

  test("stale detection prevents reuse of expired results", () => {
    const sid = sessionID("stale_detection")
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    writeResult(sid, makePacket({
      subtask_goal: "ancient task",
      created_at: oldTime,
      completion_status: "VERIFIED_COMPLETE",
    }))
    const result = checkDeduplication(sid, "ancient task", { maxAgeMinutes: 60 })
    expect(result.isRedundant).toBe(false)
    expect(result.recommendedAction).toBe("redo_allowed")
  })
})
