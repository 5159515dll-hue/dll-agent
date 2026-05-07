/**
 * dll-agent cost-cap.ts
 *
 * 成本上限（cost cap）：按 session 累计模型调用费用，达到上限时发出警告或阻断。
 * 同时也跟踪各 provider 的成本，防止单一 provider 过度消耗。
 */

import fs from "fs"
import path from "path"
import os from "os"
import { write as writeEvidence, redact } from "./evidence"
import { SKILL_REGISTRY } from "./skill-registry"
import {
  type CostCapConfig,
  type CostStatus,
  DEFAULT_COST_CAP,
} from "./interfaces"
import type { MessageV2 } from "@/session/message-v2"

// ─── 配置 ──────────────────────────────────────────────────────────────────

export function config(): CostCapConfig {
  const envCap = process.env.DLL_AGENT_COST_CAP_USD
  const envSingleCap = process.env.DLL_AGENT_COST_SINGLE_CALL_CAP_USD
  const envDisabled = process.env.DLL_AGENT_COST_CAP_DISABLED

  return {
    ...DEFAULT_COST_CAP,
    enabled: envDisabled !== "1",
    session_cap_usd: envCap ? parseFloat(envCap) : DEFAULT_COST_CAP.session_cap_usd,
    single_call_cap_usd: envSingleCap ? parseFloat(envSingleCap) : DEFAULT_COST_CAP.single_call_cap_usd,
  }
}

// ─── 状态文件 ─────────────────────────────────────────────────────────────

export function costFile(sessionID: string) {
  return path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "cost.json")
}

export function loadCostStatus(sessionID: string): CostStatus {
  const file = costFile(sessionID)
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    // Corrupted — start fresh
  }
  return {
    session_total_usd: 0,
    by_provider: {},
    session_cap_exceeded: false,
    provider_cap_exceeded: {},
    last_warning: null,
  }
}

export function saveCostStatus(sessionID: string, status: CostStatus) {
  const file = costFile(sessionID)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(redact(status), null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // Best-effort
  }
}

// ─── 成本追踪 ─────────────────────────────────────────────────────────────

/**
 * 从 session 的所有消息中计算累计成本。
 * 扫描所有 assistant 消息的 cost 字段并求和。
 */
export function computeSessionCost(
  messages: MessageV2.WithParts[],
  extraGroups?: MessageV2.WithParts[][],
): {
  total_usd: number
  by_provider: Record<string, number>
} {
  let total = 0
  const byProvider: Record<string, number> = {}

  const accumulate = (msgs: MessageV2.WithParts[]) => {
    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      const info = msg.info as MessageV2.Assistant
      const cost = info.cost ?? 0
      const provider = info.providerID ?? "unknown"

      total += cost
      byProvider[provider] = (byProvider[provider] ?? 0) + cost
    }
  }

  accumulate(messages)
  if (extraGroups) for (const g of extraGroups) accumulate(g)

  return { total_usd: total, by_provider: byProvider }
}

/**
 * 检查当前 session 成本是否超出上限。
 * 返回：
 * - exceeded: 是否超出 session 上限或任何 provider 上限
 * - warning: 百分比警告级别（80%+ 时）
 */
export function checkCap(
  sessionID: string,
  messages: MessageV2.WithParts[],
  extraGroups?: MessageV2.WithParts[][],
): {
  exceeded: boolean
  session_cap_exceeded: boolean
  provider_cap_exceeded: Record<string, boolean>
  percent_used: number
  warning: string | null
} {
  const cfg = config()
  if (!cfg.enabled) {
    return {
      exceeded: false,
      session_cap_exceeded: false,
      provider_cap_exceeded: {},
      percent_used: 0,
      warning: null,
    }
  }

  const { total_usd, by_provider } = computeSessionCost(messages, extraGroups)
  const sessionCap = cfg.session_cap_usd
  const percentUsed = Math.round((total_usd / sessionCap) * 100)

  let exceeded = false
  const providerCapExceeded: Record<string, boolean> = {}
  const warnings: string[] = []

  // Session cap check
  if (total_usd >= sessionCap) {
    exceeded = true
    warnings.push(`session cost $${total_usd.toFixed(4)} exceeds cap $${sessionCap.toFixed(2)}`)
    writeEvidence("cost.cap_exceeded", {
      total_usd,
      session_cap: sessionCap,
      percent: percentUsed,
    }, sessionID)
  } else if (percentUsed >= 80) {
    warnings.push(`session cost at ${percentUsed}% of cap ($${total_usd.toFixed(4)} / $${sessionCap.toFixed(2)})`)
    writeEvidence("cost.cap_warning", {
      total_usd,
      session_cap: sessionCap,
      percent: percentUsed,
    }, sessionID)
  }

  // Provider cap check
  for (const [provider, cost] of Object.entries(by_provider)) {
    const providerCap = cfg.provider_caps[provider]
    if (providerCap !== undefined && cost >= providerCap) {
      providerCapExceeded[provider] = true
      exceeded = true
      warnings.push(`${provider} cost $${cost.toFixed(4)} exceeds provider cap $${providerCap.toFixed(2)}`)
    }
  }

  // Update state
  const status = loadCostStatus(sessionID)
  status.session_total_usd = total_usd
  status.by_provider = by_provider
  status.session_cap_exceeded = exceeded
  status.provider_cap_exceeded = providerCapExceeded
  status.last_warning = warnings.join("; ") || null
  saveCostStatus(sessionID, status)

  return {
    exceeded,
    session_cap_exceeded: total_usd >= sessionCap,
    provider_cap_exceeded: providerCapExceeded,
    percent_used: percentUsed,
    warning: warnings.join("; ") || null,
  }
}

