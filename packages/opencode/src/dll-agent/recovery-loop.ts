/**
 * Conservative autonomous recovery policy for dll-agent.
 *
 * This module does not execute repairs. It classifies a failure, decides whether
 * the commander can continue automatically, and identifies when escalation or
 * user input is required.
 */

import type { MessageV2 } from "@/session/message-v2"
import type { ContinuationPacket, ReviewerRole, RiskLevel } from "./interfaces"
import { buildActionableError, buildFailureFingerprint, type FailureCategory } from "./actionable-error"
import { write as writeEvidence } from "./evidence"
import { checkResultSufficiency } from "./result-sufficiency-gate"

export type RecoveryStatus = "AUTO_CONTINUE" | "ESCALATE_REVIEWER" | "BLOCKED_USER_REQUIRED" | "BLOCKED_BUDGET_EXHAUSTED"
export type FailureType =
  | "command_error"
  | "test_failure"
  | "typecheck_failure"
  | "lint_failure"
  | "build_failure"
  | "dependency_missing"
  | "permission_denied"
  | "file_not_found"
  | "config_error"
  | "provider_error"
  | "reasoning_param_error"
  | "network_error"
  | "doctor_failed"
  | "reviewer_block"
  | "final_gate_block"
  | "continuation_required"
  | "destructive_action_required"
  | "secret_or_auth_missing"
  | "repeated_failure"
  | "unknown_failure"
export type FailureSeverity = "low" | "medium" | "high" | "critical"
export type RecoveryAction =
  | "continue_local_repair"
  | "reuse_existing_result"
  | "run_verification"
  | "trigger_reviewer"
  | "trigger_cross_review"
  | "request_user_input"
  | "blocked_budget_exhausted"
  | "blocked_security"

export interface LatestFailure {
  whatFailed: string
  stderr: string
  evidenceRef: string
}

export interface RecoveryBudgetState {
  fingerprint_attempts: number
  max_fingerprint_attempts: number
  phase_attempts: number
  max_phase_attempts: number
  task_attempts: number
  max_task_attempts: number
}

export interface FailureClassification {
  failure_type: FailureType
  severity: FailureSeverity
  fingerprint: string
  evidence_refs: string[]
  likely_root_cause: string
  auto_recoverable: boolean
  requires_user_input: boolean
  suggested_recovery_action: string
  required_verification: string[]
  escalation_role: ReviewerRole | null
  risk_level: RiskLevel
  category: FailureCategory
}

export interface RecoveryDecision {
  status: RecoveryStatus
  action: RecoveryAction
  failure_type: FailureType
  category: FailureCategory
  fingerprint: string
  recoveryAttempts: number
  maxRecoveryAttempts: number
  budget_state: RecoveryBudgetState
  nextAutomaticAction: string | null
  next_role: ReviewerRole | "commander" | null
  next_command: string | null
  userActionRequired: boolean
  userAction: string | null
  reviewer: ReviewerRole | null
  shouldContinue: boolean
  user_input_required: string | null
  safe_to_auto_execute: boolean
  reason: string
  verification: string[]
  evidenceRefs: string[]
}

const USER_REQUIRED_PATTERNS = [
  /api\s*key|auth\s*token|access\s*token|bearer\s*token|credential|login|验证码|登录态|凭据/i,
  /secret|cookie|ssh\s*key|keychain|\.env|secrets?/i,
  /git\s+push|release|publish|deploy|upload|上传|发布/i,
  /rm\s+-rf|destructive|破坏性|不可逆/i,
  /sudo|systemctl|launchctl|brew\s+install|apt(-get)?\s+install|global|全局系统/i,
  /cost|budget|quota|超出.*预算/i,
]

