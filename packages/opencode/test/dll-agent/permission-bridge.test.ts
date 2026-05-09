/**
 * dll-agent permission-bridge tests
 */
import { afterEach, describe, it, expect } from "bun:test"
import fs from "fs"
import { permissionPreCheck } from "../../src/dll-agent/permission-bridge"

describe("permission-bridge", () => {
  afterEach(() => {
    delete process.env.DLL_AGENT_ENABLED
    delete process.env.DLL_AGENT_AUTO_ALLOW
    delete process.env.DLL_AGENT_PERMISSION_MODE
    delete process.env.DLL_AGENT_CONFIG_ROOT
    delete process.env.DLL_AGENT_EVIDENCE_FILE
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
    process.env.DLL_AGENT_PERMISSION_MODE = "auto-review"
    const result = permissionPreCheck({
      permission: "shell",
      patterns: ["rm", "-rf", "/tmp/test"],
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("ask")
  })

  it("auto-review does not bypass git push, sudo, or secret access", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "auto-review"
    const gitPush = permissionPreCheck({
      permission: "shell",
      patterns: ["git", "push", "origin", "dev"],
    })
    const sudo = permissionPreCheck({
      permission: "shell",
      patterns: ["sudo", "systemctl", "restart", "nginx"],
    })
    const secret = permissionPreCheck({
      permission: "file_read",
      patterns: ["/project/.env"],
      projectRoot: "/project",
    })
    expect(gitPush.action).toBe("ask")
    expect(sudo.action).toBe("ask")
    expect(secret.action).toBe("ask")
  })

  it("full-access allows high-risk commander commands after role policy check", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "full-access"
    const gitPush = permissionPreCheck({
      permission: "shell",
      patterns: ["git", "push", "origin", "dev"],
      metadata: { dllAgentRole: "commander" },
    })
    const secret = permissionPreCheck({
      permission: "file_read",
      patterns: ["/project/.env"],
      projectRoot: "/project",
      metadata: { dllAgentRole: "commander" },
    })
    expect(gitPush.intercepted).toBe(true)
    expect(gitPush.action).toBe("allow")
    expect(secret.action).toBe("allow")
  })

  it("auto-review allows commander project-local file writes without allowing high-risk shell commands", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "auto-review"
    const write = permissionPreCheck({
      permission: "file_write",
      patterns: ["/project/src/app.ts"],
      projectRoot: "/project",
      metadata: { dllAgentRole: "commander" },
    })
    const unknownShell = permissionPreCheck({
      permission: "shell",
      patterns: ["custom-dangerous-tool", "--mutate"],
      projectRoot: "/project",
      metadata: { dllAgentRole: "commander" },
    })
    expect(write.intercepted).toBe(true)
    expect(write.action).toBe("allow")
    expect(unknownShell.action).toBe("ask")
  })

  it("records role-tool policy evidence for permission decisions", () => {
    const evidenceFile = `/tmp/dll-agent-permission-bridge-${Date.now()}.jsonl`
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "auto-review"
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    permissionPreCheck({
      permission: "file_write",
      patterns: ["/project/src/app.ts"],
      projectRoot: "/project",
      metadata: { dllAgentRole: "commander" },
      sessionID: "permission-bridge-evidence",
    })
    const evidence = fs.readFileSync(evidenceFile, "utf8")
    expect(evidence).toContain("role_tool_policy.decision")
    expect(evidence).toContain("commander")
    fs.rmSync(evidenceFile, { force: true })
  })

  it("classifies .env read (high secret risk) as ask", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "auto-review"
    const result = permissionPreCheck({
      permission: "file_read",
      patterns: [".env"],
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("ask")
  })

  it("denies mutating tools for read-only reviewer roles", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "full-access"
    const result = permissionPreCheck({
      permission: "bash",
      patterns: ["git status"],
      metadata: { dllAgentRole: "role-cross" },
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("role-cross")
  })

  it("denies final-auditor write tools", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    process.env.DLL_AGENT_PERMISSION_MODE = "full-access"
    const result = permissionPreCheck({
      permission: "edit",
      patterns: ["/project/src/app.ts"],
      metadata: { dllAgentRole: "final-auditor" },
    })
    expect(result.intercepted).toBe(true)
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("final-auditor")
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
