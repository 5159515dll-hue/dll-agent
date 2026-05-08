/**
 * dll-agent role-model-registry.ts
 *
 * Unified Role Model Registry: single source of truth for all dll-agent role
 * model mappings. Supports three-tier override resolution:
 *
 *   session override > project override > global override > built-in default
 *
 * All role model changes are written to evidence.
 */

import fs from "fs"
import path from "path"
import os from "os"
import { write as writeEvidence, redact } from "./evidence"

// ─── Types ──────────────────────────────────────────────────────────────────

export type DllRole =
  | "commander"
  | "chief-engineer"
  | "requirements-inspector"
  | "long-context-archivist"
  | "task-completion-archivist"
  | "final-auditor"
  | "role-cross"
  | "agentic-solver"
  | "multimodal-reader"
  | "multimodal-context-interpreter"
  | "voice-output"
  | "executor"

export type OverrideScope = "built-in" | "global" | "project" | "session"

export interface RoleModelConfig {
  /** Primary model in "provider/model" format, e.g. "deepseek/deepseek-v4-pro" */
  primary: string
  /** Fallback model chain (provider/model format). First available model wins. */
  fallback: string[]
  /** Scope of this config entry */
  scope: OverrideScope
  /** Whether the role is enabled */
  enabled: boolean
  /** If true, this role should only be called on-demand, not auto-triggered */
  onDemandOnly?: boolean
}

export interface EffectiveRoleModel {
  role: DllRole
  primary: string
  fallback: string[]
  source: OverrideScope
  enabled: boolean
  onDemandOnly: boolean
  /** Resolved for agent.ts / supervisor.ts use: { providerID, modelID } */
  parsed: { providerID: string; modelID: string }
  /** Whether the provider is known to be configured (best-effort check) */
  providerAvailable: boolean
}

export interface RoleModelChange {
  role: DllRole
  previousPrimary: string
  newPrimary: string
  scope: OverrideScope
  ts: string
}

export interface ValidationResult {
  valid: boolean
  reason?: string
}

// ─── Built-in defaults ──────────────────────────────────────────────────────

const BUILT_IN_DEFAULTS: Record<DllRole, Omit<RoleModelConfig, "scope">> = {
  commander: {
    primary: "deepseek/deepseek-v4-pro",
    fallback: [],
    enabled: true,
  },
  "chief-engineer": {
    primary: "deepseek/deepseek-v4-pro",
    fallback: [],
    enabled: true,
  },
  "requirements-inspector": {
    primary: "zai/glm-5.1",
    fallback: [],
    enabled: true,
  },
  "long-context-archivist": {
    primary: "kimi/kimi-k2.6",
    fallback: [],
    enabled: true,
  },
  "task-completion-archivist": {
    primary: "kimi/kimi-k2.6",
    fallback: [],
    enabled: true,
  },
  "final-auditor": {
    primary: "openai/gpt-5.5-pro",
    fallback: [],
    enabled: true,
    onDemandOnly: true,
  },
  "role-cross": {
    // Fix existing bug: supervisor.ts hardcoded role-cross to zai/glm-5.1,
    // while agent.ts and profile.ts used deepseek/deepseek-v4-pro.
    // Unify to deepseek/deepseek-v4-pro as the default (role-cross is a
    // temporary perspective shift, not a formal Chinese review).
    primary: "deepseek/deepseek-v4-pro",
    fallback: [],
    enabled: true,
  },
  "agentic-solver": {
    primary: "deepseek/deepseek-v4-pro",
    fallback: [],
    enabled: false, // Future role
  },
  "multimodal-reader": {
    primary: "openai/gpt-5.5-pro",
    fallback: [],
    enabled: false, // Future role
  },
  "multimodal-context-interpreter": {
    // Dedicated multimodal role for screenshots, images, webpage visuals,
    // PPT figures, flowcharts, charts, video, audio — non-text inputs only.
    // Uses MiMo Token Plan (mimo-v2.5-pro) via OpenAI-compatible API.
    // MiMo is a temporary entitlement; replace via /role-model-set when needed.
    primary: "mimo/mimo-v2.5-pro",
    fallback: [],
    enabled: true,
    onDemandOnly: true,
  },
  "voice-output": {
    primary: "openai/gpt-5.5-pro",
    fallback: [],
    enabled: false, // Future role
  },
  executor: {
    primary: "deepseek/deepseek-v4-pro",
    fallback: [],
    enabled: true,
  },
}

