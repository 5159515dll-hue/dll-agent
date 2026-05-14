import { listRoleModels, type DllRole, type EffectiveRoleModel } from "./role-model-registry"
import type { TaskFinalizationPolicy, TaskIntakeClassification, TaskKind } from "./task-intake-classifier"

export type IntentInteractionLevel = TaskIntakeClassification["interaction_level"]
export type IntentConfidence = TaskIntakeClassification["confidence"]

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

export type ModelIntentJudgement = {
  task_kind: TaskKind
  interaction_level: IntentInteractionLevel
  confidence: IntentConfidence
  tool_required: boolean
  reviewer_required: boolean
  verification_required: boolean
  goal_contract_required: boolean
  repo_doctor_allowed: boolean
  continuation_allowed: boolean
  final_gate_required: boolean
  finalization_policy: TaskFinalizationPolicy
  reason: string
  missing_information: string[]
}

export type IntentJudgementRecord = {
  message_id: string
  source: "deterministic" | "single_model" | "multi_model_consensus" | "hard_safety"
  plan_action: IntentJudgementPlan["action"]
  model?: string
  participants: string[]
  excluded_models: Array<{ model: string; reason: string }>
  classification: TaskIntakeClassification
  raw_confidence: IntentConfidence
  reason: string
  created_at: string
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

const TASK_KINDS = new Set<TaskKind>([
  "greeting",
  "stateless_chat",
  "informational",
  "light_engineering_analysis",
  "artifact_editing",
  "coding",
  "debugging",
  "verification",
  "planning",
  "permission",
  "high_risk",
  "multimodal",
  "unknown",
])

const INTERACTION_LEVELS = new Set<IntentInteractionLevel>(["L0", "L1", "L2", "L3", "L4"])
const CONFIDENCES = new Set<IntentConfidence>(["low", "medium", "high"])
const FINALIZATION_POLICIES = new Set<TaskFinalizationPolicy>([
  "stateless_answer",
  "informational_answer",
  "read_only_answer",
  "engineering_verification",
  "high_risk_governance",
])

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return undefined
  return candidate.slice(start, end + 1)
}

export function parseModelIntentJudgement(text: string): ModelIntentJudgement | undefined {
  try {
    const json = extractJsonObject(text)
    if (!json) return undefined
    const parsed = JSON.parse(json) as Record<string, unknown>
    const taskKind = parsed.task_kind
    const level = parsed.interaction_level
    const confidence = parsed.confidence
    const finalization = parsed.finalization_policy
    if (typeof taskKind !== "string" || !TASK_KINDS.has(taskKind as TaskKind)) return undefined
    if (typeof level !== "string" || !INTERACTION_LEVELS.has(level as IntentInteractionLevel)) return undefined
    if (typeof confidence !== "string" || !CONFIDENCES.has(confidence as IntentConfidence)) return undefined
    if (typeof finalization !== "string" || !FINALIZATION_POLICIES.has(finalization as TaskFinalizationPolicy)) return undefined
    const normalizedLevel = taskKind === "artifact_editing" && ["L0", "L1", "L2"].includes(level)
      ? "L3"
      : level
    return {
      task_kind: taskKind as TaskKind,
      interaction_level: normalizedLevel as IntentInteractionLevel,
      confidence: confidence as IntentConfidence,
      tool_required: bool(parsed.tool_required, false),
      reviewer_required: bool(parsed.reviewer_required, false),
      verification_required: bool(parsed.verification_required, false),
      goal_contract_required: bool(parsed.goal_contract_required, normalizedLevel !== "L0" && normalizedLevel !== "L1"),
      repo_doctor_allowed: bool(parsed.repo_doctor_allowed, normalizedLevel !== "L0" && normalizedLevel !== "L1"),
      continuation_allowed: bool(parsed.continuation_allowed, normalizedLevel !== "L0" && normalizedLevel !== "L1"),
      final_gate_required: bool(parsed.final_gate_required, normalizedLevel !== "L0" && normalizedLevel !== "L1"),
      finalization_policy: finalization as TaskFinalizationPolicy,
      reason: typeof parsed.reason === "string"
        ? `${parsed.reason.slice(0, 500)}${normalizedLevel !== level ? "; artifact editing normalized to L3" : ""}`
        : `model intent judgement${normalizedLevel !== level ? "; artifact editing normalized to L3" : ""}`,
      missing_information: stringArray(parsed.missing_information).slice(0, 8),
    }
  } catch {
    return undefined
  }
}

function defaultsForLevel(level: IntentInteractionLevel, taskKind: TaskKind) {
  if (level === "L0") {
    return {
      tool_required: false,
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "stateless_answer" as const,
    }
  }
  if (level === "L1") {
    return {
      tool_required: false,
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "informational_answer" as const,
    }
  }
  if (level === "L2") {
    return {
      tool_required: taskKind === "light_engineering_analysis",
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: taskKind === "light_engineering_analysis",
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "read_only_answer" as const,
    }
  }
  if (level === "L4") {
    return {
      tool_required: true,
      reviewer_required: true,
      verification_required: true,
      goal_contract_required: true,
      repo_doctor_allowed: true,
      continuation_allowed: true,
      final_gate_required: true,
      finalization_policy: "high_risk_governance" as const,
    }
  }
  return {
    tool_required: true,
    reviewer_required: false,
    verification_required: true,
    goal_contract_required: true,
    repo_doctor_allowed: true,
    continuation_allowed: true,
    final_gate_required: true,
    finalization_policy: "engineering_verification" as const,
  }
}

