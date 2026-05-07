/**
 * dll-agent skill-loader.ts
 *
 * 技能三层加载控制器：
 * 1. metadata only  — 只加载技能 id、name、description、triggers
 * 2. summary mode   — 加载简短执行规则（≤ 200 字符），用于 system prompt 尾部注入
 * 3. full mode      — 只有在技能真正激活时，才加载完整约束（requiredEvidence、
 *                      allowedCommands、forbiddenCommands、verificationCommands、
 *                      costPolicy、securityPolicy、rollbackPolicy）
 *
 * 设计原则：
 * - 不要让 skill prompt 污染主上下文；
 * - 技能输出必须结构化，方便 supervisor 和 evidence 处理；
 * - 完整规则只对 activated skills 注入到对应 subagent 的 task packet 中。
 */

import { SKILL_REGISTRY, type SkillDefinition } from "./skill-registry"

export const MAX_ACTIVE_PER_TURN = 3
export const MAX_HIGH_RISK_ACTIVE = 3
export const MAX_ACTIVE_DEFAULT = 2

// ─── Level 1: Metadata only ──────────────────────────────────────────────

/** 精简版元数据：只包含 id、name、description、trigger 关键词 */
export interface SkillMetadata {
  id: string
  name: string
  description: string
  riskLevel: SkillDefinition["riskLevel"]
  /** 代表性触发关键词（最多 5 个） */
  triggerHints: string[]
}

/** 返回所有注册技能的元数据列表，用于 commander 初始上下文注入 */
export function allMetadata(): SkillMetadata[] {
  return SKILL_REGISTRY.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    riskLevel: s.riskLevel,
    triggerHints: (s.triggers.keywords ?? []).slice(0, 5).map((r) => r.source),
  }))
}

// ─── Level 2: Summary mode ───────────────────────────────────────────────

/**
 * 为已激活技能生成最多 200 字符的简短提示字符串。
 * 调用方（supervisor 或 prompt builder）将此挂到下一轮 system prompt 末尾。
 */
export function summary(activeSkills: SkillDefinition[]): string {
  if (activeSkills.length === 0) return ""
  const parts = activeSkills.map((s) => `${s.name}(${s.riskLevel})`)
  const text = `[dll-agent active skills: ${parts.join(", ")}]`
  return text.length > 200 ? text.slice(0, 197) + "..." : text
}

// ─── Level 3: Full mode ──────────────────────────────────────────────────

/**
 * 结构化技能激活输出。每个技能被激活后，输出必须包含：
 * - skill_id, trigger_reason, risk_level
 * - findings, recommended_actions, blocked_actions
 * - required_evidence, verification_plan
 * - cost_impact, security_impact
 * - next_step
 *
 * 如果技能发现阻断问题，必须设置 blocking=true。
 */
export interface SkillActivationOutput {
  skill_id: string
  trigger_reason: string
  risk_level: SkillDefinition["riskLevel"]
  /** 技能发现的问题 */
  findings: string[]
  /** 建议操作 */
  recommended_actions: string[]
  /** 被技能规则阻断的操作 */
  blocked_actions: string[]
  /** 必须收集的 evidence 类型 */
  required_evidence: string[]
  /** 验证计划（命令列表） */
  verification_plan: string[]
  /** 成本影响说明 */
  cost_impact: {
    singleCallCapMultiplier: number
    allowOpenAI: boolean
    allowExpensiveReviewer: boolean
  }
  /** 安全影响说明 */
  security_impact: {
    requireRedaction: boolean
    allowExternalWrite: boolean
    allowNetworkFetch: boolean
  }
  /** 是否阻断后续操作 */
  blocking: boolean
  /** 阻断原因 */
  block_reason: string | null
  /** 解除阻断的必要修复 */
  required_fix: string | null
  /** 解除阻断的必要验证 */
  required_verification: string | null
  /** 下一步操作 */
  next_step: string
}

/**
 * 为单条已激活技能生成完整输出结构。
 * 由 commander 或 supervisor 在处理技能激活后调用。
 * 不会自动执行 — 调用者拿到输出后自行决定如何使用。
 */
export function fullOutput(
  skill: SkillDefinition,
  reason: string,
  opts?: { blocking?: boolean; blockReason?: string; requiredFix?: string; requiredVerification?: string },
): SkillActivationOutput {
  return {
    skill_id: skill.id,
    trigger_reason: reason,
    risk_level: skill.riskLevel,
    findings: [],
    recommended_actions: skill.verificationCommands ?? [],
    blocked_actions: skill.forbiddenCommands ?? [],
    required_evidence: skill.requiredEvidence,
    verification_plan: skill.verificationCommands ?? [],
    cost_impact: {
      singleCallCapMultiplier: skill.costPolicy.singleCallCapMultiplier,
      allowOpenAI: skill.costPolicy.allowOpenAI,
      allowExpensiveReviewer: skill.costPolicy.allowExpensiveReviewer,
    },
    security_impact: {
      requireRedaction: skill.securityPolicy.requireRedaction,
      allowExternalWrite: skill.securityPolicy.allowExternalWrite,
      allowNetworkFetch: skill.securityPolicy.allowNetworkFetch,
    },
    blocking: opts?.blocking ?? false,
    block_reason: opts?.blockReason ?? null,
    required_fix: opts?.requiredFix ?? null,
    required_verification: opts?.requiredVerification ?? null,
    next_step: skill.verificationCommands?.[0] ?? "proceed with task",
  }
}

/**
 * 为所有激活技能生成批量结构化输出。
 * 用于 supervisor 做 reconciliation 或 evidence 记录。
 */
export function fullOutputs(
  activated: { skill: SkillDefinition; reason: string }[],
): SkillActivationOutput[] {
  return activated.map((a) => fullOutput(a.skill, a.reason))
}

/**
 * 获取技能的完整规则（full mode），用于注入 subagent task packet。
 * 只在技能真正激活时调用，避免 prompt 污染。
 */
export function fullRules(skill: SkillDefinition): string {
  const lines = [
    `[dll-agent skill: ${skill.id} v${skill.version}]`,
    `Risk: ${skill.riskLevel}`,
    skill.description,
    "",
    "Required evidence:",
    ...skill.requiredEvidence.map((e) => `  - ${e}`),
    "",
    "Verification:",
    ...(skill.verificationCommands ?? []).map((c) => `  $ ${c}`),
  ]
  if (skill.allowedCommands && skill.allowedCommands.length > 0) {
    lines.push("", "Allowed commands:")
    for (const c of skill.allowedCommands) lines.push(`  $ ${c}`)
  }
  if (skill.forbiddenCommands && skill.forbiddenCommands.length > 0) {
    lines.push("", "FORBIDDEN commands:")
    for (const c of skill.forbiddenCommands) lines.push(`  ✗ ${c}`)
  }
  lines.push(
    "",
    `Cost policy: singleCallCap×${skill.costPolicy.singleCallCapMultiplier}, OpenAI=${skill.costPolicy.allowOpenAI}, expensiveReviewer=${skill.costPolicy.allowExpensiveReviewer}`,
  )
  lines.push(
    `Security: redaction=${skill.securityPolicy.requireRedaction}, externalWrite=${skill.securityPolicy.allowExternalWrite}, networkFetch=${skill.securityPolicy.allowNetworkFetch}`,
  )
  if (skill.rollbackPolicy.autoRollback) {
    lines.push("", "Rollback plan:")
    for (const c of skill.rollbackPolicy.rollbackCommands) lines.push(`  $ ${c}`)
  }
  return lines.join("\n")
}