const FAILURE_OUTPUT_PATTERNS = [
  /error TS\d+|tsgo|tsc|typecheck/i,
  /FAIL|AssertionError|expect\(.*\)|test.*fail|✗|✘/i,
  /cannot find module|module not found|cannot resolve|import .* not found|export .* not found/i,
  /ENOENT|no such file|file not found|path .* not found/i,
  /permission denied|access denied|EACCES|not allowed/i,
  /provider.*reasoning_effort|reasoning_effort|max.*low.*medium.*high|literal_error/i,
  /config.*invalid|json.*parse|yaml.*parse|toml.*parse/i,
  /doctor.*(failed|fail|失败)|result:\s*failed/i,
  /gate.*(blocked|block|阻断)|final.*gate/i,
  /reviewer.*(blocked|block|阻断)/i,
  /lint.*(failed|error)|eslint|oxlint/i,
  /build.*(failed|error)|webpack|vite|rollup/i,
]

function needsUserInput(text: string) {
  return USER_REQUIRED_PATTERNS.some((pattern) => pattern.test(text))
}

function verificationFor(category: FailureCategory) {
  if (category === "typecheck_error") return ["rerun typecheck"]
  if (category === "test_failure") return ["rerun failing tests"]
  if (category === "dependency_missing") return ["rerun command that failed after dependency/path fix"]
  if (category === "config_error") return ["rerun config validation or failed command"]
  if (category === "provider_normalization_error") return ["rerun provider mock/smoke", "verify request body is normalized"]
  if (category === "file_not_found") return ["verify corrected path exists", "rerun failed command"]
  if (category === "model_error") return ["rerun provider request smoke or mocked provider normalization test"]
  if (category === "gate_blocked" || category === "reviewer_blocked") return ["rerun required gate verification"]
  return ["rerun failed command", "collect evidence"]
}

function failureTypeFor(category: FailureCategory, text: string): FailureType {
  if (/reasoning_effort|literal_error|max.*low.*medium.*high/i.test(text)) return "reasoning_param_error"
  if (/doctor.*(failed|fail|失败)|result:\s*failed/i.test(text)) return "doctor_failed"
  if (/reviewer.*(?:block|blocked|阻断)/i.test(text)) return "reviewer_block"
  if (/final.*gate|gate.*(?:block|blocked|阻断)/i.test(text)) return "final_gate_block"
  if (/rm\s+-rf|destructive|破坏性|不可逆/i.test(text)) return "destructive_action_required"
  if (/api\s*key|auth\s*token|access\s*token|bearer\s*token|credential|login|验证码|登录态|凭据|secret|cookie|ssh\s*key|keychain|\.env|secrets?/i.test(text)) return "secret_or_auth_missing"
  if (/lint.*(failed|error)|eslint|oxlint/i.test(text)) return "lint_failure"
  if (/build.*(failed|error)|webpack|vite|rollup/i.test(text)) return "build_failure"
  if (category === "typecheck_error") return "typecheck_failure"
  if (category === "test_failure") return "test_failure"
  if (category === "dependency_missing") return "dependency_missing"
  if (category === "permission_denied") return "permission_denied"
  if (category === "file_not_found") return "file_not_found"
  if (category === "config_error") return "config_error"
  if (category === "provider_normalization_error" || category === "model_error") return "provider_error"
  if (category === "network_error" || category === "timeout") return "network_error"
  if (category === "gate_blocked") return "final_gate_block"
  if (category === "reviewer_blocked") return "reviewer_block"
  if (category === "tool_error") return "command_error"
  return text.trim() ? "command_error" : "unknown_failure"
}

function riskFor(type: FailureType): RiskLevel {
  if (type === "destructive_action_required" || type === "secret_or_auth_missing" || type === "permission_denied") {
    return "high"
  }
  if (
    type === "reviewer_block" ||
    type === "final_gate_block" ||
    type === "doctor_failed" ||
    type === "continuation_required" ||
    type === "repeated_failure"
  ) return "medium"
  return "low"
}

function severityFor(type: FailureType): FailureSeverity {
  if (type === "destructive_action_required" || type === "secret_or_auth_missing") return "critical"
  if (type === "permission_denied" || type === "doctor_failed" || type === "reviewer_block" || type === "final_gate_block") return "high"
  if (type === "test_failure" || type === "typecheck_failure" || type === "build_failure" || type === "lint_failure") return "medium"
  return "low"
}

