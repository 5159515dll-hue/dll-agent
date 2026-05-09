import fs from "fs"
import path from "path"
import { write as writeEvidence } from "./evidence"
import { configRoot } from "./role-model-store"

export type DllPermissionMode = "default" | "auto-review" | "full-access"

const MODES: DllPermissionMode[] = ["default", "auto-review", "full-access"]

export function permissionModeConfigPath() {
  return path.join(configRoot(), "config", "permissions.json")
}

export function isPermissionMode(value: string): value is DllPermissionMode {
  return MODES.includes(value as DllPermissionMode)
}

export function normalizePermissionMode(value: string | undefined): DllPermissionMode | null {
  const mode = value?.trim().toLowerCase().replace(/_/g, "-")
  if (!mode) return null
  if (mode === "auto" || mode === "autoreview") return "auto-review"
  if (mode === "full" || mode === "fullaccess") return "full-access"
  if (isPermissionMode(mode)) return mode
  return null
}

function envPermissionMode(): DllPermissionMode | null {
  const explicit = normalizePermissionMode(process.env.DLL_AGENT_PERMISSION_MODE)
  if (explicit) return explicit
  if (process.env.DLL_AGENT_AUTO_ALLOW === "0") return "default"
  if (process.env.DLL_AGENT_AUTO_ALLOW === "1") return "full-access"
  return null
}

export function getPermissionMode(): DllPermissionMode {
  const env = envPermissionMode()
  if (env) return env
  try {
    const file = permissionModeConfigPath()
    if (!fs.existsSync(file)) return "full-access"
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { mode?: string }
    return normalizePermissionMode(data.mode) ?? "full-access"
  } catch {
    return "full-access"
  }
}

export function setPermissionMode(mode: DllPermissionMode, sessionID?: string) {
  const file = permissionModeConfigPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const data = {
    version: 1,
    mode,
    updated_at: new Date().toISOString(),
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  writeEvidence("permission_mode.set", { mode, file }, sessionID)
  return data
}

export function permissionModeLabel(mode: DllPermissionMode) {
  if (mode === "default") return "Default"
  if (mode === "auto-review") return "Auto-review"
  return "Full Access"
}

export function permissionModeDescription(mode: DllPermissionMode) {
  if (mode === "default") return "Use OpenCode's normal permission prompts and configured rules."
  if (mode === "auto-review") return "Auto-approve low-risk/project-local work; ask for high-risk or uncertain actions."
  return "Grant all permissions by explicit user choice; high-risk actions are allowed and recorded as Full Access overrides."
}

export function renderPermissionModeStatus() {
  const mode = getPermissionMode()
  return [
    "dll-agent permissions:",
    `current=${mode} (${permissionModeLabel(mode)})`,
    "",
    "options:",
    "- default: OpenCode default permission prompts",
    "- auto-review: low-risk auto, high-risk/manual-review actions ask",
    "- full-access: grant all permissions by explicit user choice; high-risk actions are recorded as overrides",
    "",
    "set with:",
    "/permissions default",
    "/permissions auto-review",
    "/permissions full-access",
  ].join("\n")
}

export function permissionModeOptions() {
  return MODES.map((mode) => ({
    mode,
    label: permissionModeLabel(mode),
    description: permissionModeDescription(mode),
  }))
}
