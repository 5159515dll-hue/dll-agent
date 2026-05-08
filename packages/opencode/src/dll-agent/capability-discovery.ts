/**
 * dll-agent Capability Discovery
 *
 * 自动发现本地环境中的可用能力，标准化后写入 registry。
 * Discovery 结果不直接驱动执行——必须通过 registry 的 merge 和验证层。
 *
 * 发现来源（按优先级）：
 *   1. 本地内建声明（builtin）
 *   2. 项目 manifest（package.json, pyproject.toml 等）
 *   3. skill 元数据 / SKILL.md
 *   4. MCP server manifest
 *   5. 本地已安装命令（which, npm ls, pip show, bun pm）
 *   6. 官方文档摘要（低置信度，仅写缓存）
 *
 * 关键约束：
 *   - 不能每轮全量跑 → TTL/cooldown/cache
 *   - 只在缺能力/新项目/doctor检查/用户升级时触发
 */

import fs from "fs"
import path from "path"
import os from "os"
import { execSync } from "child_process"
import type { CapabilityEntry, CapabilitySourceType } from "./capability-schema"
import { createMinimalEntry } from "./capability-schema"
import { addDiscovered } from "./capability-registry"

// ─── Cache & TTL ────────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(os.homedir(), ".dll-agent", "capabilities")
const DISCOVERY_CACHE_FILE = "discovery-cache.json"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface DiscoveryCache {
  last_run_at: string
  results: { id: string; source_type: CapabilitySourceType; found_at: string }[]
}

function loadCache(): DiscoveryCache | null {
  try {
    const fp = path.join(CACHE_DIR, DISCOVERY_CACHE_FILE)
    if (!fs.existsSync(fp)) return null
    const data = JSON.parse(fs.readFileSync(fp, "utf8"))
    const age = Date.now() - new Date(data.last_run_at).getTime()
    if (age > DEFAULT_TTL_MS) return null // Stale
    return data
  } catch {
    return null
  }
}

function saveCache(results: DiscoveryCache["results"]) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(CACHE_DIR, DISCOVERY_CACHE_FILE),
      JSON.stringify({ last_run_at: new Date().toISOString(), results }, null, 2),
    )
  } catch {
    // Best-effort
  }
}

function shouldRun(): boolean {
  // Check if TTL has expired
  const cache = loadCache()
  if (cache) return false
  return true
}

// ─── Discovery Functions ────────────────────────────────────────────────────────

/**
 * Discover capabilities from project manifest files.
 */
