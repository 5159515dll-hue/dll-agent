import { describe, expect, test } from "bun:test"
import { buildDoctorNextActionReport, renderDoctorNextActions } from "../../src/dll-agent/doctor-next-action"
import type { DoctorReport } from "../../src/dll-agent/dll-doctor"

function report(checks: DoctorReport["checks"]): DoctorReport {
  return {
    timestamp: new Date().toISOString(),
    overall: checks.some((check) => check.severity === "FAIL") ? "FAIL" : checks.some((check) => check.severity === "WARN") ? "WARN" : "PASS",
    checks,
    passCount: checks.filter((check) => check.severity === "PASS").length,
    warnCount: checks.filter((check) => check.severity === "WARN").length,
    failCount: checks.filter((check) => check.severity === "FAIL").length,
  }
}

describe("doctor-next-action", () => {
  test("runtime API key memory warn is informational", () => {
    const next = buildDoctorNextActionReport(report([{
      name: "runtime-config-api-key-memory",
      severity: "WARN",
      message: "rendered runtime config contains API keys in memory; this is expected at launch and is not written to disk",
      nextAction: null,
      evidence: null,
    }]))
    expect(next.actions[0]?.severity).toBe("no_action_needed")
  })

  test("evidence sessions warn suggests dry-run", () => {
    const next = buildDoctorNextActionReport(report([{
      name: "evidence-session-count",
      severity: "WARN",
      message: "110 session directories (max 100) — nearing limit",
      nextAction: "Run: dll-agent doctor --repair-safe",
      evidence: null,
    }]))
    expect(next.actions[0]?.severity).toBe("user_optional")
    expect(next.actions[0]?.command).toContain("--dry-run")
  })

  test("quota stale suggests quota refresh", () => {
    const next = buildDoctorNextActionReport(report([{
      name: "quota-refresh",
      severity: "WARN",
      message: "Quota status stale",
      nextAction: "Run: /Users/dailulu/.local/bin/dll-agent-quota",
      evidence: null,
    }]))
    expect(next.actions[0]?.command).toContain("dll-agent-quota")
  })

  test("process cleanup requires user authorization", () => {
    const next = buildDoctorNextActionReport(report([{
      name: "background-processes",
      severity: "WARN",
      message: "High-CPU bun/opencode process detected",
      nextAction: "Inspect process manually",
      evidence: null,
    }]))
    expect(next.actions[0]?.severity).toBe("user_authorization_required")
  })

  test("doctor failed check is blocking and output is redacted", () => {
    const next = buildDoctorNextActionReport(report([{
      name: "provider-key",
      severity: "FAIL",
      message: "provider key token=secret-value is invalid",
      nextAction: "Set provider key",
      evidence: null,
    }]))
    expect(next.blocking).toBe(1)
    expect(JSON.stringify(next)).not.toContain("secret-value")
    expect(renderDoctorNextActions(report([]))).toContain("dll-agent doctor next action")
  })
})
