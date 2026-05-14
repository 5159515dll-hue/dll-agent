import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { write as writeEvidence } from "../../src/dll-agent/evidence"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"
import {
  buildCommandActivity,
  buildCommandActivityExpandedLines,
  buildCommandActivityMiniLines,
  buildToolActivitySummary,
  type CommandActivityEvent,
} from "../../src/dll-agent/command-activity"

const cleanupFiles: string[] = []
const cleanupSessions: string[] = []
const cleanupHomes: string[] = []
const originalHome = process.env.HOME

afterEach(() => {
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  for (const file of cleanupFiles.splice(0)) fs.rmSync(file, { force: true })
  for (const sid of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", sid), { recursive: true, force: true })
  }
  delete process.env.DLL_AGENT_CONFIG_ROOT
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  for (const home of cleanupHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function sessionID() {
  const sid = `command_activity_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(sid)
  return sid
}

function useTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "command-activity-home-"))
  cleanupHomes.push(home)
  process.env.HOME = home
  process.env.DLL_AGENT_CONFIG_ROOT = path.join(home, ".dll-agent")
}

describe("command activity", () => {
  test("builds redacted command events from evidence and Result Ledger", () => {
    useTempHome()
    const sid = sessionID()
    const evidenceFile = path.join(os.tmpdir(), `${sid}.jsonl`)
    cleanupFiles.push(evidenceFile)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile

    writeEvidence("tool.command.finished", {
      role: "commander",
      tool: "bash",
      command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test",
      status: "failed",
      exit_code: 1,
      duration_ms: 1200,
      failure_type: "command_error",
    }, sid)
    writeEvidence("doctor.run", { overall: "WARN", passCount: 20, warnCount: 1, failCount: 0 }, sid)
    writeResult(sid, buildResultPacket({
      sessionID: sid,
      executing_role: "commander",
      model: "test/model",
      user_goal: "run checks",
      subtask_goal: "typecheck",
      claimed_result: "typecheck passed",
      completion_status: "VERIFIED_COMPLETE",
      commands_run: [{ command: "bun typecheck", result: "passed", exitCode: 0, evidenceRef: "cmd:typecheck" }],
      verification_results: [{ name: "typecheck", status: "passed", evidenceRef: "cmd:typecheck" }],
      evidence_refs: ["cmd:typecheck"],
    }))

    const events = buildCommandActivity({ sessionID: sid, evidenceFile })
    expect(events.some((event) => event.command_summary.includes("Bearer REDACTED"))).toBe(true)
    expect(JSON.stringify(events)).not.toContain("abcdefghijklmnop")
    expect(events.some((event) => event.status === "failed" && event.failure_type === "command_error")).toBe(true)
    expect(events.some((event) => event.command_summary === "bun typecheck" && event.status === "passed")).toBe(true)
    expect(events.every((event) => event.redaction_status === "redacted")).toBe(true)
  })

  test("renders compact and expanded bounded command windows", () => {
    const events = [
      {
        command_id: "cmd-1",
        timestamp: "2026-05-10T00:00:00.000Z",
        role: "commander",
        tool: "bash",
        command_summary: "bun test --cwd packages/opencode test/dll-agent/",
        status: "passed",
        duration_ms: 900,
        exit_code: 0,
        evidence_ref: "tool.command@1",
        requires_user_action: false,
        redaction_status: "redacted",
      },
      {
        command_id: "cmd-2",
        timestamp: "2026-05-10T00:01:00.000Z",
        role: "commander",
        tool: "doctor",
        command_summary: "dll-agent doctor",
        status: "blocked",
        evidence_ref: "doctor.run@2",
        requires_user_action: true,
        redaction_status: "redacted",
      },
    ] as const

    const compact = buildCommandActivityMiniLines({ events: [...events], width: 80 })
    const expanded = buildCommandActivityExpandedLines({ events: [...events], width: 120, limit: 8 })

    expect(compact[0]).toContain("dll-agent doctor")
    expect(expanded.join("\n")).toContain("需要用户处理")
    expect(compact.every((line) => line.length <= 80)).toBe(true)
    expect(expanded.every((line) => line.length <= 120)).toBe(true)
  })

  test("aggregates repeated Param Incorrect events in command windows", () => {
    const events: CommandActivityEvent[] = Array.from({ length: 12 }, (_, index) => ({
      command_id: `param-${index}`,
      timestamp: `2026-05-10T00:00:${String(index).padStart(2, "0")}.000Z`,
      role: "system",
      tool: "capability",
      command_summary: "Param Incorrect",
      status: "failed",
      failure_type: "param_incorrect",
      evidence_ref: `capability.actions@${index}`,
      requires_user_action: false,
      redaction_status: "redacted",
    }))

    const compact = buildCommandActivityMiniLines({ events: [...events], width: 120, limit: 4 })
    const expanded = buildCommandActivityExpandedLines({ events: [...events], width: 160, limit: 10 })

    expect(compact.join("\n")).toContain("Param Incorrect ×12")
    expect(expanded.join("\n")).toContain("Param Incorrect ×12")
    expect(compact.join("\n").match(/Param Incorrect/g)?.length).toBe(1)
    expect(expanded.join("\n").match(/Param Incorrect/g)?.length).toBe(1)
  })

  test("summarizes live Read/Glob tool parts without command evidence", () => {
    const summary = buildToolActivitySummary({
      parts: [
        { type: "tool", tool: "read", state: { status: "completed" } },
        { type: "tool", tool: "glob", state: { status: "completed" } },
        { type: "tool", tool: "grep", state: { status: "completed" } },
        { type: "tool", tool: "write", state: { status: "completed" } },
        { type: "tool", tool: "bash", state: { status: "error" } },
        { type: "tool", tool: "mcp.playwright", state: { status: "running" } },
      ],
      evidenceRef: "session:test",
    })

    expect(summary.readonly_tools).toBe(3)
    expect(summary.writes).toBe(1)
    expect(summary.commands).toBe(1)
    expect(summary.mcp).toBe(1)
    expect(summary.running).toBe(1)
    expect(summary.failed).toBe(1)

    const compact = buildCommandActivityMiniLines({ events: [], toolSummary: summary, width: 120 })
    const expanded = buildCommandActivityExpandedLines({ events: [], toolSummary: summary, width: 160 })
    expect(compact[0]).toContain("只读工具 3 次｜写入 1｜MCP 1｜命令 1")
    expect(expanded[0]).toContain("证据=session:test")
  })
})
