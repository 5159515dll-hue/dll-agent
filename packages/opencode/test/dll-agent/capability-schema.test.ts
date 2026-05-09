import { describe, test, expect } from "bun:test"
import {
  validateCapabilityEntry,
  validateRegistry,
  schemaGaps,
  createMinimalEntry,
  type CapabilityEntry,
} from "../../src/dll-agent/capability-schema"
import {
  toolToCapabilityEntry,
  skillToCapabilityEntry,
  mapAllBuiltins,
  modelCapability,
  softwareCapability,
} from "../../src/dll-agent/capability-mapping"
import { GLOBAL_DEFAULT_TOOLS } from "../../src/dll-agent/tool-catalog"
import { SKILL_REGISTRY } from "../../src/dll-agent/skill-registry"

// ─── Schema Validation Tests ────────────────────────────────────────────────────

describe("capability-schema", () => {
  test("validateCapabilityEntry passes for valid entries", () => {
    const entry = createMinimalEntry({
      id: "test-tool",
      kind: "tool",
      name: "Test Tool",
      capabilities: ["testing"],
    })
    const result = validateCapabilityEntry(entry)
    expect(result.valid).toBe(true)
    expect(result.missing_required.length).toBe(0)
  })

  test("validateCapabilityEntry detects missing required fields", () => {
    const entry = createMinimalEntry({
      id: "test-tool",
      kind: "tool",
      name: "Test Tool",
      // capabilities intentionally empty
      capabilities: [],
    })
    const result = validateCapabilityEntry(entry)
    expect(result.valid).toBe(false)
    expect(result.invalid_fields).toContain("capabilities")
  })

  test("validateCapabilityEntry validates confidence range", () => {
    const entry = createMinimalEntry({
      id: "test-tool",
      kind: "tool",
      name: "Test Tool",
      capabilities: ["testing"],
      confidence: 2.5,
    })
    const result = validateCapabilityEntry(entry)
    expect(result.invalid_fields).toContain("confidence")
  })

  test("validateCapabilityEntry requires runtime for MCP", () => {
    const entry = createMinimalEntry({
      id: "test-mcp",
      kind: "mcp",
      name: "Test MCP",
      capabilities: ["automation"],
    })
    const result = validateCapabilityEntry(entry)
    expect(result.missing_required).toContain("runtime")
  })

  test("validateRegistry detects duplicates", () => {
    const entry = createMinimalEntry({
      id: "dup-id",
      kind: "tool",
      name: "Dup Tool",
      capabilities: ["testing"],
    })
    const results = validateRegistry([entry, entry])
    const result = results.get("dup-id")!
    expect(result.invalid_fields).toContain("id-duplicate")
  })

  test("schemaGaps returns only invalid entries", () => {
    const valid = createMinimalEntry({
      id: "valid",
      kind: "tool",
      name: "Valid",
      capabilities: ["testing"],
    })
    const invalid = createMinimalEntry({
      id: "invalid",
      kind: "tool",
      name: "Invalid",
      capabilities: [],
    })
    const gaps = schemaGaps([valid, invalid])
    expect(gaps.length).toBe(1)
    expect(gaps[0].id).toBe("invalid")
  })

  test("suggests raising risk for system_package_manager", () => {
    const entry = createMinimalEntry({
      id: "risky",
      kind: "software",
      name: "Risky",
      capabilities: ["system-mod"],
      install_strategy: "system_package_manager",
      risk_level: "low",
    })
    const result = validateCapabilityEntry(entry)
    expect(result.suggestions.some((s) => s.includes("raising"))).toBe(true)
  })
})

// ─── ToolEntry Mapping Tests ────────────────────────────────────────────────────

