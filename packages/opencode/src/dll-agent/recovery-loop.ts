/**
 * Conservative autonomous recovery policy for dll-agent.
 *
 * This module does not execute repairs. It classifies a failure, decides whether
 * the commander can continue automatically, and identifies when escalation or
 * user input is required.
 */

import type { MessageV2 } from "@/session/message-v2"
import type { ReviewerRole } from "./interfaces"
import { buildActionableError, buildFailureFingerprint, type FailureCategory } from "./actionable-error"
import { write as writeEvidence } from "./evidence"

export type RecoveryStatus = "AUTO_CONTINUE" | "ESCALATE_REVIEWER" | "BLOCKED_USER_REQUIRED" | "BLOCKED_BUDGET_EXHAUSTED"

export interface LatestFailure {
  whatFailed: string
  stderr: string
  evidenceRef: string
}

export interface RecoveryDecision {
  status: RecoveryStatus
  category: FailureCategory
  fingerprint: string
  recoveryAttempts: number
  maxRecoveryAttempts: number
  nextAutomaticAction: string | null
  userActionRequired: boolean
  userAction: string | null
  reviewer: ReviewerRole | null
  shouldContinue: boolean
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

  if (recoveryAttempts >= maxRecoveryAttempts) {
    return {
      status: "BLOCKED_BUDGET_EXHAUSTED",
      category,
      fingerprint,
      recoveryAttempts,
      maxRecoveryAttempts,
      nextAutomaticAction: null,
      userActionRequired: true,
      userAction: `Recovery budget exhausted for ${fingerprint}. User decision is required before spending more attempts.`,
      reviewer: null,
      shouldContinue: false,
      reason: "recovery budget exhausted",
      verification: verificationFor(category),
      evidenceRefs: [params.failure.evidenceRef],
    }
  }

  if (actionable.userActionRequired || needsUserInput(params.failure.stderr)) {
    return {
      status: "BLOCKED_USER_REQUIRED",
      category,
      fingerprint,
      recoveryAttempts,
      maxRecoveryAttempts,
      nextAutomaticAction: null,
      userActionRequired: true,
      userAction: actionable.userAction ?? "User authorization or missing secret/login input is required.",
      reviewer: null,
      shouldContinue: false,
      reason: "failure requires user input or high-risk authorization",
      verification: verificationFor(category),
      evidenceRefs: [params.failure.evidenceRef],
    }
  }

  const reviewer: ReviewerRole | null = recoveryAttempts >= 2
    ? "role-cross"
    : recoveryAttempts >= 1
    ? "chief-engineer"
    : null

  return {
    status: reviewer ? "ESCALATE_REVIEWER" : "AUTO_CONTINUE",
    category,
    fingerprint,
    recoveryAttempts,
    maxRecoveryAttempts,
    nextAutomaticAction: actionable.nextAutomaticAction ?? "Diagnose the failure, apply a minimal fix, and rerun verification.",
    userActionRequired: false,
    userAction: null,
    reviewer,
    shouldContinue: true,
    reason: reviewer
      ? `same failure fingerprint seen ${recoveryAttempts + 1} time(s); escalate to ${reviewer}`
      : "normal recoverable error; commander should continue automatically",
    verification: verificationFor(category),
    evidenceRefs: [params.failure.evidenceRef],
  }
}

export function buildRecoveryHint(decision: RecoveryDecision) {
  const lines = [
    `<dll-agent-recovery-loop>`,
    `Status: ${decision.status}`,
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
  writeEvidence("recovery.decision", {
    status: decision.status,
    category: decision.category,
    fingerprint: decision.fingerprint,
    recoveryAttempts: decision.recoveryAttempts,
    reviewer: decision.reviewer,
    reason: decision.reason,
    userActionRequired: decision.userActionRequired,
    evidenceRefs: decision.evidenceRefs,
  }, sessionID)
}
