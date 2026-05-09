/**
 * Phase 10 real-world scenario evaluation.
 *
 * This module is a deterministic regression dashboard over dll-agent's existing
 * runtime guarantees. It does not execute model calls or mutate session state.
 */

export type ScenarioFinalStatus =
  | "VERIFIED_COMPLETE"
  | "CONTINUATION_REQUIRED"
  | "BLOCKED_USER_REQUIRED"
  | "BLOCKED_BUDGET_EXHAUSTED"
  | "UNVERIFIED_PARTIAL"
  | "FAILED"

export type ScenarioRisk = "low" | "medium" | "high"
export type ScenarioResultStatus = "pass" | "fail"
export type ScenarioCostTier = "none" | "low" | "medium" | "high"
export type ScenarioEvaluationLayer = "deterministic" | "local_smoke" | "manual" | "live_required"
export type ScenarioExternalStatus = "not_run" | "manual_not_run" | "live_not_run"

export type RuntimeCapabilityStatus =
  | "implemented_runtime_verified"
  | "implemented_runtime_unverified"
  | "partial_runtime"
  | "pure_function_only"
  | "prompt_only"
  | "config_only"
  | "docs_only"
  | "missing"
  | "broken"
  | "blocked_by_external"

export type RuntimeCapabilityId =
  | "goal_contract"
  | "continuation_gate"
  | "evidence_gate"
  | "final_gate"
  | "recovery_loop"
  | "result_ledger"
  | "dedup_gate"
  | "stale_detection"
  | "correctness_routing"
  | "routing_evidence"
  | "requirements_inspector"
  | "chief_engineer"
  | "task_completion_archivist"
  | "final_auditor"
  | "role_cross"
  | "role_model_registry"
  | "provider_bridge"
  | "permission_policy"
  | "role_tool_policy"
  | "skill_registry"
  | "mcp_lifecycle"
  | "multimodal_context"
  | "mimo_status"
  | "doctor_strictness"
  | "task_observability"

export interface RealWorldScenario {
  id: string
  name: string
  goal: string
  risk: ScenarioRisk
  expected_route: {
    commander: boolean
    reviewers: string[]
    gates: string[]
    dispatch: string[]
  }
  models_used: string[]
  evidence_required: string[]
  final_status: ScenarioFinalStatus
  human_intervention_required: boolean
  cost_tier: ScenarioCostTier
  token_tier: ScenarioCostTier
  evaluation_layer: ScenarioEvaluationLayer
  required_capabilities: RuntimeCapabilityId[]
  acceptance_refs: string[]
}

export interface ScenarioEvaluation {
  scenario_id: string
  name: string
  goal: string
  expected_route: RealWorldScenario["expected_route"]
  models_used: string[]
  evidence: string[]
  final_status: ScenarioFinalStatus
  human_intervention_needed: boolean
  cost_tier: ScenarioCostTier
  token_tier: ScenarioCostTier
  evaluation_layer: ScenarioEvaluationLayer
  deterministic_status: ScenarioResultStatus
  external_status: ScenarioExternalStatus
  status: ScenarioResultStatus
  errors: string[]
}

export interface ScenarioSuiteReport {
  generated_at: string
  total: number
  pass: number
  fail: number
  deterministic_pass: number
  deterministic_fail: number
  false_pass_risk: number
  human_intervention_scenarios: number
  unnecessary_reviewer_scenarios: number
  not_run_scenarios: number
  manual_not_run_scenarios: number
  live_not_run_scenarios: number
  scenarios: ScenarioEvaluation[]
}

