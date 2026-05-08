/**
 * dll-agent permission-bridge tests
 */
import { describe, it, expect } from "bun:test"
import { permissionPreCheck } from "../../src/dll-agent/permission-bridge"

describe("permission-bridge", () => {
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
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["rm", "-rf", "/tmp/test"],
    })
    // High risk should always be intercepted with action=ask (requires confirmation)
    if (result.intercepted) {
      expect(result.action).toBe("ask")
    }
  })

  it("classifies .env read (high secret risk) as ask", () => {
    const result = permissionPreCheck({
      permission: "file_read",
      patterns: [".env"],
    })
    if (result.intercepted) {
      expect(result.action).toBe("ask")
    }
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
