/**
 * dll-agent result-sufficiency-gate.ts
 *
 * Evaluates whether an existing ResultPacket is sufficient for a downstream task.
 * Called before any model starts work on a subtask that might overlap with
 * already-completed results.
 *
 * Builds on: result-ledger.ts
 * Consumed by: deduplication-gate.ts, supervisor.ts
 */
import {
  loadResults,
  queryResults,
  type ResultPacket,
  type ResultCompletionStatus,
} from "./result-ledger"
import fs from "fs"
import path from "path"
import crypto from "crypto"

// ─── Sufficiency Verdict ───────────────────────────────────────────────────

export type SufficiencyVerdict =
  | "sufficient"                    // Result is complete and verified — reuse
  | "sufficient_but_unverified"     // Result exists but needs verification
  | "partial"                       // Result partially complete — continue from gaps
  | "partial_with_gaps"             // Result exists but explicit gaps remain
  | "failed_with_diagnosis"         // Result failed but has diagnostic info
  | "stale"                         // Result exists but code has changed since
  | "insufficient"                  // Result exists but doesn't cover required scope
  | "none"                          // No prior result exists
  | "conflict"                      // Prior result conflicts with current goal
  | "invalidated"                   // Prior result has been explicitly invalidated

export type ResultSufficiencyAction =
  | "reuse_existing"
  | "verify_existing"
  | "continue_from_existing"
  | "repair_existing"
  | "redo_allowed"
  | "blocked_missing_evidence"
  | "blocked_stale"
  | "blocked_context_insufficient"
  | "no_existing_result"

export interface SufficiencyCheck {
  verdict: SufficiencyVerdict
  /** The result packets that match the query */
  matchingResults: ResultPacket[]
  /** Best result to reuse (highest completion status, most recent) */
  bestResult: ResultPacket | null
  /** Whether the existing result can be safely reused */
  canReuse: boolean
  /** What actions are needed before the result can be reused */
  neededActions: string[]
  /** What part of the task is already covered */
  coveredScope: string[]
  /** What gaps remain (if partial) */
  remainingGaps: string[]
  /** Evidence that supports the sufficiency decision */
  evidenceRefs: string[]
  /** Why a candidate was treated as stale */
  staleReasons?: string[]
  /** Dispatch/recovery level action derived from the verdict */
  action: ResultSufficiencyAction
}

// ─── Sufficiency Check ─────────────────────────────────────────────────────

/**
 * Check if existing results are sufficient for a given task goal.
 *
 * @param sessionID — current session
 * @param taskGoal — what the downstream model needs to accomplish
 * @param requiredFilePaths — files that must be touched/modified/checked
 * @param requiredVerifications — verification commands that must pass
 */
