import { describe, expect, test } from "bun:test"
import {
  buildCapabilityPromptIndex,
  buildCapabilitySidebarStatus,
  buildCapabilityStatusReport,
  renderCapabilityStatus,
} from "../../src/dll-agent/capability-status"
import { buildEffectiveCapabilityManifest } from "../../src/dll-agent/capability-registry"
import { mapAllBuiltins } from "../../src/dll-agent/capability-mapping"
import { GLOBAL_DEFAULT_TOOLS } from "../../src/dll-agent/tool-catalog"
import { SKILL_REGISTRY } from "../../src/dll-agent/skill-registry"

describe("capability-status", () => {
  test("buildCapabilityStatusReport reads real registry and runtime state", () => {
    const report = buildCapabilityStatusReport(process.cwd())
    expect(report.total).toBeGreaterThan(0)
    expect(report.by_kind).toBeDefined()
    expect(report.by_status).toBeDefined()
    expect(Array.isArray(report.pending_permission)).toBe(true)
    expect(report.lsp.main_language).toBeTruthy()
    expect(report.lsp.target_count).toBeGreaterThanOrEqual(0)
  })

  test("renderCapabilityStatus returns direct status text", () => {
    const text = renderCapabilityStatus(process.cwd())
    expect(text).toContain("dll-agent capability status")
    expect(text).toContain("by kind:")
    expect(text).toContain("runtime:")
    expect(text).toContain("effective status:")
    expect(text).toContain("lsp:")
    expect(text).not.toContain("Use the capability planner")
  })

  test("effective manifest exposes five capability kinds and bounded prompt index", () => {
    const manifest = buildEffectiveCapabilityManifest({
      builtin: mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY),
      projectDir: process.cwd(),
      recordEvidence: false,
    })
    expect(manifest.by_kind.skill).toBeGreaterThan(0)
    expect(manifest.by_kind.tool).toBeGreaterThan(0)
    expect(manifest.by_kind.mcp).toBeGreaterThan(0)
    expect(manifest.by_kind.lsp).toBeGreaterThan(0)
    expect(manifest.by_kind.multimodal).toBeGreaterThan(0)
    const index = buildCapabilityPromptIndex(manifest, 240)
    expect(index.length).toBeLessThanOrEqual(240)
    expect(index).toContain("playwright:mcp:")
    expect(index).not.toContain("prompt_detail")
  })

  test("heavy MCP and multimodal are registered on-demand rather than running in manifest", () => {
    const manifest = buildEffectiveCapabilityManifest({
      builtin: mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY),
      projectDir: process.cwd(),
      recordEvidence: false,
    })
    expect(manifest.effective_status.playwright).toBe("on_demand")
    expect(manifest.effective_status["multimodal-context-interpreter"]).not.toBe("running")
  })

  test("buildCapabilitySidebarStatus returns bounded TUI lines", () => {
    const status = buildCapabilitySidebarStatus(process.cwd(), 48)
    expect(status.generated_at).toBeTruthy()
    expect(status.lines.length).toBeGreaterThanOrEqual(3)
    expect(status.lines.length).toBeLessThanOrEqual(4)
    expect(status.lines[0]).toContain("registered")
    expect(status.lines[1]).toContain("on-demand")
    expect(status.lines.join("\n")).not.toContain("permission github")
    for (const line of status.lines) {
      expect(line.length).toBeLessThanOrEqual(48)
    }
  })

  test("buildCapabilitySidebarStatus is task-aware for browser audit", () => {
    const status = buildCapabilitySidebarStatus(process.cwd(), 72, {
      userGoal: "Full CRM browser click-through audit with console and network inspection",
    })
    const text = status.lines.join("\n")
    expect(text).toContain("task selected")
    expect(text).toContain("playwright")
    expect(text).toContain("mcp auto")
    expect(text).not.toContain("permission github")
  })

  test("buildCapabilitySidebarStatus does not treat SSH baseline as Playwright permission blocker", () => {
    const status = buildCapabilitySidebarStatus(process.cwd(), 72, {
      userGoal: [
        "Full CRM browser click-through audit",
        "Part 1: Baseline verification - SSH to server, check HEAD, alembic, healthz",
        "Part 3: Core sales-domain flows - browser click-through testing",
      ].join("\n"),
    })
    const text = status.lines.join("\n")
    expect(text).toContain("playwright")
    expect(text).toContain("mcp auto")
    expect(text).not.toContain("task permission playwright")
  })
})
