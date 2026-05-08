/**
 * Combines tool stdout, Result Ledger, and task artifacts into one evidence
 * snapshot that gates and UX can consume consistently.
 */

import { scanArtifactLedger, type ArtifactLedgerSnapshot } from "./artifact-ledger"
import { loadResults } from "./result-ledger"
import { ensureArtifactResults } from "./artifact-result-ledger"

export interface EvidenceSnapshot {
  has_real_tool_evidence: boolean
  has_artifacts: boolean
  verification_passed: boolean
  fail_count: number
  warn_count: number
  blockers: string[]
  evidence_refs: string[]
  artifact_snapshot?: ArtifactLedgerSnapshot
}

export interface EvidenceSnapshotInput {
  sessionID?: string
  projectDir?: string
  toolEvidence?: boolean
}

export function buildEvidenceSnapshot(input: EvidenceSnapshotInput = {}): EvidenceSnapshot {
  const blockers: string[] = []
  const evidenceRefs: string[] = []
  let failCount = 0
  let warnCount = 0
  let hasArtifacts = false
  let artifactSnapshot: ArtifactLedgerSnapshot | undefined

  if (input.projectDir) {
    artifactSnapshot = scanArtifactLedger(input.projectDir)
    if (input.sessionID) {
      ensureArtifactResults(input.sessionID, input.projectDir, artifactSnapshot)
    }
    hasArtifacts = artifactSnapshot.artifacts.length > 0
    failCount += artifactSnapshot.failCount
    warnCount += artifactSnapshot.warnCount
    evidenceRefs.push(...artifactSnapshot.artifacts.slice(0, 20).map((artifact) => `artifact:${artifact.path}`))
    blockers.push(...artifactSnapshot.blockers)
    if (artifactSnapshot.failCount > 0) {
      blockers.push(`artifact reports contain ${artifactSnapshot.failCount} FAIL result(s)`)
    }
  }

  if (input.sessionID) {
    for (const result of loadResults(input.sessionID)) {
      evidenceRefs.push(`result:${result.packet_id}`)
      if (result.completion_status === "BLOCKED" || result.completion_status === "FAILED") {
        blockers.push(`${result.executing_role}: ${result.subtask_goal}`)
      }
      if (result.completion_status === "PARTIAL" && result.unresolved_items.length > 0) {
        blockers.push(`${result.executing_role}: ${result.unresolved_items.join("; ")}`)
      }
      for (const verification of result.verification_results) {
        if (verification.status === "failed") failCount++
        if (verification.status === "passed") evidenceRefs.push(`verification:${verification.name}`)
      }
      if (result.artifacts_produced.length > 0) hasArtifacts = true
    }
  }

  const hasRealToolEvidence = Boolean(input.toolEvidence || artifactSnapshot?.hasAuditEvidence)
  const verificationPassed = hasRealToolEvidence && failCount === 0 && blockers.length === 0

  return {
    has_real_tool_evidence: hasRealToolEvidence,
    has_artifacts: hasArtifacts,
    verification_passed: verificationPassed,
    fail_count: failCount,
    warn_count: warnCount,
    blockers,
    evidence_refs: [...new Set(evidenceRefs)],
    artifact_snapshot: artifactSnapshot,
  }
}
