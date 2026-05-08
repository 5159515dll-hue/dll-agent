/**
 * dll-agent Capability Registry
 *
 * 本地权威能力注册表。运行时所有能力决策只依赖此注册表，
 * 不直接依赖网络猜测。注册表是多层融合后的统一真相来源。
 *
 * 层级体系（优先级从低到高）：
 *   layer 0: builtin      — 仓库内建声明（tool-catalog + skill-registry）
 *   layer 1: global       — ~/.dll-agent/capabilities/registry.json
 *   layer 2: discovered   — ~/.dll-agent/capabilities/discovered.json
 *   layer 3: project      — <project>/.dll-agent/capabilities.json
 *
 * 核心规则：
 *   1. 高层覆盖低层同 ID 条目
 *   2. project 层可 remove 低层条目
 *   3. 新发现能力先进入 discovered 层
 *   4. 通过验证后升级为 active/available
 *   5. doc-summary 来源不能直接进入高信任层
 *   6. 所有 merge 操作记录 evidence
 */

import fs from "fs"
import path from "path"
import os from "os"
import type { CapabilityEntry, CapabilityStatus, Platform } from "./capability-schema"
import { validateCapabilityEntry, type SchemaValidationResult } from "./capability-schema"

// ─── Registry Types ────────────────────────────────────────────────────────────

export type RegistryLayer = "builtin" | "global" | "discovered" | "project"

export interface RegistrySnapshot {
  /** 合并后的全量条目 */
  entries: CapabilityEntry[]
  /** 每个条目的来源层 */
  layer: Record<string, RegistryLayer>
  /** 条目数量 */
  total: number
  /** 按状态分组 */
  by_status: Record<CapabilityStatus, number>
  /** 按 kind 分组 */
  by_kind: Record<string, number>
  /** 快照时间 */
  timestamp: string
}

export interface RegistryMergeResult {
  /** 合并后的条目 */
  entries: CapabilityEntry[]
  /** 各层条目数 */
  layer_counts: Record<RegistryLayer, number>
  /** 被覆盖的条目 ID */
  overridden: string[]
  /** 被移除的条目 ID */
  removed: string[]
  /** 被去重的条目 ID */
  deduplicated: string[]
  /** 时间戳 */
  timestamp: string
}

export interface RegistryFilter {
  /** 仅保留这些平台 */
  platforms?: Platform[]
  /** 仅保留这些 kind */
  kinds?: string[]
  /** 排除这些风险级别 */
  exclude_risks?: string[]
  /** 仅保留这些状态 */
  statuses?: string[]
  /** 最低置信度 */
  min_confidence?: number
}

// ─── Storage Paths ─────────────────────────────────────────────────────────────

const DLL_DIR = path.join(os.homedir(), ".dll-agent")
const CAPABILITIES_DIR = path.join(DLL_DIR, "capabilities")

function globalRegistryPath(): string {
  return path.join(CAPABILITIES_DIR, "registry.json")
}

function discoveredRegistryPath(): string {
  return path.join(CAPABILITIES_DIR, "discovered.json")
}

function projectRegistryPath(projectDir: string): string {
  return path.join(projectDir, ".dll-agent", "capabilities.json")
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

// ─── I/O ────────────────────────────────────────────────────────────────────────

function readJsonFile<T>(filepath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filepath)) return fallback
    return JSON.parse(fs.readFileSync(filepath, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(filepath: string, data: unknown) {
  try {
    ensureDir(path.dirname(filepath))
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2))
  } catch {
    // Best-effort
  }
}

// ─── Layer I/O ──────────────────────────────────────────────────────────────────

export function loadGlobalRegistry(): CapabilityEntry[] {
  const data = readJsonFile<{ entries?: CapabilityEntry[] }>(globalRegistryPath(), {})
  return Array.isArray(data.entries) ? data.entries : []
}

export function saveGlobalRegistry(entries: CapabilityEntry[]) {
  writeJsonFile(globalRegistryPath(), {
    entries,
    updated_at: new Date().toISOString(),
  })
}

export function loadDiscoveredRegistry(): CapabilityEntry[] {
  const data = readJsonFile<{ entries?: CapabilityEntry[] }>(discoveredRegistryPath(), {})
  return Array.isArray(data.entries) ? data.entries : []
}

export function saveDiscoveredRegistry(entries: CapabilityEntry[]) {
  writeJsonFile(discoveredRegistryPath(), {
    entries,
    updated_at: new Date().toISOString(),
  })
}

export function loadProjectRegistry(projectDir: string): CapabilityEntry[] {
  const data = readJsonFile<{ entries?: CapabilityEntry[]; removed?: string[] }>(
    projectRegistryPath(projectDir),
    {},
  )
  return Array.isArray(data.entries) ? data.entries : []
}

