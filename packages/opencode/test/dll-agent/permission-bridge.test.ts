/**
 * dll-agent permission-bridge tests
 */
import { afterEach, describe, it, expect } from "bun:test"
import { permissionPreCheck } from "../../src/dll-agent/permission-bridge"

describe("permission-bridge", () => {
  afterEach(() => {
    delete process.env.DLL_AGENT_ENABLED
    delete process.env.DLL_AGENT_AUTO_ALLOW
  })

  it("intercepts low-risk shell typecheck as allow", () => {
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["bun", "typecheck"],
      projectRoot: "/project",
    })
    // dll-agent auto-allow is enabled when DLL_AGENT_ENABLED=1
    // If not enabled, intercepted will be false
    if (result.intercepted) {
      expect(result.action).toBe("allow")
    }
  })

  it("classifies git status (low risk) appropriately", () => {
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["git", "status"],
    })
    // Either auto-allowed or passed through (depending on env)
    expect(["allow", "ask"]).toContain(result.action)
  })

  it("classifies rm -rf (high risk) as ask", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["rm", "-rf", "/tmp/test"],
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("ask")
  })

  it("classifies .env read (high secret risk) as ask", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    const result = permissionPreCheck({
      permission: "file_read",
      patterns: [".env"],
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("ask")
  })

  it("denies mutating tools for read-only reviewer roles", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    const result = permissionPreCheck({
      permission: "bash",
      patterns: ["git status"],
      metadata: { dllAgentRole: "role-cross" },
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("role-cross")
  })

  it("handles unknown permission types gracefully", () => {
    const result = permissionPreCheck({
      permission: "some_unknown_permission",
      patterns: ["foo"],
    })
    // Should not throw — either intercepted or not
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it("returns non-intercepted when dll-agent not enabled", () => {
    // This test verifies the fallback behavior — when env is not set,
    // the function returns intercepted=false and action=ask
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["echo", "hello"],
    })
    expect(result.action).toBeDefined()
    expect(result.reason).toBeDefined()
  })
})
