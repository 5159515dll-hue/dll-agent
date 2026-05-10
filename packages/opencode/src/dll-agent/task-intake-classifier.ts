export type TaskKind =
  | "greeting"
  | "stateless_chat"
  | "informational"
  | "light_engineering_analysis"
  | "coding"
  | "debugging"
  | "verification"
  | "planning"
  | "permission"
  | "high_risk"
  | "multimodal"
  | "unknown"

export type InteractionLevel = "L0" | "L1" | "L2" | "L3" | "L4"

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
  confidence: "low" | "medium" | "high"
  reason: string
  matched_rules: string[]
  safety_overrides: string[]
}

export const DEFAULT_TASK_INTAKE_RULES = {
  greetings: [
    /^(你好|您好|hello|hi|hey|在吗|哈喽|早上好|上午好|中午好|下午好|晚上好|谢谢|多谢|thanks|thank you|ok|okay|好的|好|嗯|收到|辛苦了)$/i,
  ],
  informational: [
    /^(介绍一下|介绍下|介绍|讲讲|说说|说明一下|解释一下|什么是|何为|tell me about|explain|what is|介绍一下.*是什么)/i,
    /(是什么|有什么用|用于什么|能做什么|怎么理解)$/i,
    /^summarize (?:the )?(?:concept|idea|meaning|purpose|overview)\b/i,
  ],
  lightEngineeringAnalysis: [
    /(帮我看看|看一下|分析一下|评估一下|review一下|解释.*代码|架构.*说明|代码.*说明|不改代码|只分析|只读分析)/i,
  ],
  coding: [
    /(改|修改|修复|实现|新增|删除|重构|写代码|编辑|patch|fix|implement|edit|write|delete|refactor)/i,
  ],
  debugging: [
    /(报错|错误|失败|日志|异常|栈|traceback|stack trace|error|failed|exception|debug|调试|定位原因)/i,
  ],
  verification: [
    /(测试|验证|检查|typecheck|build|doctor|lint|smoke|运行测试|跑测试|verify|test|run tests?)/i,
  ],
  planning: [
    /(计划|方案|规划|拆解|路线图|继续|下一步|完成所有|所有目标|active plan|phase|plan|roadmap|strategy|continue|next step)/i,
  ],
  permission: [
    /(权限|授权|Full Access|Auto-review|secrets?|token|cookie|ssh key|credential|凭据|密钥|钥匙串)/i,
  ],
  multimodal: [
    /(截图|图片|图表|流程图|视频|音频|screenshot|image|photo|chart|flowchart|video|audio|\.(?:png|jpg|jpeg|gif|webp|mp4|mov|mp3|wav)\b)/i,
  ],
  highRisk: [
    /(provider|routing|route|gate|evidence|result ledger|dedup|permission|secrets?|auth|model switching|role model|doctor failed|quota|cost policy|MCP runtime|git push|sudo|rm\s+-rf|reset\s+--hard|clean\s+-fdx|release|upload|上游同步|远程发布|删除|覆盖|破坏性|权限|凭据|模型切换|结果账本|证据|审查路由)/i,
  ],
} as const

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

  if (input.hasNonTextInput || matchPolicy(text, policy.multimodal) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.multimodal)) {
    matchedRules.push(matchPolicy(text, policy.multimodal) ? "policy:multimodal" : "multimodal")
    return baseClassification({
      task_kind: "multimodal",
      interaction_level: "L3",
      tool_required: input.hasNonTextInput ?? false,
      reviewer_required: !!input.hasNonTextInput,
      verification_required: false,
      repo_doctor_allowed: false,
      confidence: input.hasNonTextInput ? "high" : "medium",
      reason: "user-origin multimodal input or multimodal request detected",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.high_risk) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.highRisk)) {
    matchedRules.push(matchPolicy(text, policy.high_risk) ? "policy:high_risk" : "high_risk")
    return baseClassification({
      task_kind: "high_risk",
      interaction_level: "L4",
      tool_required: true,
      reviewer_required: true,
      verification_required: true,
      repo_doctor_allowed: true,
      confidence: "high",
      reason: "user-origin high-risk governance, permission, provider, release, or destructive operation signal",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.permission) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.permission)) {
    matchedRules.push(matchPolicy(text, policy.permission) ? "policy:permission" : "permission")
    return baseClassification({
      task_kind: "permission",
      interaction_level: "L4",
      tool_required: false,
      reviewer_required: true,
      verification_required: false,
      repo_doctor_allowed: false,
      confidence: "high",
      reason: "user-origin permission or secret boundary request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if ((matchPolicy(text, policy.greetings) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.greetings)) && text.length <= 40) {
    matchedRules.push(matchPolicy(text, policy.greetings) ? "policy:greeting" : "greeting")
    return baseClassification({
      task_kind: "greeting",
      interaction_level: "L0",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      confidence: "high",
      reason: "stateless greeting or acknowledgement from user-origin input",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (!hasFileOrPathIntent(text) && !hasCodeBlock(text) && (matchPolicy(text, policy.informational) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.informational))) {
    matchedRules.push(matchPolicy(text, policy.informational) ? "policy:informational" : "informational")
    return baseClassification({
      task_kind: "informational",
      interaction_level: "L1",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      confidence: "high",
      reason: "stateless informational question without file, tool, verification, or mutation intent",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.debugging) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.debugging)) {
    matchedRules.push(matchPolicy(text, policy.debugging) ? "policy:debugging" : "debugging")
    return baseClassification({
      task_kind: "debugging",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      confidence: "high",
      reason: "user-origin debugging or failure signal",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.coding) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.coding)) {
    matchedRules.push(matchPolicy(text, policy.coding) ? "policy:coding" : "coding")
    return baseClassification({
      task_kind: "coding",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      confidence: "high",
      reason: "user-origin code mutation intent",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.verification) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.verification)) {
    matchedRules.push(matchPolicy(text, policy.verification) ? "policy:verification" : "verification")
    return baseClassification({
      task_kind: "verification",
      interaction_level: "L3",
      tool_required: true,
      reviewer_required: false,
      verification_required: true,
      repo_doctor_allowed: true,
      confidence: "high",
      reason: "user-origin verification or repo-health request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.light_engineering_analysis) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.lightEngineeringAnalysis) || hasFileOrPathIntent(text)) {
    matchedRules.push(matchPolicy(text, policy.light_engineering_analysis) ? "policy:light_engineering_analysis" : hasFileOrPathIntent(text) ? "file_or_path_reference" : "light_engineering_analysis")
    return baseClassification({
      task_kind: "light_engineering_analysis",
      interaction_level: "L2",
      tool_required: hasFileOrPathIntent(text),
      reviewer_required: false,
      verification_required: false,
      repo_doctor_allowed: true,
      confidence: "medium",
      reason: "user-origin light engineering analysis or file/path reference without mutation",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (matchPolicy(text, policy.planning) || matchRule(text, DEFAULT_TASK_INTAKE_RULES.planning)) {
    matchedRules.push(matchPolicy(text, policy.planning) ? "policy:planning" : "planning")
    return baseClassification({
      task_kind: "planning",
      interaction_level: "L2",
      tool_required: false,
      reviewer_required: false,
      verification_required: false,
      repo_doctor_allowed: false,
      confidence: "medium",
      reason: "user-origin planning request",
      matched_rules: matchedRules,
      safety_overrides: safetyOverrides,
    })
  }

  if (text.length <= 120 && !hasFileOrPathIntent(text) && !hasCodeBlock(text)) {
    matchedRules.push("short_stateless_chat")
    return baseClassification({
      task_kind: "stateless_chat",
      interaction_level: "L1",
      goal_contract_required: false,
      repo_doctor_allowed: false,
      continuation_allowed: false,
      final_gate_required: false,
      confidence: "medium",
      reason: "short user-origin chat without tool, file, code, verification, or mutation intent",
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

export * as TaskIntakeClassifier from "./task-intake-classifier"
import fs from "fs"
import os from "os"
import path from "path"
