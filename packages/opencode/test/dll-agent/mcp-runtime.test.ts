import { beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { CapabilityEntry } from "../../src/dll-agent/capability-schema"
import type { McpRuntimeRequest } from "../../src/dll-agent/capability-orchestrator"
import {
  mcpRuntimeStatus,
  preflightMcpRuntime,
  recordMcpRuntimeConnected,
  recordMcpRuntimeConnectFailed,
  recordMcpRuntimeStopped,
  runMcpRuntimeHealthcheck,
  stopMcpRuntime,
} from "../../src/dll-agent/mcp-runtime"
import { acquireLock, markStopped, releaseLock } from "../../src/dll-agent/mcp-manager"

const MCP_DIR = path.join(os.homedir(), ".dll-agent", "mcp")
const TEST_NAMES = [
  "test_runtime_allow",
  "test_runtime_connected",
  "test_runtime_failed",
  "test_runtime_mutex",
  "test_runtime_skip",
  "test_runtime_missing_binary",
  "test_runtime_missing_env",
  "test_runtime_sensitive",
  "test_runtime_role_block",
]

function cleanup() {
  try {
    fs.mkdirSync(MCP_DIR, { recursive: true })
    for (const name of TEST_NAMES) {
      for (const suffix of [".json", ".lock"]) {
        const file = path.join(MCP_DIR, `${name}${suffix}`)
        if (fs.existsSync(file)) fs.unlinkSync(file)
      }
    }
  } catch {}
  delete process.env.DLL_AGENT_TEST_REQUIRED_TOKEN
}

beforeEach(cleanup)

function request(overrides: Partial<McpRuntimeRequest> = {}): McpRuntimeRequest {
  return {
    name: "test_runtime_allow",
    entry_id: "test-runtime",
    auto_connect: true,
    reason: "task explicitly needs isolated test MCP",
    risk_level: "medium",
    heavy: true,
    requires_consent: false,
    config: {
      type: "local",
      command: ["echo", "hello"],
      enabled: true,
      timeout: 1_000,
    },
    ...overrides,
  }
}

function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    id: "test-runtime",
    kind: "mcp",
    name: "test-runtime",
    description: "test runtime MCP",
    capabilities: ["test"],
    input_types: ["text"],
    output_types: ["text"],
    risk_level: "medium",
    cost_level: "free",
    requires_token: false,
    requires_install: false,
    install_strategy: "none",
    start_policy: "on_demand",
    runtime: {
      start_command: ["echo", "hello"],
      isolated: true,
      mutex_key: "test_runtime_allow",
      heavy: true,
      start_policy: "on_demand",
      healthcheck: { type: "pid" },
      start_timeout_ms: 1_000,
    },
    dependencies: { binaries: ["echo"] },
    source: "test",
    source_type: "manual",
    confidence: 1,
    status: "on_demand",
    platforms: ["any"],
    project_scope: "global",
    registered_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  }
}

