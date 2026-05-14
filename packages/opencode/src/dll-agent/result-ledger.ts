/**
 * dll-agent result-ledger.ts
 *
 * Structured result recording for multi-model collaboration.
 *
 * When a model (commander, reviewer, engineer) completes a subtask, it should
 * write a ResultPacket to the ledger. Subsequent models can query the ledger
 * to check what's already been done — avoiding duplicate work, token waste,
 * and result overwriting.
 *
 * Storage: ~/.dll-agent/sessions/{sessionID}/results.jsonl
 * Each line is a JSON ResultPacket record.
 *
 * Builds on: evidence.ts (redaction), continuation-gate.ts (ContinuationPacket pattern)
 * Consumed by: result-sufficiency-gate.ts, deduplication-gate.ts, supervisor.ts, gates.ts
 */
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { write as writeEvidence, redact } from "./evidence"
import type { SupervisorState, ReviewerRole, RiskLevel } from "./interfaces"

// ─── Result Packet Type ────────────────────────────────────────────────────

export type ResultCompletionStatus =
  | "VERIFIED_COMPLETE"   // task fully done, verified with real tool evidence
  | "PARTIAL"             // task partially done, gaps remain
  | "FAILED"              // task attempted but failed
  | "BLOCKED"             // task blocked by external factors
  | "UNVERIFIED"          // task done but verification not run
  | "STALE"               // task was done but code has since changed
  | "INVALIDATED"         // result invalidated by reviewer or new evidence

export interface ResultFileChange {
  filePath: string
  changeSummary: string
  hashAfter?: string
  mtimeMsAfter?: number
  sizeAfter?: number
}

export interface ResultArtifact {
  filePath: string
  artifactType: "code" | "test" | "log" | "report" | "doc" | "screenshot" | "browser_trace" | "audit_report" | "generated_script" | "command_log" | "other"
  purpose: string
}

export interface ResultCommandRun {
  command: string
  result: "passed" | "failed" | "not_run"
  exitCode?: number
  evidenceRef?: string
}

export interface ResultVerification {
  name: string           // e.g. "typecheck", "bun test", "doctor"
  status: "passed" | "failed" | "not_run"
  evidenceRef?: string
}

export interface ResultPacket {
  packet_type: "result_packet"
  packet_id: string
  task_id?: string
  subtask_id?: string
  /** Role that produced this result */
  executing_role: ReviewerRole | "commander" | "executor"
  /** Model that executed the work */
  model: string
  /** The original user's goal */
  user_goal: string
  /** The specific subtask's goal */
  subtask_goal: string
  /** What the executing model claims was achieved */
  claimed_result: string
  /** Structured completion status */
  completion_status: ResultCompletionStatus
  files_changed: ResultFileChange[]
  artifacts_produced: ResultArtifact[]
  commands_run: ResultCommandRun[]
  verification_results: ResultVerification[]
  /** References to evidence entries that back this result */
  evidence_refs: string[]
  unresolved_items: string[]
  known_risks: string[]
  /** Whether this result can be reused by a subsequent model */
  reusable: boolean
  /** Whether this result has gone stale (code changed since) */
  stale: boolean
  /** Hash of the result packet for deduplication */
  result_hash: string
  /** ISO timestamp of when the result was created */
  created_at: string
  /** If invalidated, why */
  invalidation_reason?: string
  /** If result was reused, reference to the original packet_id */
  reused_from?: string
  /** Context handoff packet used to produce this reviewer result */
  context_packet_id?: string | null
  /** True when a reviewer result was recorded without a context handoff packet */
  missing_context_packet?: boolean
  /** Runtime role-run envelope used to isolate same-model multi-role decisions */
  role_run_id?: string | null
  role_instance_id?: string | null
  action_fingerprint?: string | null
  /** Reviewer output normalization metadata */
  structured_output_missing?: boolean
  confidence?: "low" | "medium" | "high"
  raw_summary_ref?: string | null
  redacted_summary?: string | null
  source_kind?: "structured_reviewer_output" | "fallback_reviewer_output" | "dedup_reuse"
  /** Redaction status — always "redacted" after write */
  redaction_status: "redacted"
}

