/**
 * dll-agent Capability Dependency Resolver
 *
 * 当能力需要的软件/MCP/skill 缺失时，自动决定如何处理。
 * 基于风险分级的 auto-approval 策略——不是无边界自动安装。
 *
 * 动作类型：
 *   use_now        — 立即使用
 *   lazy_start     — 延迟启动
 *   auto_install   — 项目/用户目录内自动安装
 *   ask_permission — 需要用户确认（高风险）
 *   degrade        — 降级使用替代方案
 *   skip           — 不可用且无法修复
 *
 * 风险分级：
 *   低风险 → auto_install / lazy_start
 *   中风险 → ask_permission 或确认后 auto_install
 *   高风险 → 阻断，必须手动授权
 */

import type { CapabilityEntry, CapabilityRiskLevel } from "./capability-schema"
import type { InstallStrategy } from "./capability-schema"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

// ─── Resolver Types ─────────────────────────────────────────────────────────────

export type ResolverAction =
  | "use_now"
  | "lazy_start"
  | "auto_install"
  | "ask_permission"
  | "degrade"
  | "skip"

export interface ResolverDecision {
  entry_id: string
  action: ResolverAction
  reason: string
  risk_level: CapabilityRiskLevel
  install_command?: string[]
  verify_command?: string[]
  rollback_command?: string[]
  degraded_alternative?: string
  requires_user_consent: boolean
}

export interface ResolverResult {
  /** All decisions */
  decisions: ResolverDecision[]
  /** Entries that can be used immediately */
  ready: ResolverDecision[]
  /** Entries that need installation/startup */
  pending: ResolverDecision[]
  /** Entries that are unfixable */
  blocked: ResolverDecision[]
}

// ─── Risk-Based Auto-Approval ───────────────────────────────────────────────────

/**
 * Low-risk: project-local install, user-cache download, non-destructive CLI start.
 * Auto-approved without asking.
 */
const LOW_RISK_INSTALL_STRATEGIES: InstallStrategy[] = [
  "none",
  "npx_runtime",
  "project_local_npm",
  "project_local_pip",
]

/**
 * Medium-risk: first network download, user-local binary.
 * Can auto-approve if confidence is high (>= 0.8).
 */
const MEDIUM_RISK_INSTALL_STRATEGIES: InstallStrategy[] = [
  "user_local_binary",
]

/**
 * High-risk: global install, system modification, token access.
 * Always requires user consent.
 */
const HIGH_RISK_INSTALL_STRATEGIES: InstallStrategy[] = [
  "system_package_manager",
]

// ─── Dependency Checking ────────────────────────────────────────────────────────

