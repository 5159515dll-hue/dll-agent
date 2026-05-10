import crypto from "crypto"
import fs from "fs"
import path from "path"
import {
  capabilityAcquisitionPaths,
  parseCapabilityJson,
  validateCapabilityInstallManifest,
  writeCapabilityEvidence,
  type CapabilityAcquisitionRiskLevel,
  type CapabilityInstallManifest,
  type CapabilityManifestValidation,
  type CapabilityRiskAssessment,
} from "./capability-acquisition"

export interface QuarantineCandidateRecord {
  candidate_id: string
  status: "quarantined" | "risk_classified" | "audited" | "rejected"
  manifest: CapabilityInstallManifest
  manifest_checksum: string
  manifest_json: string
  risk_assessment?: CapabilityRiskAssessment
  audit_verdict?: "pass" | "warn" | "block" | "needs_user_auth"
  rejected_reason?: string
  evidence_refs: string[]
  created_at: string
  updated_at: string
}

function now() {
  return new Date().toISOString()
}

function safeID(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)
}

function hashText(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`
}

function candidateDir(root: string, candidateID: string) {
  return path.join(capabilityAcquisitionPaths(root).quarantine, safeID(candidateID))
}

function recordPath(root: string, candidateID: string) {
  return path.join(candidateDir(root, candidateID), "quarantine.json")
}

export function validateQuarantineManifest(manifest: unknown): CapabilityManifestValidation {
  return validateCapabilityInstallManifest(manifest)
}

export function createQuarantineCandidate(input: {
  root: string
  manifest: CapabilityInstallManifest
  candidateID?: string
  sessionID?: string
}): QuarantineCandidateRecord {
  const validation = validateQuarantineManifest(input.manifest)
  if (!validation.valid) throw new Error(`invalid capability manifest: ${validation.errors.join("; ")}`)
  const candidateID = safeID(input.candidateID ?? input.manifest.id)
  const dir = candidateDir(input.root, candidateID)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const manifestJson = JSON.stringify(input.manifest, null, 2)
  const record: QuarantineCandidateRecord = {
    candidate_id: candidateID,
    status: "quarantined",
    manifest: input.manifest,
    manifest_checksum: hashText(manifestJson),
    manifest_json: manifestJson,
    evidence_refs: [`capability.quarantined:${candidateID}`],
    created_at: now(),
    updated_at: now(),
  }
  writeQuarantineManifest(input.root, record)
  writeCapabilityEvidence(
    "capability.quarantined",
    {
      candidate_id: candidateID,
      kind: input.manifest.kind,
      risk_level: input.manifest.risk.level,
      quarantine_path: dir,
      source_verified: input.manifest.source.verified,
    },
    input.sessionID,
  )
  return record
}

export function writeQuarantineManifest(root: string, record: QuarantineCandidateRecord) {
  const dir = candidateDir(root, record.candidate_id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(recordPath(root, record.candidate_id), JSON.stringify(record, null, 2), { mode: 0o600 })
}

export function readQuarantineCandidate(root: string, candidateID: string): QuarantineCandidateRecord {
  const parsed = parseCapabilityJson(fs.readFileSync(recordPath(root, candidateID), "utf8"))
  const validation = validateQuarantineManifest((parsed as QuarantineCandidateRecord).manifest)
  if (!validation.valid) throw new Error(`invalid quarantined manifest: ${validation.errors.join("; ")}`)
  return parsed as QuarantineCandidateRecord
}

export function markRiskAssessed(input: {
  root: string
  candidateID: string
  riskAssessment: CapabilityRiskAssessment
  sessionID?: string
}) {
  const record = readQuarantineCandidate(input.root, input.candidateID)
  const updated: QuarantineCandidateRecord = {
    ...record,
    status: "risk_classified",
    risk_assessment: input.riskAssessment,
    updated_at: now(),
    evidence_refs: [...record.evidence_refs, `capability.risk_assessed:${record.candidate_id}`],
  }
  writeQuarantineManifest(input.root, updated)
  writeCapabilityEvidence(
    "capability.risk_assessed",
    {
      candidate_id: record.candidate_id,
      risk_level: input.riskAssessment.riskLevel,
      hard_blocked: input.riskAssessment.hardBlocked,
      requires_user_authorization: input.riskAssessment.requiresUserAuthorization,
    },
    input.sessionID,
  )
  return updated
}

export function markAudited(input: {
  root: string
  candidateID: string
  verdict: "pass" | "warn" | "block" | "needs_user_auth"
  sessionID?: string
}) {
  const record = readQuarantineCandidate(input.root, input.candidateID)
  const updated: QuarantineCandidateRecord = {
    ...record,
    status: "audited",
    audit_verdict: input.verdict,
    updated_at: now(),
    evidence_refs: [...record.evidence_refs, `capability.audited:${record.candidate_id}`],
  }
  writeQuarantineManifest(input.root, updated)
  writeCapabilityEvidence(
    "capability.audited",
    { candidate_id: record.candidate_id, verdict: input.verdict, risk_level: record.manifest.risk.level },
    input.sessionID,
  )
  return updated
}

export function markRejected(input: {
  root: string
  candidateID: string
  reason: string
  riskLevel?: CapabilityAcquisitionRiskLevel
  sessionID?: string
}) {
  const record = readQuarantineCandidate(input.root, input.candidateID)
  const updated: QuarantineCandidateRecord = {
    ...record,
    status: "rejected",
    rejected_reason: input.reason,
    updated_at: now(),
    evidence_refs: [...record.evidence_refs, `capability.blocked:${record.candidate_id}`],
  }
  writeQuarantineManifest(input.root, updated)
  writeCapabilityEvidence(
    "capability.blocked",
    { candidate_id: record.candidate_id, reason: input.reason, risk_level: input.riskLevel ?? record.manifest.risk.level },
    input.sessionID,
  )
  return updated
}

export function deleteQuarantineCandidate(input: { root: string; candidateID: string; sessionID?: string }) {
  const dir = candidateDir(input.root, input.candidateID)
  if (!dir.startsWith(capabilityAcquisitionPaths(input.root).quarantine + path.sep)) {
    throw new Error("refusing to delete outside quarantine")
  }
  fs.rmSync(dir, { recursive: true, force: true })
  writeCapabilityEvidence("capability.disabled", { candidate_id: input.candidateID, deleted_quarantine: true }, input.sessionID)
}

export function quarantineCandidatePath(root: string, candidateID: string) {
  return candidateDir(root, candidateID)
}

export * as CapabilityQuarantine from "./capability-quarantine"