// ─── Storage ───────────────────────────────────────────────────────────────

export function resultLedgerPath(sessionID: string) {
  const root = process.env.DLL_AGENT_CONFIG_ROOT || path.join(os.homedir(), ".dll-agent")
  return path.join(root, "sessions", sessionID, "results.jsonl")
}

/**
 * Write a ResultPacket to the session's result ledger.
 * Each result is appended as one JSON line to results.jsonl.
 * Automatically redacts secrets before writing.
 */
export function writeResult(sessionID: string, packet: ResultPacket) {
  const target = resultLedgerPath(sessionID)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(
      target,
      JSON.stringify(redact(packet)) + "\n",
    )
    writeEvidence("result.produced", {
      packet_id: packet.packet_id,
      executing_role: packet.executing_role,
      completion_status: packet.completion_status,
      files_changed: packet.files_changed.length,
      artifacts: packet.artifacts_produced.length,
      context_packet_id: packet.context_packet_id ?? null,
      missing_context_packet: packet.missing_context_packet ?? false,
      role_run_id: packet.role_run_id ?? null,
      action_fingerprint: packet.action_fingerprint ?? null,
      structured_output_missing: packet.structured_output_missing ?? false,
      confidence: packet.confidence ?? null,
      source_kind: packet.source_kind ?? null,
      raw_summary_ref: packet.raw_summary_ref ?? null,
    }, sessionID)
  } catch {
    // Result ledger is diagnostic and must not block the session
  }
}

/**
 * Load all ResultPackets for a session.
 * Silently skips corrupted lines.
 */
export function loadResults(sessionID: string): ResultPacket[] {
  const target = resultLedgerPath(sessionID)
  const results: ResultPacket[] = []
  try {
    if (!fs.existsSync(target)) return results
    const lines = fs.readFileSync(target, "utf8").split("\n")
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.packet_type === "result_packet") {
          results.push(parsed as ResultPacket)
        }
      } catch {
        // Corrupted line — skip
      }
    }
  } catch {
    // File missing or unreadable — return empty
  }
  return results
}

/**
 * Query results by filter criteria.
 * All filter fields are optional; passed criteria are AND-combined.
 */
export function queryResults(
  sessionID: string,
  filter: {
    executing_role?: string
    completion_status?: ResultCompletionStatus
    task_id?: string
    subtask_id?: string
    /** Match results that touch any of these file paths */
    file_paths?: string[]
    /** Only return results newer than this (ISO timestamp) */
    since?: string
    /** Only return reusable results */
    reusable_only?: boolean
  } = {},
): ResultPacket[] {
  const results = loadResults(sessionID)
  return results.filter((r) => {
    if (filter.executing_role && r.executing_role !== filter.executing_role) return false
    if (filter.completion_status && r.completion_status !== filter.completion_status) return false
    if (filter.task_id && r.task_id !== filter.task_id) return false
    if (filter.subtask_id && r.subtask_id !== filter.subtask_id) return false
    if (filter.file_paths && filter.file_paths.length > 0) {
      const hasOverlap = filter.file_paths.some((fp) =>
        r.files_changed.some((fc) => fc.filePath.includes(fp) || fp.includes(fc.filePath)),
      )
      if (!hasOverlap) return false
    }
    if (filter.since && r.created_at < filter.since) return false
    if (filter.reusable_only) {
      if (!r.reusable) return false
      if (r.stale || r.completion_status === "STALE" || r.completion_status === "INVALIDATED") return false
    }
    return true
  })
}

/**
 * Mark a result as invalidated (stale, reviewer-overridden, or code-changed).
 * Does NOT modify the original file — it appends a new packet with
 * completion_status=INVALIDATED that references the original.
 */