export const CURRENT_RUNTIME_CAPABILITIES: Record<RuntimeCapabilityId, RuntimeCapabilityStatus> = {
  goal_contract: "implemented_runtime_verified",
  continuation_gate: "implemented_runtime_verified",
  evidence_gate: "implemented_runtime_verified",
  final_gate: "implemented_runtime_verified",
  recovery_loop: "implemented_runtime_verified",
  result_ledger: "implemented_runtime_verified",
  dedup_gate: "implemented_runtime_verified",
  stale_detection: "implemented_runtime_verified",
  correctness_routing: "implemented_runtime_verified",
  routing_evidence: "implemented_runtime_verified",
  requirements_inspector: "implemented_runtime_verified",
  chief_engineer: "implemented_runtime_verified",
  task_completion_archivist: "implemented_runtime_verified",
  final_auditor: "implemented_runtime_verified",
  role_cross: "implemented_runtime_verified",
  role_model_registry: "implemented_runtime_verified",
  provider_bridge: "implemented_runtime_verified",
  permission_policy: "implemented_runtime_verified",
  role_tool_policy: "implemented_runtime_verified",
  skill_registry: "implemented_runtime_verified",
  mcp_lifecycle: "implemented_runtime_verified",
  multimodal_context: "implemented_runtime_verified",
  mimo_status: "implemented_runtime_verified",
  doctor_strictness: "implemented_runtime_verified",
  task_observability: "implemented_runtime_verified",
}

const baseRefs = [
  "bun run --cwd packages/opencode typecheck",
  "bun test --cwd packages/opencode test/dll-agent/",
  "dll-agent doctor",
]

