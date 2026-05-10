import { listRoleModels, type DllRole, type EffectiveRoleModel } from "./role-model-registry"
import type { TaskIntakeClassification } from "./task-intake-classifier"

export type IntentConsensusParticipant = {
  model: string
  providerID: string
  modelID: string
  roles: DllRole[]
  sources: string[]
}

export type IntentConsensusPlan = {
  required: boolean
  reason: string
  participants: IntentConsensusParticipant[]
  excluded: Array<{ model: string; reason: string }>
}

export type IntentJudgementPlan = {
  action: "deterministic_accept" | "single_model_judge" | "multi_model_consensus" | "hard_safety"
  reason: string
  primary?: IntentConsensusParticipant
  consensus?: IntentConsensusPlan
}

function parseModel(model: string) {
  const slash = model.indexOf("/")
  if (slash === -1) return { providerID: model, modelID: "" }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function isExcludedIntentConsensusModel(model: string) {
  const provider = parseModel(model).providerID.toLowerCase()
  if (provider === "openai") return "openai_excluded_by_intent_consensus_policy"
  if (/tts|voice|speech|audio/i.test(model)) return "voice_tts_excluded_from_coding_intent_consensus"
  return undefined
}

export function collectIntentConsensusParticipants(input: {
  sessionID?: string
  projectDir?: string
  roleModels?: EffectiveRoleModel[]
} = {}): IntentConsensusPlan["participants"] {
  const grouped = new Map<string, IntentConsensusParticipant>()
  for (const effective of input.roleModels ?? listRoleModels(input.sessionID, input.projectDir)) {
    if (!effective.enabled) continue
    if (isExcludedIntentConsensusModel(effective.primary)) continue
    const parsed = parseModel(effective.primary)
    const existing = grouped.get(effective.primary)
    if (existing) {
      if (!existing.roles.includes(effective.role)) existing.roles.push(effective.role)
      if (!existing.sources.includes(effective.source)) existing.sources.push(effective.source)
      continue
    }
    grouped.set(effective.primary, {
      model: effective.primary,
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      roles: [effective.role],
      sources: [effective.source],
    })
  }
  return [...grouped.values()]
}

export function buildIntentConsensusPlan(input: {
  classification: TaskIntakeClassification
  sessionID?: string
  projectDir?: string
  roleModels?: EffectiveRoleModel[]
}): IntentConsensusPlan {
  const roleModels = input.roleModels ?? listRoleModels(input.sessionID, input.projectDir)
  const participants = collectIntentConsensusParticipants({
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    roleModels,
  })
  const commander = participants.find((participant) => participant.roles.includes("commander"))
  const orderedParticipants = commander
    ? [commander, ...participants.filter((participant) => participant !== commander)]
    : participants
  const excluded = roleModels
    .map((effective) => {
      const reason = isExcludedIntentConsensusModel(effective.primary)
      return reason ? { model: effective.primary, reason } : undefined
    })
    .filter((item): item is { model: string; reason: string } => Boolean(item))

  if (input.classification.interaction_level === "L4") {
    return {
      required: false,
      reason: "hard safety rules decide L4 tasks; model consensus cannot downgrade high-risk intent",
      participants: orderedParticipants,
      excluded,
    }
  }
  if (input.classification.confidence === "low" || input.classification.model_classifier_needed) {
    return {
      required: true,
      reason: "deterministic task intake classification is low-confidence or ambiguous",
      participants: orderedParticipants,
      excluded,
    }
  }
  return {
    required: false,
    reason: "deterministic task intake classification is confident enough; skip consensus to avoid unnecessary model calls",
    participants: orderedParticipants,
    excluded,
  }
}

export function buildIntentJudgementPlan(input: {
  classification: TaskIntakeClassification
  sessionID?: string
  projectDir?: string
  roleModels?: EffectiveRoleModel[]
  previousSingleModelConfidence?: "low" | "medium" | "high"
}): IntentJudgementPlan {
  const consensus = buildIntentConsensusPlan(input)
  if (input.classification.interaction_level === "L4") {
    return {
      action: "hard_safety",
      reason: "hard safety classification wins before any model judgement",
      consensus,
    }
  }
  if (input.previousSingleModelConfidence === "low") {
    return {
      action: "multi_model_consensus",
      reason: "single-model intent judgement was low confidence; escalate to all configured non-OpenAI models",
      consensus: { ...consensus, required: true },
    }
  }
  if (input.classification.confidence === "low" || input.classification.model_classifier_needed) {
    return {
      action: "single_model_judge",
      reason: "deterministic classifier is ambiguous; ask the primary non-OpenAI runtime model first",
      primary: consensus.participants[0],
      consensus,
    }
  }
  return {
    action: "deterministic_accept",
    reason: "deterministic user-origin classification is confident; no intent model call needed",
    consensus,
  }
}

export * as IntentConsensus from "./intent-consensus"
