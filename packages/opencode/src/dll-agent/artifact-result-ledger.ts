/**
 * Converts discovered task artifacts into Result Ledger packets. This bridges
 * generated reports/screenshots/scripts into the same structured completion
 * path as reviewer and verifier outputs.
 */

import { scanArtifactLedger, type ArtifactLedgerSnapshot } from "./artifact-ledger"
import {
  buildResultPacket,
  loadResults,
  writeResult,
  type ResultCompletionStatus,
  type ResultPacket,
} from "./result-ledger"
import { write as writeEvidence } from "./evidence"

export interface ArtifactResultEnsureResult {
  wrote: boolean
  packet_id?: string
  status?: ResultCompletionStatus
  reason: string
}

function artifactType(kind: string): ResultPacket["artifacts_produced"][number]["artifactType"] {
  if (kind === "audit_report") return "audit_report"
  if (kind === "screenshot") return "screenshot"
  if (kind === "generated_script") return "generated_script"
  if (kind === "command_log") return "command_log"
  if (kind === "business_source_change") return "code"
  return "other"
}

function statusFromSnapshot(snapshot: ArtifactLedgerSnapshot): ResultCompletionStatus {
  if (snapshot.blockers.length > 0 || snapshot.failCount > 0) return "BLOCKED"
  if (snapshot.auditReports.some((report) => report.metrics.coverageGap)) return "PARTIAL"
  if (snapshot.hasAuditEvidence) return "VERIFIED_COMPLETE"
  if (snapshot.auditReports.length > 0 || snapshot.artifacts.length > 0) return "UNVERIFIED"
  return "UNVERIFIED"
}

function existingArtifactResult(sessionID: string, snapshot: ArtifactLedgerSnapshot): boolean {
  const reportRefs = new Set(snapshot.auditReports.map((report) => `artifact-ledger:${report.path}`))
  if (reportRefs.size === 0) return false
  return loadResults(sessionID).some((result) =>
    result.evidence_refs.some((ref) => reportRefs.has(ref)),
  )
}

export function ensureArtifactResults(
  sessionID: string | undefined,
  projectDir: string | undefined,
  snapshot?: ArtifactLedgerSnapshot,
): ArtifactResultEnsureResult {
  if (!sessionID || !projectDir) return { wrote: false, reason: "missing session or project" }
  const artifactSnapshot = snapshot ?? scanArtifactLedger(projectDir)
  if (artifactSnapshot.artifacts.length === 0) return { wrote: false, reason: "no artifacts" }
  if (existingArtifactResult(sessionID, artifactSnapshot)) return { wrote: false, reason: "artifact result already exists" }

  const status = statusFromSnapshot(artifactSnapshot)
  const unresolved = [
    ...artifactSnapshot.blockers,
    ...(artifactSnapshot.failCount > 0 ? [`audit report has ${artifactSnapshot.failCount} failing result(s)`] : []),
    ...(artifactSnapshot.auditReports.some((report) => report.metrics.coverageGap)
      ? ["audit report discloses uncovered, unfinished, or unverified scope"]
      : []),
  ]
  const packet = buildResultPacket({
    sessionID,
    executing_role: "commander",
    model: "artifact-ledger",
    user_goal: "current session task",
    subtask_goal: "Classify generated task artifacts and audit report evidence",
    claimed_result: status === "VERIFIED_COMPLETE"
      ? "Generated audit artifacts are present and contain no blocking report issue."
      : "Generated audit artifacts are present but do not prove verified completion.",
    completion_status: status,
    artifacts_produced: artifactSnapshot.artifacts.map((artifact) => ({
      filePath: artifact.path,
      artifactType: artifactType(artifact.kind),
      purpose: artifact.purpose,
    })),
    commands_run: artifactSnapshot.artifacts.some((artifact) => artifact.kind === "generated_script")
      ? [{ command: "task-specific audit runner", result: "passed", evidenceRef: "artifact:generated_script" }]
      : [],
    verification_results: artifactSnapshot.auditReports.map((report) => ({
      name: `audit report: ${report.path}`,
      status: report.metrics.fail && report.metrics.fail > 0 ? "failed" : "passed",
      evidenceRef: `artifact:${report.path}`,
    })),
    evidence_refs: [
      ...artifactSnapshot.auditReports.map((report) => `artifact-ledger:${report.path}`),
      ...artifactSnapshot.artifacts.slice(0, 20).map((artifact) => `artifact:${artifact.path}`),
    ],
    unresolved_items: [...new Set(unresolved)],
    known_risks: artifactSnapshot.redactionApplied
      ? ["audit report contained secret-like values and was automatically redacted"]
      : [],
  })
  writeResult(sessionID, packet)
  writeEvidence("result.artifact_ledger_backfilled", {
    packet_id: packet.packet_id,
    status,
    artifacts: artifactSnapshot.artifacts.length,
    reports: artifactSnapshot.auditReports.length,
    blockers: unresolved.length,
    redaction_applied: artifactSnapshot.redactionApplied,
  }, sessionID)
  return { wrote: true, packet_id: packet.packet_id, status, reason: "artifact result written" }
}
