import { redact } from "./evidence"
import { buildEvidenceSnapshot } from "./evidence-normalizer"
import { assessGoalCompletion, loadGoalContract, type GoalContract } from "./goal-contract"
import { loadResults, type ResultPacket, type ResultVerification } from "./result-ledger"
import type { ReviewerRole, RiskLevel, SupervisorMetricsSnapshot, SupervisorState } from "./interfaces"

export interface ContextHandoffPacket {
  packet_id: string
  packet_type: "context_handoff_packet"
  session_id: string
  task_id?: string
  target_role: string
  routing_reason: string
  risk_level: RiskLevel
  goal_contract_ref?: string
  user_goal: string
  success_criteria_status: {
    total: number
    satisfied: number
    unsatisfied: string[]
    unknown: string[]
  }
  active_plan_status: {
    total: number
    completed: number
    blocking_unfinished: string[]
    non_blocking_followup: string[]
  }
  changed_files: Array<{
    path: string
    summary?: string
  }>
  result_packet_refs: string[]
  evidence_refs: string[]
  verification_summary: Array<{
    name: string
    status: "passed" | "failed" | "not_run" | "unknown"
    evidence_ref?: string
  }>
  blocking_findings: Array<{
    source: string
    finding: string
    evidence_ref?: string
    required_action?: string
  }>
  required_actions: string[]
  stale_or_partial_results: string[]
  cooldown_or_budget_state?: {
    reviewer_cooldown?: string[]
    budget_remaining?: number
  }
  missing_context: string[]
  context_confidence: "low" | "medium" | "high"
  redaction_status: "redacted"
}

export interface BuildContextHandoffPacketInput {
  sessionID: string
  targetRole: ReviewerRole
  routingReason: string
  riskLevel: RiskLevel
  metrics: SupervisorMetricsSnapshot
  fallbackUserGoal?: string
  changedFiles?: Array<{ path: string; summary?: string }>
  state?: SupervisorState
  projectDir?: string
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 15))}...[truncated]`
}

function compactText(text: string, max = 240) {
  return truncate(
    text
      .replace(/\s+/g, " ")
      .replace(/\b([A-Za-z0-9_-]+)(?:\s+\1){5,}\b/gi, "$1 ...[repeated]")
      .trim(),
    max,
  )
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))]
}

function packetID(sessionID: string, targetRole: string) {
  return `ctx_${sessionID.slice(0, 12)}_${targetRole.replace(/[^a-z0-9_-]/gi, "_")}_${Date.now()}`
}

function successStatus(contract: GoalContract | null) {
  if (!contract) {
    return { total: 0, satisfied: 0, unsatisfied: [], unknown: [] }
  }
  const statusByDescription = new Map(contract.success_criteria_status.map((item) => [item.description, item]))
  const unknown: string[] = []
  const unsatisfied: string[] = []
  let satisfied = 0

  for (const criterion of contract.success_criteria) {
    const matched = contract.success_criteria_status.find((item) => item.description === criterion) ?? statusByDescription.get(criterion)
    if (!matched) {
      unknown.push(compactText(criterion))
      continue
    }
    if (matched.status === "satisfied" || matched.status === "non_blocking") {
      satisfied++
      continue
    }
    unsatisfied.push(compactText(matched.blocker ?? matched.description))
  }

  for (const item of contract.success_criteria_status) {
    if (contract.success_criteria.includes(item.description)) continue
    if (item.status === "satisfied" || item.status === "non_blocking") satisfied++
    else unsatisfied.push(compactText(item.blocker ?? item.description))
  }

  return {
    total: contract.success_criteria.length || contract.success_criteria_status.length,
    satisfied,
    unsatisfied: unique(unsatisfied).slice(0, 8),
    unknown: unique(unknown).slice(0, 8),
  }
}

function activePlanStatus(contract: GoalContract | null) {
  if (!contract) {
    return { total: 0, completed: 0, blocking_unfinished: [], non_blocking_followup: [] }
  }
  return {
    total: contract.active_plan.length,
    completed: contract.active_plan.filter((item) => item.status === "completed").length,
    blocking_unfinished: contract.active_plan
      .filter((item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked")
      .map((item) => compactText(item.blocker ?? item.description))
      .slice(0, 8),
    non_blocking_followup: contract.active_plan
      .filter((item) => item.status === "non_blocking")
      .map((item) => compactText(item.description))
      .slice(0, 8),
  }
}

function resultVerification(results: ResultPacket[], contract: GoalContract | null) {
  const seen = new Set<string>()
  const summary: ContextHandoffPacket["verification_summary"] = []
  for (const result of results) {
    for (const verification of result.verification_results) {
      const key = `${verification.name}:${verification.status}:${verification.evidenceRef ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      summary.push({
        name: compactText(verification.name, 160),
        status: verification.status,
        evidence_ref: verification.evidenceRef,
      })
    }
  }
  if (summary.length > 0) return summary.slice(0, 12)
  return (contract?.required_verification ?? []).slice(0, 8).map((name): ContextHandoffPacket["verification_summary"][number] => ({
    name: compactText(name, 160),
    status: "not_run" as const,
  }))
}

