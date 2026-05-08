/**
 * dll-agent artifact-reuse-policy.ts
 *
 * Formal policy for deciding when an existing artifact (file change, test output,
 * build result, generated code) can be safely reused vs. must be regenerated.
 *
 * Consumed by: result-sufficiency-gate.ts, deduplication-gate.ts
 * Builds on: result-ledger.ts
 */
import { type ResultPacket } from "./result-ledger"

// ─── Reuse Rules ────────────────────────────────────────────────────────────

export type ReuseDecision =
  | "reuse"           // Artifact is current and verified — use as-is
  | "review"          // Artifact exists but should be reviewed before reuse
  | "reverify"        // Artifact exists but verification must be re-run
  | "regenerate"      // Artifact is stale or invalid — must regenerate
  | "supplement"      // Artifact partially covers — fill gaps only

export interface ArtifactReuseCheck {
  /** The original result packet */
  packet: ResultPacket
  /** Overall decision for the artifact set */
  decision: ReuseDecision
  /** Files that can be reused as-is */
  reusableFiles: string[]
  /** Files that need to be regenerated */
  filesToRegenerate: string[]
  /** Files that need re-verification */
  filesToReverify: string[]
  /** Reason for the decision */
  reason: string
}

// ─── Staleness Rules ─────────────────────────────────────────────────────────

/**
 * Determine if a file artifact has gone stale.
 *
 * Staleness conditions:
 * 1. Result is explicitly marked stale/invalidated → STALE
 * 2. Result older than maxAgeMinutes → STALE
 * 3. File was modified after result creation → STALE
 * 4. File hash mismatch → STALE
 *
 * @param packet — the result packet
 * @param currentFileMtimes — map of filePath → mtimeMs (optional, from current fs)
 * @param maxAgeMinutes — max age for results (default 60)
 */
export function isFileStale(
  packet: ResultPacket,
  currentFileMtimes?: Map<string, number>,
  maxAgeMinutes: number = 60,
): boolean {
  // Explicitly invalidated
  if (packet.stale) return true
  if (packet.completion_status === "STALE") return true
  if (packet.completion_status === "INVALIDATED") return true

  // Time-based staleness
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000
  if (new Date(packet.created_at).getTime() < cutoff) return true

  // File modification staleness (if we have current mtimes)
  if (currentFileMtimes) {
    for (const fc of packet.files_changed) {
      const currentMtime = currentFileMtimes.get(fc.filePath)
      if (currentMtime !== undefined) {
        // Result created at: new Date(packet.created_at).getTime()
        // File modified after result → stale
        if (currentMtime > new Date(packet.created_at).getTime()) return true
      }
    }
  }

  return false
}

// ─── Reuse Decision Logic ───────────────────────────────────────────────────

/**
 * Decide whether a set of file artifacts can be reused.
 *
 * Decision matrix:
 *
 * | Result Status  | Files Stale? | Verification? | Decision     |
 * |---------------|-------------|---------------|-------------|
 * | VERIFIED_COMPLETE | No         | Passed        | reuse       |
 * | VERIFIED_COMPLETE | No         | Not verified  | reverify    |
 * | VERIFIED_COMPLETE | Yes        | —             | regenerate  |
 * | PARTIAL        | No         | —             | supplement  |
 * | PARTIAL        | Yes        | —             | regenerate  |
 * | UNVERIFIED     | No         | —             | reverify    |
 * | FAILED         | —          | —             | regenerate  |
 * | BLOCKED        | —          | —             | regenerate  |
 * | STALE/INVALID  | —          | —             | regenerate  |
 */
