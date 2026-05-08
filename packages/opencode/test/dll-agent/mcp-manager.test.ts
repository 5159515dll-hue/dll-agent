import { describe, expect, test, beforeEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  loadStatus,
  acquireLock,
  releaseLock,
  shouldStart,
  degrade,
  markRunning,
  markStopped,
  isAvailable,
  reconcileMcpStatus,
  cleanupManagedMcp,
  healthcheck,
  probeHealthUrl,
  type McpServerDecl,
} from "../../src/dll-agent/mcp-manager"

const LOCK_DIR = path.join(os.homedir(), ".dll-agent", "mcp")

function cleanLocks() {
  try {
    if (fs.existsSync(LOCK_DIR)) {
      for (const f of fs.readdirSync(LOCK_DIR)) {
        if (f.endsWith(".lock")) fs.unlinkSync(path.join(LOCK_DIR, f))
      }
    }
  } catch {}
}

beforeEach(() => {
  cleanLocks()
  // also clean state files for test servers
  const testNames = ["test_lock_first", "test_lock_held", "test_should_start", "test_running", "test_mark_running", "test_degrade", "test_degrade_fail", "test_avail", "test_stop", "test_reconcile_dead", "test_cleanup_idle", "test_http_health_ok", "test_http_health_fail"]
  for (const name of testNames) {
    try {
      const sf = path.join(LOCK_DIR, `${name}.json`)
      if (fs.existsSync(sf)) fs.unlinkSync(sf)
    } catch {}
  }
})

function makeDecl(overrides: Partial<McpServerDecl> = {}): McpServerDecl {
  return {
    name: "test-server",
    command: ["echo", "hello"],
    isolated: false,
    autoRestart: false,
    maxRetries: 2,
    timeoutMs: 5000,
    cooldownMs: 60_000,
    ...overrides,
  }
}

describe("DllAgentMcpManager lifecycle", () => {
  test("initial status is stopped", () => {
    const status = loadStatus("test_init")
    expect(status.status).toBe("stopped")
    expect(status.retryCount).toBe(0)
  })

  test("acquireLock returns true for first caller", () => {
    const got = acquireLock("test_lock_first")
    expect(got).toBe(true)
    releaseLock("test_lock_first")
  })

  test("acquireLock returns false while lock held", () => {
    const got1 = acquireLock("test_lock_held")
    expect(got1).toBe(true)
    const got2 = acquireLock("test_lock_held")
    expect(got2).toBe(false)
    releaseLock("test_lock_held")
  })

  test("shouldStart returns true for fresh server", () => {
    const decl = makeDecl({ name: "test_should_start" })
    const result = shouldStart(decl)
    expect(result.start).toBe(true)
    releaseLock(decl.name)
  })

  test("shouldStart returns false when running", () => {
    const decl = makeDecl({ name: "test_running" })
    markRunning(decl, 12345)
    const result = shouldStart(decl)
    expect(result.start).toBe(false)
    expect(result.reason).toBe("already running")
    markStopped(decl.name)
  })

  test("markRunning updates status correctly", () => {
    const decl = makeDecl({ name: "test_mark_running" })
    markRunning(decl, 99999)
    const status = loadStatus(decl.name)
    expect(status.status).toBe("running")
    expect(status.pid).toBe(99999)
    expect(status.lastHealthAt).toBeDefined()
    markStopped(decl.name)
  })

  test("degrade increments retry and writes error", () => {
    const decl = makeDecl({ name: "test_degrade" })
    degrade(decl, "connection refused")
    const status = loadStatus(decl.name)
    expect(status.status).toBe("degraded")
    expect(status.lastError).toBe("connection refused")
    expect(status.retryCount).toBe(1)
    releaseLock(decl.name)
  })

  test("degrade past maxRetries sets failed + cooldown", () => {
    const decl = makeDecl({ name: "test_degrade_fail", maxRetries: 0 })
    degrade(decl, "timeout")
    const status = loadStatus(decl.name)
    expect(status.status).toBe("failed")
    expect(status.cooldownUntil).toBeDefined()
    releaseLock(decl.name)
  })

  test("isAvailable returns true for running or degraded", () => {
    const decl = makeDecl({ name: "test_avail" })
    markRunning(decl, 111)
    expect(isAvailable(decl)).toBe(true)
    degrade(decl, "slow")
    expect(isAvailable(decl)).toBe(true)
    // past max retries → failed
    degrade(decl, "dead")
    const status = loadStatus(decl.name)
    // status is updated by degrade
    markStopped(decl.name)
  })

  test("markStopped releases lock and resets status", () => {
    const decl = makeDecl({ name: "test_stop" })
    markRunning(decl, 222)
    markStopped(decl.name)
    const status = loadStatus(decl.name)
    expect(status.status).toBe("stopped")
    expect(status.pid).toBeUndefined()
  })

  test("reconcileMcpStatus marks dead pid as stopped", () => {
    const decl = makeDecl({ name: "test_reconcile_dead" })
    markRunning(decl, 999999)
    const status = reconcileMcpStatus(decl.name)
    expect(status.status).toBe("stopped")
    expect(status.pid).toBeUndefined()
  })

  test("cleanupManagedMcp refuses to stop the current process", () => {
    const decl = makeDecl({ name: "test_cleanup_idle" })
    markRunning(decl, process.pid)
    const stateFile = path.join(LOCK_DIR, `${decl.name}.json`)
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    state.lastHealthAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))

    const result = cleanupManagedMcp([decl], 1_000)
    const status = loadStatus(decl.name)
    expect(result.stale.some((item) => item.includes("refuse to stop current process"))).toBe(true)
    expect(status.status).toBe("running")
    markStopped(decl.name)
  })

  test("probeHealthUrl uses curl for local healthUrl", () => {
    const calls: unknown[][] = []
    const result = probeHealthUrl("http://127.0.0.1:12345/health", 3_000, ((bin: string, args: string[]) => {
      calls.push([bin, args])
      return ""
    }) as any)
    expect(result.healthy).toBe(true)
    expect(result.probe).toBe("http")
    expect(calls[0][0]).toBe("curl")
    expect(calls[0][1]).toContain("http://127.0.0.1:12345/health")
  })

  test("healthcheck reports http detail for skipped remote healthUrl", () => {
    const decl = makeDecl({
      name: "test_http_health_ok",
      healthUrl: "https://example.com/health",
      timeoutMs: 3_000,
    })
    markRunning(decl, process.pid)
    const result = healthcheck(decl)
    expect(result.healthy).toBe(true)
    expect(result.probe).toBe("skipped")
    markStopped(decl.name)
  })

  test("healthcheck fails when local healthUrl is unreachable", () => {
    const decl = makeDecl({
      name: "test_http_health_fail",
      healthUrl: "http://127.0.0.1:9/health",
      timeoutMs: 1_000,
    })
    markRunning(decl, process.pid)
    const result = healthcheck(decl)
    expect(result.healthy).toBe(false)
    expect(result.detail).toContain("healthUrl probe failed")
    markStopped(decl.name)
  })
})
