/**
 * Task observability / flight recorder summary.
 *
 * This is a read-only adapter over existing runtime state. It does not create
 * new workflow semantics; it makes goal, supervisor, result, evidence, and
 * routing state visible in one bounded status report.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { loadGoalContract } from "./goal-contract"
import { loadResults } from "./result-ledger"
import { loadState } from "./supervisor"
import { redact, type Entry as EvidenceEntry } from "./evidence"

export interface TaskTrajectoryEvent {
  ts: string
  type: string
  summary: string
  evidence_ref: string
}

export interface TaskObservabilityReport {
  generated_at: string
  sessionID: string
  projectDir: string
  goal: string | null
  phase: string
  risk: string
  final_status: string
  blockers: string[]
  next_actions: string[]
  reviewers: {
    required: string[]
    completed: string[]
    queued: string[]
    running: string[]
  }
  results: {
    total: number
    verified: number
    partial: number
    failed: number
    reusable: number
    unresolved: string[]
  }
  evidence: {
    total: number
    by_type: Record<string, number>
    latest: TaskTrajectoryEvent[]
  }
  routing: {
    decisions: number
    selected_models: string[]
    skipped_reviewers: string[]
  }
  cleanup: {
    evidence_sessions: number
    repair_safe_recommended: boolean
    recommendation: string | null
  }
}

function sessionsDir() {
  return path.join(os.homedir(), ".dll-agent", "sessions")
}

function readEvidenceEntries(evidenceFile?: string): EvidenceEntry[] {
  const target = evidenceFile ?? process.env.DLL_AGENT_EVIDENCE_FILE
  if (!target) return []
  try {
    if (!fs.existsSync(target)) return []
    return fs.readFileSync(target, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as EvidenceEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function summarizeEvidence(entry: EvidenceEntry): string {
  const payload = entry.payload as Record<string, unknown> | null
  if (entry.type === "model.routing_decision") {
    return `${String(payload?.role ?? "role")} -> ${String(payload?.selected_model ?? "model unavailable")}`
  }
  if (entry.type.startsWith("gate.")) return String(payload?.block_reason ?? payload?.reason ?? entry.type)
  if (entry.type.startsWith("result.")) return String(payload?.packet_id ?? payload?.completion_status ?? entry.type)
  if (entry.type.startsWith("recovery.")) return String(payload?.reason ?? payload?.status ?? entry.type)
  if (entry.type.startsWith("permission.") || entry.type === "role_tool_policy.decision") {
    return String(payload?.reason ?? payload?.action ?? entry.type)
  }
  return entry.type
}

function evidenceByType(entries: EvidenceEntry[]) {
  return entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.type] = (acc[entry.type] ?? 0) + 1
    return acc
  }, {})
}

function evidenceSessionCount() {
  try {
    if (!fs.existsSync(sessionsDir())) return 0
    return fs.readdirSync(sessionsDir()).filter((name) => fs.statSync(path.join(sessionsDir(), name)).isDirectory()).length
  } catch {
    return 0
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

export function buildTaskObservabilityReport(input: {
  sessionID: string
  projectDir: string
  evidenceFile?: string
  maxEvents?: number
}): TaskObservabilityReport {
  const goal = loadGoalContract(input.sessionID)
  const supervisor = loadState(input.sessionID)
  const results = loadResults(input.sessionID)
  const evidence = readEvidenceEntries(input.evidenceFile).filter((entry) => entry.sessionID === input.sessionID)
  const routingEntries = evidence.filter((entry) => entry.type === "model.routing_decision")
  const resultUnresolved = results.flatMap((result) => result.unresolved_items)
  const goalBlocked = [
    ...(goal?.active_plan ?? []).filter((item) => item.status === "blocked").map((item) => item.blocker ?? item.description),
    ...(goal?.success_criteria_status ?? []).filter((item) => item.status === "blocked").map((item) => item.blocker ?? item.description),
  ]
  const goalPending = [
    ...(goal?.active_plan ?? []).filter((item) => item.status === "pending" || item.status === "in_progress").map((item) => item.description),
    ...(goal?.success_criteria_status ?? []).filter((item) => item.status === "pending").map((item) => item.description),
  ]
  const blockers = unique([
    supervisor.blocked_completion && supervisor.block_reason ? supervisor.block_reason : "",
    ...goalBlocked,
    ...resultUnresolved,
  ])
  const nextActions = unique([
    blockers.length > 0 ? "Resolve blocking items and rerun required verification" : "",
    goalPending.length > 0 ? `Continue active plan: ${goalPending[0]}` : "",
    supervisor.required_reviews.length > 0 ? `Complete required reviewer(s): ${supervisor.required_reviews.join(", ")}` : "",
    results.some((result) => result.completion_status === "PARTIAL") ? "Continue from partial Result Ledger packet" : "",
    results.some((result) => result.completion_status === "FAILED") ? "Repair failed Result Ledger packet and verify" : "",
    results.length === 0 ? "Produce a Result Ledger packet before final verified completion" : "",
  ])
  const selectedModels = unique(routingEntries.map((entry) => {
    const payload = entry.payload as Record<string, unknown> | null
    return String(payload?.selected_model ?? "")
  }))
  const skippedReviewers = unique(routingEntries.flatMap((entry) => {
    const payload = entry.payload as Record<string, unknown> | null
    return Array.isArray(payload?.skipped_reviewers) ? payload.skipped_reviewers.map(String) : []
  }))
  const sessionCount = evidenceSessionCount()

  return redact({
    generated_at: new Date().toISOString(),
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    goal: goal?.user_goal ?? null,
    phase: supervisor.phase,
    risk: supervisor.risk,
    final_status: blockers.length > 0 || goalPending.length > 0 ? "CONTINUATION_REQUIRED" : "OBSERVABLE",
    blockers,
    next_actions: nextActions,
    reviewers: {
      required: supervisor.required_reviews,
      completed: supervisor.completed_reviews,
      queued: supervisor.queued_reviewers ?? [],
      running: supervisor.running_reviewers ?? [],
    },
    results: {
      total: results.length,
      verified: results.filter((result) => result.completion_status === "VERIFIED_COMPLETE").length,
      partial: results.filter((result) => result.completion_status === "PARTIAL").length,
      failed: results.filter((result) => result.completion_status === "FAILED").length,
      reusable: results.filter((result) => result.reusable && !result.stale).length,
      unresolved: resultUnresolved.slice(0, 8),
    },
    evidence: {
      total: evidence.length,
      by_type: evidenceByType(evidence),
      latest: evidence.slice(-(input.maxEvents ?? 8)).map((entry) => ({
        ts: entry.ts,
        type: entry.type,
        summary: summarizeEvidence(entry).slice(0, 160),
        evidence_ref: `${entry.type}@${entry.ts}`,
      })),
    },
    routing: {
      decisions: routingEntries.length,
      selected_models: selectedModels,
      skipped_reviewers: skippedReviewers,
    },
    cleanup: {
      evidence_sessions: sessionCount,
      repair_safe_recommended: sessionCount > 100,
      recommendation: sessionCount > 100 ? "Run: dll-agent doctor --repair-safe" : null,
    },
  } satisfies TaskObservabilityReport) as TaskObservabilityReport
}

function line(label: string, value: string | number | null) {
  return `${label}: ${value ?? "(none)"}`
}

export function renderTaskStatus(input: {
  sessionID: string
  projectDir: string
  evidenceFile?: string
  maxEvents?: number
}) {
  const report = buildTaskObservabilityReport(input)
  const lines = [
    "dll-agent task status",
    line("session", report.sessionID),
    line("goal", report.goal),
    line("phase", `${report.phase} | risk=${report.risk} | status=${report.final_status}`),
    line("reviewers", `required=[${report.reviewers.required.join(",")}] completed=[${report.reviewers.completed.join(",")}] queued=[${report.reviewers.queued.join(",")}] running=[${report.reviewers.running.join(",")}]`),
    line("results", `total=${report.results.total} verified=${report.results.verified} partial=${report.results.partial} failed=${report.results.failed} reusable=${report.results.reusable}`),
    line("routing", `decisions=${report.routing.decisions} models=[${report.routing.selected_models.join(",") || "none"}] skipped=[${report.routing.skipped_reviewers.join(",") || "none"}]`),
    line("evidence", `total=${report.evidence.total} types=${Object.keys(report.evidence.by_type).length}`),
    line("blockers", report.blockers.join("; ") || "none"),
    line("next", report.next_actions.join("; ") || "none"),
  ]
  if (report.cleanup.repair_safe_recommended) lines.push(line("cleanup", report.cleanup.recommendation))
  if (report.evidence.latest.length > 0) {
    lines.push("trajectory:")
    for (const event of report.evidence.latest) {
      lines.push(`  - ${event.ts} ${event.type}: ${event.summary}`)
    }
  }
  return lines.join("\n")
}