describe("MCP on-demand runtime preflight", () => {
  test("allows connect only after binary, permission, mutex, and state checks pass", () => {
    const decision = preflightMcpRuntime({
      request: request(),
      entry: entry(),
      role: "commander",
      projectDir: process.cwd(),
      openCodeStatus: "disconnected",
    })
    expect(decision.action).toBe("allow_connect")
    expect(decision.missing_binaries).toEqual([])
    releaseLock(decision.name)
  })

  test("skips when OpenCode already reports connected", () => {
    const decision = preflightMcpRuntime({
      request: request({ name: "test_runtime_skip" }),
      entry: entry({ id: "test_runtime_skip", name: "test_runtime_skip" }),
      role: "commander",
      openCodeStatus: "connected",
    })
    expect(decision.action).toBe("skip_already_connected")
  })

  test("blocks missing binary before startup", () => {
    const decision = preflightMcpRuntime({
      request: request({
        name: "test_runtime_missing_binary",
        config: { type: "local", command: ["dll-agent-missing-binary-for-test"], enabled: true },
      }),
      entry: entry({
        id: "test_runtime_missing_binary",
        name: "test_runtime_missing_binary",
        dependencies: { binaries: ["dll-agent-missing-binary-for-test"] },
      }),
      role: "commander",
    })
    expect(decision.action).toBe("blocked_missing_binary")
    expect(decision.missing_binaries).toContain("dll-agent-missing-binary-for-test")
  })

  test("blocks missing env key without exposing env values", () => {
    process.env.DLL_AGENT_TEST_REQUIRED_TOKEN = "secret-value-that-must-not-leak"
    delete process.env.DLL_AGENT_TEST_REQUIRED_TOKEN
    const decision = preflightMcpRuntime({
      request: request({ name: "test_runtime_missing_env" }),
      entry: entry({
        id: "test_runtime_missing_env",
        name: "test_runtime_missing_env",
        dependencies: { binaries: ["echo"], tokens: ["DLL_AGENT_TEST_REQUIRED_TOKEN"] },
      }),
      role: "commander",
    })
    expect(decision.action).toBe("blocked_missing_env")
    expect(decision.missing_env_keys).toEqual(["DLL_AGENT_TEST_REQUIRED_TOKEN"])
    expect(JSON.stringify(decision)).not.toContain("secret-value-that-must-not-leak")
  })

  test("blocks sensitive browser/profile context unless explicitly authorized", () => {
    const blocked = preflightMcpRuntime({
      request: request({
        name: "test_runtime_sensitive",
        reason: "use real browser profile and cookies",
      }),
      entry: entry({ id: "test_runtime_sensitive", name: "test_runtime_sensitive" }),
      role: "commander",
    })
    expect(blocked.action).toBe("blocked_sensitive_context")

    const allowed = preflightMcpRuntime({
      request: request({
        name: "test_runtime_sensitive",
        reason: "use real browser profile and cookies",
      }),
      entry: entry({ id: "test_runtime_sensitive", name: "test_runtime_sensitive" }),
      role: "commander",
      explicitlyAuthorized: true,
    })
    expect(allowed.action).toBe("allow_connect")
    releaseLock(allowed.name)
  })

  test("respects role-tool-policy for read-only roles", () => {
    const decision = preflightMcpRuntime({
      request: request({ name: "test_runtime_role_block" }),
      entry: entry({ id: "test_runtime_role_block", name: "test_runtime_role_block" }),
      role: "final-auditor",
    })
    expect(decision.action).toBe("blocked_permission")
  })

  test("blocks when mutex is already held", () => {
    expect(acquireLock("test_runtime_mutex")).toBe(true)
    const decision = preflightMcpRuntime({
      request: request({ name: "test_runtime_mutex" }),
      entry: entry({ id: "test_runtime_mutex", name: "test_runtime_mutex" }),
      role: "commander",
    })
    expect(decision.action).toBe("blocked_mutex")
    releaseLock("test_runtime_mutex")
  })

  test("records connected, healthcheck, failed, and stopped runtime states", () => {
    const decision = preflightMcpRuntime({
      request: request({ name: "test_runtime_connected" }),
      entry: entry({ id: "test_runtime_connected", name: "test_runtime_connected" }),
      role: "commander",
    })
    expect(decision.action).toBe("allow_connect")
    recordMcpRuntimeConnected({ decision, status: "connected" })
    expect(mcpRuntimeStatus(decision.name).status).toBe("running")
    expect(runMcpRuntimeHealthcheck({ decision }).healthy).toBe(true)
    const stopResult = stopMcpRuntime({ name: decision.name, entry_id: decision.entry_id, reason: "test stop" })
    expect(stopResult.stopped).toBe(false)
    expect(stopResult.reason).toContain("refuse to stop current process")
    recordMcpRuntimeStopped({ name: decision.name, entry_id: decision.entry_id, reason: "test cleanup" })
    expect(mcpRuntimeStatus(decision.name).status).toBe("stopped")

    const failed = preflightMcpRuntime({
      request: request({ name: "test_runtime_failed" }),
      entry: entry({ id: "test_runtime_failed", name: "test_runtime_failed" }),
      role: "commander",
    })
    expect(failed.action).toBe("allow_connect")
    recordMcpRuntimeConnectFailed({ decision: failed, error: "connection refused" })
    expect(["degraded", "failed"]).toContain(mcpRuntimeStatus(failed.name).status)
    markStopped(failed.name)
  })
})