function discoverFromProjectManifests(projectDir: string): CapabilityEntry[] {
  const entries: CapabilityEntry[] = []
  const now = new Date().toISOString()

  // package.json
  const pkgPath = path.join(projectDir, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      for (const [name] of Object.entries(allDeps)) {
        if (name === "playwright" || name === "@playwright/test") {
          entries.push(createMinimalEntry({
            id: "project-playwright",
            kind: "software",
            name: "playwright",
            capabilities: ["browser-automation", "e2e-testing"],
            source_type: "manifest",
            source: `package.json dependency: ${name}`,
            confidence: 0.9,
            install_strategy: "project_local_npm",
            requires_install: false,
          }))
        }
        if (name === "puppeteer") {
          entries.push(createMinimalEntry({
            id: "project-puppeteer",
            kind: "software",
            name: "puppeteer",
            capabilities: ["browser-automation"],
            source_type: "manifest",
            source: `package.json dependency: ${name}`,
            confidence: 0.8,
            install_strategy: "project_local_npm",
            requires_install: false,
          }))
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return entries
}

/**
 * Discover capabilities from locally installed commands.
 */
function discoverLocalCommands(): CapabilityEntry[] {
  const entries: CapabilityEntry[] = []

  const knownCommands: { bin: string; id: string; capabilities: string[]; install_strategy?: import("./capability-schema").InstallStrategy }[] = [
    { bin: "python3", id: "python3", capabilities: ["python-runtime", "script-execution"] },
    { bin: "node", id: "nodejs", capabilities: ["javascript-runtime", "npm-ecosystem"] },
    { bin: "bun", id: "bun", capabilities: ["javascript-runtime", "bundler", "test-runner"] },
    { bin: "gh", id: "gh-cli", capabilities: ["github-api", "issue-management", "pr-management"] },
    { bin: "git", id: "git", capabilities: ["version-control", "diff", "merge"] },
    { bin: "docker", id: "docker", capabilities: ["container-runtime", "image-build"] },
    { bin: "ffmpeg", id: "ffmpeg", capabilities: ["video-processing", "audio-processing"] },
    { bin: "pandoc", id: "pandoc", capabilities: ["document-conversion", "markdown-processing"] },
    { bin: "rg", id: "ripgrep", capabilities: ["text-search", "code-search"] },
    { bin: "fd", id: "fd", capabilities: ["file-search"] },
  ]

  for (const cmd of knownCommands) {
    try {
      execSync(`which ${cmd.bin}`, { stdio: "ignore" })
      entries.push(createMinimalEntry({
        id: cmd.id,
        kind: "software",
        name: cmd.bin,
        capabilities: cmd.capabilities,
        source_type: "local-scan",
        source: `which ${cmd.bin}`,
        confidence: 1.0,
        install_strategy: cmd.install_strategy ?? "none",
        requires_install: false,
        verify_commands: [`${cmd.bin} --version`],
        status: "available",
      }))
    } catch {
      // Not installed
    }
  }

  // Check npm global packages for known tools
  try {
    const npmLS = execSync("npm ls -g --depth=0 --json 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    })
    const ls = JSON.parse(npmLS)
    const deps = ls.dependencies ?? {}
    for (const [name] of Object.entries(deps)) {
      if (name === "@anthropic/mcp-server-playwright" || name.includes("playwright-mcp")) {
        entries.push(createMinimalEntry({
          id: "global-playwright-mcp",
          kind: "mcp",
          name: "playwright-mcp",
          capabilities: ["browser-automation", "e2e-testing", "screenshot"],
          source_type: "local-scan",
          source: `npm global: ${name}`,
          confidence: 0.95,
          install_strategy: "none",
          requires_install: false,
          start_policy: "on_demand",
        }))
      }
    }
  } catch {
    // npm not available or no global packages
  }

  return entries
}

/**
 * Discover capabilities from MCP server manifests in the project.
 */
function discoverMcpManifests(projectDir: string): CapabilityEntry[] {
  const entries: CapabilityEntry[] = []
  const mcpConfigs = [
    path.join(projectDir, ".mcp", "config.json"),
    path.join(projectDir, "mcp.json"),
  ]

  for (const configPath of mcpConfigs) {
    try {
      if (!fs.existsSync(configPath)) continue
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
      const servers = config.mcpServers ?? config.servers ?? {}
      for (const [name, server] of Object.entries(servers) as [string, any][]) {
        entries.push(createMinimalEntry({
          id: `mcp-${name}`,
          kind: "mcp",
          name: `mcp-${name}`,
          capabilities: server.capabilities ?? ["mcp-service"],
          source_type: "mcp-manifest",
          source: configPath,
          confidence: 0.85,
          install_strategy: server.command?.[0] === "npx" ? "npx_runtime" : "none",
          requires_install: false,
          start_policy: "on_demand",
          runtime: {
            start_command: server.command ?? server.args,
            env_keys: server.env ? Object.keys(server.env) : undefined,
          },
        }))
      }
    } catch {
      // Invalid JSON or missing config
    }
  }

  return entries
}

/**
 * Discover capabilities from skill metadata files (SKILL.md).
 */
function discoverSkillMetadata(projectDir: string): CapabilityEntry[] {
  const entries: CapabilityEntry[] = []

  // Search for SKILL.md in project and .opencode/skills
  const skillDirs = [
    path.join(projectDir, ".opencode", "skills"),
    path.join(projectDir, "skills"),
  ]

  for (const dir of skillDirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const skillFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f === "SKILL.md")
      for (const file of skillFiles) {
        const skillPath = path.join(dir, file)
        const content = fs.readFileSync(skillPath, "utf8")
        // Extract name from first heading
        const nameMatch = content.match(/^#\s+(.+)/m)
        const name = nameMatch ? nameMatch[1].trim() : path.basename(file, ".md")
        // Extract description from second paragraph
        const descMatch = content.match(/^#\s+.+\n+(.+)/m)
        const description = descMatch ? descMatch[1].trim() : ""

        // Heuristic capability tag extraction
        const caps: string[] = []
        if (/effect/i.test(content)) caps.push("effect-ts")
        if (/browser|playwright|puppeteer/i.test(content)) caps.push("browser-automation")
        if (/test|vitest|jest/i.test(content)) caps.push("testing")

        entries.push(createMinimalEntry({
          id: `skill-${name.toLowerCase().replace(/\s+/g, "-")}`,
          kind: "skill",
          name,
          capabilities: caps.length > 0 ? caps : [`skill-${name.toLowerCase()}`],
          source_type: "skill-metadata",
          source: skillPath,
          confidence: 0.7,
          requires_install: false,
          install_strategy: "none",
        }))
      }
    } catch {
      // Directory not readable
    }
  }

  return entries
}

// ─── Main Discovery Pipeline ────────────────────────────────────────────────────

export interface DiscoveryResult {
  /** Total entries discovered */
  total: number
  /** New entries (not in cache) */
  new: number
  /** Updated entries */
  updated: number
  /** Entries by source type */
  by_source: Record<string, number>
  /** All discovered entries */
  entries: CapabilityEntry[]
  /** Timestamp */
  timestamp: string
}

/**
 * Run a full discovery cycle.
 * Results are normalized, deduplicated, and written to the discovered registry.
 * Does NOT directly drive execution.
 */
export function runDiscovery(projectDir?: string): DiscoveryResult {
  const allEntries: CapabilityEntry[] = []

  // Source 1: Project manifests (highest priority among discovery)
  if (projectDir && fs.existsSync(projectDir)) {
    allEntries.push(...discoverFromProjectManifests(projectDir))
  }

  // Source 2: MCP manifests
  if (projectDir && fs.existsSync(projectDir)) {
    allEntries.push(...discoverMcpManifests(projectDir))
  }

  // Source 3: Skill metadata
  if (projectDir && fs.existsSync(projectDir)) {
    allEntries.push(...discoverSkillMetadata(projectDir))
  }

  // Source 4: Local commands
  allEntries.push(...discoverLocalCommands())

  // Deduplicate by ID
  const dedupMap = new Map<string, CapabilityEntry>()
  for (const e of allEntries) {
    const existing = dedupMap.get(e.id)
    if (!existing || e.confidence > existing.confidence) {
      dedupMap.set(e.id, e)
    }
  }

  const unique = Array.from(dedupMap.values())

  // Compare with cache to track new/updated
  const cache = loadCache()
  const cachedIds = new Set((cache?.results ?? []).map((r) => r.id))
  let newCount = 0
  let updatedCount = 0

  for (const e of unique) {
    if (!cachedIds.has(e.id)) {
      newCount++
    } else {
      updatedCount++
    }
  }

  // Write to discovered registry
  for (const e of unique) {
    addDiscovered(e)
  }

  // Update cache
  saveCache(unique.map((e) => ({
    id: e.id,
    source_type: e.source_type,
    found_at: new Date().toISOString(),
  })))

  const by_source: Record<string, number> = {}
  for (const e of unique) {
    by_source[e.source_type] = (by_source[e.source_type] ?? 0) + 1
  }

  return {
    total: unique.length,
    new: newCount,
    updated: updatedCount,
    by_source,
    entries: unique,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Check if discovery should run based on TTL and force flag.
 */
export function needsDiscovery(force?: boolean): boolean {
  if (force) return true
  return shouldRun()
}

/**
 * Clear the discovery cache to force a fresh run next time.
 */
export function clearDiscoveryCache() {
  try {
    const fp = path.join(CACHE_DIR, DISCOVERY_CACHE_FILE)
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  } catch {
    // Best-effort
  }
}
