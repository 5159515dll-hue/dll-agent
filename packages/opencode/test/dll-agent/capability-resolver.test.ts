import { describe, test, expect } from "bun:test"
import {
  resolveCapability,
  resolveAll,
  isAutoApproved,
  formatDecision,
} from "../../src/dll-agent/capability-resolver"
import { createMinimalEntry, type CapabilityEntry } from "../../src/dll-agent/capability-schema"

describe("resolveCapability", () => {
  test("use_now for available capability", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "tool",
      name: "test",
      capabilities: ["testing"],
      status: "available",
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("use_now")
    expect(result.requires_user_consent).toBe(false)
  })

  test("use_now for running capability", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "tool",
      name: "test",
      capabilities: ["testing"],
      status: "running",
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("use_now")
  })

  test("auto_install for low-risk install strategy", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "tool",
      name: "test",
      capabilities: ["testing"],
      status: "missing_dependency",
      install_strategy: "project_local_npm",
      requires_install: true,
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("auto_install")
    expect(result.requires_user_consent).toBe(false)
  })

  test("auto_install for npx_runtime", () => {
    const entry = createMinimalEntry({
      id: "test-npx",
      kind: "mcp",
      name: "test-mcp",
      capabilities: ["automation"],
      status: "missing_dependency",
      install_strategy: "npx_runtime",
      requires_install: true,
      runtime: { start_command: ["npx", "-y", "test-mcp"] },
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("auto_install")
    expect(result.install_command).toBeDefined()
  })

  test("does not downgrade high-risk npx capability to low-risk auto install", () => {
    const entry = createMinimalEntry({
      id: "high-risk-mcp",
      kind: "mcp",
      name: "high-risk-mcp",
      capabilities: ["browser-automation"],
      status: "missing_dependency",
      risk_level: "high",
      install_strategy: "npx_runtime",
      requires_install: true,
      runtime: { start_command: ["npx", "high-risk-mcp"] },
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("ask_permission")
    expect(result.risk_level).toBe("high")
    expect(result.requires_user_consent).toBe(true)
  })

  test("ask_permission for high-risk install strategy", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "software",
      name: "test",
      capabilities: ["system"],
      risk_level: "high",
      status: "missing_dependency",
      install_strategy: "system_package_manager",
      requires_install: true,
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("ask_permission")
    expect(result.requires_user_consent).toBe(true)
  })

  test("skip for missing tokens with no install", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "tool",
      name: "test",
      capabilities: ["testing"],
      status: "missing_dependency",
      requires_token: true,
      dependencies: { tokens: ["MISSING_TOKEN"] },
      install_strategy: "none",
      requires_install: false,
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("skip")
  })

  test("ask_permission for user_local_binary with low confidence", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "software",
      name: "test",
      capabilities: ["binary"],
      status: "missing_dependency",
      install_strategy: "user_local_binary",
      requires_install: true,
      confidence: 0.5,
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("ask_permission")
  })

  test("auto_install for user_local_binary with high confidence", () => {
    const entry = createMinimalEntry({
      id: "test",
      kind: "software",
      name: "test",
      capabilities: ["binary"],
      status: "missing_dependency",
      install_strategy: "user_local_binary",
      requires_install: true,
      confidence: 0.9,
    })
    const result = resolveCapability(entry)
    expect(result.action).toBe("auto_install")
  })
})

describe("resolveAll", () => {
  test("categorizes entries correctly", () => {
    const entries: CapabilityEntry[] = [
      createMinimalEntry({ id: "ready-1", kind: "tool", name: "ready", capabilities: ["test"], status: "available" }) as CapabilityEntry,
      createMinimalEntry({ id: "pending-1", kind: "tool", name: "pending", capabilities: ["test"], status: "missing_dependency", install_strategy: "project_local_npm", requires_install: true }) as CapabilityEntry,
      createMinimalEntry({ id: "blocked-1", kind: "tool", name: "blocked", capabilities: ["test"], status: "missing_dependency", requires_token: true, dependencies: { tokens: ["X"] }, install_strategy: "none", requires_install: false }) as CapabilityEntry,
    ]
    const result = resolveAll(entries)
    expect(result.ready.length).toBe(1)
    expect(result.pending.length).toBe(1)
    expect(result.blocked.length).toBe(1)
    expect(result.ready[0].entry_id).toBe("ready-1")
    expect(result.pending[0].entry_id).toBe("pending-1")
    expect(result.blocked[0].entry_id).toBe("blocked-1")
  })
})

describe("isAutoApproved", () => {
  test("approves use_now, lazy_start, auto_install", () => {
    expect(isAutoApproved({ entry_id: "x", action: "use_now", reason: "", risk_level: "low", requires_user_consent: false })).toBe(true)
    expect(isAutoApproved({ entry_id: "x", action: "lazy_start", reason: "", risk_level: "low", requires_user_consent: false })).toBe(true)
    expect(isAutoApproved({ entry_id: "x", action: "auto_install", reason: "", risk_level: "low", requires_user_consent: false })).toBe(true)
  })

  test("rejects ask_permission, skip, degrade", () => {
    expect(isAutoApproved({ entry_id: "x", action: "ask_permission", reason: "", risk_level: "high", requires_user_consent: true })).toBe(false)
    expect(isAutoApproved({ entry_id: "x", action: "skip", reason: "", risk_level: "low", requires_user_consent: false })).toBe(false)
    expect(isAutoApproved({ entry_id: "x", action: "degrade", reason: "", risk_level: "low", requires_user_consent: false })).toBe(false)
  })
})

describe("formatDecision", () => {
  test("returns non-empty string with icon", () => {
    const result = formatDecision({ entry_id: "test", action: "use_now", reason: "ok", risk_level: "low", requires_user_consent: false })
    expect(result).toContain("test")
    expect(result).toContain("use_now")
  })
})
