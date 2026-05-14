export type TaskKind =
  | "greeting"
  | "stateless_chat"
  | "informational"
  | "light_engineering_analysis"
  | "artifact_editing"
  | "coding"
  | "debugging"
  | "verification"
  | "planning"
  | "permission"
  | "high_risk"
  | "multimodal"
  | "unknown"

export type InteractionLevel = "L0" | "L1" | "L2" | "L3" | "L4"

export type TaskFinalizationPolicy =
  | "stateless_answer"
  | "informational_answer"
  | "read_only_answer"
  | "engineering_verification"
  | "high_risk_governance"

export type TaskIntakeClassification = {
  task_kind: TaskKind
  interaction_level: InteractionLevel
  user_origin_only: true
  tool_required: boolean
  reviewer_required: boolean
  verification_required: boolean
  goal_contract_required: boolean
  repo_doctor_allowed: boolean
  continuation_allowed: boolean
  final_gate_required: boolean
  model_classifier_needed: boolean
  finalization_policy: TaskFinalizationPolicy
  confidence: "low" | "medium" | "high"
  reason: string
  matched_rules: string[]
  safety_overrides: string[]
}

export const DEFAULT_TASK_INTAKE_RULES = {
  greetings: [],
  informational: [],
  lightEngineeringAnalysis: [],
  coding: [],
  debugging: [],
  verification: [],
  planning: [],
  permission: [],
  multimodal: [],
  highRisk: [],
} as const satisfies Record<string, readonly RegExp[]>

export type TaskIntakePolicyManifest = Partial<Record<
  | "greetings"
  | "informational"
  | "light_engineering_analysis"
  | "coding"
  | "debugging"
  | "verification"
  | "planning"
  | "permission"
  | "multimodal"
  | "high_risk",
  string[]
>>

const policyCache = new Map<string, TaskIntakePolicyManifest>()

