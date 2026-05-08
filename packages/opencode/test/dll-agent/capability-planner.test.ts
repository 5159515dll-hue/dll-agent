import { describe, test, expect } from "bun:test"
import {
  planCapabilities,
  checkCoverage,
  type TaskContext,
} from "../../src/dll-agent/capability-planner"
import { createMinimalEntry, type CapabilityEntry } from "../../src/dll-agent/capability-schema"

function makeTool(id: string, overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return createMinimalEntry({
    id,
    kind: "tool",
    name: id,
    capabilities: [`cap-${id}`],
    ...overrides,
  } as any)
}

const registry = [
  createMinimalEntry({
    id: "playwright",
    kind: "mcp",
    name: "playwright",
    capabilities: ["browser-automation", "e2e-testing", "screenshot"],
    risk_level: "high",
    cost_level: "high",
    source_type: "builtin",
    status: "available",
    runtime: { heavy: true },
  } as any),
  createMinimalEntry({
    id: "docx-tool",
    kind: "tool",
    name: "doc/docx",
    capabilities: ["docx-read", "docx-write", "document-processing"],
    risk_level: "low",
    cost_level: "free",
    source_type: "builtin",
    status: "available",
  } as any),
  createMinimalEntry({
    id: "pdf-tool",
    kind: "tool",
    name: "pdf",
    capabilities: ["pdf-read", "pdf-extract"],
    risk_level: "low",
    cost_level: "free",
    source_type: "builtin",
    status: "available",
  } as any),
  createMinimalEntry({
    id: "gh-cli",
    kind: "software",
    name: "gh",
    capabilities: ["github-api", "pr-management", "issue-management"],
    risk_level: "medium",
    cost_level: "free",
    source_type: "local-scan",
    status: "available",
  } as any),
  createMinimalEntry({
    id: "bun-test",
    kind: "software",
    name: "bun",
    capabilities: ["test", "typecheck", "build"],
    risk_level: "low",
    cost_level: "free",
    source_type: "local-scan",
    status: "available",
  } as any),
]

describe("planCapabilities", () => {
  test("selects playwright for browser-automation task", () => {
    const result = planCapabilities(registry, {
      user_goal: "check CRM frontend clickstream with browser automation",
    })
    expect(result.required_tags).toContain("browser-automation")
    const pw = result.selected.find((s) => s.entry.id === "playwright")
    expect(pw).toBeDefined()
    expect(pw!.ready).toBe(true)
  })

  test("selects playwright for Chinese click-through audit wording", () => {
    const result = planCapabilities(registry, {
      user_goal: "检查 CRM 前端点击流并读取 console/network 错误",
    })
    expect(result.required_tags).toContain("browser-automation")
    expect(result.selected.some((s) => s.entry.id === "playwright")).toBe(true)
  })

  test("selects docx-tool for Word document task", () => {
    const result = planCapabilities(registry, {
      user_goal: "read and analyze this Word document",
      file_extensions: [".docx"],
    })
    expect(result.required_tags).toContain("docx-read")
    const doc = result.selected.find((s) => s.entry.id === "docx-tool")
    expect(doc).toBeDefined()
  })

  test("selects gh-cli for pull request task", () => {
    const result = planCapabilities(registry, {
      user_goal: "create a PR and review the code",
    })
    expect(result.required_tags).toContain("github-api")
    const gh = result.selected.find((s) => s.entry.id === "gh-cli")
    expect(gh).toBeDefined()
  })

  test("generates install suggestion for unavailable capability", () => {
    const regWithOnlyMissing = [
      createMinimalEntry({
        id: "unique-playwright",
        kind: "mcp",
        name: "playwright-missing",
        capabilities: ["browser-automation", "e2e-testing"],
        risk_level: "high",
        cost_level: "high",
        source_type: "discovered",
        status: "missing_dependency",
        install_strategy: "npx_runtime",
        requires_install: true,
      } as any),
    ]
    const result = planCapabilities(regWithOnlyMissing, {
      user_goal: "run browser automation tests",
    })
    expect(result.required_tags).toContain("browser-automation")
    const suggestion = result.install_suggestions.find((s) => s.entry_id === "unique-playwright")
    expect(suggestion).toBeDefined()
    expect(suggestion!.action).toBeTruthy()
  })

  test("reports gaps for uncovered tags", () => {
    const smallReg = [
      createMinimalEntry({ id: "only-test", kind: "tool", name: "test", capabilities: ["test"], source_type: "builtin" } as any),
    ]
    const result = planCapabilities(smallReg, {
      user_goal: "process this pdf document",
      file_extensions: [".pdf"],
    })
    expect(result.gaps.length).toBeGreaterThan(0)
    expect(result.gaps.some((g) => g.tag === "pdf-read")).toBe(true)
  })

  test("provides alternatives", () => {
    const regWithDuplicates = [
      makeTool("alt1", { capabilities: ["browser-automation"], source_type: "builtin", status: "available" }),
      makeTool("alt2", { capabilities: ["browser-automation"], source_type: "discovered", status: "available" }),
    ]
    const result = planCapabilities(regWithDuplicates, {
      user_goal: "browser automation",
    })
    expect(result.alternatives.length).toBeGreaterThan(0)
  })

  test("handles empty user goal gracefully", () => {
    const result = planCapabilities(registry, { user_goal: "" })
    expect(result.required_tags.length).toBe(0)
    expect(result.selected.length).toBe(0)
  })

  test("new capability with triggers is auto-discovered without editing TAG_RULES", () => {
    // Core capability-driven promise: new entries with triggers are
    // auto-selected WITHOUT modifying any hardcoded rules or classifiers.
    const newEntry = createMinimalEntry({
      id: "ui-audit-tool",
      kind: "tool",
      name: "ui-audit",
      capabilities: ["ui-audit", "console-audit", "network-inspect"],
      source_type: "discovered",
      status: "available",
      triggers: {
        keywords: ["ui.audit", "前端审查", "点击流"],
      },
    } as any)

    const regWithNew = [newEntry]
    const result = planCapabilities(regWithNew, {
      user_goal: "检查 CRM 前端点击流",
    })
    expect(result.required_tags).toContain("ui-audit")
    const match = result.selected.find((s) => s.entry.id === "ui-audit-tool")
    expect(match).toBeDefined()
  })
})

describe("checkCoverage", () => {
  test("reports covered and uncovered tags", () => {
    const result = checkCoverage(registry, ["browser-automation", "video-processing"])
    expect(result.covered).toContain("browser-automation")
    expect(result.uncovered).toContain("video-processing")
  })
})