export function checkResultSufficiency(
  sessionID: string,
  taskGoal: string,
  options?: {
    requiredFilePaths?: string[]
    requiredVerifications?: string[]
    /** Only consider results newer than this */
    maxAgeMinutes?: number
    /** Project root used to resolve relative file paths for hash staleness checks */
    projectDir?: string
  },
): SufficiencyCheck {
  const queried = queryResults(sessionID, {
    file_paths: options?.requiredFilePaths,
    // Include all results (not just reusable) — staleness/invalidation is checked below
    reusable_only: false,
  })
  const results = options?.requiredFilePaths?.length ? queried : queried.filter((packet) => matchesTaskGoal(packet, taskGoal))

  if (results.length === 0) {
    return {
      verdict: "none",
      matchingResults: [],
      bestResult: null,
      canReuse: false,
      neededActions: ["Execute task from scratch — no prior results"],
      coveredScope: [],
      remainingGaps: [taskGoal],
      evidenceRefs: [],
      action: "no_existing_result",
    }
  }

  // Sort: VERIFIED_COMPLETE > PARTIAL > FAILED, then most recent first
  const statusRank: Record<ResultCompletionStatus, number> = {
    VERIFIED_COMPLETE: 5,
    PARTIAL: 3,
    FAILED: 2,
    UNVERIFIED: 4,
    BLOCKED: 1,
    STALE: 0,
    INVALIDATED: -1,
  }

  const sorted = [...results].sort((a, b) => {
    const rankDiff = (statusRank[b.completion_status] ?? 0) - (statusRank[a.completion_status] ?? 0)
    if (rankDiff !== 0) return rankDiff
    return b.created_at.localeCompare(a.created_at)
  })

  const bestResult = sorted[0]

  // Check staleness: if result is marked stale/invalidated
  if (bestResult.completion_status === "STALE" || bestResult.completion_status === "INVALIDATED") {
    return {
      verdict: "invalidated",
      matchingResults: sorted,
      bestResult,
      canReuse: false,
      neededActions: [`Result invalidated: ${bestResult.invalidation_reason ?? "unknown reason"}`],
      coveredScope: [],
      remainingGaps: [taskGoal],
      evidenceRefs: bestResult.evidence_refs,
      action: "redo_allowed",
    }
  }

  const staleReasons = resultStaleReasons(bestResult, options?.projectDir)
  if (staleReasons.length > 0) {
    return {
      verdict: "stale",
      matchingResults: sorted,
      bestResult,
      canReuse: false,
      neededActions: ["Result files changed — re-verify or redo"],
      coveredScope: bestResult.files_changed.map((f) => f.filePath),
      remainingGaps: [taskGoal],
      evidenceRefs: bestResult.evidence_refs,
      staleReasons,
      action: "blocked_stale",
    }
  }

  // Check staleness: if max age exceeded
  if (options?.maxAgeMinutes) {
    const cutoff = new Date(Date.now() - options.maxAgeMinutes * 60 * 1000)
    if (new Date(bestResult.created_at) < cutoff) {
      return {
        verdict: "stale",
        matchingResults: sorted,
        bestResult,
        canReuse: false,
        neededActions: ["Result too old — regenerate or re-verify"],
        coveredScope: bestResult.files_changed.map((f) => f.filePath),
        remainingGaps: [taskGoal],
        evidenceRefs: bestResult.evidence_refs,
        action: "blocked_stale",
      }
    }
  }

  // VERIFIED_COMPLETE → sufficient
  if (bestResult.completion_status === "VERIFIED_COMPLETE") {
    if (!hasReusableEvidence(bestResult)) {
      return {
        verdict: "sufficient_but_unverified",
        matchingResults: sorted,
        bestResult,
        canReuse: true,
        neededActions: ["Run verification before claiming completion"],
        coveredScope: bestResult.files_changed.map((f) => f.filePath),
        remainingGaps: ["Verified result packet is missing evidence refs or passed verification"],
        evidenceRefs: bestResult.evidence_refs,
        action: "blocked_missing_evidence",
      }
    }
    return {
      verdict: "sufficient",
      matchingResults: sorted,
      bestResult,
      canReuse: true,
      neededActions: ["Review existing result for applicability", "No re-execution needed"],
      coveredScope: bestResult.files_changed.map((f) => f.filePath),
      remainingGaps: [],
      evidenceRefs: bestResult.evidence_refs,
      action: "reuse_existing",
    }
  }

  // UNVERIFIED → sufficient but needs verification before reuse
  if (bestResult.completion_status === "UNVERIFIED") {
    return {
      verdict: "sufficient_but_unverified",
      matchingResults: sorted,
      bestResult,
      canReuse: true,
      neededActions: ["Run verification before claiming completion"],
      coveredScope: bestResult.files_changed.map((f) => f.filePath),
      remainingGaps: bestResult.verification_results
        .filter((v) => v.status !== "passed")
        .map((v) => `Verification needed: ${v.name}`),
      evidenceRefs: bestResult.evidence_refs,
      action: "verify_existing",
    }
  }

  // PARTIAL → continue from gaps
  if (bestResult.completion_status === "PARTIAL") {
    return {
      verdict: "partial",
      matchingResults: sorted,
      bestResult,
      canReuse: true,
      neededActions: bestResult.unresolved_items,
      coveredScope: bestResult.files_changed.map((f) => f.filePath),
      remainingGaps: bestResult.unresolved_items,
      evidenceRefs: bestResult.evidence_refs,
      action: "continue_from_existing",
    }
  }

  // FAILED → has diagnosis, continue from failure point
  if (bestResult.completion_status === "FAILED") {
    return {
      verdict: "failed_with_diagnosis",
      matchingResults: sorted,
      bestResult,
      canReuse: false,
      neededActions: ["Review failure diagnosis", "Fix root cause before re-executing"],
      coveredScope: [],
      remainingGaps: [taskGoal],
      evidenceRefs: bestResult.evidence_refs,
      action: "repair_existing",
    }
  }

  // BLOCKED → similar to failed
  if (bestResult.completion_status === "BLOCKED") {
    return {
      verdict: "insufficient",
      matchingResults: sorted,
      bestResult,
      canReuse: false,
      neededActions: ["Block reason must be resolved first"],
      coveredScope: [],
      remainingGaps: [taskGoal],
      evidenceRefs: bestResult.evidence_refs,
      action: "blocked_context_insufficient",
    }
  }

  // Fallback
  return {
    verdict: "none",
    matchingResults: results,
    bestResult: null,
    canReuse: false,
    neededActions: ["Execute task from scratch"],
    coveredScope: [],
    remainingGaps: [taskGoal],
    evidenceRefs: [],
    action: "no_existing_result",
  }
}

