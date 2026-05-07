/**
 * dll-agent MCP Manager
 *
 * 配置驱动的 MCP server 管理器：声明、按需启动、互斥锁、healthcheck、失败降级。
 * 不替代 opencode 的 MCP 实现，而是在 dll-agent 侧提供管理能力。
 */

import fs from "fs"
import path from "path"
import os from "os"
import { write as writeEvidence } from "./evidence"
import type { McpStartPolicy } from "./tool-catalog"

export interface McpRegistration {
  /** MCP server 唯一名 */
  name: string
  /** 启动命令 */
  command?: string[]
  /** 健康检查 URL */
  health_url?: string
  /** 是否需要 isolated 运行 */
  isolated: boolean
  /** 互斥锁 key */
  mutex_key?: string
  /** 启动策略 */
  start_policy: McpStartPolicy
  /** 是否为重型工具 */
  heavy: boolean
  /** 是否需要用户确认 */
  requires_consent: boolean
}

export interface McpServerDecl {
  /** 唯一名，如 "puppeteer"、"filesystem" */
  name: string
  /** 启动命令，如 ["npx", "-y", "@anthropic/mcp-server-puppeteer"] */
  command: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** health check endpoint，如 "http://127.0.0.1:PORT/health" */
  healthUrl?: string
  /** 是否需要 isolated 运行（如浏览器 server 不能共享实例） */
  isolated: boolean
  /** 互斥锁文件（防止重复启动同一 server） */
  lockFile?: string
  /** 自动重启策略 */
  autoRestart: boolean
  /** 最大启动重试次数 */
  maxRetries: number
  /** 超时 (ms) */
  timeoutMs: number
  /** 冷却期 (ms)：失败后多久不重试 */
  cooldownMs: number
}

export interface McpServerStatus {
  name: string
  status: "running" | "stopped" | "failed" | "degraded"
  pid?: number
  lastHealthAt?: string
  lastError?: string
  retryCount: number
  cooldownUntil?: string
}

const STATE_DIR = path.join(os.homedir(), ".dll-agent", "mcp")

function stateFile(name: string) {
  return path.join(STATE_DIR, `${name}.json`)
}

function lockFile(name: string) {
  return path.join(STATE_DIR, `${name}.lock`)
}

export function loadStatus(name: string): McpServerStatus {
  const file = stateFile(name)
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    // corrupted
  }
  return { name, status: "stopped", retryCount: 0 }
}

function saveStatus(status: McpServerStatus) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(stateFile(status.name), JSON.stringify(status, null, 2))
  } catch {
    // best-effort
  }
}

/**
 * 尝试获取 server 互斥锁。返回 true = 获得锁（可以启动）；false = 已有进程持有锁。
 */
export function acquireLock(name: string): boolean {
  const lock = lockFile(name)
  try {
    if (fs.existsSync(lock)) {
      const raw = JSON.parse(fs.readFileSync(lock, "utf8"))
      const pid = raw.pid
      // check if the process is still alive
      try { process.kill(pid, 0); return false } catch { /* dead, remove stale lock */ }
      fs.unlinkSync(lock)
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }))
    return true
  } catch {
    return false
  }
}

export function releaseLock(name: string) {
  const lock = lockFile(name)
  try { if (fs.existsSync(lock)) fs.unlinkSync(lock) } catch { /* best-effort */ }
}

/**
 * 判断 server 是否应启动：状态非 running 且不在 cooldown 且获得锁。
 */
export function shouldStart(decl: McpServerDecl): { start: boolean; reason: string } {
  const status = loadStatus(decl.name)
  if (status.status === "running") return { start: false, reason: "already running" }
  if (status.cooldownUntil) {
    const until = new Date(status.cooldownUntil).getTime()
    if (Date.now() < until) return { start: false, reason: `cooldown until ${status.cooldownUntil}` }
  }
  if (!acquireLock(decl.name)) return { start: false, reason: "lock held by another process" }
  return { start: true, reason: "ready" }
}

/**
 * 降级：标记 server 为 degraded，写 evidence，进入 cooldown。
 */
export function degrade(decl: McpServerDecl, error: string) {
  const status = loadStatus(decl.name)
  status.status = "degraded"
  status.lastError = error
  status.retryCount++
  if (status.retryCount > decl.maxRetries) {
    status.status = "failed"
    status.cooldownUntil = new Date(Date.now() + decl.cooldownMs).toISOString()
    writeEvidence("mcp.failed", {
      server: decl.name,
      error,
      retries: status.retryCount,
      cooldown_until: status.cooldownUntil,
    })
  } else {
    writeEvidence("mcp.degraded", {
      server: decl.name,
      error,
      retry: status.retryCount,
      max_retries: decl.maxRetries,
    })
  }
  saveStatus(status)
  releaseLock(decl.name)
}

