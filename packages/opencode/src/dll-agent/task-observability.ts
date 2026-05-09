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
import type { GoalFinalStatus } from "./goal-contract"
import { buildTaskTrajectory, type TaskTrajectoryEvent as FullTaskTrajectoryEvent } from "./task-trajectory"

export type ObservableFinalStatus = GoalFinalStatus | "UNKNOWN" | "OBSERVABLE"

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
  final_status_detail: ObservableFinalStatus
  blockers: string[]
  next_actions: string[]
  verification: {
    status: "passed" | "failed" | "not_run" | "partial" | "unknown"
    required: string[]
    passed: number
    failed: number
    not_run: number
    unknown: number
  }
  continuation: {
    status: "none" | "required" | "blocked_user" | "budget_exhausted" | "unknown"
    last_packet_id: string | null
    continuation_count: number
    blocking_unfinished: number
    requires_user_input: number
    budget_exhausted: boolean
  }
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
    blocked: number
    unverified: number
    stale: number
    reusable: number
    missing_evidence: number
    low_confidence: number
    unresolved: string[]
  }
  doctor: {
    status: "pass" | "warn" | "fail" | "unknown"
    pass_count: number | null
    warn_count: number | null
    fail_count: number | null
    latest_ref: string | null
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

function legacyTrajectoryEvent(event: FullTaskTrajectoryEvent) {
  return {
    ts: event.timestamp,
    type: event.type,
    summary: event.summary,
    evidence_ref: event.evidence_ref ?? event.event_id,
  }
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

function payloadRecord(entry: EvidenceEntry | undefined) {
  return entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown>
    : {}
}

function latestOf(entries: EvidenceEntry[], type: string) {
  return entries.findLast((entry) => entry.type === type)
}

function latestContinuation(entries: EvidenceEntry[]) {
  return entries.findLast((entry) =>
    entry.type === "continuation_gate.blocked" ||
    entry.type === "continuation_gate.budget_exhausted" ||
    entry.type === "continuation_gate.dispatched" ||
    entry.type === "continuation_gate.consumed",
  )
}

function packetFromPayload(payload: Record<string, unknown>) {
  const packet = payload.continuation_packet
  return packet && typeof packet === "object" && !Array.isArray(packet)
    ? packet as Record<string, unknown>
    : {}
}

function arrayCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0
}

function doctorStatus(entries: EvidenceEntry[]): TaskObservabilityReport["doctor"] {
  const latest = latestOf(entries, "doctor.run")
  if (!latest) {
    return { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null }
  }
  const payload = payloadRecord(latest)
  const overall = String(payload.overall ?? "unknown").toLowerCase()
  return {
    status: overall === "fail" ? "fail" : overall === "warn" ? "warn" : overall === "pass" ? "pass" : "unknown",
    pass_count: typeof payload.passCount === "number" ? payload.passCount : null,
    warn_count: typeof payload.warnCount === "number" ? payload.warnCount : null,
    fail_count: typeof payload.failCount === "number" ? payload.failCount : null,
    latest_ref: `doctor.run@${latest.ts}`,
  }
}

function verificationStatus(input: {
  required: string[]
  passed: number
  failed: number
  notRun: number
  unknown: number
}): TaskObservabilityReport["verification"]["status"] {
  if (input.failed > 0) return "failed"
  if (input.notRun > 0) return "not_run"
  if (input.required.length > 0 && input.passed === 0) return "not_run"
  if (input.passed > 0 && input.unknown > 0) return "partial"
  if (input.passed > 0) return "passed"
  if (input.unknown > 0) return "unknown"
  return input.required.length > 0 ? "not_run" : "unknown"
}

function finalStatus(input: {
  blockers: string[]
  goalPending: string[]
  verification: TaskObservabilityReport["verification"]
  doctor: TaskObservabilityReport["doctor"]
  continuation: TaskObservabilityReport["continuation"]
  results: Pick<TaskObservabilityReport["results"], "verified" | "partial" | "failed" | "blocked" | "unverified" | "stale" | "missing_evidence" | "low_confidence">
}): ObservableFinalStatus {
  if (input.doctor.status === "fail") return "FAILED"
  if (input.continuation.status === "budget_exhausted") return "BLOCKED_BUDGET_EXHAUSTED"
  if (input.continuation.status === "blocked_user") return "BLOCKED_USER_REQUIRED"
  if (input.blockers.length > 0 || input.goalPending.length > 0) return "CONTINUATION_REQUIRED"
  if (input.results.failed > 0 || input.results.blocked > 0) return "CONTINUATION_REQUIRED"
  if (input.results.stale > 0 || input.results.partial > 0) return "CONTINUATION_REQUIRED"
  if (input.results.unverified > 0 || input.results.missing_evidence > 0 || input.results.low_confidence > 0) return "UNVERIFIED_PARTIAL"
  if (input.verification.status === "failed") return "FAILED"
  if (input.verification.status === "not_run" || input.verification.status === "unknown" || input.verification.status === "partial") return "UNVERIFIED_PARTIAL"
  if (input.results.verified > 0 && input.verification.status === "passed") return "VERIFIED_COMPLETE"
  return "UNKNOWN"
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
  const verificationResults = results.flatMap((result) => result.verification_results)
  const verificationPassed = verificationResults.filter((item) => item.status === "passed").length
  const verificationFailed = verificationResults.filter((item) => item.status === "failed").length
  const verificationNotRun = verificationResults.filter((item) => item.status === "not_run").length
  const verificationUnknown = Math.max(0, verificationResults.length - verificationPassed - verificationFailed - verificationNotRun)
  const doctor = doctorStatus(evidence)
  const continuationEvidence = latestContinuation(evidence)
  const continuationPayload = payloadRecord(continuationEvidence)
  const continuationPacket = packetFromPayload(continuationPayload)
  const continuationStatus: TaskObservabilityReport["continuation"]["status"] =
    continuationEvidence?.type === "continuation_gate.budget_exhausted"
      ? "budget_exhausted"
      : String(continuationPacket.final_status ?? "").includes("BLOCKED_USER_REQUIRED")
        ? "blocked_user"
        : continuationEvidence?.type === "continuation_gate.blocked" || continuationEvidence?.type === "continuation_gate.dispatched"
          ? "required"
          : continuationEvidence ? "unknown" : "none"
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
    doctor.status === "fail" ? "Fix doctor failed checks before final completion" : "",
    blockers.length > 0 ? "Resolve blocking items and rerun required verification" : "",
    goalPending.length > 0 ? `Continue active plan: ${goalPending[0]}` : "",
    supervisor.required_reviews.length > 0 ? `Complete required reviewer(s): ${supervisor.required_reviews.join(", ")}` : "",
    verificationFailed > 0 ? "Fix failed verification and rerun checks" : "",
    verificationNotRun > 0 || ((goal?.required_verification ?? []).length > 0 && verificationPassed === 0) ? "Run required verification" : "",
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
  const resultsSummary = {
    total: results.length,
    verified: results.filter((result) => result.completion_status === "VERIFIED_COMPLETE").length,
    partial: results.filter((result) => result.completion_status === "PARTIAL").length,
    failed: results.filter((result) => result.completion_status === "FAILED").length,
    blocked: results.filter((result) => result.completion_status === "BLOCKED").length,
    unverified: results.filter((result) => result.completion_status === "UNVERIFIED").length,
    stale: results.filter((result) => result.stale || result.completion_status === "STALE" || result.completion_status === "INVALIDATED").length,
    reusable: results.filter((result) => result.reusable && !result.stale).length,
    missing_evidence: results.filter((result) => result.evidence_refs.length === 0).length,
    low_confidence: results.filter((result) => result.structured_output_missing || result.confidence === "low").length,
    unresolved: resultUnresolved.slice(0, 8),
  }
  const verification = {
    status: verificationStatus({
      required: goal?.required_verification ?? [],
      passed: verificationPassed,
      failed: verificationFailed,
      notRun: verificationNotRun,
      unknown: verificationUnknown,
    }),
    required: goal?.required_verification ?? [],
    passed: verificationPassed,
    failed: verificationFailed,
    not_run: verificationNotRun,
    unknown: verificationUnknown,
  }
  const continuation = {
    status: continuationStatus,
    last_packet_id: typeof continuationPacket.packet_id === "string" ? continuationPacket.packet_id : supervisor.last_continuation_packet_id ?? null,
    continuation_count: supervisor.continuation_count ?? 0,
    blocking_unfinished: arrayCount(continuationPacket.blocking_unfinished),
    requires_user_input: arrayCount(continuationPacket.requires_user_input),
    budget_exhausted: continuationEvidence?.type === "continuation_gate.budget_exhausted",
  }
  const status = finalStatus({
    blockers,
    goalPending,
    verification,
    doctor,
    continuation,
    results: resultsSummary,
  })

  return redact({
    generated_at: new Date().toISOString(),
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    goal: goal?.user_goal ?? null,
    phase: supervisor.phase,
    risk: supervisor.risk,
    final_status: status,
    final_status_detail: status,
    blockers,
    next_actions: nextActions,
    verification,
    continuation,
    reviewers: {
      required: supervisor.required_reviews,
      completed: supervisor.completed_reviews,
      queued: supervisor.queued_reviewers ?? [],
      running: supervisor.running_reviewers ?? [],
    },
    results: {
      ...resultsSummary,
    },
    doctor,
    evidence: {
      total: evidence.length,
      by_type: evidenceByType(evidence),
      latest: buildTaskTrajectory({
        sessionID: input.sessionID,
        evidenceFile: input.evidenceFile,
        maxEvents: input.maxEvents ?? 8,
      }).map(legacyTrajectoryEvent),
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

export function buildTaskStatusLine(input: {
  report: Pick<TaskObservabilityReport, "goal" | "phase" | "risk" | "final_status_detail">
  width?: number
}) {
  const goal = input.report.goal ?? "not_available"
  const text = `task ${input.report.final_status_detail} | phase:${input.report.phase} | risk:${input.report.risk} | goal:${goal}`
  return text.slice(0, input.width ?? 160)
}

export function buildVerificationStatusLine(input: {
  report: Pick<TaskObservabilityReport, "verification" | "doctor">
  width?: number
}) {
  const v = input.report.verification
  const text = `verify ${v.status} | passed:${v.passed} failed:${v.failed} not_run:${v.not_run} required:${v.required.length} | doctor:${input.report.doctor.status}`
  return text.slice(0, input.width ?? 160)
}

export function buildResultLedgerStatusLine(input: {
  report: Pick<TaskObservabilityReport, "results" | "continuation">
  width?: number
}) {
  const r = input.report.results
  const c = input.report.continuation
  const text = `ledger total:${r.total} verified:${r.verified} partial:${r.partial} failed:${r.failed} blocked:${r.blocked} unverified:${r.unverified} stale:${r.stale} low_conf:${r.low_confidence} | continuation:${c.status}`
  return text.slice(0, input.width ?? 160)
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
    line("phase", `${report.phase} | risk=${report.risk} | status=${report.final_status_detail}`),
    line("verification", `${report.verification.status} | required=${report.verification.required.length} passed=${report.verification.passed} failed=${report.verification.failed} not_run=${report.verification.not_run} unknown=${report.verification.unknown}`),
    line("continuation", `${report.continuation.status} | packet=${report.continuation.last_packet_id ?? "not_available"} count=${report.continuation.continuation_count} blocking=${report.continuation.blocking_unfinished} user_input=${report.continuation.requires_user_input}`),
    line("doctor", `${report.doctor.status} | pass=${report.doctor.pass_count ?? "unknown"} warn=${report.doctor.warn_count ?? "unknown"} fail=${report.doctor.fail_count ?? "unknown"}`),
    line("reviewers", `required=[${report.reviewers.required.join(",")}] completed=[${report.reviewers.completed.join(",")}] queued=[${report.reviewers.queued.join(",")}] running=[${report.reviewers.running.join(",")}]`),
    line("results", `total=${report.results.total} verified=${report.results.verified} partial=${report.results.partial} failed=${report.results.failed} blocked=${report.results.blocked} unverified=${report.results.unverified} stale=${report.results.stale} reusable=${report.results.reusable} missing_evidence=${report.results.missing_evidence} low_confidence=${report.results.low_confidence}`),
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