function resultChangedFiles(results: ResultPacket[], seed: Array<{ path: string; summary?: string }>) {
  const byPath = new Map<string, { path: string; summary?: string }>()
  for (const file of seed) {
    if (file.path) byPath.set(file.path, { path: file.path, summary: file.summary ? compactText(file.summary) : undefined })
  }
  for (const result of results) {
    for (const file of result.files_changed) {
      if (!file.filePath) continue
      byPath.set(file.filePath, {
        path: file.filePath,
        summary: compactText(file.changeSummary || result.subtask_goal),
      })
    }
  }
  return [...byPath.values()].slice(0, 10)
}

function blockingFindings(input: {
  results: ResultPacket[]
  state?: SupervisorState
  evidenceBlockers: string[]
}) {
  const findings: ContextHandoffPacket["blocking_findings"] = []
  if (input.state?.blocked_completion && input.state.block_reason) {
    findings.push({
      source: "supervisor",
      finding: compactText(input.state.block_reason),
      evidence_ref: "supervisor.blocked",
      required_action: "resolve reviewer or gate blocker before final completion",
    })
  }
  for (const blocker of input.evidenceBlockers.slice(0, 6)) {
    findings.push({
      source: "evidence",
      finding: compactText(blocker),
      evidence_ref: "evidence.snapshot",
      required_action: "repair failing evidence and rerun verification",
    })
  }
  for (const result of input.results) {
    if (result.completion_status !== "BLOCKED" && result.completion_status !== "FAILED" && result.completion_status !== "PARTIAL") continue
    findings.push({
      source: `result:${result.packet_id}`,
      finding: compactText(result.unresolved_items.join("; ") || result.claimed_result),
      evidence_ref: `result:${result.packet_id}`,
      required_action: result.completion_status === "PARTIAL" ? "continue from partial result" : "repair failed or blocked result",
    })
  }
  return findings.slice(0, 10)
}

function confidence(missing: string[], verification: ContextHandoffPacket["verification_summary"], blockers: ContextHandoffPacket["blocking_findings"]) {
  if (missing.includes("user_goal")) return "low"
  if (missing.includes("goal_contract") || verification.length === 0) return "medium"
  if (verification.some((item) => item.status === "failed" || item.status === "not_run" || item.status === "unknown")) return "medium"
  if (blockers.length > 0) return "medium"
  return "high"
}

