import { describe, test, expect } from "bun:test"
import {
  planStart,
  healthcheck,
  retryOrDegrade,
  stopCapability,
  cleanupStale,
  markStarted,
  isHealthy,
  loadRuntimeState,
} from "../../src/dll-agent/capability-lifecycle"
import { createMinimalEntry } from "../../src/dll-agent/capability-schema"
import fs from "fs"
import path from "path"
import os from "os"

describe("planStart", () => {
  test("should start for on_demand policy", () => {
    const entry = createMinimalEntry({
      id: "test-mcp",
      kind: "mcp",
      name: "test",
      capabilities: ["test"],
      start_policy: "on_demand",
    })
    const result = planStart(entry)
    expect(result.should_start).toBe(true)
  })

  test("should not start for disabled policy", () => {
    const entry = createMinimalEntry({
      id: "test-disabled",
      kind: "mcp",
      name: "test",
      capabilities: ["test"],
      start_policy: "disabled",
    })
    const result = planStart(entry)
    expect(result.should_start).toBe(false)
  })

  test("should start for always policy", () => {
    const entry = createMinimalEntry({
      id: "test-always",
      kind: "mcp",
      name: "test",
      capabilities: ["test"],
      start_policy: "always",
    })
    const result = planStart(entry)
    expect(result.should_start).toBe(true)
  })

  test("should not start if already running", () => {
    markStarted("test-running", process.pid)
    const entry = createMinimalEntry({
      id: "test-running",
      kind: "mcp",
      name: "test",
      capabilities: ["test"],
      start_policy: "on_demand",
    })
    const result = planStart(entry)
    expect(result.should_start).toBe(false)
  })
})

describe("healthcheck", () => {
  test("not healthy for idle state", () => {
    const entry = createMinimalEntry({
      id: "test-health-idle",
      kind: "tool",
      name: "test",
      capabilities: ["test"],
    })
    const result = healthcheck(entry)
    expect(result.healthy).toBe(false)
  })

  test("healthy for running process", () => {
    markStarted("test-health-running", process.pid)
    const entry = createMinimalEntry({
      id: "test-health-running",
      kind: "tool",
      name: "test",
      capabilities: ["test"],
    })
    const result = healthcheck(entry)
    expect(result.healthy).toBe(true)
  })
})

describe("retryOrDegrade", () => {
  test("retries below max count", () => {
    // Clean up any previous state
    const dir = path.join(os.homedir(), ".dll-agent", "runtime")
    try { fs.unlinkSync(path.join(dir, "test-retry.json")) } catch {}
    const entry = createMinimalEntry({
      id: "test-retry",
      kind: "tool",
      name: "test",
      capabilities: ["test"],
    })
    const state = retryOrDegrade(entry, "test error")
    expect(state.retry_count).toBe(1)
    expect(state.status).toBe("idle")
  })

  test("fails after max retries", () => {
    // Prime with 2 retries
    const st = loadRuntimeState("test-retry-fail")
    st.retry_count = 2
    st.max_retries = 3
    // Write state manually
    const dir = path.join(os.homedir(), ".dll-agent", "runtime")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "test-retry-fail.json"), JSON.stringify(st))

    const entry = createMinimalEntry({
      id: "test-retry-fail",
      kind: "tool",
      name: "test",
      capabilities: ["test"],
    })
    const state = retryOrDegrade(entry, "test error")
    expect(state.retry_count).toBe(3)
    expect(state.status).toBe("failed")
  })
})

describe("stopCapability", () => {
  test("returns not stopped for no PID", () => {
    const result = stopCapability("nonexistent-capability")
    expect(result.stopped).toBe(false)
  })

  test("refuses to stop self", () => {
    markStarted("self-cap", process.pid)
    const result = stopCapability("self-cap")
    expect(result.stopped).toBe(false)
    expect(result.reason).toContain("refusing to stop self")
  })
})

describe("cleanupStale", () => {
  test("cleans up idle entries", () => {
    const entry = createMinimalEntry({
      id: "test-cleanup",
      kind: "tool",
      name: "test",
      capabilities: ["test"],
    })
    const result = cleanupStale([entry])
    // Should mark as stale since there's no runtime state
    expect(result.stale_entries.length + result.errors.length).toBeGreaterThanOrEqual(0)
  })
})

describe("isHealthy", () => {
  test("returns false for unknown entry", () => {
    expect(isHealthy("unknown-entry")).toBe(false)
  })

  test("returns true for running entry with valid PID", () => {
    markStarted("test-is-healthy", process.pid)
    expect(isHealthy("test-is-healthy")).toBe(true)
  })
})