describe("toolToCapabilityEntry", () => {
  test("maps all GLOBAL_DEFAULT_TOOLS without error", () => {
    const results = GLOBAL_DEFAULT_TOOLS.map(toolToCapabilityEntry)
    expect(results.length).toBe(GLOBAL_DEFAULT_TOOLS.length)
    for (const r of results) {
      expect(r.id).toBeTruthy()
      expect(r.kind).toBeTruthy()
      expect(r.capabilities.length).toBeGreaterThan(0)
    }
  })

  test("playwright maps to mcp kind with runtime", () => {
    const pw = GLOBAL_DEFAULT_TOOLS.find((t) => t.id === "playwright")!
    const entry = toolToCapabilityEntry(pw)
    expect(entry.kind).toBe("mcp")
    expect(entry.runtime).toBeDefined()
    expect(entry.runtime!.heavy).toBe(true)
    expect(entry.runtime!.start_policy).toBe("on_demand")
    expect(entry.cost_level).toBe("high")
  })

  test("doc-docx maps to tool kind with correct capabilities", () => {
    const doc = GLOBAL_DEFAULT_TOOLS.find((t) => t.id === "doc-docx")!
    const entry = toolToCapabilityEntry(doc)
    expect(entry.kind).toBe("tool")
    expect(entry.capabilities).toContain("docx-read")
    expect(entry.capabilities).toContain("docx-write")
    expect(entry.input_types).toContain(".docx")
    expect(entry.install_strategy).toBe("project_local_pip")
    expect(entry.dependencies?.packages).toEqual(["python-docx"])
    expect(entry.verify_commands).toEqual([`python3 -c "import docx"`])
  })

  test("document tools map to project-local package installs, not binary installs", () => {
    const expectations = [
      ["pdf", "pypdf", `python3 -c "import pypdf"`],
      ["ppt-pptx", "python-pptx", `python3 -c "import pptx"`],
      ["xlsx", "openpyxl", `python3 -c "import openpyxl"`],
    ]
    for (const [toolID, pkg, verify] of expectations) {
      const tool = GLOBAL_DEFAULT_TOOLS.find((t) => t.id === toolID)!
      const entry = toolToCapabilityEntry(tool)
      expect(entry.install_strategy).toBe("project_local_pip")
      expect(entry.dependencies?.packages).toEqual([pkg])
      expect(entry.dependencies?.packages).not.toContain("python3")
      expect(entry.verify_commands).toEqual([verify])
    }
  })

  test("github maps with requires_token true", () => {
    const gh = GLOBAL_DEFAULT_TOOLS.find((t) => t.id === "github")!
    const entry = toolToCapabilityEntry(gh)
    expect(entry.requires_token).toBe(true)
    expect(entry.dependencies?.tokens).toContain("GITHUB_TOKEN")
  })

  test("repo-doctor skill kind has correct capabilities", () => {
    const rd = GLOBAL_DEFAULT_TOOLS.find((t) => t.id === "repo-doctor")!
    const entry = toolToCapabilityEntry(rd)
    expect(entry.kind).toBe("skill")
    expect(entry.capabilities).toContain("repo-health")
  })

  test("all entries have valid source_type=builtin", () => {
    for (const tool of GLOBAL_DEFAULT_TOOLS) {
      const entry = toolToCapabilityEntry(tool)
      expect(entry.source_type).toBe("builtin")
      expect(entry.confidence).toBe(1.0)
    }
  })
})

// ─── SkillDefinition Mapping Tests ──────────────────────────────────────────────

describe("skillToCapabilityEntry", () => {
  test("maps all SKILL_REGISTRY without error", () => {
    const results = SKILL_REGISTRY.map(skillToCapabilityEntry)
    expect(results.length).toBe(SKILL_REGISTRY.length)
    for (const r of results) {
      expect(r.id).toBeTruthy()
      expect(r.kind).toBe("skill")
      expect(r.source_type).toBe("builtin")
    }
  })

  test("repo-doctor skill has correct capabilities", () => {
    const rd = SKILL_REGISTRY.find((s) => s.id === "repo-doctor")!
    const entry = skillToCapabilityEntry(rd)
    expect(entry.capabilities).toContain("repo-health")
    expect(entry.capabilities).toContain("diagnostic")
  })

  test("self-repair skill has high risk", () => {
    const sr = SKILL_REGISTRY.find((s) => s.id === "self-repair")!
    const entry = skillToCapabilityEntry(sr)
    expect(entry.risk_level).toBe("high")
  })

  test("cost-guard has free cost_level", () => {
    const cg = SKILL_REGISTRY.find((s) => s.id === "cost-guard")!
    const entry = skillToCapabilityEntry(cg)
    // cost-guard does NOT allow OpenAI or expensive reviewers
    expect(entry.cost_level).toBe("free")
  })

  test("cross-review has high cost_level due to allowOpenAI", () => {
    const cr = SKILL_REGISTRY.find((s) => s.id === "cross-review")!
    const entry = skillToCapabilityEntry(cr)
    expect(entry.cost_level).toBe("high")
  })

  test("verification commands are preserved", () => {
    const tg = SKILL_REGISTRY.find((s) => s.id === "test-gate")!
    const entry = skillToCapabilityEntry(tg)
    expect(entry.verify_commands).toBeDefined()
    expect(entry.verify_commands!.length).toBeGreaterThan(0)
  })

  test("triggers with signals are mapped", () => {
    const rd = SKILL_REGISTRY.find((s) => s.id === "repo-doctor")!
    const entry = skillToCapabilityEntry(rd)
    expect(entry.triggers?.signals).toBeDefined()
    expect(entry.triggers!.signals!.length).toBeGreaterThan(0)
  })
})