/**
 * Check if a result packet has gone stale.
 * Currently checks timestamp-based staleness only.
 * In future: compare file hashes against current git state.
 */
export function isResultStale(packet: ResultPacket, maxAgeMinutes: number = 60): boolean {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000)
  if (new Date(packet.created_at) < cutoff) return true
  if (packet.stale) return true
  if (packet.completion_status === "STALE" || packet.completion_status === "INVALIDATED") return true
  return false
}

function hasReusableEvidence(packet: ResultPacket) {
  return packet.evidence_refs.length > 0 && packet.verification_results.some((v) => v.status === "passed")
}

function matchesTaskGoal(packet: ResultPacket, taskGoal: string) {
  const goal = normalize(taskGoal)
  if (!goal) return true
  const haystack = normalize(`${packet.user_goal} ${packet.subtask_goal} ${packet.claimed_result}`)
  if (haystack.includes(goal) || goal.includes(normalize(packet.subtask_goal))) return true
  const tokens = goal.split(/\s+/).filter((token) => token.length >= 4)
  if (tokens.length === 0) return haystack.includes(goal.slice(0, 12))
  return tokens.some((token) => haystack.includes(token))
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function resultStaleReasons(packet: ResultPacket, projectDir?: string) {
  const reasons: string[] = []
  for (const file of packet.files_changed) {
    const hasSnapshot = Boolean(file.hashAfter) || (typeof file.mtimeMsAfter === "number" && typeof file.sizeAfter === "number")
    if (!hasSnapshot) continue
    const fullPath = resolvePath(file.filePath, projectDir)
    const stat = statFile(fullPath)
    if (!stat) {
      reasons.push(`${file.filePath}: missing current file`)
      continue
    }
    if (file.hashAfter) {
      const currentHash = hashFile(fullPath)
      if (!currentHash || currentHash !== file.hashAfter) {
        reasons.push(`${file.filePath}: hash changed`)
        continue
      }
    }
    if (!file.hashAfter && typeof file.mtimeMsAfter === "number" && typeof file.sizeAfter === "number") {
      if (stat.size !== file.sizeAfter || Math.abs(stat.mtimeMs - file.mtimeMsAfter) > 1) {
        reasons.push(`${file.filePath}: mtime/size changed`)
      }
    }
  }
  return reasons
}

function resolvePath(filePath: string, projectDir?: string) {
  if (path.isAbsolute(filePath)) return filePath
  return path.join(projectDir ?? process.cwd(), filePath)
}

function hashFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
  } catch {
    return null
  }
}

function statFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

export function artifactReuseDecision(packet: ResultPacket, projectDir?: string): {
  reusable: boolean
  reason: string
  staleReasons: string[]
} {
  const staleReasons = resultStaleReasons(packet, projectDir)
  if (staleReasons.length > 0) return { reusable: false, reason: "artifact changed or missing", staleReasons }
  if (packet.completion_status !== "VERIFIED_COMPLETE") {
    return { reusable: false, reason: `artifact result is ${packet.completion_status}`, staleReasons: [] }
  }
  if (!hasReusableEvidence(packet)) return { reusable: false, reason: "artifact result lacks verification evidence", staleReasons: [] }
  return { reusable: true, reason: "artifact unchanged and verified", staleReasons: [] }
}
