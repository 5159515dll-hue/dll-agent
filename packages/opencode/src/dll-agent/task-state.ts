/**
 * Artifact-aware task state summary for TUI/CLI UX. This does not replace the
 * model-maintained Todo list; it provides an evidence-derived counterweight so
 * stale Todo entries do not hide real progress or blockers.
 */

import { scanArtifactLedger } from "./artifact-ledger"
import { assessGoalCompletion, loadGoalContract } from "./goal-contract"
import { loadResults } from "./result-ledger"
import { loadState } from "./supervisor"

export type TaskStateStatus = "idle" | "in_progress" | "blocked" | "partial" | "verified"

export interface TaskStateSnapshot {
  status: TaskStateStatus
  goal: string | null
  goal_status: string | null
  completed_steps: string[]
  blockers: string[]
  next_action: string
  result_packets: number
}

export function buildTaskStateSnapshot(input: {
  sessionID?: string
  projectDir: string
}): TaskStateSnapshot {
  const artifact = scanArtifactLedger(input.projectDir)
  const results = input.sessionID ? loadResults(input.sessionID) : []
  const contract = input.sessionID ? loadGoalContract(input.sessionID) : null
  const completed: string[] = []
  const blockers: string[] = []

  if (artifact.artifacts.some((item) => item.kind === "generated_script")) {
    completed.push("audit script generated")
  }
  if (artifact.auditReports.length > 0) {
    completed.push("audit report generated")
  }
  if (artifact.screenshotCount > 0) {
    completed.push(`${artifact.screenshotCount} screenshot(s) captured`)
  }
  if (results.length > 0) {
    completed.push(`${results.length} result packet(s) recorded`)
  }
  if (contract) {
    completed.push("goal contract recorded")
  }

  blockers.push(...artifact.blockers)
  if (artifact.failCount > 0) blockers.push(`audit report has ${artifact.failCount} FAIL result(s)`)
  if (input.sessionID) {
    try {
      const state = loadState(input.sessionID)
      if (state.blocked_completion && state.block_reason) blockers.push(state.block_reason)
    } catch {
      // State is diagnostic; ignore unreadable state.
    }
  }
  const goalAssessment = contract
    ? assessGoalCompletion({
        contract,
        resultStatuses: results.map((packet) => packet.completion_status),
        blockers,
      })
    : null
  if (goalAssessment && goalAssessment.final_status === "CONTINUATION_REQUIRED") {
    blockers.push(...goalAssessment.blocking_items)
  }
  if (goalAssessment && goalAssessment.final_status === "FAILED") {
    blockers.push(...goalAssessment.reasons)
  }

  const hasVerified = results.some((packet) => packet.completion_status === "VERIFIED_COMPLETE") ||
    (artifact.hasAuditEvidence && artifact.failCount === 0 && artifact.blockers.length === 0) ||
    goalAssessment?.final_status === "VERIFIED_COMPLETE"
  const hasPartial = results.some((packet) => packet.completion_status === "PARTIAL" || packet.completion_status === "UNVERIFIED") ||
    (artifact.auditReports.length > 0 && !hasVerified)
  const status: TaskStateStatus = blockers.length > 0
    ? "blocked"
    : hasVerified
    ? "verified"
    : hasPartial
    ? "partial"
    : completed.length > 0
    ? "in_progress"
    : "idle"

  const nextAction = blockers.length > 0
    ? "resolve report/gate blockers before final PASS"
    : status === "verified"
    ? "finalize with evidence refs"
    : artifact.auditReports.length === 0
    ? "run the selected audit/test tool and write a report"
    : "record result ledger packet or disclose partial status"

  return {
    status,
    goal: contract?.user_goal ?? null,
    goal_status: goalAssessment?.final_status ?? null,
    completed_steps: [...new Set(completed)],
    blockers: [...new Set(blockers)].slice(0, 5),
    next_action: nextAction,
    result_packets: results.length,
  }
}

export function buildTaskSidebarLines(input: {
  sessionID?: string
  projectDir: string
  maxLineLength?: number
}): string[] {
  const state = buildTaskStateSnapshot(input)
  const max = input.maxLineLength ?? 72
  const trim = (line: string) => line.length <= max ? line : `${line.slice(0, max - 1)}…`
  const lines = [`task ${state.status} · ${state.next_action}`]
  if (state.goal) {
    lines.push(`task goal ${state.goal}`)
  }
  if (state.blockers.length > 0) {
    lines.push(`task blocker ${state.blockers[0]}`)
  }
  if (state.completed_steps.length > 0) {
    lines.push(`task evidence ${state.completed_steps.slice(0, 2).join(", ")}`)
  }
  return lines.map(trim).slice(0, 3)
}