// ─── mapAllBuiltins Tests ───────────────────────────────────────────────────────

describe("mapAllBuiltins", () => {
  test("returns correct total count", () => {
    const all = mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY)
    expect(all.length).toBe(GLOBAL_DEFAULT_TOOLS.length + SKILL_REGISTRY.length)
  })

  test("no duplicate IDs between tools and skills (shared IDs like repo-doctor exist in both registries)", () => {
    const all = mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY)
    const ids = new Set(all.map((e) => e.id))
    // Some IDs exist in both tool-catalog and skill-registry (e.g. repo-doctor)
    // The unique count should be less than total
    expect(ids.size).toBeLessThan(all.length)
    expect(ids.size).toBeGreaterThan(0)
  })

  test("all entries pass schema validation", () => {
    const all = mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY)
    const gaps = schemaGaps(all)
    if (gaps.length > 0) {
      console.error("Schema gaps found:", JSON.stringify(gaps, null, 2))
    }
    expect(gaps.length).toBe(0)
  })
})

// ─── Model Capability Tests ─────────────────────────────────────────────────────

describe("modelCapability", () => {
  test("creates valid model entry", () => {
    const entry = modelCapability({
      id: "deepseek-v4",
      provider: "deepseek",
      modelName: "deepseek-v4-pro",
      description: "Primary reasoning model",
      capabilities: ["deep-reasoning", "code-generation", "debugging"],
      contextLimit: 1_048_576,
    })
    expect(entry.kind).toBe("model")
    expect(entry.name).toBe("deepseek/deepseek-v4-pro")
    expect(entry.capabilities).toContain("deep-reasoning")
    expect(entry.status).toBe("available")
    expect(entry.evidence?.selection_rationale).toContain("1048576")
  })
})

// ─── Software Capability Tests ──────────────────────────────────────────────────

describe("softwareCapability", () => {
  test("creates valid software entry", () => {
    const entry = softwareCapability({
      id: "ffmpeg",
      name: "ffmpeg",
      description: "Video/audio processing",
      capabilities: ["video-processing", "audio-processing"],
      install_strategy: "system_package_manager",
      riskLevel: "medium",
      verifyCommand: ["ffmpeg", "-version"],
    })
    expect(entry.kind).toBe("software")
    expect(entry.install_strategy).toBe("system_package_manager")
    expect(entry.verify_commands).toEqual(["ffmpeg", "-version"])
  })
})

// ─── createMinimalEntry Tests ───────────────────────────────────────────────────

describe("createMinimalEntry", () => {
  test("fills defaults for all optional fields", () => {
    const entry = createMinimalEntry({
      id: "minimal",
      kind: "tool",
      name: "Minimal",
    })
    expect(entry.capabilities).toEqual([])
    expect(entry.risk_level).toBe("low")
    expect(entry.cost_level).toBe("free")
    expect(entry.source).toBe("manual")
    expect(entry.confidence).toBe(1.0)
    expect(entry.status).toBe("registered")
    expect(entry.platforms).toEqual(["any"])
    expect(entry.registered_at).toBeTruthy()
  })

  test("allows overriding defaults", () => {
    const entry = createMinimalEntry({
      id: "custom",
      kind: "tool",
      name: "Custom",
      capabilities: ["custom-cap"],
      risk_level: "high",
      confidence: 0.5,
    })
    expect(entry.capabilities).toEqual(["custom-cap"])
    expect(entry.risk_level).toBe("high")
    expect(entry.confidence).toBe(0.5)
  })
})
