import fs from "fs"
import path from "path"
import os from "os"
import type { DllRole, OverrideScope, RoleModelConfig } from "./role-model-registry"

interface FileRoleModelConfig {
  primary?: string
  fallback?: string[]
  enabled?: boolean
  onDemandOnly?: boolean
}

export function configRoot() {
  return process.env.DLL_AGENT_CONFIG_ROOT || path.join(os.homedir(), ".dll-agent")
}

export function globalConfigPath() {
  return path.join(configRoot(), "config", "role-models.jsonc")
}

export function projectConfigPath(projectDir?: string) {
  if (!projectDir) return null
  const a = path.join(projectDir, ".dll-agent", "role-models.jsonc")
  const b = path.join(projectDir, "dll-agent.role-models.jsonc")
  if (fs.existsSync(a)) return a
  if (fs.existsSync(b)) return b
  return null
}

export function sessionOverridePath(sessionID?: string) {
  if (!sessionID) return null
  return path.join(configRoot(), "sessions", sessionID, "supervisor.json")
}

export function loadJsoncFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, "utf8")
    const cleaned = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(?=\s*[}\]])/g, "")
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

export function loadOverridesFromConfig(
  filePath: string | null,
  scope: OverrideScope,
  isRole: (value: string) => value is DllRole,
): Partial<Record<DllRole, RoleModelConfig>> | null {
  if (!filePath) return null
  const data = loadJsoncFile(filePath)
  if (!data?.roles) return null
  const roles = data.roles as Record<string, FileRoleModelConfig>
  const result: Partial<Record<DllRole, RoleModelConfig>> = {}
  for (const [roleName, cfg] of Object.entries(roles)) {
    if (!isRole(roleName)) continue
    if (!cfg.primary) continue
    result[roleName] = {
      primary: cfg.primary,
      fallback: cfg.fallback ?? [],
      scope,
      enabled: cfg.enabled ?? true,
      onDemandOnly: cfg.onDemandOnly,
    }
  }
  return result
}

export function loadSessionOverrides(
  sessionID: string | undefined,
  isRole: (value: string) => value is DllRole,
): Partial<Record<DllRole, RoleModelConfig>> | null {
  if (!sessionID) return null
  const filePath = sessionOverridePath(sessionID)
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"))
    const overrides = state.role_model_overrides as Record<string, { primary: string; fallback?: string[]; enabled?: boolean }> | undefined
    if (!overrides) return null
    const result: Partial<Record<DllRole, RoleModelConfig>> = {}
    for (const [roleName, cfg] of Object.entries(overrides)) {
      if (!isRole(roleName)) continue
      if (!cfg.primary) continue
      result[roleName] = {
        primary: cfg.primary,
        fallback: cfg.fallback ?? [],
        scope: "session",
        enabled: cfg.enabled ?? true,
      }
    }
    return result
  } catch {
    return null
  }
}
