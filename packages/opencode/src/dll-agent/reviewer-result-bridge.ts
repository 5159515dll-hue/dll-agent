/**
 * Bridges structured reviewer output into Result Ledger packets.
 *
 * Supervisor state mutation remains in supervisor.ts; this module owns only the
 * reviewer-output -> result-packet transformation and best-effort ledger write.
 */

import { resolveRoleProviderHint } from "./role-provider-bridge"
import { buildResultPacket, writeResult as writeResultLedger, type ResultPacket } from "./result-ledger"
import { reviewerToDllRole } from "./routing-policy"
import { redact, write as writeEvidence } from "./evidence"
import {
  normalizeMultimodalPacketOutput,
  savePacket as saveMultimodalPacket,
  writeMultimodalEvidence,
} from "./multimodal-context"
import type { ReviewerOutput, ReviewerRole, SupervisorState } from "./interfaces"

const BLOCKING_FALLBACK_PATTERNS = [
  /fail_block|block_completion|blocking|blocked|fail(?:ed)?|cannot pass/i,
  /(阻断|失败|未完成|缺少证据|不能通过|不应通过|无法通过)/,
]

function compactSummary(text: string | undefined) {
  const raw = (text ?? "Reviewer completed without structured JSON output.").trim()
  const normalized = raw.replace(/\s+/g, " ").slice(0, 800)
  return String(redact(normalized))
}

function fallbackBlocks(summary: string) {
  return BLOCKING_FALLBACK_PATTERNS.some((pattern) => pattern.test(summary))
}

function reviewerModel(input: {
  reviewer: ReviewerRole
  sessionID: string
  projectDir?: string
}) {
  const model = resolveRoleProviderHint({
    role: reviewerToDllRole(input.reviewer),
    sessionID: input.sessionID,
    projectDir: input.projectDir,
  })
  return `${model.providerID}/${model.modelID}`
}

function buildMultimodalReviewerResultPacket(input: {
  sessionID: string
  reviewer: ReviewerRole
  state: SupervisorState
  projectDir?: string
  contextPacketID?: string
  roleRunID?: string
  roleInstanceID?: string
  actionFingerprint?: string
  rawText?: string
}): ResultPacket {
  const model = reviewerModel(input)
  const normalized = normalizeMultimodalPacketOutput({
    rawText: input.rawText,
    sessionID: input.sessionID,
    model,
    fallbackUserGoal: input.state.metrics?.final_claim ? "completion claim" : "ongoing task",
    contextPacketID: input.contextPacketID,
    evidenceRefs: [
      input.contextPacketID ? `context_handoff:${input.contextPacketID}` : `missing_context_packet:${input.reviewer}`,
      input.roleRunID ? `role_run:${input.roleRunID}` : `missing_role_run_envelope:${input.reviewer}`,
    ],
  })
  saveMultimodalPacket(input.sessionID, normalized.packet)
  const completionStatus = normalized.structuredOutputMissing
    ? "UNVERIFIED"
    : normalized.valid && normalized.packet.context_sufficient
      ? "VERIFIED_COMPLETE"
      : "PARTIAL"
  const knownRisks = [
    ...(normalized.structuredOutputMissing ? ["structured_output_missing", "low_confidence_multimodal_output"] : []),
    ...(!normalized.valid ? ["invalid_multimodal_context_packet"] : []),
    ...(!normalized.packet.context_sufficient ? ["multimodal_context_insufficient"] : []),
    ...(!input.contextPacketID ? ["missing_context_packet"] : []),
    ...(!input.roleRunID ? ["missing_role_run_envelope"] : []),
    ...normalized.validationIssues.map((issue) => `multimodal_validation:${issue}`),
  ]
  const evidenceRefs = [
    `multimodal_context:${normalized.packet.packet_id}`,
    input.contextPacketID ? `context_handoff:${input.contextPacketID}` : `missing_context_packet:${input.reviewer}`,
    input.roleRunID ? `role_run:${input.roleRunID}` : `missing_role_run_envelope:${input.reviewer}`,
    ...normalized.packet.evidence_refs,
  ]
  const packet = buildResultPacket({
    sessionID: input.sessionID,
    executing_role: input.reviewer,
    model: normalized.packet.model || model,
    user_goal: normalized.packet.user_goal,
    subtask_goal: `Multimodal context packet: ${normalized.packet.input_type} ${normalized.packet.source_ref}`,
    claimed_result: [
      `Multimodal packet ${normalized.packet.packet_id}`,
      `confidence=${normalized.packet.overall_confidence}`,
      `context_sufficient=${normalized.packet.context_sufficient}`,
      normalized.packet.observations[0]?.description,
    ].filter(Boolean).join(" | "),
    completion_status: completionStatus,
    artifacts_produced: normalized.packet.source_ref
      ? [{
          filePath: normalized.packet.source_ref,
          artifactType: normalized.packet.input_type === "screenshot" ? "screenshot" : "other",
          purpose: "multimodal source reference",
        }]
      : [],
    verification_results: [
      { name: "multimodal_context_packet_validation", status: normalized.valid ? "passed" : "failed" },
    ],
    evidence_refs: evidenceRefs,
    unresolved_items: normalized.packet.context_sufficient ? [] : normalized.packet.uncertainties,
    known_risks: knownRisks,
    context_packet_id: input.contextPacketID ?? null,
    missing_context_packet: !input.contextPacketID,
    role_run_id: input.roleRunID ?? null,
    role_instance_id: input.roleInstanceID ?? null,
    action_fingerprint: input.actionFingerprint ?? null,
    structured_output_missing: normalized.structuredOutputMissing,
    confidence: normalized.packet.overall_confidence,
    raw_summary_ref: normalized.structuredOutputMissing ? `multimodal_raw_summary:${input.reviewer}:${Date.now()}` : null,
    redacted_summary: normalized.structuredOutputMissing ? normalized.packet.observations[0]?.description ?? null : null,
    source_kind: normalized.structuredOutputMissing ? "fallback_reviewer_output" : "structured_reviewer_output",
    projectDir: input.projectDir,
  })
  writeMultimodalEvidence(
    normalized.structuredOutputMissing || !normalized.valid
      ? "multimodal.context.low_confidence"
      : "multimodal.context.produced",
    {
      packet_id: normalized.packet.packet_id,
      source_hash: normalized.packet.source_hash,
      input_type: normalized.packet.input_type,
      model: normalized.packet.model,
      overall_confidence: normalized.packet.overall_confidence,
      context_sufficient: normalized.packet.context_sufficient,
      context_packet_id: input.contextPacketID ?? null,
      result_packet_id: packet.packet_id,
      structured_output_missing: normalized.structuredOutputMissing,
      validation_issues: normalized.validationIssues,
    },
    input.sessionID,
  )
  return packet
}

