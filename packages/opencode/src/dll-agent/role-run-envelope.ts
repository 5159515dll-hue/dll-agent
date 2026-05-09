import { buildActionFingerprint } from "./action-fingerprint-gate"
import type { ReviewerRole, RiskLevel } from "./interfaces"
import type { ResultPacket } from "./result-ledger"

export interface RoleRunEnvelope {
  role_run_id: string
  role_instance_id: string
  session_id: string
  role: ReviewerRole | "commander" | "executor"
  model: string
  context_packet_id?: string | null
  trigger_reason: string
  risk_level: RiskLevel
  independence_mode: "isolated" | "arbitration"
  allowed_actions: string[]
  forbidden_actions: string[]
  action_fingerprint: string
  created_at: string
  redaction_status: "redacted"
}

function hash(text: string) {
  let result = 0
  for (let i = 0; i < text.length; i++) {
    result = ((result << 5) - result) + text.charCodeAt(i)
    result |= 0
  }
  return Math.abs(result).toString(16)
}

export function buildRoleRunEnvelope(input: {
  sessionID: string
  role: RoleRunEnvelope["role"]
  model: string
  contextPacketID?: string | null
  triggerReason: string
  riskLevel: RiskLevel
  allowedActions: string[]
  forbiddenActions: string[]
  files?: string[]
  failureFingerprint?: string | null
  now?: Date
}): RoleRunEnvelope {
  const actionFingerprint = buildActionFingerprint({
    role: input.role,
    model: input.model,
    contextPacketID: input.contextPacketID,
    intendedAction: input.triggerReason,
    files: input.files,
    failureFingerprint: input.failureFingerprint,
  })
  const roleInstanceID = [
    input.sessionID,
    input.role,
    hash(`${input.model}|${input.contextPacketID ?? "no-context"}|${input.triggerReason}|${actionFingerprint}`),
  ].join(":")
  return {
    role_run_id: `rr_${hash(`${roleInstanceID}|${input.now?.toISOString() ?? Date.now()}`)}`,
    role_instance_id: roleInstanceID,
    session_id: input.sessionID,
    role: input.role,
    model: input.model,
    context_packet_id: input.contextPacketID ?? null,
    trigger_reason: input.triggerReason,
    risk_level: input.riskLevel,
    independence_mode: input.role === "role-cross" ? "arbitration" : "isolated",
    allowed_actions: input.allowedActions,
    forbidden_actions: input.forbiddenActions,
    action_fingerprint: actionFingerprint,
    created_at: (input.now ?? new Date()).toISOString(),
    redaction_status: "redacted",
  }
}

export function findSameModelRoleRunRisks(envelopes: RoleRunEnvelope[]): string[] {
  const risks: string[] = []
  const byModel = new Map<string, RoleRunEnvelope[]>()
  for (const envelope of envelopes) {
    const key = envelope.model
    byModel.set(key, [...(byModel.get(key) ?? []), envelope])
  }
  for (const [model, group] of byModel) {
    const roles = [...new Set(group.map((item) => item.role))]
    if (roles.length < 2) continue
    const missingContext = group.filter((item) => !item.context_packet_id)
    if (missingContext.length > 0) {
      risks.push(`same model ${model} used by roles ${roles.join(", ")} with missing context packet for ${missingContext.map((item) => item.role).join(", ")}`)
    }
    const duplicateContext = new Map<string, RoleRunEnvelope[]>()
    for (const item of group.filter((entry) => entry.context_packet_id)) {
      duplicateContext.set(item.context_packet_id!, [...(duplicateContext.get(item.context_packet_id!) ?? []), item])
    }
    for (const [packetID, packetGroup] of duplicateContext) {
      const packetRoles = [...new Set(packetGroup.map((item) => item.role))]
      if (packetRoles.length > 1 && !packetRoles.includes("role-cross")) {
        risks.push(`same model ${model} reused context packet ${packetID} across roles ${packetRoles.join(", ")}`)
      }
    }
  }
  return risks
}

export function findSameModelResultRisks(results: ResultPacket[]): string[] {
  const reviewerResults = results.filter((result) =>
    result.executing_role !== "commander" &&
    result.executing_role !== "executor" &&
    (result.role_run_id || result.context_packet_id || result.missing_context_packet),
  )
  const byModel = new Map<string, ResultPacket[]>()
  for (const result of reviewerResults) {
    byModel.set(result.model, [...(byModel.get(result.model) ?? []), result])
  }
  return [...byModel.entries()].flatMap(([model, group]) => {
    const roles = [...new Set(group.map((result) => String(result.executing_role)))]
    if (roles.length < 2) return []
    const risks: string[] = []
    const missingRun = group.filter((result) => !result.role_run_id)
    if (missingRun.length > 0) {
      risks.push(`same model ${model} produced multi-role reviewer results without role_run_id: ${missingRun.map((result) => `${result.executing_role}:${result.packet_id}`).join(", ")}`)
    }
    const missingContext = group.filter((result) => !result.context_packet_id || result.missing_context_packet)
    if (missingContext.length > 0) {
      risks.push(`same model ${model} produced multi-role reviewer results with missing context_packet_id: ${missingContext.map((result) => `${result.executing_role}:${result.packet_id}`).join(", ")}`)
    }
    const byAction = new Map<string, ResultPacket[]>()
    for (const result of group.filter((item) => item.action_fingerprint)) {
      byAction.set(result.action_fingerprint!, [...(byAction.get(result.action_fingerprint!) ?? []), result])
    }
    for (const [fingerprint, packetGroup] of byAction) {
      const packetRoles = [...new Set(packetGroup.map((result) => String(result.executing_role)))]
      if (packetRoles.length > 1) {
        risks.push(`same action fingerprint ${fingerprint} repeated across roles ${packetRoles.join(", ")} for model ${model}`)
      }
    }
    return risks
  })
}

export * as RoleRunEnvelope from "./role-run-envelope"