// ─── Config file paths ──────────────────────────────────────────────────────

function globalConfigPath() {
  return path.join(os.homedir(), ".dll-agent", "config", "role-models.jsonc")
}

function projectConfigPath(projectDir?: string) {
  if (!projectDir) return null
  // Priority: <project>/.dll-agent/role-models.jsonc > <project>/dll-agent.role-models.jsonc
  const a = path.join(projectDir, ".dll-agent", "role-models.jsonc")
  const b = path.join(projectDir, "dll-agent.role-models.jsonc")
  if (fs.existsSync(a)) return a
  if (fs.existsSync(b)) return b
  return null
}

function sessionOverridePath(sessionID?: string) {
  if (!sessionID) return null
  return path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "supervisor.json")
}

// ─── Config loading (sync) ─────────────────────────────────────────────────

function parseModelString(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash === -1) return { providerID: model, modelID: "" }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function loadJsoncFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, "utf8")
    // Minimal JSONC support: strip // comments and trailing commas
    const cleaned = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(?=\s*[}\]])/g, "")
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

interface FileRoleModelConfig {
  primary?: string
  fallback?: string[]
  enabled?: boolean
  onDemandOnly?: boolean
}

function loadOverridesFromConfig(
  filePath: string | null,
  scope: OverrideScope,
): Partial<Record<DllRole, RoleModelConfig>> | null {
  if (!filePath) return null
  const data = loadJsoncFile(filePath)
  if (!data?.roles) return null
  const roles = data.roles as Record<string, FileRoleModelConfig>
  const result: Partial<Record<DllRole, RoleModelConfig>> = {}
  for (const [roleName, cfg] of Object.entries(roles)) {
    if (!isDllRole(roleName)) continue
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

function loadSessionOverrides(sessionID?: string): Partial<Record<DllRole, RoleModelConfig>> | null {
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
      if (!isDllRole(roleName)) continue
      if (!cfg.primary) continue
      result[roleName as DllRole] = {
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

// ─── Validation ─────────────────────────────────────────────────────────────

export function isDllRole(value: string): value is DllRole {
  return value in BUILT_IN_DEFAULTS
}

export const ALL_ROLES: DllRole[] = Object.keys(BUILT_IN_DEFAULTS) as DllRole[]

export const ACTIVE_ROLES: DllRole[] = ALL_ROLES.filter(
  (r) => BUILT_IN_DEFAULTS[r].enabled,
)

const MODEL_FORMAT_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i

export function validateRoleModel(model: string): ValidationResult {
  if (!model || typeof model !== "string") {
    return { valid: false, reason: "model must be a non-empty string" }
  }
  if (!model.includes("/")) {
    return { valid: false, reason: "model must be in 'provider/model' format" }
  }
  if (!MODEL_FORMAT_RE.test(model)) {
    return { valid: false, reason: "model format invalid: expected 'provider/model' with alphanumeric, dot, underscore, hyphen characters" }
  }
  return { valid: true }
}

// TTS/voice models that should not be used for coding roles
const VOICE_MODEL_PATTERNS = [/tts/i, /voice/i, /speech/i, /audio/i]

export function isVoiceModel(model: string): boolean {
  return VOICE_MODEL_PATTERNS.some((p) => p.test(model))
}

// ─── Core resolution ────────────────────────────────────────────────────────

/**
 * Resolve the effective model for a given role.
 *
 * Priority: session override > project override > global override > built-in default
 */
export function resolveRoleModel(
  role: DllRole,
  sessionID?: string,
  projectDir?: string,
): EffectiveRoleModel {
  // 1. Session override
  const sessionOverrides = loadSessionOverrides(sessionID)
  if (sessionOverrides?.[role]) {
    const cfg = sessionOverrides[role]!
    return buildEffective(role, cfg, "session")
  }

  // 2. Project override
  const projPath = projectConfigPath(projectDir)
  const projectOverrides = loadOverridesFromConfig(projPath, "project")
  if (projectOverrides?.[role]) {
    const cfg = projectOverrides[role]!
    return buildEffective(role, cfg, "project")
  }

  // 3. Global override
  const globalPath = globalConfigPath()
  const globalOverrides = loadOverridesFromConfig(globalPath, "global")
  if (globalOverrides?.[role]) {
    const cfg = globalOverrides[role]!
    return buildEffective(role, cfg, "global")
  }

  // 4. Built-in default
  const def = BUILT_IN_DEFAULTS[role]
  if (!def) {
    // Should not happen if isDllRole check passes
    return {
      role,
      primary: "",
      fallback: [],
      source: "built-in",
      enabled: false,
      onDemandOnly: false,
      parsed: { providerID: "", modelID: "" },
      providerAvailable: false,
    }
  }
  return buildEffective(role, { ...def, scope: "built-in" }, "built-in")
}

function buildEffective(
  role: DllRole,
  cfg: RoleModelConfig,
  source: OverrideScope,
): EffectiveRoleModel {
  return {
    role,
    primary: cfg.primary,
    fallback: cfg.fallback,
    source,
    enabled: cfg.enabled,
    onDemandOnly: cfg.onDemandOnly ?? false,
    parsed: parseModelString(cfg.primary),
    providerAvailable: checkProviderAvailable(cfg.primary),
  }
}

/**
 * Best-effort check if a provider is available.
 * Checks known provider keys in environment variables.
 */
function checkProviderAvailable(model: string): boolean {
  const { providerID } = parseModelString(model)
  const envKeyMap: Record<string, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    kimi: "KIMI_API_KEY",
    zai: "ZAI_API_KEY",
    mimo: "MIMO_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    qwen: "QWEN_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    gemini: "GOOGLE_API_KEY",
  }
  const envKey = envKeyMap[providerID.toLowerCase()]
  if (!envKey) return false // Unknown provider — assume available for custom/OpenAI-compat
  return !!process.env[envKey]
}

/**
 * Set a role model override at a given scope.
 *
 * - session: writes to ~/.dll-agent/sessions/<sessionID>/supervisor.json
 * - project: writes to <projectDir>/.dll-agent/role-models.jsonc
 * - global: writes to ~/.dll-agent/config/role-models.jsonc
 */
export function setRoleModelOverride(
  role: DllRole,
  model: string,
  scope: OverrideScope,
  sessionID?: string,
  projectDir?: string,
): RoleModelChange | null {
  const previous = resolveRoleModel(role, sessionID, projectDir)

  if (scope === "session" && sessionID) {
    return writeSessionOverride(role, model, sessionID, previous)
  }

  const cfgPath =
    scope === "global"
      ? globalConfigPath()
      : scope === "project" && projectDir
        ? path.join(projectDir, ".dll-agent", "role-models.jsonc")
        : null

  if (!cfgPath) return null

  return writeFileOverride(role, model, scope, cfgPath, previous)
}

function writeSessionOverride(
  role: DllRole,
  model: string,
  sessionID: string,
  previous: EffectiveRoleModel,
): RoleModelChange | null {
  const statePath = sessionOverridePath(sessionID)
  if (!statePath) return null

  try {
    let state: Record<string, unknown> = {}
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"))
    }
    const overrides: Record<string, unknown> = (state.role_model_overrides as Record<string, unknown>) ?? {}
    overrides[role] = { primary: model, fallback: [] }
    state.role_model_overrides = overrides
    state.updated_at = new Date().toISOString()

    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(redact(state), null, 2))
    fs.renameSync(tmp, statePath)
  } catch {
    return null
  }

  const change: RoleModelChange = {
    role,
    previousPrimary: previous.primary,
    newPrimary: model,
    scope: "session",
    ts: new Date().toISOString(),
  }

  writeEvidence("role-model.set", {
    role,
    previous: previous.primary,
    new: model,
    scope: "session",
    sessionID,
  })

  return change
}

function writeFileOverride(
  role: DllRole,
  model: string,
  scope: OverrideScope,
  cfgPath: string,
  previous: EffectiveRoleModel,
): RoleModelChange | null {
  try {
    let data: Record<string, unknown> = { version: 1, roles: {} }
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8")
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(?=\s*[}\]])/g, "")
      data = JSON.parse(cleaned)
    }
    const roles = (data.roles as Record<string, unknown>) ?? {}
    roles[role] = { primary: model, enabled: true }
    data.roles = roles
    data.version = 1

    const dir = path.dirname(cfgPath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${cfgPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, cfgPath)
  } catch {
    return null
  }

  const change: RoleModelChange = {
    role,
    previousPrimary: previous.primary,
    newPrimary: model,
    scope,
    ts: new Date().toISOString(),
  }

  writeEvidence("role-model.set", {
    role,
    previous: previous.primary,
    new: model,
    scope,
    file: cfgPath,
  })

  return change
}