export function buildReviewerResultPacket(input: {
  sessionID: string
  reviewer: ReviewerRole
  output: ReviewerOutput
  state: SupervisorState
  projectDir?: string
  contextPacketID?: string
  roleRunID?: string
  roleInstanceID?: string
  actionFingerprint?: string
}): ResultPacket {
  const dllRole = reviewerToDllRole(input.reviewer)
  const effective = resolveRoleProviderHint({
    role: dllRole,
    sessionID: input.sessionID,
    projectDir: input.projectDir,
  })
  const missingContextPacket = !input.contextPacketID
  const evidenceRefs = [
    `reviewer:${input.reviewer}`,
    `score:${input.output.score}`,
    input.contextPacketID ? `context_handoff:${input.contextPacketID}` : `missing_context_packet:${input.reviewer}`,
    input.roleRunID ? `role_run:${input.roleRunID}` : `missing_role_run_envelope:${input.reviewer}`,
  ]
  const knownRisks = [
    ...(missingContextPacket ? ["missing_context_packet"] : []),
    ...(!input.roleRunID ? ["missing_role_run_envelope"] : []),
  ]
  return buildResultPacket({
    sessionID: input.sessionID,
    executing_role: input.reviewer,
    model: `${effective.providerID}/${effective.modelID}`,
    user_goal: input.state.metrics?.final_claim ? "completion claim" : "ongoing task",
    subtask_goal: `Review by ${input.reviewer}: ${input.output.trigger_reason}`,
    claimed_result: `Review verdict: ${input.output.verdict} | Score: ${input.output.score} | Evidence confidence: ${input.output.evidence_confidence}`,
    completion_status: input.output.block_completion ? "BLOCKED" : "VERIFIED_COMPLETE",
    evidence_refs: evidenceRefs,
    unresolved_items: input.output.findings.filter((finding) => finding.severity === "block").map((finding) => finding.summary),
    known_risks: knownRisks,
    context_packet_id: input.contextPacketID ?? null,
    missing_context_packet: missingContextPacket,
    role_run_id: input.roleRunID ?? null,
    role_instance_id: input.roleInstanceID ?? null,
    action_fingerprint: input.actionFingerprint ?? null,
    structured_output_missing: false,
    confidence: input.output.evidence_confidence >= 80 ? "high" : input.output.evidence_confidence >= 50 ? "medium" : "low",
    source_kind: "structured_reviewer_output",
    verification_results: [
      { name: "reviewer_score", status: input.output.score >= 70 ? "passed" : "failed" },
    ],
  })
}

