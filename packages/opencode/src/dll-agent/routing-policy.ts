import { resolveRoleModel, type DllRole } from "./role-model-registry"
import { COOLDOWN_CONFIG, type ReviewerRole, type RiskLevel } from "./interfaces"
import type { Metrics } from "./triggers"
import type { MessageV2 } from "@/session/message-v2"

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "deepseek/deepseek-v4-pro": 1_048_576,
  "deepseek/deepseek-v4": 1_048_576,
  "openai/gpt-5.5-pro": 1_050_000,
  "openai/gpt-5": 1_050_000,
  "kimi/kimi-k2.6": 262_144,
  "kimi/kimi-k2": 262_144,
  "zai/glm-5.1": 204_800,
  "zai/glm-5": 204_800,
}

export function modelContextLimit(providerID?: string, modelID?: string): number | undefined {
  if (!providerID || !modelID) return undefined
  const key = `${providerID}/${modelID}`.toLowerCase()
  if (MODEL_CONTEXT_LIMITS[key]) return MODEL_CONTEXT_LIMITS[key]
  for (const [k, v] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key.includes(k.split("/")[1]?.replace(/-/g, "") ?? "")) return v
  }
  return undefined
}

export function assessRisk(metrics: Metrics): RiskLevel {
  let score = 0

  if (metrics.toolFailures >= 3) score += 3
  else if (metrics.toolFailures >= 1) score += 1

  if (metrics.permissionDenied >= 2) score += 2
  else if (metrics.permissionDenied >= 1) score += 1

  if (metrics.repeatedToolFailure) score += 3

  if (metrics.recentUserCorrection) score += 2
  if (metrics.userCorrections >= 3) score += 2
  else if (metrics.userCorrections >= 1) score += 1

  if (metrics.longContextSignal) score += 1

  if (metrics.reviewerConflictSignal) score += 2

  if (metrics.finalClaim && !metrics.verificationEvidence) score += 3

  if (score >= 6) return "high"
  if (score >= 3) return "medium"
  return "low"
}

export function hasNonTextInput(messages: MessageV2.WithParts[]) {
  return messages.slice(-8).some((message) =>
    message.parts.some((part) => {
      if (part.type !== "file") return false
      const mime = "mime" in part && typeof part.mime === "string" ? part.mime : ""
      return /^(image|audio|video)\//i.test(mime) || /pdf|presentation|powerpoint/i.test(mime)
    }),
  )
}

export function reviewerToDllRole(reviewer: ReviewerRole): DllRole {
  if (reviewer === "requirements-inspector") return "requirements-inspector"
  if (reviewer === "long-context-archivist") return "long-context-archivist"
  if (reviewer === "task-completion-archivist") return "task-completion-archivist"
  if (reviewer === "chief-engineer") return "chief-engineer"
  if (reviewer === "final-auditor") return "final-auditor"
  if (reviewer === "role-cross") return "role-cross"
  if (reviewer === "multimodal-context-interpreter") return "multimodal-context-interpreter"
  return "chief-engineer"
}

export function reviewerModelCandidates(reviewer: ReviewerRole, sessionID: string) {
  const effective = resolveRoleModel(reviewerToDllRole(reviewer), sessionID, process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR)
  return {
    selected: effective.primary,
    candidates: [effective.primary, ...effective.fallback],
  }
}

export function maxReviewersForRouting(risk: RiskLevel, metrics: Metrics) {
  if (
    risk === "high" ||
    metrics.reviewerConflictSignal ||
    metrics.repeatedToolFailure ||
    (metrics.finalClaim && !metrics.realToolEvidence)
  ) return 3
  if (risk === "medium" || metrics.recentUserCorrection || metrics.userCorrections > 0 || metrics.kimiCompletionCheckSignal) return 2
  return COOLDOWN_CONFIG.max_reviewers_per_round
}

export function reviewerRequiredForCorrectness(
  reviewer: ReviewerRole,
  reason: string,
  risk: RiskLevel,
  metrics: Metrics,
) {
  if (risk === "high") return true
  if (reviewer === "requirements-inspector" && (metrics.recentUserCorrection || metrics.userCorrections > 0 || metrics.scopeExpandedSignal || metrics.glmCompletionClaimSignal)) return true
  if (reviewer === "chief-engineer" && (metrics.repeatedToolFailure || metrics.toolFailures >= 3 || metrics.permissionDenied > 0)) return true
  if (reviewer === "role-cross" && metrics.reviewerConflictSignal) return true
  if (reviewer === "task-completion-archivist" && metrics.kimiCompletionCheckSignal) return true
  if (reviewer === "final-auditor" && metrics.finalClaim) return true
  if (reviewer === "multimodal-context-interpreter" && reason.includes("multimodal input")) return true
  return false
}