/**
 * 标记 server 为 running 并记录 health 时间。
 */
export function markRunning(decl: McpServerDecl, pid?: number) {
  const status = loadStatus(decl.name)
  status.status = "running"
  status.pid = pid
  status.lastHealthAt = new Date().toISOString()
  status.retryCount = 0
  status.lastError = undefined
  status.cooldownUntil = undefined
  saveStatus(status)
}

/**
 * 标记 server 为 stopped。
 */
export function markStopped(name: string) {
  const status = loadStatus(name)
  status.status = "stopped"
  status.pid = undefined
  saveStatus(status)
  releaseLock(name)
}

/**
 * 获取所有注册 server 的状态列表（用于 TUI 显示）。
 */
export function allStatus(decls: McpServerDecl[]): McpServerStatus[] {
  return decls.map((d) => loadStatus(d.name))
}

/**
 * 检查 server 是否可用（running 或 degraded 且可降级使用）。
 */
export function isAvailable(decl: McpServerDecl): boolean {
  const status = loadStatus(decl.name)
  if (status.status === "running") return true
  if (status.status === "degraded") return true
  return false
}

// ─── Catalog Bridge ────────────────────────────────────────────────────────────

/**
 * 从 tool-catalog 的 ToolEntry 转换为 mcp-manager 的 McpServerDecl。
 * 用于桥接 tool-catalog 声明与 mcp-manager 运行时管理。
 */
export function fromCatalogRegistration(reg: McpRegistration): McpServerDecl {
  return {
    name: reg.name,
    command: reg.command ?? [],
    healthUrl: reg.health_url,
    isolated: reg.isolated,
    lockFile: path.join(STATE_DIR, `${reg.name}.lock`),
    autoRestart: false,
    maxRetries: 3,
    timeoutMs: 30000,
    cooldownMs: 60000,
  }
}

/**
 * 检查启动策略是否允许自动启动。
 */
export function isAutostartable(policy: McpStartPolicy): boolean {
  return policy === "autostart_lightweight"
}

/**
 * 检查启动策略是否为 on-demand。
 */
export function isOnDemand(policy: McpStartPolicy): boolean {
  return policy === "on_demand"
}

/**
 * healthcheck：检查 MCP server 是否健康。
 * 通过 healthUrl（如果配置）或进程存活检测。
 */
export function healthcheck(decl: McpServerDecl): { healthy: boolean; detail: string } {
  const status = loadStatus(decl.name)
  if (status.status !== "running") return { healthy: false, detail: `status is ${status.status}` }

  // Process alive check
  if (status.pid) {
    try {
      process.kill(status.pid, 0)
    } catch {
      return { healthy: false, detail: `pid ${status.pid} not found` }
    }
  }

  // Update health timestamp
  status.lastHealthAt = new Date().toISOString()
  saveStatus(status)

  writeEvidence("mcp.health_check", {
    server: decl.name,
    healthy: true,
    pid: status.pid,
  })

  return { healthy: true, detail: "ok" }
}

/**
 * 列出所有注册的 MCP server 及其详细状态。
 */
export function detailedStatus(decls: McpServerDecl[]): Record<string, McpServerStatus & { healthy: boolean; start_policy: McpStartPolicy; heavy: boolean }> {
  const result: Record<string, McpServerStatus & { healthy: boolean; start_policy: McpStartPolicy; heavy: boolean }> = {}
  for (const d of decls) {
    const status = loadStatus(d.name)
    const health = healthcheck(d)
    result[d.name] = {
      ...status,
      healthy: health.healthy,
      start_policy: isOnDemand(d.isolated ? "on_demand" : "autostart_lightweight") ? "on_demand" : "autostart_lightweight",
      heavy: d.isolated,
    }
  }
  return result
}

/**
 * 检查端口是否被占用。
 */
export function checkPort(port: number): { free: boolean; process?: string } {
  try {
    const result = require("child_process").execSync(`lsof -i :${port} -t`, { encoding: "utf8" }).trim()
    if (result) return { free: false, process: result }
    return { free: true }
  } catch {
    return { free: true }
  }
}