export const REAL_WORLD_SCENARIOS: RealWorldScenario[] = [
  {
    id: "S01_SHORT_CODE_TASK",
    name: "ordinary short code task",
    goal: "Make a small project-local code fix and verify it.",
    risk: "low",
    expected_route: { commander: true, reviewers: [], gates: ["evidence_gate", "final_gate"], dispatch: [] },
    models_used: ["commander"],
    evidence_required: ["tool.verification", "result.verified"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "local_smoke",
    required_capabilities: ["goal_contract", "evidence_gate", "final_gate", "result_ledger", "correctness_routing"],
    acceptance_refs: ["supervisor.test.ts: defaultCommander", "result-ledger.test.ts", ...baseRefs],
  },
  {
    id: "S02_USER_CORRECTION",
    name: "user correction",
    goal: "User says the implementation is off track and asks to realign.",
    risk: "medium",
    expected_route: { commander: true, reviewers: ["requirements-inspector"], gates: ["reconciliation_gate", "final_gate"], dispatch: ["requirements-inspector"] },
    models_used: ["commander", "requirements-inspector"],
    evidence_required: ["model.routing_decision", "reviewer.requirements", "reconciliation"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["requirements_inspector", "correctness_routing", "routing_evidence", "continuation_gate"],
    acceptance_refs: ["supervisor.test.ts: user correction triggers requirements-inspector", ...baseRefs],
  },
  {
    id: "S03_TEST_FAILURE",
    name: "test failure recovery",
    goal: "A test command fails after a code change.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["recovery_loop", "evidence_gate"], dispatch: ["commander"] },
    models_used: ["commander"],
    evidence_required: ["recovery.decision", "tool.failure", "tool.verification"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["recovery_loop", "evidence_gate", "final_gate"],
    acceptance_refs: ["recovery-loop.test.ts: test failure gets automatic repair action", ...baseRefs],
  },
  {
    id: "S04_TYPECHECK_FAILURE",
    name: "typecheck failure recovery",
    goal: "Typecheck fails after a patch.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["recovery_loop", "evidence_gate"], dispatch: ["commander"] },
    models_used: ["commander"],
    evidence_required: ["recovery.decision", "tool.failure", "tool.verification"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["recovery_loop", "evidence_gate", "final_gate"],
    acceptance_refs: ["recovery-loop.test.ts: typecheck failure gets automatic repair action", ...baseRefs],
  },
  {
    id: "S05_REPEATED_FAILURE",
    name: "repeated failure escalation",
    goal: "The same failure fingerprint repeats across repair attempts.",
    risk: "high",
    expected_route: { commander: true, reviewers: ["chief-engineer", "role-cross"], gates: ["recovery_loop", "reconciliation_gate"], dispatch: ["chief-engineer", "role-cross"] },
    models_used: ["commander", "chief-engineer", "role-cross"],
    evidence_required: ["recovery.decision", "model.routing_decision", "reviewer.result"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["recovery_loop", "chief_engineer", "role_cross", "correctness_routing"],
    acceptance_refs: ["recovery-loop.test.ts: repeated failure escalation", ...baseRefs],
  },
  {
    id: "S06_FINAL_CLAIM_MISSING_EVIDENCE",
    name: "final claim without evidence",
    goal: "Assistant claims completion without real verification output.",
    risk: "high",
    expected_route: { commander: true, reviewers: ["final-auditor"], gates: ["evidence_gate", "final_gate"], dispatch: ["final-auditor"] },
    models_used: ["commander", "final-auditor"],
    evidence_required: ["gate.blocked_completion", "model.routing_decision"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["evidence_gate", "final_gate", "final_auditor", "routing_evidence"],
    acceptance_refs: ["gates.test.ts: high risk completion w/o evidence", ...baseRefs],
  },
  {
    id: "S07_UNFINISHED_PLAN",
    name: "unfinished active plan",
    goal: "Final report is attempted while active plan items remain pending.",
    risk: "medium",
    expected_route: { commander: true, reviewers: ["task-completion-archivist"], gates: ["continuation_gate"], dispatch: ["commander"] },
    models_used: ["commander", "task-completion-archivist"],
    evidence_required: ["continuation_gate.blocked", "continuation.packet"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["goal_contract", "continuation_gate", "task_completion_archivist"],
    acceptance_refs: ["continuation-gate.test.ts: active plan unfinished", ...baseRefs],
  },
  {
    id: "S08_RESULT_REUSE",
    name: "verified result reuse",
    goal: "A later model can reuse a verified Result Ledger packet.",
    risk: "low",
    expected_route: { commander: true, reviewers: [], gates: ["dedup_gate", "result_sufficiency_gate"], dispatch: ["reuse_existing"] },
    models_used: ["commander"],
    evidence_required: ["result.verified", "dedup.reuse"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "none",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["result_ledger", "dedup_gate", "stale_detection"],
    acceptance_refs: ["result-ledger.test.ts: subsequent model can reuse verified result", ...baseRefs],
  },
  {
    id: "S09_STALE_RESULT",
    name: "stale result revalidation",
    goal: "A previous result becomes stale after file hashes change.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["dedup_gate", "result_sufficiency_gate"], dispatch: ["revalidate_or_redo"] },
    models_used: ["commander"],
    evidence_required: ["result.stale_detected", "tool.verification"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["result_ledger", "dedup_gate", "stale_detection"],
    acceptance_refs: ["result-ledger.test.ts: stale result is NOT returned in reusable_only queries", ...baseRefs],
  },
  {
    id: "S10_PROVIDER_ROUTING_HIGH_RISK",
    name: "high-risk provider routing change",
    goal: "Modify provider routing or reasoning normalization.",
    risk: "high",
    expected_route: { commander: true, reviewers: ["requirements-inspector", "final-auditor"], gates: ["evidence_gate", "reconciliation_gate", "final_gate"], dispatch: ["requirements-inspector", "final-auditor"] },
    models_used: ["commander", "requirements-inspector", "final-auditor"],
    evidence_required: ["model.routing_decision", "tool.verification", "doctor.run"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["provider_bridge", "correctness_routing", "routing_evidence", "final_auditor"],
    acceptance_refs: ["role-model-registry.test.ts", "supervisor.test.ts: high-risk repeated failure can route more than one reviewer", ...baseRefs],
  },
  {
    id: "S11_SECRET_PERMISSION",
    name: "secret or permission boundary",
    goal: "A task requires reading .env or SSH credentials.",
    risk: "high",
    expected_route: { commander: true, reviewers: [], gates: ["permission_policy"], dispatch: ["user_decision"] },
    models_used: ["commander"],
    evidence_required: ["permission.decision", "recovery.blocked"],
    final_status: "BLOCKED_USER_REQUIRED",
    human_intervention_required: true,
    cost_tier: "none",
    token_tier: "low",
    evaluation_layer: "manual",
    required_capabilities: ["permission_policy", "role_tool_policy", "doctor_strictness"],
    acceptance_refs: ["permission-classifier.test.ts", "role-tool-policy.test.ts", ...baseRefs],
  },
  {
    id: "S12_MULTIMODAL_INPUT",
    name: "MiMo multimodal input",
    goal: "A screenshot or image must be interpreted before code work.",
    risk: "medium",
    expected_route: { commander: true, reviewers: ["multimodal-context-interpreter"], gates: ["evidence_gate"], dispatch: ["multimodal-context-interpreter"] },
    models_used: ["commander", "multimodal-context-interpreter"],
    evidence_required: ["multimodal.context", "model.routing_decision"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "live_required",
    required_capabilities: ["multimodal_context", "mimo_status", "correctness_routing"],
    acceptance_refs: ["multimodal-context.test.ts", "supervisor.test.ts: MiMo multimodal reviewer does not enter pure text/code tasks", ...baseRefs],
  },
  {
    id: "S13_MIMO_EXPIRED_FALLBACK",
    name: "MiMo expired fallback",
    goal: "MiMo status is expired but a pure text task should continue.",
    risk: "low",
    expected_route: { commander: true, reviewers: [], gates: ["provider_status"], dispatch: ["provider_fallback"] },
    models_used: ["commander"],
    evidence_required: ["provider.status", "quota.status"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "local_smoke",
    required_capabilities: ["mimo_status", "provider_bridge", "role_model_registry"],
    acceptance_refs: ["role-model-registry.test.ts", "tools.test.ts", ...baseRefs],
  },
  {
    id: "S14_ROLE_MODEL_SET",
    name: "role model switching",
    goal: "User changes commander model with /role-model-set for global scope.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["provider_bridge"], dispatch: ["effective_role_model"] },
    models_used: ["commander"],
    evidence_required: ["role_model.changed", "provider.model_resolved"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "local_smoke",
    required_capabilities: ["role_model_registry", "provider_bridge", "routing_evidence"],
    acceptance_refs: ["role-model-registry.test.ts", ...baseRefs],
  },
  {
    id: "S15_DOCTOR_FAILED",
    name: "doctor failed blocks PASS",
    goal: "Doctor reports failed checks before final completion.",
    risk: "high",
    expected_route: { commander: true, reviewers: ["final-auditor"], gates: ["final_gate", "continuation_gate"], dispatch: ["commander"] },
    models_used: ["commander", "final-auditor"],
    evidence_required: ["doctor.run", "gate.blocked_completion"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "medium",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["doctor_strictness", "continuation_gate", "final_gate"],
    acceptance_refs: ["continuation-gate.test.ts: doctor failed", "dll-doctor.test.ts", ...baseRefs],
  },
  {
    id: "S16_DOCTOR_REPAIR_SAFE",
    name: "doctor repair safe",
    goal: "Safe cleanup is requested for stale sessions or residual runtime state.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["permission_policy"], dispatch: ["doctor_repair_safe"] },
    models_used: ["commander"],
    evidence_required: ["doctor.run", "repair_safe.plan"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "none",
    token_tier: "low",
    evaluation_layer: "local_smoke",
    required_capabilities: ["doctor_strictness", "permission_policy", "task_observability"],
    acceptance_refs: ["dll-doctor.test.ts", "evidence.test.ts: session cleanup", ...baseRefs],
  },
  {
    id: "S17_FINAL_REPORT_VERIFIED",
    name: "verified final report",
    goal: "Final report accurately distinguishes verified, partial, blocked, and unverified items.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["evidence_gate", "final_gate"], dispatch: ["result_packet"] },
    models_used: ["commander"],
    evidence_required: ["result.verified", "tool.verification", "final.status"],
    final_status: "VERIFIED_COMPLETE",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["result_ledger", "evidence_gate", "final_gate", "task_observability"],
    acceptance_refs: ["gates.test.ts", "task-observability.test.ts", ...baseRefs],
  },
  {
    id: "S18_NORMAL_NO_USER_INTERVENTION",
    name: "normal recoverable problem without user intervention",
    goal: "A normal path/import/config error is repaired automatically.",
    risk: "medium",
    expected_route: { commander: true, reviewers: [], gates: ["recovery_loop"], dispatch: ["commander"] },
    models_used: ["commander"],
    evidence_required: ["recovery.decision", "tool.verification"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "low",
    token_tier: "low",
    evaluation_layer: "deterministic",
    required_capabilities: ["recovery_loop", "evidence_gate"],
    acceptance_refs: ["recovery-loop.test.ts: normal error does not stop", ...baseRefs],
  },
  {
    id: "S19_USER_INTERVENTION_REQUIRED",
    name: "external user input required",
    goal: "A required token, login, captcha, release, or destructive action blocks automation.",
    risk: "high",
    expected_route: { commander: true, reviewers: [], gates: ["permission_policy"], dispatch: ["user_decision"] },
    models_used: ["commander"],
    evidence_required: ["recovery.blocked", "permission.decision"],
    final_status: "BLOCKED_USER_REQUIRED",
    human_intervention_required: true,
    cost_tier: "none",
    token_tier: "low",
    evaluation_layer: "manual",
    required_capabilities: ["permission_policy", "recovery_loop", "doctor_strictness"],
    acceptance_refs: ["recovery-loop.test.ts: permission denied requires user authorization", ...baseRefs],
  },
  {
    id: "S20_REVIEWER_CONFLICT",
    name: "multi-model reviewer conflict",
    goal: "Two reviewers disagree on whether completion is acceptable.",
    risk: "high",
    expected_route: { commander: true, reviewers: ["requirements-inspector", "final-auditor", "role-cross"], gates: ["reconciliation_gate", "final_gate"], dispatch: ["role-cross"] },
    models_used: ["commander", "requirements-inspector", "final-auditor", "role-cross"],
    evidence_required: ["reviewer.result", "reviewer.conflict", "reconciliation"],
    final_status: "CONTINUATION_REQUIRED",
    human_intervention_required: false,
    cost_tier: "high",
    token_tier: "medium",
    evaluation_layer: "deterministic",
    required_capabilities: ["role_cross", "correctness_routing", "routing_evidence", "final_gate"],
    acceptance_refs: ["cross-review.test.ts", "gates.test.ts: reconciliation", ...baseRefs],
  },
]

function capabilityErrors(
  scenario: RealWorldScenario,
  capabilities: Partial<Record<RuntimeCapabilityId, RuntimeCapabilityStatus>>,
) {
  return scenario.required_capabilities.flatMap((capability) => {
    const status = capabilities[capability] ?? "missing"
    if (status === "implemented_runtime_verified") return []
    return [`${capability} is ${status}`]
  })
}

function invariantErrors(scenario: RealWorldScenario) {
  const errors: string[] = []
  if (scenario.final_status === "VERIFIED_COMPLETE" && scenario.evidence_required.length === 0) {
    errors.push("VERIFIED_COMPLETE requires evidence")
  }
  if (scenario.final_status === "VERIFIED_COMPLETE" && scenario.expected_route.gates.length === 0) {
    errors.push("VERIFIED_COMPLETE requires at least one gate")
  }
  if (scenario.id.includes("MISSING_EVIDENCE") && scenario.final_status === "VERIFIED_COMPLETE") {
    errors.push("missing-evidence final claim cannot be VERIFIED_COMPLETE")
  }
  if (scenario.id.includes("SECRET") && !scenario.human_intervention_required) {
    errors.push("secret access must require user intervention")
  }
  if (scenario.id.includes("MULTIMODAL") && !scenario.models_used.includes("multimodal-context-interpreter")) {
    errors.push("multimodal input must route to multimodal-context-interpreter")
  }
  if (scenario.id === "S01_SHORT_CODE_TASK" && scenario.expected_route.reviewers.length > 0) {
    errors.push("ordinary short code task must not trigger reviewers")
  }
  if (scenario.id === "S20_REVIEWER_CONFLICT" && !scenario.expected_route.reviewers.includes("role-cross")) {
    errors.push("reviewer conflict must dispatch role-cross")
  }
  return errors
}

function externalStatus(scenario: RealWorldScenario): ScenarioExternalStatus {
  if (scenario.evaluation_layer === "manual") return "manual_not_run"
  if (scenario.evaluation_layer === "live_required") return "live_not_run"
  return "not_run"
}

export function evaluateScenario(
  scenario: RealWorldScenario,
  capabilities: Partial<Record<RuntimeCapabilityId, RuntimeCapabilityStatus>> = CURRENT_RUNTIME_CAPABILITIES,
): ScenarioEvaluation {
  const errors = [
    ...capabilityErrors(scenario, capabilities),
    ...invariantErrors(scenario),
  ]
  return {
    scenario_id: scenario.id,
    name: scenario.name,
    goal: scenario.goal,
    expected_route: scenario.expected_route,
    models_used: scenario.models_used,
    evidence: scenario.evidence_required,
    final_status: scenario.final_status,
    human_intervention_needed: scenario.human_intervention_required,
    cost_tier: scenario.cost_tier,
    token_tier: scenario.token_tier,
    evaluation_layer: scenario.evaluation_layer,
    deterministic_status: errors.length === 0 ? "pass" : "fail",
    external_status: externalStatus(scenario),
    status: errors.length === 0 ? "pass" : "fail",
    errors,
  }
}

export function evaluateRealWorldScenarioSuite(
  capabilities: Partial<Record<RuntimeCapabilityId, RuntimeCapabilityStatus>> = CURRENT_RUNTIME_CAPABILITIES,
): ScenarioSuiteReport {
  const scenarios = REAL_WORLD_SCENARIOS.map((scenario) => evaluateScenario(scenario, capabilities))
  const pass = scenarios.filter((scenario) => scenario.status === "pass").length
  const fail = scenarios.filter((scenario) => scenario.status === "fail").length
  return {
    generated_at: new Date().toISOString(),
    total: scenarios.length,
    pass,
    fail,
    deterministic_pass: pass,
    deterministic_fail: fail,
    false_pass_risk: scenarios.filter((scenario) =>
      scenario.final_status === "VERIFIED_COMPLETE" && scenario.evidence.length === 0,
    ).length,
    human_intervention_scenarios: scenarios.filter((scenario) => scenario.human_intervention_needed).length,
    unnecessary_reviewer_scenarios: scenarios.filter((scenario) =>
      scenario.scenario_id === "S01_SHORT_CODE_TASK" && scenario.expected_route.reviewers.length > 0,
    ).length,
    not_run_scenarios: scenarios.filter((scenario) => scenario.external_status === "not_run").length,
    manual_not_run_scenarios: scenarios.filter((scenario) => scenario.external_status === "manual_not_run").length,
    live_not_run_scenarios: scenarios.filter((scenario) => scenario.external_status === "live_not_run").length,
    scenarios,
  }
}

export function renderScenarioSuiteReport(report = evaluateRealWorldScenarioSuite()) {
  const lines = [
    "dll-agent real-world scenario evaluation",
    `total=${report.total} deterministic_pass=${report.deterministic_pass} deterministic_fail=${report.deterministic_fail} false_pass_risk=${report.false_pass_risk}`,
    `human_intervention_scenarios=${report.human_intervention_scenarios} unnecessary_reviewer_scenarios=${report.unnecessary_reviewer_scenarios}`,
    `external_status not_run=${report.not_run_scenarios} manual_not_run=${report.manual_not_run_scenarios} live_not_run=${report.live_not_run_scenarios}`,
    ...report.scenarios.map((scenario) =>
      `${scenario.status.toUpperCase()} ${scenario.scenario_id} ${scenario.final_status} layer=${scenario.evaluation_layer} external=${scenario.external_status} route=${[
        "commander",
        ...scenario.expected_route.reviewers,
        ...scenario.expected_route.dispatch,
      ].filter(Boolean).join(">") || "none"} evidence=${scenario.evidence.join(",") || "none"}`,
    ),
  ]
  return lines.join("\n")
}
