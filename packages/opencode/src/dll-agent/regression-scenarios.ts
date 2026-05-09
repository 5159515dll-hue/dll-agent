import { redact } from "./evidence"
import { REAL_WORLD_SCENARIOS } from "./scenario-evaluation"

export type RegressionScenarioStatus = "not_run" | "passed" | "failed" | "partial" | "blocked"

export interface RegressionScenarioState {
  scenario_id: string
  name: string
  purpose: string
  expected_route: string[]
  required_evidence: string[]
  status: RegressionScenarioStatus
  last_run: string | null
  next_action: string
  risk: "low" | "medium" | "high"
  redaction_status: "redacted"
}

export interface RegressionScenarioReport {
  generated_at: string
  total: number
  by_status: Record<RegressionScenarioStatus, number>
  scenarios: RegressionScenarioState[]
  redaction_status: "redacted"
}

function routeSummary(scenario: (typeof REAL_WORLD_SCENARIOS)[number]) {
  return [
    scenario.expected_route.commander ? "commander" : "",
    ...scenario.expected_route.reviewers,
    ...scenario.expected_route.gates,
    ...scenario.expected_route.dispatch,
  ].filter(Boolean)
}

export function buildRegressionScenarioReport(): RegressionScenarioReport {
  const scenarios = REAL_WORLD_SCENARIOS.map((scenario) => ({
    scenario_id: scenario.id,
    name: scenario.name,
    purpose: scenario.goal,
    expected_route: routeSummary(scenario),
    required_evidence: scenario.evidence_required,
    status: "not_run" as const,
    last_run: null,
    next_action: "Run this scenario through the regression scenario harness before marking passed.",
    risk: scenario.risk,
    redaction_status: "redacted" as const,
  }))
  return redact({
    generated_at: new Date().toISOString(),
    total: scenarios.length,
    by_status: {
      not_run: scenarios.length,
      passed: 0,
      failed: 0,
      partial: 0,
      blocked: 0,
    },
    scenarios,
    redaction_status: "redacted",
  } satisfies RegressionScenarioReport) as RegressionScenarioReport
}

export function renderRegressionScenarioStatus(maxChars = 5_000) {
  const report = buildRegressionScenarioReport()
  const lines = [
    "dll-agent regression status",
    `total: ${report.total}`,
    `status: not_run=${report.by_status.not_run} passed=${report.by_status.passed} failed=${report.by_status.failed} partial=${report.by_status.partial} blocked=${report.by_status.blocked}`,
    "",
    ...report.scenarios.map((scenario) =>
      `- ${scenario.scenario_id} ${scenario.status} risk=${scenario.risk}: ${scenario.name} | next=${scenario.next_action}`
    ),
  ]
  return lines.join("\n").slice(0, maxChars)
}

export function buildRegressionStatusLine(width = 160) {
  const report = buildRegressionScenarioReport()
  return `regression scenarios:${report.total} not_run:${report.by_status.not_run} passed:${report.by_status.passed}`.slice(0, width)
}

export * as RegressionScenarios from "./regression-scenarios"
