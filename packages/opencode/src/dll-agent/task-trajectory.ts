import { readEntries, redact, type Entry as EvidenceEntry } from "./evidence"
import { loadResults } from "./result-ledger"
import type { RiskLevel } from "./interfaces"

export interface TaskTrajectoryEvent {
  event_id: string
  timestamp: string
  task_id?: string
  session_id?: string
  type: string
  summary: string
  evidence_ref?: string
  related_refs?: string[]
  risk_level?: RiskLevel
  redaction_status: "redacted"
}

function payloadRecord(entry: EvidenceEntry | undefined) {
  return entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown>
    : {}
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : []
}

function eventType(type: string) {
  if (type === "goal.created" || type.startsWith("goal.")) return "goal.created"
  if (type === "model.routing_decision") return "routing.decision"
  if (type === "result.produced") return "result.produced"
  if (type === "result.reused" || type === "dedup.reused" || type === "dedup.blocked") return "result.reused"
  if (type === "result.stale") return "result.stale"
  if (type.startsWith("recovery.failure")) return "failure.classified"
  if (type === "recovery.decision") return "recovery.decision"
  if (type.includes("reviewer") && type.includes("trigger")) return "reviewer.triggered"
  if (type.includes("reviewer") && type.includes("completed")) return "reviewer.completed"
  if (type === "continuation_gate.blocked" || type === "continuation_gate.dispatched") return "continuation.required"
  if (type === "gate.blocked_completion" || type === "final.gate.blocked") return "final.gate.blocked"
  if (type === "final.verified") return "final.verified"
  if (type.startsWith("permission.") || type === "role_tool_policy.decision") return "permission.decision"
  if (type.startsWith("capability.")) return "capability.loaded"
  if (type.startsWith("mcp.")) return "mcp.status"
  if (type.startsWith("lsp.")) return "lsp.prewarm"
  if (type === "doctor.run") return "doctor.run"
  if (type.includes("tool") || type.includes("command")) return type.includes("failed") ? "command.failed" : "tool.called"
  return type
}

function summaryFor(entry: EvidenceEntry) {
  const payload = payloadRecord(entry)
  if (entry.type === "model.routing_decision") {
    return `${String(payload.role ?? "role")} ${String(payload.action ?? "decision")} ${String(payload.selected_model ?? "model_unknown")}`
  }
  if (entry.type === "doctor.run") {
    return `doctor ${String(payload.overall ?? "unknown")} ${String(payload.passCount ?? "?")}P/${String(payload.warnCount ?? "?")}W/${String(payload.failCount ?? "?")}F`
  }
  if (entry.type.startsWith("recovery.")) return String(payload.reason ?? payload.failure_type ?? payload.action ?? entry.type)
  if (entry.type.startsWith("result.") || entry.type.startsWith("dedup.")) {
    return String(payload.packet_id ?? payload.result_ref ?? payload.reason ?? entry.type)
  }
  if (entry.type.startsWith("gate.") || entry.type.startsWith("continuation_gate.")) {
    return String(payload.block_reason ?? payload.reason ?? payload.final_status ?? entry.type)
  }
  return String(payload.summary ?? payload.reason ?? payload.action ?? entry.type)
}

function relatedRefs(payload: Record<string, unknown>) {
  return [
    ...stringArray(payload.evidence_refs),
    ...stringArray(payload.result_refs),
    ...stringArray(payload.context_packet_refs),
    typeof payload.packet_id === "string" ? payload.packet_id : "",
    typeof payload.context_packet_id === "string" ? payload.context_packet_id : "",
  ].filter(Boolean).slice(0, 12)
}

function riskLevel(payload: Record<string, unknown>): RiskLevel | undefined {
  const risk = payload.risk_level ?? payload.risk
  return risk === "low" || risk === "medium" || risk === "high" ? risk : undefined
}

export function buildTaskTrajectory(input: {
  sessionID: string
  evidenceFile?: string
  maxEvents?: number
}): TaskTrajectoryEvent[] {
  const evidenceEvents = readEntries(input.evidenceFile)
    .filter((entry) => entry.sessionID === input.sessionID)
    .map((entry, index) => {
      const payload = payloadRecord(entry)
      return redact({
        event_id: `${eventType(entry.type)}:${entry.ts}:${index}`,
        timestamp: entry.ts,
        task_id: typeof payload.task_id === "string" ? payload.task_id : undefined,
        session_id: entry.sessionID,
        type: eventType(entry.type),
        summary: summaryFor(entry).slice(0, 240),
        evidence_ref: `${entry.type}@${entry.ts}`,
        related_refs: relatedRefs(payload),
        risk_level: riskLevel(payload),
        redaction_status: "redacted",
      } satisfies TaskTrajectoryEvent) as TaskTrajectoryEvent
    })

  const resultEvents = loadResults(input.sessionID).map((result, index) => redact({
    event_id: `result.produced:${result.created_at}:${index}`,
    timestamp: result.created_at,
    task_id: result.task_id,
    session_id: input.sessionID,
    type: result.reused_from ? "result.reused" : result.stale ? "result.stale" : "result.produced",
    summary: `${result.executing_role} ${result.completion_status} ${result.packet_id}`.slice(0, 240),
    evidence_ref: `result:${result.packet_id}`,
    related_refs: [result.packet_id, result.context_packet_id ?? "", ...result.evidence_refs].filter(Boolean).slice(0, 12),
    redaction_status: "redacted",
  } satisfies TaskTrajectoryEvent) as TaskTrajectoryEvent)

  return [...evidenceEvents, ...resultEvents]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-(input.maxEvents ?? 50))
}

export function renderTaskTrajectory(input: {
  sessionID: string
  evidenceFile?: string
  maxEvents?: number
  maxChars?: number
}) {
  const events = buildTaskTrajectory(input)
  const lines = [
    "dll-agent task trajectory",
    `session: ${input.sessionID}`,
    `events: ${events.length}`,
    "",
    ...events.map((event) => {
      const refs = event.related_refs?.length ? ` refs=${event.related_refs.join(",")}` : ""
      return `- ${event.timestamp} ${event.type}: ${event.summary}${refs}`
    }),
  ]
  return lines.join("\n").slice(0, input.maxChars ?? 5_000)
}

export * as TaskTrajectory from "./task-trajectory"