export function invalidateResult(
  sessionID: string,
  originalPacketId: string,
  reason: string,
  invalidatedBy: string,
) {
  const all = loadResults(sessionID)
  const original = all.find((r) => r.packet_id === originalPacketId)
  if (!original) return

  const invalidated: ResultPacket = {
    packet_type: "result_packet",
    packet_id: `inv_${Date.now()}`,
    executing_role: original.executing_role,
    model: original.model,
    user_goal: original.user_goal,
    subtask_goal: original.subtask_goal,
    claimed_result: `RESULT INVALIDATED: ${reason}`,
    completion_status: "INVALIDATED",
    files_changed: original.files_changed,
    artifacts_produced: original.artifacts_produced,
    commands_run: original.commands_run,
    verification_results: original.verification_results,
    evidence_refs: [...original.evidence_refs, `invalidated_by:${invalidatedBy}`],
    unresolved_items: original.unresolved_items,
    known_risks: original.known_risks,
    reusable: false,
    stale: true,
    result_hash: original.result_hash,
    created_at: new Date().toISOString(),
    invalidation_reason: reason,
    reused_from: originalPacketId,
    redaction_status: "redacted",
  }
  writeResult(sessionID, invalidated)
  writeEvidence("result.invalidated", {
    original_packet_id: originalPacketId,
    reason,
    invalidated_by: invalidatedBy,
  }, sessionID)
}

/**
 * Generate a simple hash for result deduplication.
 * Uses a subset of fields that uniquely identify the work product.
 */
export function computeResultHash(packet: Omit<ResultPacket, "result_hash" | "packet_id" | "created_at">): string {
  const data = JSON.stringify({
    roles: packet.executing_role,
    goal: packet.user_goal.slice(0, 200),
    subtask: packet.subtask_goal.slice(0, 200),
    files: packet.files_changed.map((f) => f.filePath).sort(),
    verification: packet.verification_results.map((v) => `${v.name}=${v.status}`),
    status: packet.completion_status,
  })
  // Simple FNV-like hash in JS
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const chr = data.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return `res_${Math.abs(hash).toString(16).slice(0, 8)}`
}

export function snapshotFileChange(file: ResultFileChange, projectDir?: string): ResultFileChange {
  if (file.hashAfter && typeof file.mtimeMsAfter === "number" && typeof file.sizeAfter === "number") return file
  const fullPath = path.isAbsolute(file.filePath) ? file.filePath : path.join(projectDir ?? process.cwd(), file.filePath)
  try {
    if (!fs.existsSync(fullPath)) return file
    const stat = fs.statSync(fullPath)
    const hashAfter = file.hashAfter ?? crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")
    return {
      ...file,
      hashAfter,
      mtimeMsAfter: file.mtimeMsAfter ?? stat.mtimeMs,
      sizeAfter: file.sizeAfter ?? stat.size,
    }
  } catch {
    return file
  }
}

export function snapshotFileChanges(files: ResultFileChange[], projectDir?: string) {
  return files.map((file) => snapshotFileChange(file, projectDir))
}

/**
 * Build a summary of all completed results for injection into reviewer context.
 * Returns a condensed text block suitable for buildReviewerContext().
 */
export function buildResultsSummary(sessionID: string): string {
  const results = loadResults(sessionID)
  if (results.length === 0) return "No prior results in ledger."

  const completed = results.filter((r) => r.completion_status === "VERIFIED_COMPLETE")
  const partial = results.filter((r) => r.completion_status === "PARTIAL")
  const invalid = results.filter((r) =>
    r.completion_status === "INVALIDATED" || r.completion_status === "STALE",
  )

  const lines = ["[dll-agent result ledger summary]"]
  if (completed.length > 0) {
    lines.push(`Completed results (${completed.length}):`)
    for (const r of completed.slice(0, 5)) {
      lines.push(`  - [${r.executing_role}] ${r.subtask_goal.slice(0, 80)} | ${r.packet_id} | reusable=${r.reusable}`)
    }
  }
  if (partial.length > 0) {
    lines.push(`Partial results (${partial.length}):`)
    for (const r of partial.slice(0, 3)) {
      lines.push(`  - [${r.executing_role}] ${r.subtask_goal.slice(0, 80)} | gaps: ${r.unresolved_items.length}`)
    }
  }
  if (invalid.length > 0) {
    lines.push(`Invalidated results (${invalid.length}):`)
    for (const r of invalid.slice(0, 3)) {
      lines.push(`  - [${r.executing_role}] ${r.invalidation_reason?.slice(0, 80) ?? "unknown reason"}`)
    }
  }
  return lines.join("\n")
}

