import {
  buildCapabilityAuditPacket,
  writeCapabilityEvidence,
  type CapabilityAuditPacket,
  type CapabilityAuditorVerdict,
  type CapabilityRiskAssessment,
} from "./capability-acquisition"
import { markAudited, type QuarantineCandidateRecord } from "./capability-quarantine"

export type MockAuditorDecision = "pass" | "warn" | "block" | "insufficient_evidence"

export interface CapabilityAuditRuntimeResult {
  packet: CapabilityAuditPacket
  verdict: CapabilityAuditorVerdict
  allowed_to_sandbox: boolean
  requires_user_authorization: boolean
  blocked: boolean
  reason: string
}

export function buildRuntimeAuditPacket(input: {
  candidate: QuarantineCandidateRecord
  riskAssessment: CapabilityRiskAssessment
  evidenceRefs?: string[]
}) {
  return buildCapabilityAuditPacket({
    candidate: input.candidate.manifest,
    riskAssessment: input.riskAssessment,
    sourceMetadata: {
      source: input.candidate.manifest.source,
      checksum: input.candidate.manifest.source.checksum,
    },
    requestedPermissions: input.candidate.manifest.permissions,
    sandboxPlan: {
      fixture_only: true,
      network_allowed: false,
      unknown_code_execution: false,
      activation: false,
    },
    smokeTestPlan: input.candidate.manifest.commands.smoke,
    rollbackPlan: input.candidate.manifest.rollback.steps,
    evidenceRefs: input.evidenceRefs ?? input.candidate.evidence_refs,
  })
}

export function mockFinalAuditorVerdict(input: {
  riskAssessment: CapabilityRiskAssessment
  decision: MockAuditorDecision
}): CapabilityAuditorVerdict {
  if (input.riskAssessment.hardBlocked) {
    return {
      verdict: "block",
      risk_level: input.riskAssessment.riskLevel,
      blocking_reasons: ["R4 hard block cannot be overridden by final-auditor"],
      conditions: [],
      required_user_authorization: true,
      required_smoke_tests: input.riskAssessment.requiredSmokeTests,
      rollback_required: input.riskAssessment.rollbackRequired,
      confidence: "high",
    }
  }
  if (input.decision === "block" || input.decision === "insufficient_evidence") {
    return {
      verdict: input.decision === "block" ? "block" : "insufficient_evidence",
      risk_level: input.riskAssessment.riskLevel,
      blocking_reasons: [input.decision === "block" ? "mock auditor blocked candidate" : "mock auditor found insufficient evidence"],
      conditions: [],
      required_user_authorization: input.riskAssessment.requiresUserAuthorization,
      required_smoke_tests: input.riskAssessment.requiredSmokeTests,
      rollback_required: input.riskAssessment.rollbackRequired,
      confidence: "medium",
    }
  }
  return {
    verdict: input.riskAssessment.requiresUserAuthorization ? "approve_with_user_auth" : "approve_auto",
    risk_level: input.riskAssessment.riskLevel,
    blocking_reasons: [],
    conditions: input.decision === "warn" ? ["warning accepted only for mock audit path"] : [],
    required_user_authorization: input.riskAssessment.requiresUserAuthorization,
    required_smoke_tests: input.riskAssessment.requiredSmokeTests,
    rollback_required: input.riskAssessment.rollbackRequired,
    confidence: input.decision === "warn" ? "medium" : "high",
  }
}

export function enforceAuditPolicy(input: {
  root: string
  candidate: QuarantineCandidateRecord
  riskAssessment: CapabilityRiskAssessment
  decision: MockAuditorDecision
  sessionID?: string
}): CapabilityAuditRuntimeResult {
  const packet = buildRuntimeAuditPacket({ candidate: input.candidate, riskAssessment: input.riskAssessment })
  const verdict = mockFinalAuditorVerdict({ riskAssessment: input.riskAssessment, decision: input.decision })
  const blocked = verdict.verdict === "block" || verdict.verdict === "insufficient_evidence" || input.riskAssessment.hardBlocked
  const requiresUserAuthorization = verdict.required_user_authorization || input.riskAssessment.requiresUserAuthorization
  const allowedToSandbox = !blocked && !requiresUserAuthorization && input.riskAssessment.riskLevel === "R2"
  markAudited({
    root: input.root,
    candidateID: input.candidate.candidate_id,
    verdict: blocked ? "block" : requiresUserAuthorization ? "needs_user_auth" : verdict.conditions.length ? "warn" : "pass",
    sessionID: input.sessionID,
  })
  writeCapabilityEvidence(
    "capability.audit_policy_decision",
    {
      candidate_id: input.candidate.candidate_id,
      risk_level: input.riskAssessment.riskLevel,
      verdict: verdict.verdict,
      allowed_to_sandbox: allowedToSandbox,
      requires_user_authorization: requiresUserAuthorization,
      blocked,
    },
    input.sessionID,
  )
  return {
    packet,
    verdict,
    allowed_to_sandbox: allowedToSandbox,
    requires_user_authorization: requiresUserAuthorization,
    blocked,
    reason: blocked
      ? verdict.blocking_reasons.join("; ")
      : requiresUserAuthorization
        ? "user authorization required before sandbox or activation"
        : allowedToSandbox
          ? "R2 mock final-auditor pass allows fixture sandbox"
          : "no sandbox action required",
  }
}

export * as CapabilityAuditRuntime from "./capability-audit-runtime"