function verificationForFailureType(type: FailureType, fallback: string[]) {
  if (type === "typecheck_failure") return ["rerun typecheck"]
  if (type === "test_failure") return ["rerun failing tests"]
  if (type === "lint_failure") return ["rerun lint"]
  if (type === "build_failure") return ["rerun build"]
  if (type === "doctor_failed") return ["rerun dll-agent doctor"]
  if (type === "reasoning_param_error" || type === "provider_error") return ["rerun provider normalization test or smoke"]
  if (type === "continuation_required" || type === "final_gate_block") return ["rerun required verification", "collect evidence refs"]
  return fallback
}

function blockedBySecurity(type: FailureType) {
  return type === "destructive_action_required"
}

function userInputRequiredFor(type: FailureType, text: string) {
  return type === "secret_or_auth_missing" || type === "permission_denied" || needsUserInput(text)
}

export function classifyFailure(params: {
  failure: LatestFailure
  repairCounts?: Record<string, number>
}): FailureClassification {
  const actionable = buildActionableError({
    whatFailed: params.failure.whatFailed,
    stderr: params.failure.stderr,
  })
  const type = failureTypeFor(actionable.category, `${params.failure.whatFailed}\n${params.failure.stderr}`)
  const fingerprint = buildFailureFingerprint(actionable.category, params.failure.stderr)
  const attempts = params.repairCounts?.[fingerprint] ?? 0
  const repeated = attempts >= 1
  const requiresUserInput = userInputRequiredFor(type, params.failure.stderr)
  const securityBlocked = blockedBySecurity(type)
  return {
    failure_type: repeated && !requiresUserInput && !securityBlocked ? "repeated_failure" : type,
    severity: repeated ? "high" : severityFor(type),
    fingerprint,
    evidence_refs: [params.failure.evidenceRef],
    likely_root_cause: actionable.whyLikely,
    auto_recoverable: !requiresUserInput && !securityBlocked,
    requires_user_input: requiresUserInput || securityBlocked,
    suggested_recovery_action: actionable.nextAutomaticAction ?? "Diagnose the failure, apply a minimal fix, and rerun verification.",
    required_verification: verificationForFailureType(type, verificationFor(actionable.category)),
    escalation_role: repeated ? attempts >= 2 ? "role-cross" : "chief-engineer" : null,
    risk_level: riskFor(type),
    category: actionable.category,
  }
}

function buildBudgetState(params: {
  fingerprintAttempts: number
  phaseAttempts?: number
  taskAttempts?: number
  maxFingerprintAttempts: number
  maxPhaseAttempts: number
  maxTaskAttempts: number
}): RecoveryBudgetState {
  return {
    fingerprint_attempts: params.fingerprintAttempts,
    max_fingerprint_attempts: params.maxFingerprintAttempts,
    phase_attempts: params.phaseAttempts ?? 0,
    max_phase_attempts: params.maxPhaseAttempts,
    task_attempts: params.taskAttempts ?? 0,
    max_task_attempts: params.maxTaskAttempts,
  }
}

export function extractLatestFailure(messages: MessageV2.WithParts[]): LatestFailure | null {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool") continue
      const state = part.state
      const input = state.status === "pending" ? {} : state.input as Record<string, unknown> | undefined
      const command = typeof input?.command === "string" ? input.command : part.tool
      if (state.status === "error") {
        return {
          whatFailed: command,
          stderr: state.error,
          evidenceRef: `tool:${part.tool}:${part.callID}`,
        }
      }
      if (state.status !== "completed") continue
      const output = state.output ?? ""
      if (!FAILURE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output))) continue
      return {
        whatFailed: command,
        stderr: output.slice(0, 4000),
        evidenceRef: `tool:${part.tool}:${part.callID}`,
      }
    }
  }
  return null
}

