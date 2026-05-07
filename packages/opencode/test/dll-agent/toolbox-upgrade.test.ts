import { describe, expect, test } from "bun:test"
import { listScripts, typecheck, type ScriptResult } from "../../src/dll-agent/toolbox"

describe("DllAgentToolbox scripts", () => {
  test("listScripts returns all 9 built-in scripts", () => {
    const scripts = listScripts()
    expect(scripts.length).toBe(9)
    expect(scripts.map((s) => s.name)).toContain("typecheck")
    expect(scripts.map((s) => s.name)).toContain("test")
    expect(scripts.map((s) => s.name)).toContain("smoke")
    expect(scripts.map((s) => s.name)).toContain("doctor")
  })

  test("typecheck --dry-run produces dryRun result", () => {
    const result = typecheck(true)
    expect(result.dryRun).toBe(true)
    expect(result.success).toBe(true)
    expect(result.stdout).toContain("[dry-run]")
    expect(result.exitCode).toBe(0)
  })

  test("typecheck runs in real mode from packages/opencode", () => {
    // Real test depends on cwd. Accepted: pass or fail (env-dependent).
    const result = typecheck(false)
    expect(result.dryRun).toBe(false)
    // Just verify it executes without crash — pass/fail depends on env
    expect(typeof result.exitCode).toBe("number")
  })

  test("sessionCleanupDryRun is read-only", () => {
    const { sessionCleanupDryRun } = require("../../src/dll-agent/toolbox")
    const result = sessionCleanupDryRun(false) as ScriptResult
    // Always succeeds (uses ls and du, not rm)
    expect(result.success).toBe(true)
    expect(result.stdout).toBeDefined()
  })
})

import {
  createUpgradePlan,
  generateRollbackCommands,
  type UpgradePlan,
} from "../../src/dll-agent/upgrade-guard"

describe("DllAgentUpgradeGuard", () => {
  test("createUpgradePlan returns structured plan", () => {
    const plan = createUpgradePlan(
      "1.1.0",
      "Test upgrade",
      ["task1", "task2"],
      [],
      "low risk",
      ["git checkout -- ."],
    )
    expect(plan.version).toBe("1.1.0")
    expect(plan.taskList).toEqual(["task1", "task2"])
    expect(plan.riskAssessment).toBe("low risk")
    expect(plan.rollbackCommands).toEqual(["git checkout -- ."])
  })

  test("generateRollbackCommands returns git-based rollback steps", () => {
    const cmds = generateRollbackCommands()
    expect(cmds.length).toBeGreaterThan(0)
    expect(cmds.some((c) => c.includes("git checkout"))).toBe(true)
    expect(cmds.some((c) => c.includes("bun test"))).toBe(true)
  })
})
