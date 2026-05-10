/**
 * dll-agent skills.ts
 *
 * 纯函数 skill 激活/停用逻辑。从 skill-registry.ts 中按触发条件选出
 * 当前应当激活的 skills。激活/停用都写入 evidence。
 *
 * 不在此处操作 prompt；调用方（supervisor 或 prompt 构建处）拿到 ActiveSkill[]
 * 后通过 DllAgentSkillLoader.summary() / fullOutput() / fullRules() 获取
 * 不同层级的加载内容。
 *
 * 触发来源：
 * - 用户输入关键词
 * - 文件类型（修改/查看的文件 glob）
 * - 仓库标记（.git, package.json 等）
 * - 显式 intent（slash command 或 metadata）
 * - 工具失败信号（由 supervisor 传递）
 * - 测试/typecheck/doctor 失败信号（由 supervisor 传递）
 * - 上下文过长信号（由 supervisor 传递）
 * - evidence 缺失信号（由 gate 传递）
 */

import { SKILL_REGISTRY, type SkillDefinition, type SkillRisk, type SkillSignal } from "./skill-registry"
import { fullOutputs, summary as skillSummary, type SkillActivationOutput } from "./skill-loader"
import { write as writeEvidence, redact } from "./evidence"
import { canSuppressRoutineReview, classifyTaskIntake } from "./task-intake-classifier"
import fs from "fs"
import path from "path"
import os from "os"

export const MAX_ACTIVE_PER_TURN = 3

export interface ActivationInput {
  /** 用户当前消息文本（聚合最近 5 条 user message 即可） */
  userText: string
  /** 当前会话已修改/查看的文件路径 */
  files: string[]
  /** 仓库根包含的文件名 */
  repoMarkers: string[]
  /** 用户显式 intents（来自 slash command 或 metadata） */
  intents: string[]
  /** 用户是否对该 skill 显式同意（满足 requiresExplicitConsent） */
  consents?: string[]
  /** 当前步数 */
  currentStep: number
  /** 已激活历史：skill id -> { lastStep, count, fingerprint } */
  history?: Record<string, { lastStep: number; count: number; fingerprint?: string }>
  /** sessionID 用于 evidence */
  sessionID?: string
  /**
   * 来自 supervisor 的运行时信号（机器证据，非用户文本）。
   * 命中即可绕过 requiresExplicitConsent — 因为信号本身就是系统级硬证据。
   */
  signals?: SkillSignal[]
}

export interface ActivationResult {
  activated: ActiveSkill[]
  skipped: SkipRecord[]
  /** 所有激活技能的结构化输出（Level 3: full mode），方便 supervisor 处理 */
  outputs: SkillActivationOutput[]
}

export interface ActiveSkill {
  skill: SkillDefinition
  reason: string
}

export interface SkipRecord {
  name: string
  reason: "cooldown" | "max_activations" | "no_match" | "needs_consent" | "fingerprint_cooldown"
}

// ─── Matching ────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*")
  return new RegExp("^" + re + "$")
}

function matchAny(text: string, patterns: RegExp[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((re) => re.test(text))
}

function matchGlobs(files: string[], globs: string[] | undefined): string | undefined {
  if (!globs || globs.length === 0 || files.length === 0) return undefined
  for (const g of globs) {
    const re = globToRegex(g)
    const hit = files.find((f) => re.test(f))
    if (hit) return hit
  }
  return undefined
}

function matchSkill(
  skill: SkillDefinition,
  input: ActivationInput,
): { reason: string; bySignal: boolean } | undefined {
  const t = skill.triggers
  // Signal match has priority — system-driven hard evidence
  if (t.signals && t.signals.length > 0 && input.signals && input.signals.length > 0) {
    const hit = t.signals.find((s) => input.signals!.includes(s))
    if (hit) return { reason: `signal:${hit}`, bySignal: true }
  }
  if (matchAny(input.userText, t.keywords)) return { reason: "keyword match", bySignal: false }
  const fileHit = matchGlobs(input.files, t.fileGlobs)
  if (fileHit) return { reason: `file match: ${fileHit}`, bySignal: false }
  if (t.repoMarkers && t.repoMarkers.some((m) => input.repoMarkers.includes(m))) {
    if (skill.id === "repo-doctor" && !canUseRepoDoctorMarker(input)) return undefined
    return { reason: "repo marker match", bySignal: false }
  }
  if (t.intents && t.intents.some((i) => input.intents.includes(i)))
    return { reason: "explicit intent", bySignal: false }
  return undefined
}

function canUseRepoDoctorMarker(input: ActivationInput) {
  const classification = classifyTaskIntake({ userText: input.userText })
  if (!classification.repo_doctor_allowed && canSuppressRoutineReview(classification)) return false
  if (input.signals?.some((s) => s === "tool_failures_high" || s === "tool_failures_repeated" || s === "permission_denied" || s === "verification_failed")) return true
  if (input.intents.some((i) => i === "repo-doctor" || i === "diagnose")) return true
  if (/项目.*乱|repo.*health|健康检查|baseline.*broken|项目.*坏|diagnose|repo doctor|跑不起来|启动失败|依赖.*问题|test|typecheck|build|doctor|检查|诊断/i.test(input.userText)) return true
  return false
}

// ─── Fingerprint & Cooldown ──────────────────────────────────────────────

/**
 * 为 skill 匹配生成 fingerprint，用于防止相同错误/keyword 无限重复激活。
 * fingerprint 基于 skill id + 触发理由（前 80 字符）。
 */
function fingerprint(skillId: string, reason: string): string {
  const normalized = reason.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 80)
  return `${skillId}:${normalized}`
}

