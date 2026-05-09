/**
 * Direct capability status renderer for /capability-status and doctor.
 *
 * This is intentionally not a prompt template. It reads the actual merged
 * registry, resolver decisions, and runtime state and returns a compact report.
 */

import { GLOBAL_DEFAULT_TOOLS } from "./tool-catalog"
import { SKILL_REGISTRY } from "./skill-registry"
import { mapAllBuiltins } from "./capability-mapping"
import { buildEffectiveCapabilityManifest, getFullRegistry, snapshot, type EffectiveCapabilityManifest } from "./capability-registry"
import { resolveAll } from "./capability-resolver"
import { runtimeSummary } from "./capability-lifecycle"
import { orchestrateCapabilities } from "./capability-orchestrator"
import { buildTaskSidebarLines } from "./task-state"
import { buildLspPrewarmTargets, computeLspBridgePlan } from "./lsp-bridge"

export interface CapabilityStatusReport {
  generated_at: string
  projectDir: string
  total: number
  by_kind: Record<string, number>
  by_status: Record<string, number>
  available: string[]
  running: string[]
  missing: string[]
  blocked: string[]
  pending_permission: string[]
  runtime_states: Record<string, string>
  effective_status: EffectiveCapabilityManifest["effective_status"]
  effective_by_status: Record<string, number>
  lsp: {
    main_language: string
    prewarm_count: number
    lazy_count: number
    target_count: number
  }
}

export interface CapabilitySidebarStatus {
  generated_at: string
  lines: string[]
  has_attention: boolean
}

export interface CapabilitySidebarOptions {
  userGoal?: string
  sessionID?: string
}

function ids(entries: { id: string }[], max = 12): string[] {
  return entries.map((entry) => entry.id).slice(0, max)
}

export function buildCapabilityStatusReport(projectDir: string): CapabilityStatusReport {
  const builtins = mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY)
  const registry = getFullRegistry(builtins, projectDir)
  const manifest = buildEffectiveCapabilityManifest({ builtin: builtins, projectDir, recordEvidence: false })
  const snap = snapshot(registry.entries)
  const resolver = resolveAll(registry.entries)
  const runtime = runtimeSummary(registry.entries)
  const lspPlan = computeLspBridgePlan(projectDir)
  const lspTargets = buildLspPrewarmTargets(lspPlan)
  const runtimeStates = Object.fromEntries(
    Object.entries(runtime)
      .filter(([, state]) => state.status !== "idle")
      .map(([id, state]) => [id, state.status]),
  )

  return {
    generated_at: new Date().toISOString(),
    projectDir,
    total: registry.entries.length,
    by_kind: snap.by_kind,
    by_status: snap.by_status,
    available: ids(registry.entries.filter((entry) => entry.status === "available")),
    running: ids(registry.entries.filter((entry) => entry.status === "running")),
    missing: ids(registry.entries.filter((entry) => entry.status === "missing_dependency")),
    blocked: ids(registry.entries.filter((entry) => entry.status === "blocked" || entry.status === "failed")),
    pending_permission: resolver.decisions
      .filter((decision) => decision.action === "ask_permission" || decision.requires_user_consent)
      .map((decision) => decision.entry_id)
      .slice(0, 12),
    runtime_states: runtimeStates,
    effective_status: manifest.effective_status,
    effective_by_status: manifest.by_status,
    lsp: {
      main_language: lspPlan.mainLanguage,
      prewarm_count: lspPlan.prewarm.length,
      lazy_count: lspPlan.lazy.length,
      target_count: lspTargets.length,
    },
  }
}