export function checkArtifactReuse(
  packet: ResultPacket,
  currentFileMtimes?: Map<string, number>,
  maxAgeMinutes: number = 60,
): ArtifactReuseCheck {
  const allFiles = packet.files_changed.map((f) => f.filePath)
  const staleFiles: string[] = []

  for (const fc of packet.files_changed) {
    if (packet.stale || packet.completion_status === "STALE" || packet.completion_status === "INVALIDATED") {
      staleFiles.push(fc.filePath)
      continue
    }
    if (new Date(packet.created_at).getTime() < Date.now() - maxAgeMinutes * 60 * 1000) {
      staleFiles.push(fc.filePath)
      continue
    }
    if (currentFileMtimes) {
      const mtime = currentFileMtimes.get(fc.filePath)
      if (mtime !== undefined && mtime > new Date(packet.created_at).getTime()) {
        staleFiles.push(fc.filePath)
      }
    }
  }

  const verified = packet.verification_results.every((v) => v.status === "passed")
    && packet.verification_results.length > 0

  switch (packet.completion_status) {
    case "VERIFIED_COMPLETE": {
      if (staleFiles.length > 0) {
        return {
          packet,
          decision: "regenerate",
          reusableFiles: allFiles.filter((f) => !staleFiles.includes(f)),
          filesToRegenerate: staleFiles,
          filesToReverify: [],
          reason: `${staleFiles.length} file(s) have changed since result was created`,
        }
      }
      if (!verified) {
        return {
          packet,
          decision: "reverify",
          reusableFiles: allFiles,
          filesToRegenerate: [],
          filesToReverify: allFiles,
          reason: "Result is complete but needs re-verification",
        }
      }
      return {
        packet,
        decision: "reuse",
        reusableFiles: allFiles,
        filesToRegenerate: [],
        filesToReverify: [],
        reason: "All files are verified and current — safe to reuse",
      }
    }

    case "PARTIAL": {
      if (staleFiles.length > 0) {
        return {
          packet,
          decision: "regenerate",
          reusableFiles: [],
          filesToRegenerate: allFiles,
          filesToReverify: [],
          reason: "Partial result is stale — full regeneration needed",
        }
      }
      return {
        packet,
        decision: "supplement",
        reusableFiles: allFiles,
        filesToRegenerate: [],
        filesToReverify: [],
        reason: `Partial result — ${packet.unresolved_items.length} gaps remain`,
      }
    }

    case "UNVERIFIED": {
      if (staleFiles.length > 0) {
        return {
          packet,
          decision: "regenerate",
          reusableFiles: [],
          filesToRegenerate: allFiles,
          filesToReverify: [],
          reason: "Unverified and stale — regeneration needed",
        }
      }
      return {
        packet,
        decision: "reverify",
        reusableFiles: allFiles,
        filesToRegenerate: [],
        filesToReverify: allFiles,
        reason: "Result exists but verification is needed before reuse",
      }
    }

    case "FAILED":
    case "BLOCKED":
    case "STALE":
    case "INVALIDATED":
    default: {
      return {
        packet,
        decision: "regenerate",
        reusableFiles: [],
        filesToRegenerate: allFiles,
        filesToReverify: [],
        reason: `Result status is ${packet.completion_status} — cannot be reused`,
      }
    }
  }
}

// ─── Batch Reuse Check ──────────────────────────────────────────────────────

/**
 * Check artifact reuse across multiple result packets.
 * Returns the most permissive applicable reuse policy.
 */
export function checkBatchArtifactReuse(
  packets: ResultPacket[],
  currentFileMtimes?: Map<string, number>,
  maxAgeMinutes: number = 60,
): {
  canReuseAll: boolean
  decisions: ArtifactReuseCheck[]
  reusableFiles: Set<string>
  filesToRegenerate: Set<string>
  summary: string
} {
  const decisions: ArtifactReuseCheck[] = []
  const reusableFiles = new Set<string>()
  const filesToRegenerate = new Set<string>()

  for (const packet of packets) {
    const check = checkArtifactReuse(packet, currentFileMtimes, maxAgeMinutes)
    decisions.push(check)
    for (const f of check.reusableFiles) reusableFiles.add(f)
    for (const f of check.filesToRegenerate) filesToRegenerate.add(f)
  }

  const canReuseAll = decisions.every((d) => d.decision === "reuse")

  const summary = canReuseAll
    ? `All ${decisions.length} result(s) are verified and current — safe to reuse all artifacts.`
    : `${decisions.filter((d) => d.decision === "reuse").length}/${decisions.length} results reusable. ` +
      `${filesToRegenerate.size} file(s) need regeneration.`

  return { canReuseAll, decisions, reusableFiles, filesToRegenerate, summary }
}