function inCooldown(skill: SkillDefinition, input: ActivationInput): SkipRecord | undefined {
  const h = input.history?.[skill.id]
  if (!h) return undefined
  if (h.count >= skill.activationPolicy.maxActivationsPerSession) {
    return { name: skill.name, reason: "max_activations" }
  }
  if (input.currentStep - h.lastStep < skill.activationPolicy.minStepInterval) {
    return { name: skill.name, reason: "cooldown" }
  }
  return undefined
}

function inFingerprintCooldown(
  skill: SkillDefinition,
  reason: string,
  input: ActivationInput,
): boolean {
  const h = input.history?.[skill.id]
  const maxRepeats = skill.deactivationPolicy.maxFingerprintRepeats
  if (!maxRepeats || !h) return false
  const fp = fingerprint(skill.id, reason)
  if (h.fingerprint === fp && h.count >= maxRepeats) return true
  return false
}

const RISK_ORDER: Record<SkillRisk, number> = { low: 0, medium: 1, high: 2 }

// ─── Activation ──────────────────────────────────────────────────────────

/**
 * 激活函数（纯函数：不修改外部状态、不写文件）。
 * 写 evidence 是受控副作用，仅在 sessionID 存在时执行。
 *
 * 每次最多自动激活 2 个技能（MAX_ACTIVE_PER_TURN 是 3 作为上限兜底）。
 * 高风险任务（risk level high 的 skill 被激活）最多 3 个。
 * cost-guard 激活时 OpenAI 相关技能必须经过 cost guard 检查。
 */
export function activate(input: ActivationInput): ActivationResult {
  const skipped: SkipRecord[] = []
  const candidates: ActiveSkill[] = []

  for (const skill of SKILL_REGISTRY) {
    const match = matchSkill(skill, input)
    if (!match) {
      skipped.push({ name: skill.name, reason: "no_match" })
      continue
    }
    const reason = match.reason
    // requiresExplicitConsent: 普通 keyword/file 匹配需要用户同意；
    // 但 supervisor signal 触发是系统硬证据，可绕过 consent。
    if (skill.activationPolicy.requiresExplicitConsent && !match.bySignal) {
      if (!input.consents?.includes(skill.name) && !input.consents?.includes(skill.id)) {
        skipped.push({ name: skill.name, reason: "needs_consent" })
        continue
      }
    }
    const cooldown = inCooldown(skill, input)
    if (cooldown) {
      skipped.push(cooldown)
      continue
    }
    if (inFingerprintCooldown(skill, reason, input)) {
      skipped.push({ name: skill.name, reason: "fingerprint_cooldown" })
      continue
    }
    candidates.push({ skill, reason })
  }

  const sorted = candidates.sort((a, b) => RISK_ORDER[a.skill.riskLevel] - RISK_ORDER[b.skill.riskLevel])

  // 计算 max: 是否有 high-risk skill 被激活
  const hasHighRisk = sorted.some((c) => c.skill.riskLevel === "high")
  const maxActive = hasHighRisk ? Math.min(MAX_ACTIVE_PER_TURN, 3) : Math.min(MAX_ACTIVE_PER_TURN, 2)

  const activated = sorted.slice(0, maxActive)
  const overflow = sorted.slice(maxActive)
  for (const o of overflow) skipped.push({ name: o.skill.name, reason: "max_activations" })

  // Evidence — 只写新的或变更的 activation；同一 skill+同一 fingerprint 不重复写入
  if (input.sessionID) {
    for (const a of activated) {
      const fp = fingerprint(a.skill.id, a.reason)
      // 如果 history 中已有相同 fingerprint 的激活记录，跳过重复写入
      if (input.history?.[a.skill.id]?.fingerprint === fp) continue
      writeEvidence(
        "skill.activated",
        {
          skill: a.skill.name,
          id: a.skill.id,
          reason: a.reason,
          risk: a.skill.riskLevel,
          fingerprint: fp,
        },
        input.sessionID,
      )
    }
    for (const s of skipped) {
      if (s.reason !== "no_match") {
        writeEvidence("skill.skipped", { skill: s.name, reason: s.reason }, input.sessionID)
      }
    }
  }

  // 生成结构化 Level 3 输出
  const outputs = fullOutputs(activated)

  return { activated, skipped, outputs }
}

