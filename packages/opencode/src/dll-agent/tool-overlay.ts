/**
 * dll-agent Tool Overlay
 *
 * 项目级工具叠加清单的加载与 merge 逻辑。
 *
 * 支持的文件路径（按优先级）：
 *   1. <project>/.dll-agent/tools.jsonc
 *   2. <project>/dll-agent.tools.jsonc
 *
 * Merge 规则：
 *   1. 内置安全 denylist 最高（不可移除）
 *   2. project remove 高于 global default
 *   3. project override 高于 global 同名 MCP
 *   4. project add 追加能力
 *   5. global default 提供基础能力
 *   6. 未声明能力不自动启用
 *
 * 所有 merge 结果写入 evidence 且脱敏。
 */

import fs from "fs"
import path from "path"
import { write as writeEvidence } from "./evidence"
import { redact } from "./evidence"
import {
  type ToolEntry,
  type ToolManifest,
  type McpStartPolicy,
  GLOBAL_DEFAULT_TOOLS,
  DEFAULT_MANIFEST,
  findTool,
} from "./tool-catalog"

// ─── Project Overlay Schema ───────────────────────────────────────────────────

export interface ProjectToolOverlay {
  version: 1
  /** 项目名（可选，用于 evidence 标记） */
  project?: string
  skills: {
    add?: string[]
    remove?: string[]
  }
  tools: {
    add?: ToolEntry[]
    remove?: string[]
  }
  mcp: {
    add?: ToolEntry[]
    remove?: string[]
    /** 覆盖同名的 MCP 配置（project override） */
    override?: Record<string, Partial<ToolEntry["mcp"]>>
  }
  commands: {
    add?: string[]
    remove?: string[]
  }
  prompt?: {
    /** 追加到 prompt index 的内容 */
    add_index?: string[]
  }
  security?: {
    /** 项目额外的禁止命令 */
    extra_deny_commands?: string[]
  }
}

export interface EffectiveManifest {
  version: 1
  source: "global" | "merged"
  project?: string
  /** 有效的工具清单 */
  tools: ToolEntry[]
  /** 每个工具的状态 */
  tool_status: Record<string, ToolStatus>
  /** merge 来源标记 */
  merge_source: Record<string, "global_default" | "project_add" | "project_override">
  /** prompt 配置 */
  prompt: ToolManifest["prompt"]
  /** 安全配置 */
  security: ToolManifest["security"] & { extra_deny_commands?: string[] }
  /** 启动策略 */
  startup: ToolManifest["startup"]
  features: ToolManifest["features"]
  /** merge 时间 */
  merged_at: string
}

export type ToolStatus =
  | "registered"        // 已注册
  | "available"         // 可用
  | "unavailable"       // 不可用（缺少依赖）
  | "active"            // 已激活
  | "running"           // MCP 运行中
  | "failed"            // 失败
  | "disabled_by_project"  // 被项目 remove
  | "blocked_by_policy"    // 被安全策略阻止
  | "requires_consent"     // 需要用户确认

// ─── Project Overlay Loader ───────────────────────────────────────────────────

/**
 * 从项目目录加载 overlay 文件。
 * 按优先级尝试 .dll-agent/tools.jsonc → dll-agent.tools.jsonc。
 */
export function loadProjectOverlay(projectDir: string): ProjectToolOverlay | null {
  const candidates = [
    path.join(projectDir, ".dll-agent", "tools.jsonc"),
    path.join(projectDir, "dll-agent.tools.jsonc"),
  ]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8")
        const stripped = stripJsonComments(raw)
        const parsed = JSON.parse(stripped)
        if (parsed.version === 1) {
          writeEvidence("tool_catalog.overlay_loaded", {
            file,
            project: parsed.project ?? projectDir,
            tool_count: (parsed.tools?.add?.length ?? 0) + (parsed.mcp?.add?.length ?? 0),
          })
          return parsed as ProjectToolOverlay
        }
      }
    } catch (err: any) {
      writeEvidence("tool_catalog.overlay_error", {
        file,
        error: err?.message ?? String(err),
      })
    }
  }
  return null
}

/**
 * 简单的 JSONC comment strip。移除 // 和块注释。
 */
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/.*$/gm, "")            // line comments
    .replace(/^\s*[\r\n]/gm, "")         // blank lines
}

// ─── Merge Logic ──────────────────────────────────────────────────────────────

/**
 * 将 global default manifest 与 project overlay 合并为 effective manifest。
 *
 * 优先级（从高到低）：
 *   1. 安全 denylist（不可移除的安全策略）
 *   2. project remove（明确移除的条目）
 *   3. project override（覆盖同名 MCP 配置）
 *   4. project add（追加的新条目）
 *   5. global default（基础能力）
 */
