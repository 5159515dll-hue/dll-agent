import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import {
  mergeLayers,
  getFullRegistry,
  filterRegistry,
  findByCapability,
  findById,
  addDiscovered,
  promoteDiscovered,
  invalidateCapability,
  projectAdd,
  projectRemove,
  validateLayer,
  findStaleEntries,
  snapshot,
  loadGlobalRegistry,
  saveGlobalRegistry,
  loadDiscoveredRegistry,
  saveDiscoveredRegistry,
  loadProjectRegistry,
  saveProjectRegistry,
  type RegistryMergeResult,
} from "../../src/dll-agent/capability-registry"
import {
  createMinimalEntry,
  type CapabilityEntry,
} from "../../src/dll-agent/capability-schema"

// ─── Helpers ────────────────────────────────────────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), "dll-agent-registry-test-" + Date.now())
const DLL_DIR = path.join(os.homedir(), ".dll-agent-test-backup")

function makeTool(id: string, overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return createMinimalEntry({
    id,
    kind: "tool",
    name: id,
    capabilities: [`cap-${id}`],
    ...overrides,
  })
}

function makeSkill(id: string): CapabilityEntry {
  return createMinimalEntry({
    id,
    kind: "skill",
    name: id,
    capabilities: [`skill-cap-${id}`],
  })
}

// ─── Merge Logic ────────────────────────────────────────────────────────────────

describe("mergeLayers", () => {
  test("merges layers with correct precedence", () => {
    const builtin = [makeTool("a", { source: "builtin-a" })]
    const global = [makeTool("a", { source: "global-a" })]
    const discovered: CapabilityEntry[] = []
    const project: CapabilityEntry[] = []

    const result = mergeLayers(builtin, global, discovered, project)
    expect(result.entries.length).toBe(1)
    // Global overrides builtin
    expect(result.entries[0].source).toBe("global-a")
    expect(result.overridden).toContain("a")
  })

  test("project layer has highest precedence", () => {
    const builtin = [makeTool("a", { source: "builtin" })]
    const global = [makeTool("a", { source: "global" })]
    const discovered = [makeTool("a", { source: "discovered" })]
    const project = [makeTool("a", { source: "project" })]

    const result = mergeLayers(builtin, global, discovered, project)
    expect(result.entries.length).toBe(1)
    expect(result.entries[0].source).toBe("project")
  })

  test("project removals exclude lower-layer entries", () => {
    const builtin = [makeTool("a"), makeTool("b")]
    const global: CapabilityEntry[] = []
    const discovered: CapabilityEntry[] = []
    const project: CapabilityEntry[] = []
    const removals = ["a"]

    const result = mergeLayers(builtin, global, discovered, project, removals)
    expect(result.entries.length).toBe(1)
    expect(result.entries[0].id).toBe("b")
    expect(result.removed).toContain("a")
  })

  test("layers can add new entries independently", () => {
    const builtin = [makeTool("a")]
    const global = [makeTool("b")]
    const discovered = [makeTool("c")]
    const project = [makeTool("d")]

    const result = mergeLayers(builtin, global, discovered, project)
    expect(result.entries.length).toBe(4)
    const ids = result.entries.map((e) => e.id).sort()
    expect(ids).toEqual(["a", "b", "c", "d"])
  })

  test("layer counts are correct", () => {
    const builtin = [makeTool("a"), makeTool("b")]
    const global = [makeTool("c")]
    const discovered: CapabilityEntry[] = []
    const project: CapabilityEntry[] = []

    const result = mergeLayers(builtin, global, discovered, project)
    expect(result.layer_counts.builtin).toBe(2)
    expect(result.layer_counts.global).toBe(1)
    expect(result.layer_counts.discovered).toBe(0)
    expect(result.layer_counts.project).toBe(0)
  })

  test("empty layers produce empty result", () => {
    const result = mergeLayers([], [], [], [])
    expect(result.entries.length).toBe(0)
  })
})

// ─── Filter & Query ─────────────────────────────────────────────────────────────