export function buildContextHandoffPacket(input: BuildContextHandoffPacketInput): ContextHandoffPacket {
  const contract = loadGoalContract(input.sessionID)
  const results = loadResults(input.sessionID)
  const evidence = buildEvidenceSnapshot({
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    toolEvidence: input.metrics.real_tool_evidence || input.metrics.verification_evidence,
  })
  const missing: string[] = []
  if (!contract) missing.push("goal_contract")
  const userGoal = contract?.user_goal || compactText(input.fallbackUserGoal ?? "", 1_500)
  if (!userGoal) missing.push("user_goal")

  const verification = resultVerification(results, contract)
  if (verification.length === 0) missing.push("verification_summary")
  const blockers = blockingFindings({
    results,
    state: input.state,
    evidenceBlockers: evidence.blockers,
  })
  const assessment = contract
    ? assessGoalCompletion({
        contract,
        verificationResults: verification.map((item) => ({
          name: item.name,
          status: item.status === "unknown" ? "not_run" : item.status,
          evidenceRef: item.evidence_ref,
        })),
        resultStatuses: results.map((item) => item.completion_status),
        blockers: blockers.map((item) => item.finding),
      })
    : null
  const requiredActions = unique([
    ...(assessment?.required_next_actions ?? []),
    ...blockers.flatMap((item) => item.required_action ? [item.required_action] : []),
  ]).map((item) => compactText(item)).slice(0, 10)
  if (requiredActions.length === 0 && blockers.length > 0) requiredActions.push("resolve blocking findings")

  const packet: ContextHandoffPacket = {
    packet_id: packetID(input.sessionID, input.targetRole),
    packet_type: "context_handoff_packet",
    session_id: input.sessionID,
    task_id: contract?.task_id,
    target_role: input.targetRole,
    routing_reason: compactText(input.routingReason, 240),
    risk_level: input.riskLevel,
    goal_contract_ref: contract ? `goal_contract:${contract.task_id}` : undefined,
    user_goal: userGoal || "(missing user goal)",
    success_criteria_status: successStatus(contract),
    active_plan_status: activePlanStatus(contract),
    changed_files: resultChangedFiles(results, input.changedFiles ?? []),
    result_packet_refs: results.slice(-12).map((result) => result.packet_id),
    evidence_refs: unique([
      ...(contract?.evidence_refs ?? []),
      ...evidence.evidence_refs,
      ...results.flatMap((result) => [`result:${result.packet_id}`, ...result.evidence_refs]),
    ]).slice(0, 24),
    verification_summary: verification,
    blocking_findings: blockers,
    required_actions: requiredActions,
    stale_or_partial_results: results
      .filter((result) => result.stale || result.completion_status === "STALE" || result.completion_status === "PARTIAL" || result.completion_status === "UNVERIFIED" || result.completion_status === "FAILED" || result.completion_status === "INVALIDATED")
      .map((result) => `${result.packet_id}:${result.completion_status}`)
      .slice(0, 10),
    cooldown_or_budget_state: input.state?.required_reviews.length || input.state?.queued_reviewers?.length
      ? {
          reviewer_cooldown: unique([
            ...(input.state.required_reviews ?? []),
            ...((input.state.queued_reviewers ?? []) as string[]),
          ]).slice(0, 8),
        }
      : undefined,
    missing_context: unique(missing),
    context_confidence: "medium",
    redaction_status: "redacted",
  }
  packet.context_confidence = confidence(packet.missing_context, packet.verification_summary, packet.blocking_findings)
  return redact(packet) as ContextHandoffPacket
}

function list(title: string, items: string[], empty = "- none") {
  return [`${title}:`, ...(items.length ? items.map((item) => `- ${item}`) : [empty])]
}

function renderVerification(items: ContextHandoffPacket["verification_summary"]) {
  return items.map((item) => `- ${item.name}: ${item.status}${item.evidence_ref ? ` (${item.evidence_ref})` : ""}`)
}

function renderBlockers(items: ContextHandoffPacket["blocking_findings"]) {
  return items.map((item) => `- [${item.source}] ${item.finding}${item.required_action ? ` | action: ${item.required_action}` : ""}${item.evidence_ref ? ` | evidence: ${item.evidence_ref}` : ""}`)
}

function renderWithinLimit(priority: string[], optional: string[], maxChars: number) {
  const out: string[] = []
  for (const line of priority) out.push(line)
  for (const line of optional) {
    const next = [...out, line].join("\n")
    if (next.length > maxChars) break
    out.push(line)
  }
  return truncate(out.join("\n"), maxChars)
}