/**
 * 单次调用前检查：预估成本是否超过 single_call_cap。
 * 使用 token 数估算成本。
 *
 * 当 sessionID 提供时，会读取 active skills 的 costPolicy.singleCallCapMultiplier，
 * 以最严格（最小）系数压缩 cap，让 cost-guard 等技能真正生效。
 */
export function checkSingleCallCap(
  providerID: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  sessionID?: string,
): { allowed: boolean; estimated_cost: number; effective_cap: number; reason?: string } {
  const cfg = config()
  if (!cfg.enabled) return { allowed: true, estimated_cost: 0, effective_cap: cfg.single_call_cap_usd }

  const prices = estimateTokenPrices(providerID)
  const estimatedCost = (estimatedInputTokens / 1_000_000) * prices.input +
    (estimatedOutputTokens / 1_000_000) * prices.output

  // 基于 active skills 的 costPolicy 收紧 cap（取最严格的 multiplier）。
  // 直接读取 active-skills.json 避免循环依赖（skills → cost-cap）。
  let multiplier = 1.0
  let imposedBy: string | null = null
  if (sessionID) {
    try {
      const skillsFile = path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "active-skills.json")
      if (fs.existsSync(skillsFile)) {
        const raw = JSON.parse(fs.readFileSync(skillsFile, "utf8")) as { ids?: string[] }
        const activeIds = raw.ids ?? []
        for (const skill of SKILL_REGISTRY) {
          if (!activeIds.includes(skill.id)) continue
          const m = skill.costPolicy?.singleCallCapMultiplier
          if (typeof m === "number" && m > 0 && m < multiplier) {
            multiplier = m
            imposedBy = skill.id ?? skill.name
          }
        }
      }
    } catch {
      // 忽略：cost-cap 必须永不阻塞主流程
    }
  }

  const effectiveCap = cfg.single_call_cap_usd * multiplier

  if (estimatedCost > effectiveCap) {
    if (sessionID) {
      writeEvidence("cost.single_call_blocked", {
        provider: providerID,
        estimated_cost: estimatedCost,
        single_call_cap: cfg.single_call_cap_usd,
        effective_cap: effectiveCap,
        multiplier,
        imposed_by_skill: imposedBy,
      }, sessionID)
    }
    return {
      allowed: false,
      estimated_cost: estimatedCost,
      effective_cap: effectiveCap,
      reason: imposedBy
        ? `estimated cost $${estimatedCost.toFixed(4)} exceeds single call cap $${effectiveCap.toFixed(2)} (skill ${imposedBy} multiplier ${multiplier})`
        : `estimated cost $${estimatedCost.toFixed(4)} exceeds single call cap $${effectiveCap.toFixed(2)}`,
    }
  }

  return { allowed: true, estimated_cost: estimatedCost, effective_cap: effectiveCap }
}

/**
 * Phase 5 fix: 重新计算（authoritative）而非增量累加。
 *
 * 原实现每次 supervisor step 都把"最后一条 assistant 消息"的 cost 加到累计值，
 * 但同一条 assistant 消息会跨多个 step 存在 ⇒ 重复计费 / cost.json 膨胀 /
 * `cost.session_total` evidence 事件被噪声充斥。
 *
 * 改为始终基于全部消息重算（与 checkCap 同源），仅在 delta != 0 时写 evidence，
 * 避免相同消息重复触发事件。
 */
export function trackLastCall(
  sessionID: string,
  messages: MessageV2.WithParts[],
  extraGroups?: MessageV2.WithParts[][],
) {
  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
  if (!lastAssistant) return

  const info = lastAssistant.info as MessageV2.Assistant
  const provider = info.providerID ?? "unknown"

  const { total_usd, by_provider } = computeSessionCost(messages, extraGroups)
  const status = loadCostStatus(sessionID)
  const delta = total_usd - status.session_total_usd
  status.session_total_usd = total_usd
  status.by_provider = by_provider
  saveCostStatus(sessionID, status)

  if (delta > 0) {
    writeEvidence("cost.session_total", {
      delta,
      total: total_usd,
      provider,
    }, sessionID)
  }
}

// ─── 成本估算（保守估计，用于单次调用 cap）─────────────────────────────────

/**
 * 估算 token 价格（美元/百万 tokens）。
 * 这些是保守的公开标价，用于成本上限计算。
 * 实际成本由 provider 返回的 cost 字段精确计算。
 */
function estimateTokenPrices(provider: string): { input: number; output: number } {
  switch (provider) {
    case "deepseek":
      return { input: 0.55, output: 2.19 }
    case "openai":
      return { input: 3.00, output: 12.00 }
    case "kimi":
      return { input: 0.28, output: 1.40 }
    case "zai":
      return { input: 0.50, output: 2.00 }
    default:
      return { input: 1.00, output: 4.00 }
  }
}