export function buildFallbackReviewerResultPacket(input: {
  sessionID: string
  reviewer: ReviewerRole
  state: SupervisorState
  projectDir?: string
  contextPacketID?: string
  roleRunID?: string
  roleInstanceID?: string
  actionFingerprint?: string
  rawText?: string
  reusedFromPacketID?: string
}): ResultPacket {
  const missingContextPacket = !input.contextPacketID
  const isReuse = Boolean(input.reusedFromPacketID)
  const summary = compactSummary(input.rawText)
  const blocks = !isReuse && fallbackBlocks(summary)
  const rawSummaryRef = isReuse ? null : `reviewer_raw_summary:${input.reviewer}:${Date.now()}`
  const evidenceRefs = [
    `reviewer:${input.reviewer}`,
    input.contextPacketID ? `context_handoff:${input.contextPacketID}` : `missing_context_packet:${input.reviewer}`,
    input.roleRunID ? `role_run:${input.roleRunID}` : `missing_role_run_envelope:${input.reviewer}`,
    isReuse ? `reused_result:${input.reusedFromPacketID}` : rawSummaryRef,
  ].filter((ref): ref is string => Boolean(ref))
  const knownRisks = isReuse
    ? ["dedup_reuse"]
    : [
        "structured_output_missing",
        "low_confidence_reviewer_output",
        ...(missingContextPacket ? ["missing_context_packet"] : []),
        ...(!input.roleRunID ? ["missing_role_run_envelope"] : []),
      ]
  const packet = buildResultPacket({
    sessionID: input.sessionID,
    executing_role: input.reviewer,
    model: reviewerModel(input),
    user_goal: input.state.metrics?.final_claim ? "completion claim" : "ongoing task",
    subtask_goal: isReuse
      ? `Review by ${input.reviewer}: reused verified result ${input.reusedFromPacketID}`
      : `Review by ${input.reviewer}: fallback normalized unstructured output`,
    claimed_result: isReuse
      ? `Reviewer completion satisfied by reusable Result Ledger packet ${input.reusedFromPacketID}`
      : `Fallback reviewer output (low confidence): ${summary}`,
    completion_status: isReuse ? "VERIFIED_COMPLETE" : blocks ? "BLOCKED" : "UNVERIFIED",
    evidence_refs: evidenceRefs,
    unresolved_items: blocks ? [summary] : [],
    known_risks: knownRisks,
    context_packet_id: input.contextPacketID ?? null,
    missing_context_packet: missingContextPacket,
    role_run_id: input.roleRunID ?? null,
    role_instance_id: input.roleInstanceID ?? null,
    action_fingerprint: input.actionFingerprint ?? null,
    structured_output_missing: !isReuse,
    confidence: isReuse ? "medium" : "low",
    raw_summary_ref: rawSummaryRef,
    redacted_summary: isReuse ? null : summary,
    source_kind: isReuse ? "dedup_reuse" : "fallback_reviewer_output",
    reused_from: input.reusedFromPacketID,
    verification_results: [
      { name: "structured_reviewer_output", status: isReuse ? "passed" : "not_run" },
    ],
  })
  if (!isReuse) {
    writeEvidence("reviewer.fallback_result_normalized", {
      reviewer: input.reviewer,
      packet_id: packet.packet_id,
      context_packet_id: input.contextPacketID ?? null,
      missing_context_packet: missingContextPacket,
      raw_summary_ref: rawSummaryRef,
      redacted_summary: summary,
      completion_status: packet.completion_status,
    }, input.sessionID)
  }
  return packet
}

export function writeReviewerResult(input: {
  sessionID: string
  reviewer: ReviewerRole
  output?: ReviewerOutput
  state: SupervisorState
  projectDir?: string
  contextPacketID?: string
  roleRunID?: string
  roleInstanceID?: string
  actionFingerprint?: string
  rawText?: string
  reusedFromPacketID?: string
}): ResultPacket | null {
  try {
    if (
      input.reviewer === "multimodal-context-interpreter" &&
      !input.output &&
      !input.reusedFromPacketID
    ) {
      const packet = buildMultimodalReviewerResultPacket({
        sessionID: input.sessionID,
        reviewer: input.reviewer,
        state: input.state,
        projectDir: input.projectDir,
        contextPacketID: input.contextPacketID,
        roleRunID: input.roleRunID,
        roleInstanceID: input.roleInstanceID,
        actionFingerprint: input.actionFingerprint,
        rawText: input.rawText,
      })
      writeResultLedger(input.sessionID, packet)
      return packet
    }
    const packet = input.output
      ? buildReviewerResultPacket({
          sessionID: input.sessionID,
          reviewer: input.reviewer,
          output: input.output,
          state: input.state,
          projectDir: input.projectDir,
          contextPacketID: input.contextPacketID,
          roleRunID: input.roleRunID,
          roleInstanceID: input.roleInstanceID,
          actionFingerprint: input.actionFingerprint,
        })
      : buildFallbackReviewerResultPacket(input)
    writeResultLedger(input.sessionID, packet)
    return packet
  } catch {
    return null
  }
}
