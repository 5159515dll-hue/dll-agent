import { redact } from "./evidence"
import type { DoctorCheck, DoctorReport } from "./dll-doctor"

export type DoctorNextActionSeverity =
  | "no_action_needed"
  | "user_optional"
  | "user_authorization_required"
  | "blocking"
  | "dangerous_to_auto_fix"

export interface DoctorNextAction {
  check_name: string
  severity: DoctorNextActionSeverity
  summary: string
  command: string | null
  reason: string
  redaction_status: "redacted"
}

export interface DoctorNextActionReport {
  generated_at: string
  doctor_overall: string
  actions: DoctorNextAction[]
  blocking: number
  optional: number
  authorization_required: number
  no_action_needed: number
  redaction_status: "redacted"
}

function actionFor(check: DoctorCheck): DoctorNextAction {
  const message = `${check.name} ${check.message} ${check.nextAction ?? ""}`.toLowerCase()

  if (check.severity === "FAIL") {
    return {
      check_name: check.name,
      severity: "blocking",
      summary: check.message,
      command: check.nextAction,
      reason: "doctor failed checks block verified completion",
      redaction_status: "redacted",
    }
  }

  if (check.name === "runtime-config-api-key-memory" || message.includes("api keys in memory")) {
    return {
      check_name: check.name,
      severity: "no_action_needed",
      summary: check.message,
      command: null,
      reason: "runtime config contains keys in memory at launch but is not written to disk",
      redaction_status: "redacted",
    }
  }

  if (check.name.includes("evidence") && (message.includes("session") || message.includes("rotation") || message.includes("nearing"))) {
    return {
      check_name: check.name,
      severity: "user_optional",
      summary: check.message,
      command: "dll-agent doctor --repair-safe --dry-run",
      reason: "safe cleanup should be previewed before deleting inactive evidence/session data",
      redaction_status: "redacted",
    }
  }

  if (check.name.includes("quota") || message.includes("quota status")) {
    return {
      check_name: check.name,
      severity: "user_optional",
      summary: check.message,
      command: "/Users/dailulu/.local/bin/dll-agent-quota",
      reason: "quota refresh is local status maintenance and does not affect model routing correctness",
      redaction_status: "redacted",
    }
  }

  if (check.name.includes("playwright") || check.name.includes("mcp") || check.name.includes("background-processes") || message.includes("high-cpu")) {
    return {
      check_name: check.name,
      severity: "user_authorization_required",
      summary: check.message,
      command: check.nextAction,
      reason: "process cleanup requires confirming the process is stale and not tied to an active session",
      redaction_status: "redacted",
    }
  }

  if (message.includes("secret") || message.includes("token") || message.includes("api key") || message.includes("cookie")) {
    return {
      check_name: check.name,
      severity: "dangerous_to_auto_fix",
      summary: check.message,
      command: check.nextAction,
      reason: "secret-bearing configuration must not be modified automatically",
      redaction_status: "redacted",
    }
  }

  if (check.severity === "WARN") {
    return {
      check_name: check.name,
      severity: check.nextAction ? "user_optional" : "no_action_needed",
      summary: check.message,
      command: check.nextAction,
      reason: check.nextAction ? "doctor reported a non-blocking warning with an optional next action" : "doctor warning is informational",
      redaction_status: "redacted",
    }
  }

  return {
    check_name: check.name,
    severity: "no_action_needed",
    summary: check.message,
    command: null,
    reason: "doctor check passed",
    redaction_status: "redacted",
  }
}

export function buildDoctorNextActionReport(report: DoctorReport): DoctorNextActionReport {
  const actions = report.checks
    .filter((check) => check.severity !== "PASS" || check.nextAction || check.name === "runtime-config-api-key-memory")
    .map(actionFor)
  return redact({
    generated_at: new Date().toISOString(),
    doctor_overall: report.overall,
    actions,
    blocking: actions.filter((action) => action.severity === "blocking").length,
    optional: actions.filter((action) => action.severity === "user_optional").length,
    authorization_required: actions.filter((action) => action.severity === "user_authorization_required").length,
    no_action_needed: actions.filter((action) => action.severity === "no_action_needed").length,
    redaction_status: "redacted",
  } satisfies DoctorNextActionReport) as DoctorNextActionReport
}

export function renderDoctorNextActions(report: DoctorReport, maxChars = 5_000) {
  const next = buildDoctorNextActionReport(report)
  const lines = [
    "dll-agent doctor next action",
    `doctor: ${next.doctor_overall}`,
    `blocking: ${next.blocking} | optional: ${next.optional} | auth_required: ${next.authorization_required} | info: ${next.no_action_needed}`,
    "",
    ...next.actions.map((action) =>
      [
        `- ${action.check_name}: ${action.severity}`,
        action.summary,
        `reason=${action.reason}`,
        action.command ? `next=${action.command}` : "next=none",
      ].join(" | ")
    ),
  ]
  return lines.join("\n").slice(0, maxChars)
}

export * as DoctorNextAction from "./doctor-next-action"