export function saveProjectRegistry(projectDir: string, entries: CapabilityEntry[]) {
  writeJsonFile(projectRegistryPath(projectDir), {
    entries,
    updated_at: new Date().toISOString(),
  })
}

// ─── Merge Logic ────────────────────────────────────────────────────────────────

/**
 * Merge all layers into a single authoritative entry list.
 *
 * Precedence (highest wins):
 *   project > discovered > global > builtin
 *
 * Project layer can explicitly remove entries from lower layers
 * via a "removed" list stored in the project capabilities file.
 */
export function mergeLayers(
  builtin: CapabilityEntry[],
  global: CapabilityEntry[],
  discovered: CapabilityEntry[],
  project: CapabilityEntry[],
  projectRemovals?: string[],
): RegistryMergeResult {
  const map = new Map<string, { entry: CapabilityEntry; layer: RegistryLayer }>()
  const overridden: string[] = []
  const removed = new Set(projectRemovals ?? [])
  const deduplicated: string[] = []

  function insert(entries: CapabilityEntry[], layer: RegistryLayer) {
    for (const entry of entries) {
      if (removed.has(entry.id)) {
        removed.delete(entry.id)
        continue
      }
      const existing = map.get(entry.id)
      if (existing) {
        // Higher layer overwrites lower layer
        const layerOrder: Record<RegistryLayer, number> = {
          builtin: 0,
          global: 1,
          discovered: 2,
          project: 3,
        }
        if (layerOrder[layer] > layerOrder[existing.layer]) {
          map.set(entry.id, { entry, layer })
          overridden.push(entry.id)
        }
      } else {
        map.set(entry.id, { entry, layer })
      }
    }
  }

  insert(builtin, "builtin")
  insert(global, "global")
  insert(discovered, "discovered")
  insert(project, "project")

  const entries = Array.from(map.values()).map((v) => ({
    ...v.entry,
    // Enrich with layer metadata (not persisted)
  }))

  const layer_counts: Record<RegistryLayer, number> = { builtin: 0, global: 0, discovered: 0, project: 0 }
  for (const [, v] of map) layer_counts[v.layer]++

  return {
    entries,
    layer_counts,
    overridden,
    removed: [...projectRemovals ?? []],
    deduplicated,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Get the full merged registry for the current session.
 */
export function getFullRegistry(
  builtin: CapabilityEntry[],
  projectDir?: string,
): RegistryMergeResult {
  const global = loadGlobalRegistry()
  const discovered = loadDiscoveredRegistry()
  const project = projectDir ? loadProjectRegistry(projectDir) : []
  const projectRemovals = projectDir
    ? readJsonFile<{ removed?: string[] }>(projectRegistryPath(projectDir), {}).removed
    : undefined

  return mergeLayers(builtin, global, discovered, project, projectRemovals)
}

// ─── Discovery Promotion ────────────────────────────────────────────────────────

/**
 * Add a discovered capability to the discovered layer.
 * Low-confidence entries (doc-summary) get confidence capped at 0.5.
 */
export function addDiscovered(entry: CapabilityEntry): CapabilityEntry {
  const entries = loadDiscoveredRegistry()

  // Cap confidence for untrusted sources
  if (entry.source_type === "doc-summary" && entry.confidence > 0.5) {
    entry.confidence = 0.5
  }

  // Update or append
  const idx = entries.findIndex((e) => e.id === entry.id)
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry, registered_at: entries[idx].registered_at }
  } else {
    entries.push(entry)
  }

  saveDiscoveredRegistry(entries)
  return entry
}

/**
 * Promote a discovered capability to the global registry after verification.
 * Only entries with source_type != "doc-summary" and confidence >= 0.7 can be promoted.
 */
export function promoteDiscovered(id: string): CapabilityEntry | null {
  const discovered = loadDiscoveredRegistry()
  const idx = discovered.findIndex((e) => e.id === id)
  if (idx < 0) return null

  const entry = discovered[idx]
  if (entry.source_type === "doc-summary") return null // Never auto-promote doc summaries
  if (entry.confidence < 0.7) return null

  // Verify schema before promotion
  const validation = validateCapabilityEntry(entry)
  if (!validation.valid) return null

  // Move to global registry
  const global = loadGlobalRegistry()
  const gIdx = global.findIndex((e) => e.id === id)
  const promoted = {
    ...entry,
    source_type: "discovered" as const,
    status: "available" as const,
    last_verified_at: new Date().toISOString(),
  }

  if (gIdx >= 0) {
    global[gIdx] = promoted
  } else {
    global.push(promoted)
  }

  saveGlobalRegistry(global)

  // Remove from discovered
  discovered.splice(idx, 1)
  saveDiscoveredRegistry(discovered)

  return promoted
}

