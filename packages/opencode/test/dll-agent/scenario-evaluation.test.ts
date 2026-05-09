import { describe, expect, test } from "bun:test"
import {
  REAL_WORLD_SCENARIOS,
  evaluateRealWorldScenarioSuite,
  renderScenarioSuiteReport,
} from "../../src/dll-agent/scenario-evaluation"

describe("Phase 10 real-world scenario evaluation", () => {
  test("defines exactly the required 20 acceptance scenarios", () => {
    expect(REAL_WORLD_SCENARIOS).toHaveLength(20)
    expect(new Set(REAL_WORLD_SCENARIOS.map((scenario) => scenario.id)).size).toBe(20)

    for (const scenario of REAL_WORLD_SCENARIOS) {
      expect(scenario.goal.length).toBeGreaterThan(10)
      expect(scenario.models_used.length).toBeGreaterThan(0)
      expect(scenario.evidence_required.length).toBeGreaterThan(0)
      expect(scenario.required_capabilities.length).toBeGreaterThan(0)
      expect(scenario.acceptance_refs.length).toBeGreaterThan(0)
      expect(["low", "medium", "high"]).toContain(scenario.risk)
    }
  })

  test("ordinary short code task uses only commander and does not trigger reviewer", () => {
    const scenario = REAL_WORLD_SCENARIOS.find((item) => item.id === "S01_SHORT_CODE_TASK")
    expect(scenario).toBeDefined()
    expect(scenario?.models_used).toEqual(["commander"])
    expect(scenario?.expected_route.reviewers).toEqual([])
    expect(scenario?.human_intervention_required).toBe(false)
  })

  test("correctness-required scenarios cannot be skipped for cost reasons", () => {
    const byID = Object.fromEntries(REAL_WORLD_SCENARIOS.map((scenario) => [scenario.id, scenario]))

    expect(byID.S02_USER_CORRECTION.expected_route.reviewers).toContain("requirements-inspector")
    expect(byID.S05_REPEATED_FAILURE.expected_route.reviewers).toContain("chief-engineer")
    expect(byID.S06_FINAL_CLAIM_MISSING_EVIDENCE.final_status).toBe("CONTINUATION_REQUIRED")
    expect(byID.S10_PROVIDER_ROUTING_HIGH_RISK.expected_route.reviewers.length).toBeGreaterThan(1)
    expect(byID.S20_REVIEWER_CONFLICT.expected_route.reviewers).toContain("role-cross")
  })

  test("permission and external dependency scenarios stop only when user input is required", () => {
    const blocked = REAL_WORLD_SCENARIOS.filter((scenario) => scenario.human_intervention_required)
    expect(blocked.map((scenario) => scenario.id).sort()).toEqual([
      "S11_SECRET_PERMISSION",
      "S19_USER_INTERVENTION_REQUIRED",
    ])
    expect(blocked.every((scenario) => scenario.final_status === "BLOCKED_USER_REQUIRED")).toBe(true)
  })

  test("multimodal and MiMo fallback routes are separated", () => {
    const multimodal = REAL_WORLD_SCENARIOS.find((scenario) => scenario.id === "S12_MULTIMODAL_INPUT")
    const fallback = REAL_WORLD_SCENARIOS.find((scenario) => scenario.id === "S13_MIMO_EXPIRED_FALLBACK")

    expect(multimodal?.models_used).toContain("multimodal-context-interpreter")
    expect(fallback?.models_used).not.toContain("multimodal-context-interpreter")
    expect(fallback?.models_used).toEqual(["commander"])
  })

  test("suite passes with current runtime-verified capabilities and has no false PASS risk", () => {
    const report = evaluateRealWorldScenarioSuite()

    expect(report.total).toBe(20)
    expect(report.pass).toBe(20)
    expect(report.fail).toBe(0)
    expect(report.false_pass_risk).toBe(0)
    expect(report.unnecessary_reviewer_scenarios).toBe(0)
    expect(report.human_intervention_scenarios).toBe(2)
  })

  test("suite fails if a required runtime capability regresses to prompt-only", () => {
    const report = evaluateRealWorldScenarioSuite({
      evidence_gate: "prompt_only",
    })

    expect(report.fail).toBeGreaterThan(0)
    expect(report.scenarios.some((scenario) => scenario.errors.includes("evidence_gate is prompt_only"))).toBe(true)
  })

  test("rendered report is bounded and includes route, status, and evidence", () => {
    const text = renderScenarioSuiteReport()

    expect(text).toContain("dll-agent real-world scenario evaluation")
    expect(text).toContain("S01_SHORT_CODE_TASK")
    expect(text).toContain("S20_REVIEWER_CONFLICT")
    expect(text).toContain("false_pass_risk=0")
    expect(text.length).toBeLessThan(7000)
  })
})