export function buildEffectiveManifest(
  globalTools: ToolEntry[],
  globalManifest: ToolManifest,
  overlay: ProjectToolOverlay | null,
  projectDir?: string,
): EffectiveManifest {
  const mergeSource: Record<string, "global_default" | "project_add" | "project_override"> = {}
  const toolStatus: Record<string, ToolStatus> = {}

  // Start with global tools
  const toolMap = new Map<string, ToolEntry>()
  for (const t of globalTools) {
    toolMap.set(t.id, { ...t, mcp: t.mcp ? { ...t.mcp } : undefined })
    mergeSource[t.id] = "global_default"
    toolStatus[t.id] = "registered"
  }

  // Build remove set
  const removeSet = new Set<string>()

  if (overlay) {
    for (const id of overlay.skills?.remove ?? []) removeSet.add(id)
    for (const id of overlay.tools?.remove ?? []) removeSet.add(id)
    for (const id of overlay.mcp?.remove ?? []) removeSet.add(id)
    for (const id of overlay.commands?.remove ?? []) removeSet.add(id)
  }

  // Security denylist — force keep security-redaction
  const SECURITY_DENYLIST = new Set(["security-redaction", "test-gate"])

  // Apply removes (except security denylist)
  for (const id of removeSet) {
    if (SECURITY_DENYLIST.has(id)) {
      toolStatus[id] = "blocked_by_policy"
      continue
    }
    toolMap.delete(id)
    delete mergeSource[id]
    toolStatus[id] = "disabled_by_project"
  }

  // Apply project adds
  if (overlay) {
    for (const t of overlay.tools?.add ?? []) {
      toolMap.set(t.id, { ...t, mcp: t.mcp ? { ...t.mcp } : undefined })
      mergeSource[t.id] = "project_add"
      toolStatus[t.id] = "registered"
    }
    for (const t of overlay.mcp?.add ?? []) {
      toolMap.set(t.id, { ...t, mcp: t.mcp ? { ...t.mcp } : undefined })
      mergeSource[t.id] = "project_add"
      toolStatus[t.id] = "registered"
    }
  }

  // Apply MCP overrides
  if (overlay?.mcp?.override) {
    for (const [name, overrideConfig] of Object.entries(overlay.mcp.override)) {
      const existing = toolMap.get(name)
      if (existing && existing.mcp) {
        existing.mcp = { ...existing.mcp, ...overrideConfig }
        mergeSource[name] = "project_override"
        toolStatus[name] = "registered"
      }
    }
  }

  // Build security config
  const security = {
    ...globalManifest.security,
    extra_deny_commands: [
      ...(globalManifest.security.deny_commands ?? []),
      ...(overlay?.security?.extra_deny_commands ?? []),
    ],
  }

  const result: EffectiveManifest = {
    version: 1,
    source: overlay ? "merged" : "global",
    project: overlay?.project ?? projectDir,
    tools: Array.from(toolMap.values()),
    tool_status: toolStatus,
    merge_source: mergeSource,
    prompt: globalManifest.prompt,
    security,
    startup: globalManifest.startup,
    features: globalManifest.features,
    merged_at: new Date().toISOString(),
  }

  // Write evidence (redacted)
  writeEvidence("tool_catalog.merged", {
    source: result.source,
    project: result.project,
    tool_count: result.tools.length,
    tool_ids: result.tools.map((t) => t.id),
    remove_count: removeSet.size,
    removed_ids: [...removeSet],
  })

  return result
}

/**
 * 从 global default manifest 构建 effective manifest（无 project overlay）。
 */
export function buildGlobalEffective(): EffectiveManifest {
  return buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, null)
}

// ─── Derive Status ────────────────────────────────────────────────────────────

/**
 * 推断 MCP tools 的可用性状态。
 * 检查依赖（binary、token、port）是否存在。
 */
export function deriveToolAvailability(tool: ToolEntry): ToolStatus {
  // Check MCP-specific conditions
  if (tool.kind === "mcp" && tool.mcp) {
    if (tool.mcp.start_policy === "disabled") return "unavailable"
    if (tool.mcp.requires_consent) return "requires_consent"
  }
  // Check requirements
  if (tool.requirements?.binaries?.length) {
    for (const bin of tool.requirements.binaries) {
      // Simple PATH check (best-effort, don't fail)
      const paths = (process.env.PATH ?? "").split(path.delimiter)
      const found = paths.some((p) => {
        try { return fs.existsSync(path.join(p, bin)) } catch { return false }
      })
      if (!found && bin !== "npx") return "unavailable" // npx is often bundled with node
    }
  }
  // Check tokens (without revealing them)
  if (tool.requirements?.tokens?.length) {
    for (const token of tool.requirements.tokens) {
      if (!process.env[token]) return "unavailable"
    }
  }
  return "available"
}

/**
 * 更新 effective manifest 中所有 tool 的可用性状态。
 * 仅对 status 为 "registered" 的 entry 进行更新。
 */
export function refreshAvailability(manifest: EffectiveManifest): EffectiveManifest {
  for (const [id, status] of Object.entries(manifest.tool_status)) {
    if (status === "registered" || status === "available" || status === "unavailable") {
      const tool = findTool(id, manifest.tools)
      if (tool) {
        manifest.tool_status[id] = deriveToolAvailability(tool)
      }
    }
  }
  return manifest
}

// ─── Session State ────────────────────────────────────────────────────────────

import os from "os"

const SESSION_STATE_DIR = path.join(os.homedir(), ".dll-agent", "sessions")
const EFFECTIVE_MANIFEST_FILE = "effective-tools.json"

/**
 * 将 effective manifest 写入 session state。
 */
export function writeSessionEffective(sessionId: string, manifest: EffectiveManifest) {
  try {
    const dir = path.join(SESSION_STATE_DIR, sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, EFFECTIVE_MANIFEST_FILE)
    // Redact before writing
    const redacted = JSON.parse(JSON.stringify(manifest))
    // Don't serialize RegExp
    redacted.tools = redacted.tools?.map((t: any) => ({
      ...t,
      triggers: t.triggers ? { ...t.triggers, keywords: t.triggers.keywords?.map((r: RegExp) => r.source) } : undefined,
    }))
    fs.writeFileSync(file, JSON.stringify(redact(redacted), null, 2))
    writeEvidence("tool_catalog.session_written", { session_id: sessionId })
  } catch (err: any) {
    writeEvidence("tool_catalog.session_write_error", {
      session_id: sessionId,
      error: err?.message ?? String(err),
    })
  }
}

/**
 * 从 session state 读取 effective manifest。
 */
export function readSessionEffective(sessionId: string): EffectiveManifest | null {
  try {
    const file = path.join(SESSION_STATE_DIR, sessionId, EFFECTIVE_MANIFEST_FILE)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
