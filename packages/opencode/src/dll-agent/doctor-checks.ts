import { buildDoctorNextActionReport } from "./doctor-next-action"
import type { DoctorCheck, DoctorSeverity } from "./dll-doctor"
import { buildModelUsageReport } from "./model-usage-report"
import { buildRegressionScenarioReport } from "./regression-scenarios"
import { evaluateRealWorldScenarioSuite } from "./scenario-evaluation"
import { buildTaskObservabilityReport } from "./task-observability"
import { buildTaskTrajectory } from "./task-trajectory"

export function checkObservabilityHealth(projectRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  try {
    const report = buildTaskObservabilityReport({
      sessionID: "doctor-observability-smoke",
      projectDir: projectRoot,
      maxEvents: 2,
    })
    checks.push({
      name: "task-observability",
      severity: "PASS",
      message: `Task status/trajectory renderer is available (evidence sessions=${report.cleanup.evidence_sessions})`,
      nextAction: report.cleanup.repair_safe_recommended ? report.cleanup.recommendation : null,
      evidence: `routing_decisions=${report.routing.decisions}, evidence_events=${report.evidence.total}`,
    })
    const trajectory = buildTaskTrajectory({
      sessionID: "doctor-observability-smoke",
      maxEvents: 2,
    })
    const usage = buildModelUsageReport({
      sessionID: "doctor-observability-smoke",
      maxItems: 2,
    })
    const scenarios = buildRegressionScenarioReport()
    const nextActions = buildDoctorNextActionReport({
      timestamp: new Date().toISOString(),
      overall: "WARN",
      checks: [{
        name: "runtime-config-api-key-memory",
        severity: "WARN",
        message: "rendered runtime config contains API keys in memory; this is expected at launch and is not written to disk",
        nextAction: null,
        evidence: null,
      }],
      passCount: 0,
      warnCount: 1,
      failCount: 0,
    })
    checks.push({
      name: "observability-read-models",
      severity: scenarios.total === 20 && nextActions.no_action_needed === 1 ? "PASS" : "FAIL",
      message: `Observability readers available: trajectory=${trajectory.length}, routing=${usage.total_decisions}, regression=${scenarios.total}, doctor_next=${nextActions.actions.length}`,
      nextAction: scenarios.total === 20 ? null : "Inspect regression-scenarios.ts and scenario-evaluation.ts",
      evidence: `trajectory=${trajectory.length}, routing=${usage.total_decisions}, regression=${scenarios.total}, doctor_next=${nextActions.actions.length}`,
    })
  } catch (error) {
    checks.push({
      name: "task-observability",
      severity: "FAIL",
      message: "Task status/trajectory renderer failed",
      nextAction: "Inspect task-observability.ts and /task-status command wiring",
      evidence: String(error),
    })
  }
  return checks
}

export function checkScenarioEvaluationHealth(): DoctorCheck[] {
  try {
    const report = evaluateRealWorldScenarioSuite()
    const severity: DoctorSeverity = report.fail > 0 || report.false_pass_risk > 0 ? "FAIL" : "PASS"
    return [{
      name: "real-world-scenario-evaluation",
      severity,
      message: severity === "PASS"
        ? `Phase 10 deterministic/local scenario checks pass (${report.deterministic_pass}/${report.total}); live_not_run=${report.live_not_run_scenarios}; false_pass_risk=${report.false_pass_risk}`
        : `Phase 10 deterministic/local scenario gaps detected (${report.deterministic_fail}/${report.total} failed, false_pass_risk=${report.false_pass_risk})`,
      nextAction: severity === "PASS" ? null : "Run scenario-evaluation tests and inspect failed acceptance refs",
      evidence: `human_intervention=${report.human_intervention_scenarios}, unnecessary_reviewer=${report.unnecessary_reviewer_scenarios}, manual_not_run=${report.manual_not_run_scenarios}, live_not_run=${report.live_not_run_scenarios}`,
    }]
  } catch (error) {
    return [{
      name: "real-world-scenario-evaluation",
      severity: "FAIL",
      message: "Phase 10 real-world scenario evaluator failed",
      nextAction: "Inspect scenario-evaluation.ts",
      evidence: String(error),
    }]
  }
}

export * as DoctorChecks from "./doctor-checks"