export function buildCapabilityPromptIndex(
  manifest: Pick<EffectiveCapabilityManifest, "entries" | "effective_status">,
  maxChars = 1_200,
): string {
  const rows = manifest.entries
    .map((entry) => `${entry.id}:${entry.kind}:${manifest.effective_status[entry.id] ?? entry.status}`)
    .slice(0, 40)
  const text = `[dll-agent capabilities ${rows.join(", ")}]`
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

function countLine(label: string, counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
  return `${label}: ${parts.join(", ") || "none"}`
}

function truncateText(value: string, max = 72): string {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + "…"
}

function shortIds(values: string[], max = 3): string {
  if (values.length === 0) return "none"
  const shown = values.slice(0, max)
  const suffix = values.length > max ? ` +${values.length - max}` : ""
  return `${shown.join(", ")}${suffix}`
}

export function buildCapabilitySidebarStatus(
  projectDir: string,
  maxLineLength = 72,
  options: CapabilitySidebarOptions = {},
): CapabilitySidebarStatus {
  const report = buildCapabilityStatusReport(projectDir)
  const byStatus = report.by_status
  const runtime = Object.entries(report.runtime_states)
  const available = byStatus.available ?? report.available.length
  const running = (byStatus.running ?? report.running.length) + runtime.length
  const missing = byStatus.missing_dependency ?? report.missing.length
  const blocked = (byStatus.blocked ?? 0) + (byStatus.failed ?? 0)
  const onDemandPermission = report.pending_permission.length
  const mcp = report.by_kind.mcp ?? 0
  const skills = report.by_kind.skill ?? 0
  const tools = report.by_kind.tool ?? 0
  const taskGoal = options.userGoal?.trim()
  const task = taskGoal
    ? orchestrateCapabilities({
        projectDir,
        userGoal: taskGoal,
        allowMcpAutoConnect: true,
        allowMutatingActions: false,
        recordEvidence: false,
        performCleanup: false,
      })
    : undefined
  const selected = task?.plan.selected.map((m) => m.entry.id) ?? []
  const autoMcp = task?.mcpRequests.filter((request) => request.auto_connect).map((request) => request.entry_id) ?? []
  const autoMcpSet = new Set(autoMcp)
  const taskPermission = task?.actions
    .filter((action) => action.type === "ask_permission" && !autoMcpSet.has(action.entry_id))
    .map((action) => action.entry_id) ?? []
  const hasAttention = missing > 0 || blocked > 0 || taskPermission.length > 0
  const taskLines = options.sessionID
    ? buildTaskSidebarLines({ sessionID: options.sessionID, projectDir, maxLineLength })
    : []
  const lines = [
    `registered ${report.total} · tools ${tools} · skills ${skills} · mcp ${mcp}`,
    selected.length > 0
      ? `task selected ${shortIds(selected, 4)}`
      : `ready ${available} · running ${running} · on-demand ${onDemandPermission}`,
    ...taskLines.slice(0, 2),
  ]

  if (hasAttention) {
    const attention = [
      taskPermission.length > 0 ? `task permission ${shortIds(taskPermission)}` : "",
      missing > 0 ? `missing ${shortIds(report.missing)}` : "",
      blocked > 0 ? `blocked ${shortIds(report.blocked)}` : "",
    ].filter(Boolean).join(" · ")
    lines.push(attention)
  } else if (autoMcp.length > 0) {
    lines.push(`mcp auto ${shortIds(autoMcp, 4)}`)
  }

  if (runtime.length > 0) {
    lines.push(`runtime ${shortIds(runtime.map(([id, status]) => `${id}=${status}`), 4)}`)
  } else {
    lines.push("runtime idle/on-demand")
  }

  return {
    generated_at: report.generated_at,
    lines: lines.map((line) => truncateText(line, maxLineLength)).slice(0, 5),
    has_attention: hasAttention || taskLines.some((line) => line.includes("blocked") || line.includes("blocker")),
  }
}

export function renderCapabilityStatus(projectDir: string): string {
  const report = buildCapabilityStatusReport(projectDir)
  const lines = [
    "dll-agent capability status",
    `project: ${report.projectDir}`,
    `updated: ${report.generated_at}`,
    `total: ${report.total}`,
    countLine("by kind", report.by_kind),
    countLine("by status", report.by_status),
    countLine("effective status", report.effective_by_status),
    `available: ${report.available.join(", ") || "none"}`,
    `running: ${report.running.join(", ") || "none"}`,
    `missing: ${report.missing.join(", ") || "none"}`,
    `blocked: ${report.blocked.join(", ") || "none"}`,
    `needs permission: ${report.pending_permission.join(", ") || "none"}`,
    `lsp: main=${report.lsp.main_language} prewarm=${report.lsp.prewarm_count} lazy=${report.lsp.lazy_count} targets=${report.lsp.target_count}`,
  ]
  const runtime = Object.entries(report.runtime_states)
  if (runtime.length > 0) {
    lines.push(`runtime: ${runtime.map(([id, status]) => `${id}=${status}`).join(", ")}`)
  } else {
    lines.push("runtime: no non-idle capability runtime states")
  }
  return lines.join("\n")
}