/**
 * Reset a role model override at a given scope.
 * Resetting removes the override, falling back to the next tier.
 */
export function resetRoleModelOverride(
  role: DllRole,
  scope: OverrideScope,
  sessionID?: string,
  projectDir?: string,
): RoleModelChange | null {
  const previous = resolveRoleModel(role, sessionID, projectDir)

  if (scope === "session" && sessionID) {
    const statePath = sessionOverridePath(sessionID)
    if (!statePath) return null
    try {
      if (!fs.existsSync(statePath)) return null
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
      const overrides = (state.role_model_overrides as Record<string, unknown>) ?? {}
      if (!(role in overrides)) return null
      delete overrides[role]
      if (Object.keys(overrides).length === 0) {
        delete state.role_model_overrides
      } else {
        state.role_model_overrides = overrides
      }
      state.updated_at = new Date().toISOString()

      const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(redact(state), null, 2))
      fs.renameSync(tmp, statePath)
    } catch {
      return null
    }
  } else {
    const cfgPath =
      scope === "global"
        ? globalConfigPath()
        : scope === "project" && projectDir
          ? path.join(projectDir, ".dll-agent", "role-models.jsonc")
          : null
    if (!cfgPath || !fs.existsSync(cfgPath)) return null
    try {
      const raw = fs.readFileSync(cfgPath, "utf8")
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(?=\s*[}\]])/g, "")
      const data = JSON.parse(cleaned)
      const roles = (data.roles as Record<string, unknown>) ?? {}
      if (!(role in roles)) return null
      delete roles[role]
      if (Object.keys(roles).length === 0) {
        delete data.roles
      }
      data.version = data.version ?? 1
      const tmp = `${cfgPath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, cfgPath)
    } catch {
      return null
    }
  }

  const after = resolveRoleModel(role, sessionID, projectDir)

  const change: RoleModelChange = {
    role,
    previousPrimary: previous.primary,
    newPrimary: after.primary,
    scope,
    ts: new Date().toISOString(),
  }

  writeEvidence("role-model.reset", {
    role,
    previous: previous.primary,
    restored: after.primary,
    scope,
  })

  return change
}

/**
 * List all roles with their effective models.
 */
export function listRoleModels(
  sessionID?: string,
  projectDir?: string,
): EffectiveRoleModel[] {
  return ALL_ROLES.map((role) => resolveRoleModel(role, sessionID, projectDir))
}

/**
 * Get the default model for a role (built-in only, no overrides).
 * Used when config resolution is not available (e.g., during bootstrap).
 */
export function getDefaultModel(role: DllRole): string {
  return BUILT_IN_DEFAULTS[role]?.primary ?? ""
}

/**
 * Get the built-in default config for a role.
 */
export function getBuiltInConfig(role: DllRole): RoleModelConfig | undefined {
  const def = BUILT_IN_DEFAULTS[role]
  if (!def) return undefined
  return { ...def, scope: "built-in" }
}

// ─── Fallback resolution ────────────────────────────────────────────────────

/**
 * Resolve the first available fallback model for a role.
 * If the primary is unavailable, try fallback chain in order.
 * Returns the primary if no fallback is available or if primary is available.
 */
export function resolveAvailableModel(
  role: DllRole,
  sessionID?: string,
  projectDir?: string,
): { model: string; usedFallback: boolean } {
  const effective = resolveRoleModel(role, sessionID, projectDir)
  if (effective.providerAvailable) {
    return { model: effective.primary, usedFallback: false }
  }
  // Try fallback chain
  for (const fb of effective.fallback) {
    if (checkProviderAvailable(fb)) {
      writeEvidence("role-model.fallback_used", {
        role,
        primary: effective.primary,
        fallback: fb,
      })
      return { model: fb, usedFallback: true }
    }
  }
  // No fallback available — return primary anyway (caller should handle)
  writeEvidence("role-model.fallback_exhausted", {
    role,
    primary: effective.primary,
    fallback_chain: effective.fallback,
  })
  return { model: effective.primary, usedFallback: false }
}

// ─── Doctor helpers ─────────────────────────────────────────────────────────

export interface RoleModelDoctorIssue {
  role: DllRole
  severity: "WARN" | "FAIL"
  message: string
}

/**
 * Check all role models for common issues:
 * - Hardcoded model residues (roles using deprecated models)
 * - Provider key missing
 * - Voice/TTS models assigned to coding roles
 * - Config conflicts (same role defined in multiple scopes)
 */
export function doctorCheck(
  sessionID?: string,
  projectDir?: string,
): RoleModelDoctorIssue[] {
  const issues: RoleModelDoctorIssue[] = []
  const codingRoles: DllRole[] = [
    "commander",
    "chief-engineer",
    "agentic-solver",
  ]

  for (const role of ACTIVE_ROLES) {
    const effective = resolveRoleModel(role, sessionID, projectDir)

    // Check provider availability
    if (!effective.providerAvailable) {
      issues.push({
        role,
        severity: "WARN",
        message: `provider key not found for model '${effective.primary}' (source: ${effective.source})`,
      })
    }

    // Check voice/TTS model on coding role
    if (codingRoles.includes(role) && isVoiceModel(effective.primary)) {
      issues.push({
        role,
        severity: "FAIL",
        message: `voice/TTS model '${effective.primary}' cannot be assigned to coding role '${role}'`,
      })
    }

    // Check if model string is valid
    const validation = validateRoleModel(effective.primary)
    if (!validation.valid) {
      issues.push({
        role,
        severity: "FAIL",
        message: `invalid model format for role '${role}': ${validation.reason}`,
      })
    }
  }

  // Check for config conflicts (same role in multiple override files)
  const globalPath = globalConfigPath()
  const projPath = projectConfigPath(projectDir)
  if (globalPath && projPath && fs.existsSync(globalPath) && fs.existsSync(projPath)) {
    const globalCfg = loadJsoncFile(globalPath)
    const projCfg = loadJsoncFile(projPath)
    const globalRoles = Object.keys((globalCfg?.roles as Record<string, unknown>) ?? {})
    const projRoles = Object.keys((projCfg?.roles as Record<string, unknown>) ?? {})
    const overlap = globalRoles.filter((r) => projRoles.includes(r))
    for (const r of overlap) {
      if (isDllRole(r)) {
        issues.push({
          role: r,
          severity: "WARN",
          message: `role '${r}' has both global and project overrides (project wins)`,
        })
      }
    }
  }

  return issues
}