function checkBinary(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function checkToken(envKey: string): boolean {
  return !!process.env[envKey]
}

function checkPort(port: number): boolean {
  try {
    execSync(`lsof -i :${port} -t`, { stdio: "ignore" })
    return false // Port is in use
  } catch {
    return true // Port is free
  }
}

// ─── Install Command Generation ─────────────────────────────────────────────────

function generateInstallCommand(entry: CapabilityEntry): string[] | undefined {
  switch (entry.install_strategy) {
    case "npx_runtime":
      return entry.runtime?.start_command ?? ["npx", "-y", entry.id]
    case "project_local_npm":
      return ["bun", "add", "-d", entry.id]
    case "project_local_pip": {
      const pkgs = entry.dependencies?.packages ?? []
      if (pkgs.length === 0) return undefined
      return ["python3", "-m", "pip", "install", "--target", ".dll-agent/tools/python", ...pkgs]
    }
    case "user_local_binary":
      return undefined // Needs custom download logic, ask permission
    case "system_package_manager":
      return ["brew", "install", entry.id]
    default:
      return undefined
  }
}

function generateVerifyCommand(entry: CapabilityEntry): string[] | undefined {
  if (entry.verify_commands?.length) return entry.verify_commands
  if (entry.dependencies?.binaries?.length) {
    return [`which ${entry.dependencies.binaries[0]}`]
  }
  return undefined
}

function generateRollbackCommand(entry: CapabilityEntry): string[] | undefined {
  switch (entry.install_strategy) {
    case "project_local_npm":
      return ["bun", "remove", entry.id]
    case "project_local_pip":
      return ["pip", "uninstall", "-y", ...(entry.dependencies?.packages ?? [entry.id])]
    case "system_package_manager":
      return ["brew", "uninstall", entry.id]
    default:
      return undefined
  }
}

// ─── Main Resolution Logic ──────────────────────────────────────────────────────

/**
 * Resolve a single capability's dependency status.
 */
export function resolveCapability(entry: CapabilityEntry): ResolverDecision {
  const now = new Date().toISOString()

  // Already available → use now
  if (entry.status === "available" || entry.status === "running") {
    return {
      entry_id: entry.id,
      action: "use_now",
      reason: `Capability ${entry.id} is ${entry.status}`,
      risk_level: entry.risk_level,
      requires_user_consent: false,
    }
  }

  // No install needed but not available → check what's missing
  if (entry.install_strategy === "none" && !entry.requires_install) {
    // Check token availability
    if (entry.requires_token && entry.dependencies?.tokens?.length) {
      const missingTokens = entry.dependencies.tokens.filter((t) => !checkToken(t))
      if (missingTokens.length > 0) {
        return {
          entry_id: entry.id,
          action: "skip",
          reason: `Missing tokens: ${missingTokens.join(", ")}`,
          risk_level: entry.risk_level,
          requires_user_consent: true,
        }
      }
    }
    // Check binary availability
    if (entry.dependencies?.binaries?.length) {
      const missing = entry.dependencies.binaries.filter((b) => !checkBinary(b))
      if (missing.length > 0) {
        return {
          entry_id: entry.id,
          action: "ask_permission",
          reason: `Missing binaries: ${missing.join(", ")}. No install strategy defined.`,
          risk_level: entry.risk_level,
          requires_user_consent: true,
        }
      }
    }
    // Everything is fine, mark available
    return {
      entry_id: entry.id,
      action: "lazy_start",
      reason: "All dependencies satisfied, can lazy-start",
      risk_level: entry.risk_level,
      requires_user_consent: false,
    }
  }

  // Needs installation → risk-based decision
  const strategy = entry.install_strategy

  // Low-risk install strategies are only auto-approved for low/medium risk
  // capabilities. A high-risk capability can use npx/project-local mechanics
  // but still needs policy review before it is started or installed.
  if (LOW_RISK_INSTALL_STRATEGIES.includes(strategy) && entry.risk_level !== "high") {
    return {
      entry_id: entry.id,
      action: "auto_install",
      reason: `Low-risk install via ${strategy}`,
      risk_level: entry.risk_level,
      install_command: generateInstallCommand(entry),
      verify_command: generateVerifyCommand(entry),
      rollback_command: generateRollbackCommand(entry),
      requires_user_consent: false,
    }
  }

  if (LOW_RISK_INSTALL_STRATEGIES.includes(strategy) && entry.risk_level === "high") {
    return {
      entry_id: entry.id,
      action: "ask_permission",
      reason: `High-risk capability via ${strategy} — requires policy review`,
      risk_level: "high",
      install_command: generateInstallCommand(entry),
      verify_command: generateVerifyCommand(entry),
      rollback_command: generateRollbackCommand(entry),
      requires_user_consent: true,
    }
  }

  // Medium-risk: auto-install if high confidence
  if (MEDIUM_RISK_INSTALL_STRATEGIES.includes(strategy)) {
    if (entry.confidence >= 0.8) {
      return {
        entry_id: entry.id,
        action: "auto_install",
        reason: `Medium-risk install via ${strategy} with confidence ${entry.confidence}`,
        risk_level: "medium",
        install_command: generateInstallCommand(entry),
        verify_command: generateVerifyCommand(entry),
        rollback_command: generateRollbackCommand(entry),
        requires_user_consent: false,
      }
    }
    return {
      entry_id: entry.id,
      action: "ask_permission",
      reason: `Medium-risk install via ${strategy} with low confidence ${entry.confidence}`,
      risk_level: "medium",
      install_command: generateInstallCommand(entry),
      verify_command: generateVerifyCommand(entry),
      rollback_command: generateRollbackCommand(entry),
      requires_user_consent: true,
    }
  }

  // High-risk: always ask
  if (HIGH_RISK_INSTALL_STRATEGIES.includes(strategy)) {
    return {
      entry_id: entry.id,
      action: "ask_permission",
      reason: `High-risk install via ${strategy} — requires manual authorization`,
      risk_level: "high",
      install_command: generateInstallCommand(entry),
      verify_command: generateVerifyCommand(entry),
      rollback_command: generateRollbackCommand(entry),
      requires_user_consent: true,
    }
  }

  // Unknown strategy → ask
  return {
    entry_id: entry.id,
    action: "ask_permission",
    reason: `Unknown install strategy: ${strategy}`,
    risk_level: entry.risk_level,
    install_command: generateInstallCommand(entry),
    requires_user_consent: true,
  }
}

/**
 * Resolve a batch of capabilities and categorize them.
 */
export function resolveAll(entries: CapabilityEntry[]): ResolverResult {
  const decisions = entries.map(resolveCapability)
  return {
    decisions,
    ready: decisions.filter((d) => d.action === "use_now" || d.action === "lazy_start"),
    pending: decisions.filter((d) => d.action === "auto_install" || d.action === "ask_permission"),
    blocked: decisions.filter((d) => d.action === "skip" || d.action === "degrade"),
  }
}

/**
 * Check if a resolution decision allows automatic execution.
 * Only "use_now", "lazy_start", and "auto_install" are auto-approved.
 */
export function isAutoApproved(decision: ResolverDecision): boolean {
  return decision.action === "use_now"
    || decision.action === "lazy_start"
    || (decision.action === "auto_install" && !decision.requires_user_consent)
}

/**
 * Format a resolution decision for user display.
 */
export function formatDecision(decision: ResolverDecision): string {
  const icon =
    decision.action === "use_now" ? "✅" :
    decision.action === "lazy_start" ? "⏳" :
    decision.action === "auto_install" ? "🔧" :
    decision.action === "ask_permission" ? "🔐" :
    decision.action === "degrade" ? "⬇️" : "❌"

  return `${icon} ${decision.entry_id}: ${decision.action} — ${decision.reason}`
}
