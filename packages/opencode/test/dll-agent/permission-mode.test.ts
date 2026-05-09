import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  getPermissionMode,
  normalizePermissionMode,
  permissionModeConfigPath,
  renderPermissionModeStatus,
  setPermissionMode,
} from "../../src/dll-agent/permission-mode"
import { permissionPreCheck } from "../../src/dll-agent/permission-bridge"

const roots: string[] = []

function isolatedConfigRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-permissions-"))
  roots.push(root)
  process.env.DLL_AGENT_CONFIG_ROOT = root
  return root
}

describe("permission-mode", () => {
  afterEach(() => {
    delete process.env.DLL_AGENT_CONFIG_ROOT
    delete process.env.DLL_AGENT_PERMISSION_MODE
    delete process.env.DLL_AGENT_AUTO_ALLOW
    delete process.env.DLL_AGENT_ENABLED
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("defaults to full-access for backward-compatible current behavior", () => {
    isolatedConfigRoot()
    expect(getPermissionMode()).toBe("full-access")
  })

  it("normalizes codex-style permission aliases", () => {
    expect(normalizePermissionMode("Default")).toBe("default")
    expect(normalizePermissionMode("auto")).toBe("auto-review")
    expect(normalizePermissionMode("auto_review")).toBe("auto-review")
    expect(normalizePermissionMode("full")).toBe("full-access")
    expect(normalizePermissionMode("full_access")).toBe("full-access")
    expect(normalizePermissionMode("unknown")).toBe(null)
  })

  it("persists the selected mode globally", () => {
    isolatedConfigRoot()
    setPermissionMode("auto-review", "permission-mode-test")
    expect(getPermissionMode()).toBe("auto-review")
    expect(fs.existsSync(permissionModeConfigPath())).toBe(true)
  })

  it("lets environment override persisted mode", () => {
    isolatedConfigRoot()
    setPermissionMode("default")
    process.env.DLL_AGENT_PERMISSION_MODE = "full-access"
    expect(getPermissionMode()).toBe("full-access")
  })

  it("switches permission behavior dynamically without agent restart", () => {
    isolatedConfigRoot()
    process.env.DLL_AGENT_ENABLED = "1"
    setPermissionMode("full-access")
    const full = permissionPreCheck({
      permission: "shell",
      patterns: ["git", "push", "origin", "dev"],
      metadata: { dllAgentRole: "commander" },
    })
    setPermissionMode("default")
    const defaultMode = permissionPreCheck({
      permission: "shell",
      patterns: ["git", "push", "origin", "dev"],
      metadata: { dllAgentRole: "commander" },
    })
    expect(full.intercepted).toBe(true)
    expect(full.action).toBe("allow")
    expect(defaultMode.intercepted).toBe(false)
  })

  it("renders all three visible mode options", () => {
    isolatedConfigRoot()
    const text = renderPermissionModeStatus()
    expect(text).toContain("/permissions default")
    expect(text).toContain("/permissions auto-review")
    expect(text).toContain("/permissions full-access")
  })
})
