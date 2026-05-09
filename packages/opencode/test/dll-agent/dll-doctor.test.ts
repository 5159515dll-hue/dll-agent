/**
 * dll-doctor tests
 */
import { describe, it, expect } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { runDoctor, formatDoctorReport } from "../../src/dll-agent/dll-doctor"

function sessionCount() {
  const dir = path.join(os.homedir(), ".dll-agent", "sessions")
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isDirectory() && !name.startsWith(".")
    } catch {
      return false
    }
  }).length
}

describe("dll-doctor", () => {
  it("runDoctor produces a report with all check categories", () => {
    const report = runDoctor(process.cwd())
    expect(report.timestamp).toBeTruthy()
    expect(report.passCount).toBeGreaterThanOrEqual(0)
    expect(report.warnCount).toBeGreaterThanOrEqual(0)
    expect(report.failCount).toBeGreaterThanOrEqual(0)
    expect(report.checks.length).toBeGreaterThan(5)
  }, 15_000)

  it("formatDoctorReport produces readable output", () => {
    const report = runDoctor()
    const formatted = formatDoctorReport(report)
    expect(formatted).toContain("dll-agent doctor")
    expect(formatted.length).toBeGreaterThan(100)
  })

  it("permission check is included", () => {
    const report = runDoctor()
    const permCheck = report.checks.find((c) => c.name === "permission-classifier")
    expect(permCheck).toBeDefined()
  })

  it("permission mode check is included", () => {
    const report = runDoctor()
    const modeCheck = report.checks.find((c) => c.name === "permission-mode")
    expect(modeCheck).toBeDefined()
    expect(modeCheck?.message).toContain("Permission mode")
  })

  it("LSP project-main prewarm checks are included", () => {
    const report = runDoctor(process.cwd())
    const mode = report.checks.find((c) => c.name === "lsp-mode")
    const targets = report.checks.find((c) => c.name === "lsp-prewarm-targets")
    expect(mode).toBeDefined()
    expect(mode?.message).toContain("project-main")
    expect(targets).toBeDefined()
    expect(targets?.severity).toBe("PASS")
  }, 15_000)

  it("evidence gate check is included", () => {
    const report = runDoctor()
    const gateCheck = report.checks.find((c) => c.name === "evidence-gate")
    expect(gateCheck).toBeDefined()
    if (gateCheck) expect(gateCheck.severity).toBe("PASS")
  })

  it("reconciliation gate check is included", () => {
    const report = runDoctor()
    const reconCheck = report.checks.find((c) => c.name === "reconciliation-gate")
    expect(reconCheck).toBeDefined()
  })

  it("final gate check is included", () => {
    const report = runDoctor()
    const finalCheck = report.checks.find((c) => c.name === "final-gate")
    expect(finalCheck).toBeDefined()
    // final gate uses blocked evidence gate → FAIL is correct here
    if (finalCheck) expect(["PASS", "FAIL"]).toContain(finalCheck.severity)
  })

  it("artifact ledger check is included", () => {
    const report = runDoctor()
    const artifactCheck = report.checks.find((c) => c.name === "artifact-ledger")
    expect(artifactCheck).toBeDefined()
  })

  it("task observability check is included", () => {
    const report = runDoctor(process.cwd())
    const observability = report.checks.find((c) => c.name === "task-observability")
    expect(observability).toBeDefined()
    expect(observability?.severity).toBe("PASS")
  }, 15_000)

  it("real-world scenario evaluation check is included", () => {
    const report = runDoctor(process.cwd())
    const scenario = report.checks.find((c) => c.name === "real-world-scenario-evaluation")
    expect(scenario).toBeDefined()
    expect(scenario?.severity).toBe("PASS")
    expect(scenario?.message).toContain("20")
  }, 15_000)

  it("capability manifest doctor checks are included and do not leak secrets", () => {
    const report = runDoctor(process.cwd())
    const manifest = report.checks.find((c) => c.name === "capability-effective-manifest")
    const heavyMcp = report.checks.find((c) => c.name === "capability-heavy-mcp-on-demand")
    const runtimeState = report.checks.find((c) => c.name === "mcp-runtime-state")
    const runtimeMutex = report.checks.find((c) => c.name === "mcp-runtime-mutex")
    const promptIndex = report.checks.find((c) => c.name === "capability-prompt-index")
    expect(manifest).toBeDefined()
    expect(heavyMcp).toBeDefined()
    expect(runtimeState).toBeDefined()
    expect(runtimeMutex).toBeDefined()
    expect(promptIndex).toBeDefined()
    const text = JSON.stringify(report.checks)
    expect(text).toContain("GITHUB_TOKEN")
    expect(text).not.toContain("ghp_")
    expect(text).not.toContain("API_KEY=")
  }, 15_000)

  it("wrapper repair-safe dry-run reports cleanup candidates without deleting sessions or touching secrets", () => {
    const bin = path.join(os.homedir(), ".local", "bin", "dll-agent")
    if (!fs.existsSync(bin)) return
    const secrets = path.join(os.homedir(), ".dll-agent", "secrets.env")
    const beforeCount = sessionCount()
    const beforeSecretMtime = fs.existsSync(secrets) ? fs.statSync(secrets).mtimeMs : null
    const result = spawnSync(bin, ["doctor", "--repair-safe", "--dry-run"], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        DLL_AGENT_MCP_CLEANUP_AUTO: "0",
      },
    })
    expect(result.status).toBe(0)
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain("doctor --repair-safe --dry-run")
    expect(output).toContain("dry_run: true")
    expect(output).toContain("no files deleted")
    expect(output).toContain("no processes killed")
    expect(sessionCount()).toBe(beforeCount)
    const afterSecretMtime = fs.existsSync(secrets) ? fs.statSync(secrets).mtimeMs : null
    expect(afterSecretMtime).toBe(beforeSecretMtime)
  }, 20_000)
})