export function renderHandoffForRole(packet: ContextHandoffPacket, role: ReviewerRole, maxChars = 5_000): string {
  const priority = [
    `[context-handoff-packet v1] ${packet.packet_id}`,
    `target_role: ${packet.target_role}`,
    `routing_reason: ${packet.routing_reason}`,
    `risk_level: ${packet.risk_level}`,
    `context_confidence: ${packet.context_confidence}`,
    `goal_contract_ref: ${packet.goal_contract_ref ?? "missing"}`,
    ``,
    `Original user goal:`,
    truncate(packet.user_goal, 520),
    ``,
    `Success criteria: total=${packet.success_criteria_status.total} satisfied=${packet.success_criteria_status.satisfied}`,
    ...list("Unsatisfied criteria", packet.success_criteria_status.unsatisfied.slice(0, 6)),
    ...list("Unknown criteria", packet.success_criteria_status.unknown.slice(0, 6)),
    ``,
    `Active plan: total=${packet.active_plan_status.total} completed=${packet.active_plan_status.completed}`,
    ...list("Blocking unfinished", packet.active_plan_status.blocking_unfinished.slice(0, 6)),
    ``,
    ...list("Verification summary", renderVerification(packet.verification_summary).slice(0, 8)),
    ``,
    ...list("Blocking findings", renderBlockers(packet.blocking_findings).slice(0, 8)),
    ``,
    ...list("Required actions", packet.required_actions.slice(0, 8)),
    ``,
    ...list("Result packet refs", packet.result_packet_refs.slice(0, 10)),
    ...list("Evidence refs", packet.evidence_refs.slice(0, 12)),
  ]

  const roleLines: Record<ReviewerRole, string[]> = {
    "requirements-inspector": [
      ``,
      `[role focus: requirements-inspector]`,
      `Check alignment with original goal, success criteria, user corrections, scope drift, and blocking unfinished work.`,
      ...list("Non-blocking follow-up", packet.active_plan_status.non_blocking_followup.slice(0, 5)),
      ...list("Missing context", packet.missing_context),
    ],
    "chief-engineer": [
      ``,
      `[role focus: chief-engineer]`,
      `Diagnose failures, changed files, stale/partial results, and concrete repair actions.`,
      ...list("Changed files", packet.changed_files.map((file) => `${file.path}${file.summary ? ` — ${file.summary}` : ""}`).slice(0, 8)),
      ...list("Stale or partial results", packet.stale_or_partial_results),
    ],
    "long-context-archivist": [
      ``,
      `[role focus: long-context-archivist]`,
      `Preserve task timeline, result refs, missing context, and continuation items without replaying full history.`,
      ...list("Missing context", packet.missing_context),
      ...list("Non-blocking follow-up", packet.active_plan_status.non_blocking_followup.slice(0, 5)),
    ],
    "task-completion-archivist": [
      ``,
      `[role focus: task-completion-archivist]`,
      `Classify unfinished work and produce continuation only for blocking items.`,
      ...list("Non-blocking follow-up", packet.active_plan_status.non_blocking_followup.slice(0, 5)),
      ...list("Missing context", packet.missing_context),
    ],
    "final-auditor": [
      ``,
      `[role focus: final-auditor]`,
      `Audit completion claims against success criteria, verification, blockers, result refs, and evidence refs.`,
      ...list("Stale or partial results", packet.stale_or_partial_results),
      ...list("Missing context", packet.missing_context),
    ],
    "role-cross": [
      ``,
      `[role focus: role-cross]`,
      `Resolve conflicting findings and decide what evidence-backed action is needed next.`,
      ...list("Stale or partial results", packet.stale_or_partial_results),
      ...list("Missing context", packet.missing_context),
    ],
    "multimodal-context-interpreter": [
      ``,
      `[role focus: multimodal-context-interpreter]`,
      `Use this packet only to align non-text observations with the current goal and evidence refs.`,
      ...list("Missing context", packet.missing_context),
    ],
  }

  const optional = [
    ...(roleLines[role] ?? []),
    ``,
    `Redaction status: ${packet.redaction_status}`,
  ]
  return renderWithinLimit(priority, optional, maxChars)
}

export function summarizeContextHandoffPacket(packet: ContextHandoffPacket) {
  return {
    packet_id: packet.packet_id,
    target_role: packet.target_role,
    task_id: packet.task_id ?? null,
    context_confidence: packet.context_confidence,
    missing_context: packet.missing_context,
    evidence_refs: packet.evidence_refs.length,
    result_packet_refs: packet.result_packet_refs.length,
    blocking_findings: packet.blocking_findings.length,
    required_actions: packet.required_actions.length,
  }
}