describe("filterRegistry", () => {
  const entries = [
    makeTool("a", { platforms: ["darwin"], kind: "tool" as const, risk_level: "low" }),
    makeTool("b", { platforms: ["linux"], kind: "mcp" as const, risk_level: "high" }),
    makeTool("c", { platforms: ["any"], kind: "skill" as const, risk_level: "low", confidence: 0.5 }),
    makeTool("d", { platforms: ["darwin"], kind: "tool" as const, status: "available" as const }),
  ]

  test("filters by platform (darwin)", () => {
    const result = filterRegistry(entries, { platforms: ["darwin"] })
    const ids = result.map((e) => e.id)
    expect(ids).toContain("a") // explicit darwin
    expect(ids).toContain("c") // any
    expect(ids).toContain("d") // explicit darwin
    expect(ids).not.toContain("b") // linux only
  })

  test("filters by kind", () => {
    const result = filterRegistry(entries, { kinds: ["tool"] })
    expect(result.every((e) => e.kind === "tool")).toBe(true)
  })

  test("excludes high risk", () => {
    const result = filterRegistry(entries, { exclude_risks: ["high"] })
    expect(result.some((e) => e.id === "b")).toBe(false)
  })

  test("filters by minimum confidence", () => {
    const result = filterRegistry(entries, { min_confidence: 0.7 })
    expect(result.some((e) => e.id === "c")).toBe(false) // confidence 0.5
    expect(result.some((e) => e.id === "a")).toBe(true) // confidence 1.0
  })

  test("filters by status", () => {
    const result = filterRegistry(entries, { statuses: ["available"] })
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("d")
  })
})

describe("findByCapability", () => {
  const entries = [
    makeTool("a", { capabilities: ["browser-automation", "screenshot"] }),
    makeTool("b", { capabilities: ["pdf-read"] }),
    makeTool("c", { capabilities: ["browser-automation", "e2e-testing"] }),
  ]

  test("finds by exact capability tag", () => {
    const result = findByCapability(entries, "browser-automation")
    expect(result.length).toBe(2)
    expect(result.map((e) => e.id).sort()).toEqual(["a", "c"])
  })

  test("returns empty for unknown tag", () => {
    const result = findByCapability(entries, "nonexistent")
    expect(result.length).toBe(0)
  })
})

describe("findById", () => {
  const entries = [makeTool("playwright"), makeTool("doc-docx")]

  test("finds existing entry", () => {
    const result = findById(entries, "playwright")
    expect(result).toBeDefined()
    expect(result!.id).toBe("playwright")
  })

  test("returns undefined for missing entry", () => {
    const result = findById(entries, "nonexistent")
    expect(result).toBeUndefined()
  })
})

// ─── Discovery & Promotion ──────────────────────────────────────────────────────

describe("addDiscovered", () => {
  test("caps confidence for doc-summary sources", () => {
    const entry = makeTool("test", {
      source_type: "doc-summary",
      confidence: 0.9,
    })
    const result = addDiscovered(entry)
    expect(result.confidence).toBe(0.5)
  })

  test("does not cap confidence for local-scan sources", () => {
    const entry = makeTool("test2", {
      source_type: "local-scan",
      confidence: 0.9,
    })
    const result = addDiscovered(entry)
    expect(result.confidence).toBe(0.9)
  })
})

describe("promoteDiscovered", () => {
  test("rejects promotion of doc-summary entries", () => {
    addDiscovered(makeTool("ds-promote", {
      source_type: "doc-summary",
      confidence: 0.9,
    }))
    const result = promoteDiscovered("ds-promote")
    expect(result).toBeNull()
  })

  test("rejects promotion below confidence threshold", () => {
    addDiscovered(makeTool("low-conf", {
      source_type: "local-scan",
      confidence: 0.5,
    }))
    const result = promoteDiscovered("low-conf")
    expect(result).toBeNull()
  })

  test("rejects promotion without all required fields", () => {
    addDiscovered(createMinimalEntry({
      id: "incomplete",
      kind: "mcp",
      name: "Incomplete",
      source_type: "local-scan",
      confidence: 0.8,
      capabilities: [],
    }))
    const result = promoteDiscovered("incomplete")
    expect(result).toBeNull()
  })
})

// ─── Invalidation ───────────────────────────────────────────────────────────────

