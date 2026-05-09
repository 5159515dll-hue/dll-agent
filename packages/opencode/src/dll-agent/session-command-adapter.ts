import { runDoctor } from "./dll-doctor"
import { renderDoctorNextActions } from "./doctor-next-action"
import { renderModelUsageReport, renderRoutingReport } from "./model-usage-report"
import {
  normalizePermissionMode,
  renderPermissionModeStatus,
  setPermissionMode,
} from "./permission-mode"
import { renderRegressionScenarioStatus } from "./regression-scenarios"
import { renderTaskStatus } from "./task-observability"
import { renderTaskTrajectory } from "./task-trajectory"

const LOCAL_COMMANDS = new Set([
  "task-status",
  "task-trajectory",
  "model-usage",
  "routing-report",
  "doctor-next",
  "regression-status",
  "permissions",
])

export function isDllLocalCommand(command: string) {
  return LOCAL_COMMANDS.has(command)
}

export function renderDllLocalCommand(input: {
  command: string
  arguments: string
  sessionID: string
  projectDir: string
}) {
  if (input.command === "task-status") {
    return renderTaskStatus({
      sessionID: input.sessionID,
      projectDir: input.projectDir,
    })
  }
  if (input.command === "task-trajectory") {
    return renderTaskTrajectory({
      sessionID: input.sessionID,
      maxEvents: 30,
    })
  }
  if (input.command === "model-usage") {
    return renderModelUsageReport({
      sessionID: input.sessionID,
      maxItems: 30,
    })
  }
  if (input.command === "routing-report") {
    return renderRoutingReport({
      sessionID: input.sessionID,
      maxItems: 30,
    })
  }
  if (input.command === "doctor-next") {
    return renderDoctorNextActions(runDoctor(input.projectDir, { recordEvidence: false }))
  }
  if (input.command === "regression-status") {
    return renderRegressionScenarioStatus()
  }
  if (input.command === "permissions") {
    const mode = normalizePermissionMode(input.arguments)
    if (input.arguments.trim() && !mode) {
      return [
        "Invalid permission mode.",
        "Usage: /permissions [default|auto-review|full-access]",
        "",
        renderPermissionModeStatus(),
      ].join("\n")
    }
    if (mode) setPermissionMode(mode, input.sessionID)
    return renderPermissionModeStatus()
  }
  return undefined
}

export * as SessionCommandAdapter from "./session-command-adapter"