/**
 * Downgrade or invalidate a capability entry.
 */
export function invalidateCapability(
  id: string,
  reason: string,
  layer: "global" | "discovered" = "global",
): boolean {
  if (layer === "global") {
    const entries = loadGlobalRegistry()
    const idx = entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    entries[idx].status = "failed"
    entries[idx].evidence = {
      ...entries[idx].evidence,
      verification_result: "failed",
      verification_output: reason,
    }
    saveGlobalRegistry(entries)
    return true
  }

  const entries = loadDiscoveredRegistry()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return false
  entries[idx].status = "failed"
  entries[idx].evidence = {
    ...entries[idx].evidence,
    verification_result: "failed",
    verification_output: reason,
  }
  saveDiscoveredRegistry(entries)
  return true
}

// ─── Project Operations ────────────────────────────────────────────────────────

/**
 * Add or override a capability at the project level.
 */
export function projectAdd(projectDir: string, entry: CapabilityEntry) {
  const entries = loadProjectRegistry(projectDir)
  const idx = entries.findIndex((e) => e.id === entry.id)
  if (idx >= 0) {
    entries[idx] = entry
  } else {
    entries.push(entry)
  }
  saveProjectRegistry(projectDir, entries)
}

/**
 * Remove a capability in the project context.
 * Lower-layer entries with the same ID will be excluded from the merged registry.
 */
export function projectRemove(projectDir: string, id: string) {
  const filepath = projectRegistryPath(projectDir)
  const data = readJsonFile<{ entries?: CapabilityEntry[]; removed?: string[] }>(filepath, {})
  data.removed = [...(data.removed ?? []), id]
  writeJsonFile(filepath, data)
}

// ─── Query & Filter ─────────────────────────────────────────────────────────────

/**
 * Filter the merged registry by criteria.
 */
export function filterRegistry(
  entries: CapabilityEntry[],
  filter?: RegistryFilter,
): CapabilityEntry[] {
  if (!filter) return entries

  return entries.filter((e) => {
    if (filter.platforms && filter.platforms.length > 0) {
      const hasMatch = e.platforms.some((p) =>
        p === "any" || filter.platforms!.includes(p),
      )
      if (!hasMatch) return false
    }
    if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(e.kind)) {
      return false
    }
    if (filter.exclude_risks && filter.exclude_risks.length > 0 && filter.exclude_risks.includes(e.risk_level)) {
      return false
    }
    if (filter.statuses && filter.statuses.length > 0 && !filter.statuses.includes(e.status)) {
      return false
    }
    if (filter.min_confidence !== undefined && e.confidence < filter.min_confidence) {
      return false
    }
    return true
  })
}

/**
 * Find capabilities by semantic capability tags.
 */
export function findByCapability(
  entries: CapabilityEntry[],
  tag: string,
): CapabilityEntry[] {
  return entries.filter((e) => e.capabilities.includes(tag))
}

/**
 * Find capabilities by ID prefix or exact match.
 */
export function findById(
  entries: CapabilityEntry[],
  id: string,
): CapabilityEntry | undefined {
  return entries.find((e) => e.id === id)
}

/**
 * Create a snapshot of the registry state.
 */
export function snapshot(entries: CapabilityEntry[]): RegistrySnapshot {
  const by_status: Record<string, number> = {}
  const by_kind: Record<string, number> = {}

  for (const e of entries) {
    by_status[e.status] = (by_status[e.status] ?? 0) + 1
    by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1
  }

  return {
    entries,
    layer: {}, // filled by mergeLayers
    total: entries.length,
    by_status: by_status as Record<CapabilityStatus, number>,
    by_kind,
    timestamp: new Date().toISOString(),
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate all entries in a registry layer and return gaps.
 */
export function validateLayer(
  entries: CapabilityEntry[],
): { total: number; valid: number; gaps: SchemaValidationResult[] } {
  const gaps: SchemaValidationResult[] = []
  let valid = 0
  for (const e of entries) {
    const result = validateCapabilityEntry(e)
    if (result.valid) valid++
    else gaps.push(result)
  }
  return { total: entries.length, valid, gaps }
}

/**
 * Check for stale entries (not verified in > TTL).
 */
export function findStaleEntries(
  entries: CapabilityEntry[],
  ttlHours = 168, // 1 week
): CapabilityEntry[] {
  const cutoff = Date.now() - ttlHours * 3600 * 1000
  return entries.filter((e) => {
    if (!e.last_verified_at) return true // Never verified = stale
    return new Date(e.last_verified_at).getTime() < cutoff
  })
}