describe("invalidateCapability", () => {
  test("marks entry as failed in global registry", () => {
    saveGlobalRegistry([makeTool("to-fail")])
    const ok = invalidateCapability("to-fail", "test failure")
    expect(ok).toBe(true)
    const global = loadGlobalRegistry()
    const entry = global.find((e) => e.id === "to-fail")
    expect(entry?.status).toBe("failed")
    expect(entry?.evidence?.verification_result).toBe("failed")
  })

  test("returns false for nonexistent entry", () => {
    const ok = invalidateCapability("nonexistent", "test")
    expect(ok).toBe(false)
  })
})

// ─── Project Operations ─────────────────────────────────────────────────────────

describe("projectAdd and projectRemove", () => {
  const testProject = path.join(TMP_DIR, "test-project")

  beforeAll(() => {
    fs.mkdirSync(path.join(testProject, ".dll-agent"), { recursive: true })
  })

  test("projectAdd adds entry to project registry", () => {
    saveProjectRegistry(testProject, [])
    projectAdd(testProject, makeTool("proj-tool"))
    const entries = loadProjectRegistry(testProject)
    expect(entries.length).toBe(1)
    expect(entries[0].id).toBe("proj-tool")
  })

  test("projectAdd overrides existing entry", () => {
    saveProjectRegistry(testProject, [makeTool("proj-tool", { source: "old" })])
    projectAdd(testProject, makeTool("proj-tool", { source: "new" }))
    const entries = loadProjectRegistry(testProject)
    expect(entries.length).toBe(1)
    expect(entries[0].source).toBe("new")
  })

  test("projectRemove adds to removed list", () => {
    saveProjectRegistry(testProject, [])
    projectRemove(testProject, "to-remove")
    const data = JSON.parse(fs.readFileSync(
      path.join(testProject, ".dll-agent", "capabilities.json"),
      "utf8",
    ))
    expect(data.removed).toContain("to-remove")
  })
})

// ─── Validation ─────────────────────────────────────────────────────────────────

describe("validateLayer", () => {
  test("reports valid and invalid entries", () => {
    const entries = [
      makeTool("valid"),
      createMinimalEntry({ id: "invalid", kind: "tool", name: "Invalid", capabilities: [] }),
    ]
    const result = validateLayer(entries)
    expect(result.total).toBe(2)
    expect(result.valid).toBe(1)
    expect(result.gaps.length).toBe(1)
    expect(result.gaps[0].id).toBe("invalid")
  })
})

describe("findStaleEntries", () => {
  test("finds entries with no last_verified_at", () => {
    const entries = [makeTool("stale")]
    const stale = findStaleEntries(entries, 168)
    expect(stale.length).toBe(1)
  })

  test("skips recently verified entries", () => {
    const fresh = makeTool("fresh")
    fresh.last_verified_at = new Date().toISOString()
    const stale = findStaleEntries([fresh], 168)
    expect(stale.length).toBe(0)
  })

  test("finds entries verified long ago", () => {
    const old = makeTool("old")
    old.last_verified_at = new Date(Date.now() - 200 * 3600 * 1000).toISOString()
    const stale = findStaleEntries([old], 168)
    expect(stale.length).toBe(1)
  })
})

// ─── Snapshot ───────────────────────────────────────────────────────────────────

describe("snapshot", () => {
  test("correctly groups by status and kind", () => {
    const entries = [
      makeTool("a", { status: "available" }),
      makeTool("b", { status: "registered", kind: "mcp" as const }),
      makeTool("c", { status: "available", kind: "skill" as const }),
    ]
    const snap = snapshot(entries)
    expect(snap.total).toBe(3)
    expect(snap.by_status.available).toBe(2)
    expect(snap.by_status.registered).toBe(1)
    expect(snap.by_kind.tool).toBe(1)
    expect(snap.by_kind.mcp).toBe(1)
    expect(snap.by_kind.skill).toBe(1)
  })
})

// ─── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  // Clean test project
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch {}
  // Restore registry files
  try { fs.rmSync(path.join(os.homedir(), ".dll-agent", "capabilities", "registry.json")) } catch {}
  try { fs.rmSync(path.join(os.homedir(), ".dll-agent", "capabilities", "discovered.json")) } catch {}
})