// ─── Summary (delegated to skill-loader) ─────────────────────────────────

/**
 * 给 commander 的简短建议字符串（最多 200 字符），调用方可挂到下一轮
 * system prompt 末尾。不返回完整内容以避免 prompt 膨胀。
 */
export function summary(activated: ActiveSkill[]): string {
  return skillSummary(activated.map((a) => a.skill))
}

// ─── Deactivation ────────────────────────────────────────────────────────

/**
 * 应当停用的 skill 名（在 phase 切换或 verification 完成后）。
 * 调用方根据返回值更新 history。
 */
export function deactivationCandidates(
  activated: ActiveSkill[],
  opts: { phaseChanged?: boolean; verificationDone?: boolean },
): string[] {
  const names: string[] = []
  for (const a of activated) {
    if (opts.phaseChanged && a.skill.deactivationPolicy.onPhaseChange) names.push(a.skill.name)
    else if (opts.verificationDone && a.skill.deactivationPolicy.onVerificationDone) names.push(a.skill.name)
  }
  return names
}

// ─── Persistence + bash guard ────────────────────────────────────────────

function activeFile(sessionID: string) {
  return path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "active-skills.json")
}

/**
 * 将当前激活的技能名持久化到 ~/.dll-agent/sessions/<id>/active-skills.json。
 * shell.ts 等 tool 通过 loadActive 读取以拦截 forbiddenCommands。
 */
export function persist(activated: ActiveSkill[], sessionID: string) {
  const file = activeFile(sessionID)
  const names = activated.map((a) => a.skill.name)
  const policy = policyUnion(activated)
  const raw = {
    version: 2,
    names,
    ids: activated.map((a) => a.skill.id),
    requiredTools: policy.requiredTools,
    allowedCommands: policy.allowedCommands,
    forbiddenCommands: policy.forbiddenCommands,
    ts: new Date().toISOString(),
  }
  const payload = JSON.stringify(redact(raw))
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, payload, "utf8")
    fs.renameSync(tmp, file)
  } catch {
    // best-effort
  }
}

export function loadActive(sessionID: string): SkillDefinition[] {
  try {
    const file = activeFile(sessionID)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { names?: string[] }
    const names = raw.names ?? []
    return SKILL_REGISTRY.filter((s) => names.includes(s.name))
  } catch {
    return []
  }
}

/**
 * Phase 4: 聚合所有当前激活技能要求/允许/禁止的工具与命令。
 * 仅用于诊断/可见性 — bash 层硬拦截走 checkForbiddenCommand。
 */
export function policyUnion(activated: ActiveSkill[]): {
  requiredTools: string[]
  allowedCommands: string[]
  forbiddenCommands: string[]
} {
  const required = new Set<string>()
  const allowed = new Set<string>()
  const forbidden = new Set<string>()
  for (const a of activated) {
    for (const t of a.skill.requiredTools ?? []) required.add(t)
    for (const c of a.skill.allowedCommands ?? []) allowed.add(c)
    for (const c of a.skill.forbiddenCommands ?? []) forbidden.add(c)
  }
  return {
    requiredTools: [...required],
    allowedCommands: [...allowed],
    forbiddenCommands: [...forbidden],
  }
}

/**
 * 给定一段 bash 命令字符串，返回第一个匹配的 forbiddenCommand 命中。
 * 命中即应当被工具层硬阻断。
 */
export function checkForbiddenCommand(
  command: string,
  activeSkills?: SkillDefinition[],
): { skill: string; pattern: string } | null {
  if (!activeSkills || activeSkills.length === 0) return null
  for (const skill of activeSkills) {
    for (const forbidden of skill.forbiddenCommands ?? []) {
      if (command.includes(forbidden)) return { skill: skill.name, pattern: forbidden }
    }
  }
  return null
}

/**
 * 查找注册表中 skill。
 * 优先按 id 查找，fallback 到 name。
 */
export function find(idOrName: string): SkillDefinition | undefined {
  return SKILL_REGISTRY.find((s) => s.id === idOrName || s.name === idOrName)
}