export function classificationFromIntentJudgement(input: {
  deterministic: TaskIntakeClassification
  judgement?: ModelIntentJudgement
  source: "single_model" | "multi_model_consensus"
}): TaskIntakeClassification {
  if (input.deterministic.interaction_level === "L4" || input.deterministic.safety_overrides.length > 0) {
    return {
      ...input.deterministic,
      model_classifier_needed: false,
      matched_rules: [...input.deterministic.matched_rules, "intent_model_not_allowed_to_downgrade_safety"],
      reason: `${input.deterministic.reason}; hard safety classification preserved before model judgement`,
    }
  }
  const judgement = input.judgement
  if (!judgement) {
    return {
      ...input.deterministic,
      model_classifier_needed: false,
      matched_rules: [...input.deterministic.matched_rules, `${input.source}:parse_failed`],
      reason: `${input.deterministic.reason}; intent model output could not be parsed`,
    }
  }
  const defaults = defaultsForLevel(judgement.interaction_level, judgement.task_kind)
  return {
    task_kind: judgement.task_kind,
    interaction_level: judgement.interaction_level,
    user_origin_only: true,
    tool_required: judgement.tool_required || defaults.tool_required,
    reviewer_required: judgement.reviewer_required || defaults.reviewer_required,
    verification_required: judgement.verification_required || defaults.verification_required,
    goal_contract_required: judgement.goal_contract_required || defaults.goal_contract_required,
    repo_doctor_allowed: judgement.repo_doctor_allowed || defaults.repo_doctor_allowed,
    continuation_allowed: judgement.continuation_allowed || defaults.continuation_allowed,
    final_gate_required: judgement.final_gate_required || defaults.final_gate_required,
    model_classifier_needed: false,
    finalization_policy: defaults.finalization_policy,
    confidence: judgement.confidence,
    reason: `${input.source}: ${judgement.reason}`,
    matched_rules: [...input.deterministic.matched_rules, `${input.source}:semantic_intent_judgement`],
    safety_overrides: input.deterministic.safety_overrides,
  }
}

function confidenceWeight(confidence: IntentConfidence) {
  if (confidence === "high") return 3
  if (confidence === "medium") return 2
  return 1
}

export function mergeIntentJudgements(input: {
  deterministic: TaskIntakeClassification
  judgements: ModelIntentJudgement[]
}): ModelIntentJudgement | undefined {
  if (input.deterministic.interaction_level === "L4") return undefined
  if (input.judgements.length === 0) return undefined
  const highRisk = input.judgements.find((judgement) => judgement.interaction_level === "L4")
  if (highRisk) return { ...highRisk, confidence: "high", reason: `consensus escalated to L4: ${highRisk.reason}` }

  const grouped = new Map<string, { judgement: ModelIntentJudgement; votes: number; weight: number }>()
  for (const judgement of input.judgements) {
    const key = `${judgement.interaction_level}:${judgement.task_kind}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { judgement, votes: 1, weight: confidenceWeight(judgement.confidence) })
      continue
    }
    existing.votes++
    existing.weight += confidenceWeight(judgement.confidence)
    if (confidenceWeight(judgement.confidence) > confidenceWeight(existing.judgement.confidence)) {
      existing.judgement = judgement
    }
  }
  const selected = [...grouped.values()].sort((a, b) => b.votes - a.votes || b.weight - a.weight)[0]
  if (!selected) return undefined
  return {
    ...selected.judgement,
    confidence: selected.votes >= 2 || selected.judgement.confidence === "high" ? "high" : "medium",
    reason: `consensus ${selected.votes}/${input.judgements.length}: ${selected.judgement.reason}`,
  }
}

export function buildIntentJudgePrompt(input: {
  userText: string
  deterministic: TaskIntakeClassification
}) {
  return [
    "You are an internal dll-agent task-intake classifier.",
    "Classify only the latest raw user request. Do not solve the task.",
    "Do not use tools. Do not browse. Do not request secrets. Do not execute commands.",
    "Hard safety rule: destructive commands, secrets/auth, global/system mutation, remote publish, live MCP/browser/profile access, and provider/gate/permission changes are L4 and must not be downgraded.",
    "Return one JSON object only with these fields:",
    "task_kind: greeting | stateless_chat | informational | light_engineering_analysis | artifact_editing | coding | debugging | verification | planning | permission | high_risk | multimodal | unknown",
    "interaction_level: L0 | L1 | L2 | L3 | L4",
    "confidence: low | medium | high",
    "tool_required, reviewer_required, verification_required, goal_contract_required, repo_doctor_allowed, continuation_allowed, final_gate_required: booleans",
    "finalization_policy: stateless_answer | informational_answer | read_only_answer | engineering_verification | high_risk_governance",
    "reason: short explanation",
    "missing_information: array of strings",
    "",
    "Interaction levels:",
    "L0 means stateless/no-op chat.",
    "L1 means answer-only informational request.",
    "L2 means read-only engineering analysis or planning; reading files may be useful but no mutation, generated artifact, export, or verification is required.",
    "L3 means coding, debugging, verification, test/build, artifact editing/optimization, generated copy/export, or engineering execution.",
    "Classify any task that asks to edit, optimize, transform, generate, export, or save a file/artifact as task_kind=artifact_editing and interaction_level=L3, even when the artifact is a document, deck, spreadsheet, image, or other non-code file.",
    "L4 means high-risk safety/governance/permission/destructive/provider/runtime action.",
    "",
    `Deterministic classifier seed: ${JSON.stringify({
      task_kind: input.deterministic.task_kind,
      interaction_level: input.deterministic.interaction_level,
      confidence: input.deterministic.confidence,
      matched_rules: input.deterministic.matched_rules,
      safety_overrides: input.deterministic.safety_overrides,
    })}`,
    "",
    "Latest raw user request:",
    input.userText.slice(0, 4_000),
  ].join("\n")
}

export * as IntentConsensus from "./intent-consensus"