/**
 * Build a ResultPacket from a task completion event.
 * Used by supervisor.ts when markReviewerCompleted has structured output.
 */
export function buildResultPacket(params: {
  sessionID: string
  executing_role: ResultPacket["executing_role"]
  model: string
  user_goal: string
  subtask_goal: string
  claimed_result: string
  completion_status: ResultCompletionStatus
  files_changed?: ResultFileChange[]
  artifacts_produced?: ResultArtifact[]
  commands_run?: ResultCommandRun[]
  verification_results?: ResultVerification[]
  evidence_refs?: string[]
  unresolved_items?: string[]
  known_risks?: string[]
  result_hash?: string
  reused_from?: string
  context_packet_id?: string | null
  missing_context_packet?: boolean
  role_run_id?: string | null
  role_instance_id?: string | null
  action_fingerprint?: string | null
  structured_output_missing?: boolean
  confidence?: "low" | "medium" | "high"
  raw_summary_ref?: string | null
  redacted_summary?: string | null
  source_kind?: "structured_reviewer_output" | "fallback_reviewer_output" | "dedup_reuse"
  projectDir?: string
}): ResultPacket {
  const filesChanged = snapshotFileChanges(params.files_changed ?? [], params.projectDir)
  const packet: ResultPacket = {
    packet_type: "result_packet",
    packet_id: `res_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    executing_role: params.executing_role,
    model: params.model,
    user_goal: params.user_goal.slice(0, 500),
    subtask_goal: params.subtask_goal.slice(0, 500),
    claimed_result: params.claimed_result.slice(0, 500),
    completion_status: params.completion_status,
    files_changed: filesChanged,
    artifacts_produced: params.artifacts_produced ?? [],
    commands_run: params.commands_run ?? [],
    verification_results: params.verification_results ?? [],
    evidence_refs: params.evidence_refs ?? [],
    unresolved_items: params.unresolved_items ?? [],
    known_risks: params.known_risks ?? [],
    context_packet_id: params.context_packet_id,
    missing_context_packet: params.missing_context_packet,
    role_run_id: params.role_run_id,
    role_instance_id: params.role_instance_id,
    action_fingerprint: params.action_fingerprint,
    structured_output_missing: params.structured_output_missing,
    confidence: params.confidence,
    raw_summary_ref: params.raw_summary_ref,
    redacted_summary: params.redacted_summary,
    source_kind: params.source_kind,
    reusable: params.completion_status === "VERIFIED_COMPLETE",
    stale: false,
    result_hash: params.result_hash ?? computeResultHash({
      packet_type: "result_packet",
      executing_role: params.executing_role,
      model: params.model,
      user_goal: params.user_goal,
      subtask_goal: params.subtask_goal,
      claimed_result: params.claimed_result,
      completion_status: params.completion_status,
      files_changed: filesChanged,
      artifacts_produced: params.artifacts_produced ?? [],
      commands_run: params.commands_run ?? [],
      verification_results: params.verification_results ?? [],
      evidence_refs: params.evidence_refs ?? [],
      unresolved_items: params.unresolved_items ?? [],
      known_risks: params.known_risks ?? [],
      context_packet_id: params.context_packet_id,
      missing_context_packet: params.missing_context_packet,
      role_run_id: params.role_run_id,
      role_instance_id: params.role_instance_id,
      action_fingerprint: params.action_fingerprint,
      structured_output_missing: params.structured_output_missing,
      confidence: params.confidence,
      raw_summary_ref: params.raw_summary_ref,
      redacted_summary: params.redacted_summary,
      source_kind: params.source_kind,
      reusable: params.completion_status === "VERIFIED_COMPLETE",
      stale: false,
      redaction_status: "redacted",
    }),
    created_at: new Date().toISOString(),
    reused_from: params.reused_from,
    redaction_status: "redacted",
  }
  return packet
}

// ─── Evidence Record Types for Result Ledger ────────────────────────────────

/** Evidence record types that extend existing EvidenceRecordType in interfaces.ts */
export const RESULT_EVIDENCE_TYPES = [
  "result.produced",
  "result.reused",
  "result.invalidated",
  "result.dedup_blocked",
  "result.dedup_allowed",
  "result.stale_detected",
] as const