function normalizeText(text: string) {
  return text.trim().replace(/^["'“”]+|["'“”。.!?？！]+$/g, "").trim()
}

function hasFileOrPathIntent(text: string) {
  return /(?:^|\s)(?:\.{0,2}\/|~\/|\/Users\/|[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|md|json|jsonc|yaml|yml|toml|sh|sql|html|css|png|jpg|jpeg|pdf|docx|pptx|xlsx))\b/.test(text)
}

function hasCodeBlock(text: string) {
  return /```|(?:^|\n)\s*(?:import|export|const|let|function|class|def|package|SELECT|CREATE TABLE)\b/.test(text)
}

function hasMultimodalStructuralSignal(text: string) {
  return /\.(?:png|jpg|jpeg|gif|webp|bmp|svg|mp4|mov|avi|webm|mp3|wav|ogg)\b/i.test(text)
}

function hasPermissionBoundarySignal(text: string) {
  return /(?:^|[\s._-])(?:api[_-]?key|secret|token|cookie|credential|credentials|ssh[_-]?key|authorization|\.env|keychain)(?:$|[\s._-])/i.test(text)
}

function hasHighRiskStructuralSignal(text: string) {
  return /\b(?:sudo|rm\s+-rf|git\s+push|git\s+reset\s+--hard|git\s+clean\s+-fdx|curl\s+[^|]+?\|\s*(?:sh|bash)|chmod\s+[0-7]{3,4}|chown\s+|brew\s+install|npm\s+install\s+-g|pip\s+install\s+--user|docker\s+run)\b/i.test(text)
}

function hasDebugArtifactSignal(text: string) {
  return /```|(?:^|\n)\s*(?:traceback|stack trace|panic:|npm ERR!|error:|exception:|TS\d{4}|exit(?:ed)? with code [1-9])\b/i.test(text)
}

function hasVerificationCommandSignal(text: string) {
  return /\b(?:typecheck|tsgo|tsc|bun\s+test|npm\s+test|pytest|go\s+test|cargo\s+test|doctor|lint|smoke|build)\b/i.test(text)
}

function hasMutationArtifactSignal(text: string) {
  return /(?:^|\n)\s*(?:\+\+\+|---|@@\s|apply_patch|git\s+apply|cat\s+>|\b(?:write|edit|patch)\()/i.test(text)
}

function matchRule(text: string, rules: readonly RegExp[]) {
  return rules.find((rule) => rule.test(text))
}

function stripJsonComments(raw: string) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
}

function readPolicyFile(file: string): TaskIntakePolicyManifest {
  try {
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) as TaskIntakePolicyManifest
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function loadTaskIntakePolicy(projectDir = process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR || process.cwd()) {
  const key = projectDir
  const cached = policyCache.get(key)
  if (cached) return cached
  const globalPolicy = readPolicyFile(path.join(os.homedir(), ".dll-agent", "config", "task-intake-policy.jsonc"))
  const projectPolicy = readPolicyFile(path.join(projectDir, ".dll-agent", "task-intake-policy.jsonc"))
  const merged: TaskIntakePolicyManifest = {}
  for (const source of [globalPolicy, projectPolicy]) {
    for (const [k, v] of Object.entries(source)) {
      if (!Array.isArray(v)) continue
      merged[k as keyof TaskIntakePolicyManifest] = [...(merged[k as keyof TaskIntakePolicyManifest] ?? []), ...v]
    }
  }
  policyCache.set(key, merged)
  return merged
}

function wildcardToRegex(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

function matchPolicy(text: string, patterns: string[] | undefined) {
  if (!patterns?.length) return false
  return patterns.some((pattern) => {
    const trimmed = pattern.trim()
    if (!trimmed) return false
    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
      const end = trimmed.lastIndexOf("/")
      try {
        return new RegExp(trimmed.slice(1, end), trimmed.slice(end + 1) || "i").test(text)
      } catch {
        return false
      }
    }
    if (trimmed.includes("*")) return wildcardToRegex(trimmed).test(text)
    return text.toLowerCase().includes(trimmed.toLowerCase())
  })
}

function baseClassification(input: Partial<TaskIntakeClassification>): TaskIntakeClassification {
  return {
    task_kind: "unknown",
    interaction_level: "L2",
    user_origin_only: true,
    tool_required: false,
    reviewer_required: false,
    verification_required: false,
    goal_contract_required: true,
    repo_doctor_allowed: false,
    continuation_allowed: true,
    final_gate_required: true,
    model_classifier_needed: false,
    finalization_policy: "engineering_verification",
    confidence: "medium",
    reason: "default intake classification",
    matched_rules: [],
    safety_overrides: [],
    ...input,
  }
}

export function classifyTaskIntake(input: {
  userText: string
  hasNonTextInput?: boolean
  activeBlockingState?: boolean
  previousFailureFingerprint?: boolean
  doctorFailed?: boolean
  reviewerBlock?: boolean
  projectDir?: string
}): TaskIntakeClassification {
  const text = normalizeText(input.userText)
  const policy = loadTaskIntakePolicy(input.projectDir)
  const matchedRules: string[] = []
  const safetyOverrides: string[] = []

  if (!text && !input.hasNonTextInput) {
    return baseClassification({
      task_kind: "unknown",
      interaction_level: "L2",
      confidence: "low",
      model_classifier_needed: true,
      reason: "empty user-origin text",
      matched_rules: ["empty_user_text"],
    })
  }

  if (input.activeBlockingState) safetyOverrides.push("active_blocking_state")
  if (input.previousFailureFingerprint) safetyOverrides.push("previous_failure_fingerprint")
  if (input.doctorFailed) safetyOverrides.push("doctor_failed")
  if (input.reviewerBlock) safetyOverrides.push("reviewer_block")

  if (input.hasNonTextInput || hasMultimodalStructuralSignal(text) || matchPolicy(text, policy.multimodal)) {
    matchedRules.push(input.hasNonTextInput ? "structural:non_text_input" : hasMultimodalStructuralSignal(text) ? "structural:multimodal_file" : "policy:multimodal")
    return baseClassification({
      task_kind: "multimodal",
      interaction_level: "L3",
      tool_required: input.hasNonTextInput ?? false,
      reviewer_required: !!input.hasNonTextInput,
      verification_required: false,
      repo_doctor_allowed: false,
      finalization_policy: "engineering_verification",
      confidence: input.hasNonTextInput ? "high" : "medium",
      reason: "user-origin multimodal input or multimodal request detected",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasHighRiskStructuralSignal(text) || matchPolicy(text, policy.high_risk)) {
    matchedRules.push(hasHighRiskStructuralSignal(text) ? "structural:high_risk_command" : "policy:high_risk")
    return baseClassification({
      task_kind: "high_risk",
      interaction_level: "L4",
      tool_required: true,
      reviewer_required: true,
      verification_required: true,
      repo_doctor_allowed: true,
      finalization_policy: "high_risk_governance",
      confidence: "high",
      reason: "user-origin high-risk governance, permission, provider, release, or destructive operation signal",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasPermissionBoundarySignal(text) || matchPolicy(text, policy.permission)) {
    matchedRules.push(hasPermissionBoundarySignal(text) ? "structural:permission_boundary" : "policy:permission")
    return baseClassification({
      task_kind: "permission",
      interaction_level: "L4",
      tool_required: false,
      reviewer_required: true,
      verification_required: false,
      repo_doctor_allowed: false,
      finalization_policy: "high_risk_governance",
      confidence: "high",
      reason: "user-origin permission or secret boundary request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.greetings) && text.length <= 40) {
    matchedRules.push("policy:greeting")
    return baseClassification({
      task_kind: "greeting",
      interaction_level: "L0",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "stateless_answer",
      confidence: "high",
      reason: "stateless greeting or acknowledgement from user-origin input",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.light_engineering_analysis) && !hasCodeBlock(text)) {
    const engineeringReadOnly = hasFileOrPathIntent(text) || matchPolicy(text, policy.light_engineering_analysis)
    matchedRules.push("policy:light_engineering_analysis")
    return baseClassification({
      task_kind: engineeringReadOnly ? "light_engineering_analysis" : "informational",
      interaction_level: engineeringReadOnly ? "L2" : "L1",
      tool_required: hasFileOrPathIntent(text),
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: hasFileOrPathIntent(text),
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: engineeringReadOnly ? "read_only_answer" : "informational_answer",
      confidence: "high",
      reason: "project policy classified user-origin input as read-only answer without mutation or verification",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (!hasFileOrPathIntent(text) && !hasCodeBlock(text) && matchPolicy(text, policy.informational)) {
    matchedRules.push("policy:informational")
    return baseClassification({
      task_kind: "informational",
      interaction_level: "L1",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "informational_answer",
      confidence: "high",
      reason: "project policy classified user-origin input as informational answer",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasDebugArtifactSignal(text) || matchPolicy(text, policy.debugging)) {
    matchedRules.push(hasDebugArtifactSignal(text) ? "structural:debug_artifact" : "policy:debugging")
    return baseClassification({
      task_kind: "debugging",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      finalization_policy: "engineering_verification",
      confidence: "high",
      reason: "user-origin debugging or failure signal",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasMutationArtifactSignal(text) || matchPolicy(text, policy.coding)) {
    matchedRules.push(hasMutationArtifactSignal(text) ? "structural:mutation_artifact" : "policy:coding")
    return baseClassification({
      task_kind: "coding",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      finalization_policy: "engineering_verification",
      confidence: "high",
      reason: "user-origin code mutation intent",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasVerificationCommandSignal(text) || matchPolicy(text, policy.verification)) {
    matchedRules.push(hasVerificationCommandSignal(text) ? "structural:verification_command" : "policy:verification")
    return baseClassification({
      task_kind: "verification",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      finalization_policy: "engineering_verification",
      confidence: "high",
      reason: "user-origin verification or repo-health request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (hasFileOrPathIntent(text)) {
    matchedRules.push("structural:file_or_path_reference")
    return baseClassification({
      task_kind: "light_engineering_analysis",
      interaction_level: "L2",
      tool_required: hasFileOrPathIntent(text),
      reviewer_required: false,
      verification_required: false,
      repo_doctor_allowed: true,
      model_classifier_needed: true,
      finalization_policy: "engineering_verification",
      confidence: "low",
      reason: "user-origin file/path reference requires semantic intent judgement before assuming read-only or mutation",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.planning)) {
    matchedRules.push("policy:planning")
    return baseClassification({
      task_kind: "planning",
      interaction_level: "L2",
      tool_required: false,
      reviewer_required: false,
      verification_required: false,
      repo_doctor_allowed: false,
      finalization_policy: "read_only_answer",
      confidence: "medium",
      reason: "user-origin planning request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (text.length <= 40 && !hasFileOrPathIntent(text) && !hasCodeBlock(text)) {
    matchedRules.push("structural:short_no_artifact_input")
    return baseClassification({
      task_kind: "stateless_chat",
      interaction_level: "L1",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "informational_answer",
      model_classifier_needed: true,
      confidence: "low",
      reason: "short user-origin input has no structural engineering, verification, mutation, permission, or multimodal signal",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  return baseClassification({
    task_kind: "unknown",
    interaction_level: "L2",
    confidence: "low",
    model_classifier_needed: true,
    reason: "ambiguous user-origin task; deterministic classifier cannot decide with high confidence",
    matched_rules: ["ambiguous"],
    safety_overrides: safetyOverrides,
  })
}

export function canSuppressRoutineReview(classification: TaskIntakeClassification | undefined) {
  if (!classification) return false
  if (classification.safety_overrides.length > 0) return false
  if (classification.reviewer_required || classification.tool_required || classification.verification_required) return false
  return classification.interaction_level === "L0" || classification.interaction_level === "L1"
}

export function canUseReadOnlyAnswerFinalization(classification: TaskIntakeClassification | undefined) {
  if (!classification) return false
  if (classification.safety_overrides.length > 0) return false
  if (classification.reviewer_required || classification.verification_required) return false
  if (classification.task_kind !== "light_engineering_analysis") return false
  if (classification.finalization_policy !== "read_only_answer") return false
  return classification.interaction_level === "L2"
}

export function canUseAnswerOnlyFinalization(classification: TaskIntakeClassification | undefined) {
  if (!classification) return false
  if (classification.safety_overrides.length > 0) return false
  if (classification.reviewer_required || classification.verification_required) return false
  if (classification.finalization_policy === "stateless_answer") return classification.interaction_level === "L0"
  if (classification.finalization_policy === "informational_answer") return classification.interaction_level === "L1"
  return canUseReadOnlyAnswerFinalization(classification)
}

export function canTreatReadOnlyToolFailureAsInformational(classification: TaskIntakeClassification | undefined) {
  if (!classification) return false
  if (classification.safety_overrides.length > 0) return false
  if (classification.interaction_level === "L1" && classification.finalization_policy === "informational_answer") return true
  return canUseReadOnlyAnswerFinalization(classification)
}

export * as TaskIntakeClassifier from "./task-intake-classifier"
import fs from "fs"
import os from "os"
import path from "path"