export function planRecovery(params: {
  failure: LatestFailure
  repairCounts?: Record<string, number>
  maxRecoveryAttempts?: number
  phaseAttempts?: number
  taskAttempts?: number
  maxPhaseAttempts?: number
  maxTaskAttempts?: number
  sessionID?: string
  taskGoal?: string
  projectDir?: string
}): RecoveryDecision {
  const actionable = buildActionableError({
    whatFailed: params.failure.whatFailed,
    stderr: params.failure.stderr,
    maxRecoveryAttempts: params.maxRecoveryAttempts,
  })
  const fingerprint = buildFailureFingerprint(actionable.category, params.failure.stderr)
  const recoveryAttempts = params.repairCounts?.[fingerprint] ?? 0
  const maxRecoveryAttempts = params.maxRecoveryAttempts ?? actionable.maxRecoveryAttempts
  const category = actionable.category
  const classification = classifyFailure({ failure: params.failure, repairCounts: params.repairCounts })
  const budget = buildBudgetState({
    fingerprintAttempts: recoveryAttempts,
    phaseAttempts: params.phaseAttempts,
    taskAttempts: params.taskAttempts,
    maxFingerprintAttempts: maxRecoveryAttempts,
    maxPhaseAttempts: params.maxPhaseAttempts ?? 5,
    maxTaskAttempts: params.maxTaskAttempts ?? 8,
  })
  const phaseExhausted = budget.phase_attempts >= budget.max_phase_attempts
  const taskExhausted = budget.task_attempts >= budget.max_task_attempts

  if (params.sessionID && params.taskGoal) {
    const sufficiency = checkResultSufficiency(params.sessionID, params.taskGoal, {
      projectDir: params.projectDir,
      maxAgeMinutes: 120,
    })
    if (sufficiency.action === "reuse_existing" && sufficiency.bestResult) {
      return {
        status: "AUTO_CONTINUE",
        action: "reuse_existing_result",
        failure_type: classification.failure_type,
        category,
        fingerprint,
        recoveryAttempts,
        maxRecoveryAttempts,
        budget_state: budget,
        nextAutomaticAction: `Reuse verified ResultPacket ${sufficiency.bestResult.packet_id}; do not repeat the completed work.`,
        next_role: "commander",
        next_command: null,
        userActionRequired: false,
        userAction: null,
        reviewer: null,
        shouldContinue: true,
        user_input_required: null,
        safe_to_auto_execute: true,
        reason: "result ledger has verified non-stale result; recovery should reuse it instead of repairing from scratch",
        verification: [],
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }
    if (sufficiency.action === "verify_existing" && sufficiency.bestResult) {
      return {
        status: "AUTO_CONTINUE",
        action: "run_verification",
        failure_type: classification.failure_type,
        category,
        fingerprint,
        recoveryAttempts,
        maxRecoveryAttempts,
        budget_state: budget,
        nextAutomaticAction: `Verify existing ResultPacket ${sufficiency.bestResult.packet_id} instead of re-implementing.`,
        next_role: "commander",
        next_command: null,
        userActionRequired: false,
        userAction: null,
        reviewer: null,
        shouldContinue: true,
        user_input_required: null,
        safe_to_auto_execute: true,
        reason: "result ledger has existing result that needs verification",
        verification: sufficiency.neededActions,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }
    if ((sufficiency.action === "continue_from_existing" || sufficiency.action === "repair_existing") && sufficiency.bestResult) {
      classification.required_verification = sufficiency.neededActions.length > 0
        ? sufficiency.neededActions
        : classification.required_verification
    }
  }

  if (recoveryAttempts >= maxRecoveryAttempts || phaseExhausted || taskExhausted) {
    return {
      status: "BLOCKED_BUDGET_EXHAUSTED",
      action: "blocked_budget_exhausted",
      failure_type: classification.failure_type,
      category,
      fingerprint,
      recoveryAttempts,
      maxRecoveryAttempts,
      budget_state: budget,
      nextAutomaticAction: null,
      next_role: null,
      next_command: null,
      userActionRequired: true,
      userAction: `Recovery budget exhausted for ${fingerprint}. User decision is required before spending more attempts.`,
      reviewer: null,
      shouldContinue: false,
      user_input_required: "Recovery budget exhausted; user decision is required before spending more attempts.",
      safe_to_auto_execute: false,
      reason: "recovery budget exhausted",
      verification: classification.required_verification,
      evidenceRefs: [params.failure.evidenceRef],
    }
  }

  if (blockedBySecurity(classification.failure_type)) {
    return {
      status: "BLOCKED_USER_REQUIRED",
      action: "blocked_security",
      failure_type: classification.failure_type,
      category,
      fingerprint,
      recoveryAttempts,
      maxRecoveryAttempts,
      budget_state: budget,
      nextAutomaticAction: null,
      next_role: null,
      next_command: null,
      userActionRequired: true,
      userAction: "Security policy blocks automatic destructive action. User confirmation or a safer alternative is required.",
      reviewer: null,
      shouldContinue: false,
      user_input_required: "Confirm the destructive/security-sensitive action or provide a safe alternative.",
      safe_to_auto_execute: false,
      reason: "failure requires high-risk action blocked by security policy",
      verification: classification.required_verification,
      evidenceRefs: [params.failure.evidenceRef],
    }
  }

  if (actionable.userActionRequired || classification.requires_user_input) {
    return {
      status: "BLOCKED_USER_REQUIRED",
      action: "request_user_input",
      failure_type: classification.failure_type,
      category,
      fingerprint,
      recoveryAttempts,
      maxRecoveryAttempts,
      budget_state: budget,
      nextAutomaticAction: null,
      next_role: null,
      next_command: null,
      userActionRequired: true,
      userAction: actionable.userAction ?? "User authorization or missing secret/login input is required.",
      reviewer: null,
      shouldContinue: false,
      user_input_required: actionable.userAction ?? "User authorization or missing secret/login input is required.",
      safe_to_auto_execute: false,
      reason: "failure requires user input or high-risk authorization",
      verification: classification.required_verification,
      evidenceRefs: [params.failure.evidenceRef],
    }
  }

  const reviewer: ReviewerRole | null = recoveryAttempts >= 2
    ? "role-cross"
    : recoveryAttempts >= 1
    ? "chief-engineer"
    : null
  const action: RecoveryAction = reviewer
    ? reviewer === "role-cross" ? "trigger_cross_review" : "trigger_reviewer"
    : classification.failure_type === "continuation_required" || classification.failure_type === "final_gate_block"
    ? "run_verification"
    : "continue_local_repair"

  return {
    status: reviewer ? "ESCALATE_REVIEWER" : "AUTO_CONTINUE",
    action,
    failure_type: classification.failure_type,
    category,
    fingerprint,
    recoveryAttempts,
    maxRecoveryAttempts,
    budget_state: budget,
    nextAutomaticAction: actionable.nextAutomaticAction ?? "Diagnose the failure, apply a minimal fix, and rerun verification.",
    next_role: reviewer ?? "commander",
    next_command: null,
    userActionRequired: false,
    userAction: null,
    reviewer,
    shouldContinue: true,
    user_input_required: null,
    safe_to_auto_execute: true,
    reason: reviewer
      ? `same failure fingerprint seen ${recoveryAttempts + 1} time(s); escalate to ${reviewer}`
      : "normal recoverable error; commander should continue automatically",
    verification: classification.required_verification,
    evidenceRefs: [params.failure.evidenceRef],
  }
}

export function failureFromContinuationPacket(packet: ContinuationPacket): LatestFailure {
  const text = [
    packet.final_status,
    ...packet.missing_verification.map((item) => `missing verification: ${item}`),
    ...packet.blocking_reviewer_findings.map((item) => `reviewer blocked: ${item}`),
    ...packet.missing_result_refs.map((item) => `missing result: ${item}`),
    ...packet.blocking_unfinished.map((item) => item.description),
    ...packet.requires_user_input.map((item) => item.description),
  ].join("\n")
  return {
    whatFailed: "continuation gate",
    stderr: text || "continuation required",
    evidenceRef: `continuation_packet:${packet.packet_id}`,
  }
}

export function planRecoveryFromContinuationPacket(params: {
  packet: ContinuationPacket
  repairCounts?: Record<string, number>
  phaseAttempts?: number
  taskAttempts?: number
}): RecoveryDecision {
  const failure = failureFromContinuationPacket(params.packet)
  if (params.packet.missing_verification.length > 0 && params.packet.blocking_reviewer_findings.length === 0) {
    const decision = planRecovery({
      failure: {
        ...failure,
        stderr: `final gate blocked: missing verification\n${params.packet.missing_verification.join("\n")}`,
      },
      repairCounts: params.repairCounts,
      phaseAttempts: params.phaseAttempts,
      taskAttempts: params.taskAttempts,
    })
    return {
      ...decision,
      action: "run_verification",
      failure_type: "continuation_required",
      nextAutomaticAction: `Run missing verification: ${params.packet.missing_verification.join(", ")}`,
      verification: params.packet.missing_verification,
      reason: "continuation packet requires missing verification before final PASS",
    }
  }
  return planRecovery({
    failure,
    repairCounts: params.repairCounts,
    phaseAttempts: params.phaseAttempts,
    taskAttempts: params.taskAttempts,
  })
}

export function buildRecoveryHint(decision: RecoveryDecision) {
  const lines = [
    `<dll-agent-recovery-loop>`,
    `Status: ${decision.status}`,
    `Action: ${decision.action}`,
    `Failure type: ${decision.failure_type}`,
    `Category: ${decision.category}`,
    `Fingerprint: ${decision.fingerprint}`,
    `Attempts: ${decision.recoveryAttempts}/${decision.maxRecoveryAttempts}`,
    `Reason: ${decision.reason}`,
    ``,
    decision.nextAutomaticAction
      ? `Next automatic action: ${decision.nextAutomaticAction}`
      : `Next automatic action: none`,
    `Verification: ${decision.verification.join(", ")}`,
    `Evidence refs: ${decision.evidenceRefs.join(", ")}`,
    `</dll-agent-recovery-loop>`,
  ]
  return lines.join("\n")
}

export function buildBlockedRecoveryReport(decision: RecoveryDecision) {
  const lines = [
    `<dll-agent-recovery-blocked>`,
    `Final status: ${decision.status}`,
    `Action: ${decision.action}`,
    `Failure type: ${decision.failure_type}`,
    `Category: ${decision.category}`,
    `Fingerprint: ${decision.fingerprint}`,
    `Reason: ${decision.reason}`,
    `Attempts: ${decision.recoveryAttempts}/${decision.maxRecoveryAttempts}`,
    ``,
    `User action required: ${decision.userAction ?? "Provide authorization or unblock the external dependency."}`,
    `Evidence refs: ${decision.evidenceRefs.join(", ")}`,
    ``,
    `Do not claim VERIFIED_COMPLETE while this blocker remains.`,
    `</dll-agent-recovery-blocked>`,
  ]
  return lines.join("\n")
}

export function writeRecoveryDecision(sessionID: string, decision: RecoveryDecision) {
  writeEvidence("recovery.failure_classified", {
    failure_type: decision.failure_type,
    category: decision.category,
    fingerprint: decision.fingerprint,
    evidenceRefs: decision.evidenceRefs,
  }, sessionID)
  writeEvidence("recovery.decision", {
    status: decision.status,
    action: decision.action,
    failure_type: decision.failure_type,
    category: decision.category,
    fingerprint: decision.fingerprint,
    recoveryAttempts: decision.recoveryAttempts,
    budget_state: decision.budget_state,
    reviewer: decision.reviewer,
    reason: decision.reason,
    userActionRequired: decision.userActionRequired,
    safe_to_auto_execute: decision.safe_to_auto_execute,
    evidenceRefs: decision.evidenceRefs,
  }, sessionID)
  if (decision.action === "blocked_budget_exhausted") writeEvidence("recovery.budget_exhausted", decision, sessionID)
  if (decision.action === "reuse_existing_result") {
    writeEvidence("result.reused", {
      fingerprint: decision.fingerprint,
      reason: decision.reason,
      evidenceRefs: decision.evidenceRefs,
    }, sessionID)
  }
  if (decision.action === "request_user_input") writeEvidence("recovery.user_input_required", decision, sessionID)
  if (decision.action === "blocked_security") writeEvidence("recovery.security_blocked", decision, sessionID)
  if (decision.action === "trigger_reviewer" || decision.action === "trigger_cross_review") {
    writeEvidence("recovery.escalated_reviewer", decision, sessionID)
  }
  if (decision.verification.length > 0) {
    writeEvidence("recovery.verification_required", {
      fingerprint: decision.fingerprint,
      verification: decision.verification,
      evidenceRefs: decision.evidenceRefs,
    }, sessionID)
  }
}
