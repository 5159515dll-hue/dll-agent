import { describe, expect, test } from "bun:test"
import {
  buildRegressionScenarioReport,
  buildRegressionStatusLine,
  renderRegressionScenarioStatus,
} from "../../src/dll-agent/regression-scenarios"

describe("regression-scenarios", () => {
  test("registry exposes 20 not-run scenarios without pretending pass", () => {
    const report = buildRegressionScenarioReport()
    expect(report.total).toBe(20)
    expect(report.by_status.not_run).toBe(20)
    expect(report.by_status.passed).toBe(0)
    expect(report.scenarios.every((scenario) => scenario.status === "not_run")).toBe(true)
  })

  test("rendered status is bounded and explicit", () => {
    const text = renderRegressionScenarioStatus(2_000)
    expect(text).toContain("dll-agent regression status")
    expect(text).toContain("not_run=20")
    expect(text).not.toContain("passed=20")
    expect(text.length).toBeLessThanOrEqual(2_000)
  })

  test("status line is compact", () => {
    const line = buildRegressionStatusLine(80)
    expect(line).toContain("scenarios:20")
    expect(line.length).toBeLessThanOrEqual(80)
  })
})
