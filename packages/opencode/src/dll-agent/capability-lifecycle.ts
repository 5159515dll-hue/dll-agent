/**
 * dll-agent Capability Runtime Lifecycle Manager
 *
 * 统一管理所有能力（MCP / service / heavy tool）的运行时生命周期：
 * plan → start → healthcheck → use → retry/degrade → stop/reap → cleanup
 *
 * 管理对象：
 *   - MCP 进程
 *   - 后台 quota 刷新
 *   - heavy tool service
 *   - 临时 discovery worker
 */

import type { CapabilityEntry, CapabilityStatus } from "./capability-schema"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

// ─── Runtime State ──────────────────────────────────────────────────────────────

export interface RuntimeState {
  entry_id: string
  status: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
  pid?: number
  started_at?: string
  last_health_at?: string
  retry_count: number
  max_retries: number
  last_error?: string
}

const RUNTIME_DIR = path.join(os.homedir(), ".dll-agent", "runtime")

function runtimeStateFile(entryId: string): string {
  return path.join(RUNTIME_DIR, `${entryId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
}

export function loadRuntimeState(entryId: string): RuntimeState {
  try {
    const fp = runtimeStateFile(entryId)
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"))
  } catch {
    // Corrupted
  }
  return {
    entry_id: entryId,
    status: "idle",
    retry_count: 0,
    max_retries: 3,
  }
}

function saveRuntimeState(state: RuntimeState) {
  try {
    ensureRuntimeDir()
    fs.writeFileSync(runtimeStateFile(state.entry_id), JSON.stringify(state, null, 2))
  } catch {
    // Best-effort
  }
}

// ─── Process Management ─────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findChildProcesses(pid: number): number[] {
  try {
    const output = execSync(`pgrep -P ${pid} 2>/dev/null`, {
      encoding: "utf8",
      timeout: 2000,
    }).trim()
    return output ? output.split("\n").map(Number) : []
  } catch {
    return []
  }
}

// ─── Lifecycle Operations ───────────────────────────────────────────────────────

/**
 * Plan: determine if a capability should be started based on its entry and current state.
 */
export function planStart(entry: CapabilityEntry): { should_start: boolean; reason: string } {
  const state = loadRuntimeState(entry.id)

  if (state.status === "running") {
    // Verify the process is still alive
    if (state.pid && !isPidAlive(state.pid)) {
      state.status = "failed"
      state.last_error = `PID ${state.pid} no longer alive`
      saveRuntimeState(state)
      return { should_start: true, reason: "previous process died" }
    }
    return { should_start: false, reason: "already running" }
  }

  if (state.status === "failed" && state.retry_count >= state.max_retries) {
    return { should_start: false, reason: `exhausted retries (${state.retry_count}/${state.max_retries})` }
  }

  if (entry.start_policy === "disabled") {
    return { should_start: false, reason: "start_policy is disabled" }
  }

  if (entry.start_policy === "on_demand" || entry.start_policy === "autostart_lightweight") {
    return { should_start: true, reason: `start policy: ${entry.start_policy}` }
  }

  if (entry.start_policy === "always") {
    return { should_start: true, reason: "always start" }
  }

  return { should_start: false, reason: "unknown start policy" }
}

/**
 * Healthcheck: verify a running capability is healthy.
 */
export function healthcheck(entry: CapabilityEntry): { healthy: boolean; detail: string } {
  const state = loadRuntimeState(entry.id)

  if (state.status !== "running") {
    return { healthy: false, detail: `not running (status: ${state.status})` }
  }

  // PID check
  if (state.pid) {
    if (!isPidAlive(state.pid)) {
      state.status = "failed"
      state.last_error = `PID ${state.pid} not found`
      saveRuntimeState(state)
      return { healthy: false, detail: `pid ${state.pid} not found` }
    }
  }

  // Runtime healthcheck configuration
  if (entry.runtime?.healthcheck) {
    const hc = entry.runtime.healthcheck
    if (hc.type === "port" && hc.port) {
      try {
        execSync(`lsof -i :${hc.port} -t`, { stdio: "ignore", timeout: 3000 })
      } catch {
        return { healthy: false, detail: `port ${hc.port} not listening` }
      }
    }
    // URL healthcheck would be done here in a real implementation
  }

  // Update health timestamp
  state.last_health_at = new Date().toISOString()
  saveRuntimeState(state)

  return { healthy: true, detail: "ok" }
}

/**
 * Retry/degrade: handle a failed capability.
 */
export function retryOrDegrade(entry: CapabilityEntry, error: string): RuntimeState {
  const state = loadRuntimeState(entry.id)
  state.retry_count++
  state.last_error = error

  if (state.retry_count < state.max_retries) {
    state.status = "idle" // Ready for retry
  } else {
    state.status = "failed"
  }

  saveRuntimeState(state)
  return state
}

/**
 * Stop: terminate a running capability's process.
 */
export function stopCapability(entryId: string): { stopped: boolean; reason: string } {
  const state = loadRuntimeState(entryId)

  if (!state.pid) {
    state.status = "stopped"
    saveRuntimeState(state)
    return { stopped: false, reason: "no PID to stop" }
  }

  if (state.pid === process.pid) {
    return { stopped: false, reason: "refusing to stop self" }
  }

  try {
    // Kill child processes first
    const children = findChildProcesses(state.pid)
    for (const childPid of children) {
      try { process.kill(childPid, "SIGTERM") } catch { /* already dead */ }
    }

    // Kill main process
    process.kill(state.pid, "SIGTERM")

    state.status = "stopped"
    state.pid = undefined
    saveRuntimeState(state)

    return { stopped: true, reason: "stopped" }
  } catch (error) {
    state.status = "failed"
    state.last_error = String(error)
    saveRuntimeState(state)
    return { stopped: false, reason: String(error) }
  }
}

/**
 * Cleanup: remove stale state and lock files.
 */
export interface CleanupResult {
  stale_entries: string[]
  stopped_entries: string[]
  errors: string[]
}

export function cleanupStale(entries: CapabilityEntry[], maxIdleMs = 30 * 60 * 1000): CleanupResult {
  const result: CleanupResult = { stale_entries: [], stopped_entries: [], errors: [] }
  const now = Date.now()

  for (const entry of entries) {
    try {
      const state = loadRuntimeState(entry.id)

      // Idle entries without PID → mark as stale
      if (state.status === "idle" && !state.pid) {
        // Clean up runtime file
        try {
          const fp = runtimeStateFile(entry.id)
          if (fs.existsSync(fp)) fs.unlinkSync(fp)
          result.stale_entries.push(entry.id)
        } catch {
          result.errors.push(`${entry.id}: failed to clean stale state file`)
        }
        continue
      }

      // Idle entries beyond max retries → mark as stale
      if (state.status === "failed" && state.retry_count >= state.max_retries) {
        result.stale_entries.push(entry.id)
        continue
      }

      // Running entries with no health check for too long
      if (state.status === "running") {
        const lastHealth = state.last_health_at ? new Date(state.last_health_at).getTime() : 0
        if (lastHealth && now - lastHealth > maxIdleMs) {
          const stopped = stopCapability(entry.id)
          if (stopped.stopped) result.stopped_entries.push(entry.id)
        }
      }

      // Dead PID cleanup
      if (state.pid && !isPidAlive(state.pid)) {
        state.status = "stopped"
        state.pid = undefined
        saveRuntimeState(state)
        result.stale_entries.push(`${entry.id}: dead pid ${state.pid} cleaned`)
      }
    } catch (error) {
      result.errors.push(`${entry.id}: ${String(error)}`)
    }
  }

  return result
}

/**
 * Mark a capability as started (called after successful process launch).
 */
export function markStarted(entryId: string, pid: number) {
  const state = loadRuntimeState(entryId)
  state.status = "running"
  state.pid = pid
  state.started_at = new Date().toISOString()
  state.last_health_at = new Date().toISOString()
  state.retry_count = 0
  state.last_error = undefined
  saveRuntimeState(state)
}

/**
 * Get summary of all managed runtime states.
 */
export function runtimeSummary(entries: CapabilityEntry[]): Record<string, RuntimeState> {
  const summary: Record<string, RuntimeState> = {}
  for (const entry of entries) {
    summary[entry.id] = loadRuntimeState(entry.id)
  }
  return summary
}

/**
 * Check if a capability's runtime is in a healthy state.
 */
export function isHealthy(entryId: string): boolean {
  const state = loadRuntimeState(entryId)
  if (state.status !== "running") return false
  if (state.pid && !isPidAlive(state.pid)) return false
  return true
}
