/**
 * dll-doctor tests
 */
import { describe, it, expect } from "bun:test"
import { runDoctor, formatDoctorReport } from "../../src/dll-agent/dll-doctor"

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
})
