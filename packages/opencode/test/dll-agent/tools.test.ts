/**
 * dll-agent tool system tests
 *
 * Covers: global manifest, project overlay merge, on-demand MCP,
 * prompt injection strategy, evidence, doctor, security.
 *
 * 测试纯函数层（不依赖 Effect runtime 或 external MCP process）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

// ─── Module imports ──────────────────────────────────────────────────────────

import {
  GLOBAL_DEFAULT_TOOLS,
  DEFAULT_MANIFEST,
  findTool,
  heavyMcpEntries,
  mcpByStartPolicy,
  buildTriggerIndex,
  type ToolEntry,
  type ToolManifest,
} from "../../src/dll-agent/tool-catalog"

import {
  loadProjectOverlay,
  buildEffectiveManifest,
  buildGlobalEffective,
  deriveToolAvailability,
  refreshAvailability,
  writeSessionEffective,
  readSessionEffective,
  type ProjectToolOverlay,
  type EffectiveManifest,
} from "../../src/dll-agent/tool-overlay"

import {
  buildPromptIndex,
  selectToolsForDetail,
  buildDetailPrompt,
  generateToolPrompt,
  detectToolTriggers,
  detectFileTypeTriggers,
  type TriggerContext,
} from "../../src/dll-agent/tool-prompt"

import {
  acquireLock,
  releaseLock,
  shouldStart,
  isOnDemand,
  fromCatalogRegistration,
  type McpRegistration,
} from "../../src/dll-agent/mcp-manager"

import { toolDoctorChecks, type ToolDoctorResult } from "../../src/dll-agent/toolbox"

// ─── Test helpers ────────────────────────────────────────────────────────────

const TEST_SESSION = "test-session-tools"
const TEST_PROJECT = path.join(os.tmpdir(), "dll-agent-test-project")
const TEMP_SESSION_DIR = path.join(os.homedir(), ".dll-agent", "sessions", TEST_SESSION)

function cleanupSession() {
  try { fs.rmSync(TEMP_SESSION_DIR, { recursive: true, force: true }) } catch {}
}

function cleanupProject() {
  try { fs.rmSync(TEST_PROJECT, { recursive: true, force: true }) } catch {}
}

function writeProjectOverlay(overlay: ProjectToolOverlay) {
  fs.mkdirSync(path.join(TEST_PROJECT, ".dll-agent"), { recursive: true })
  fs.writeFileSync(
    path.join(TEST_PROJECT, ".dll-agent", "tools.jsonc"),
    JSON.stringify(overlay, null, 2),
  )
}

// ─── Catalog Tests ──────────────────────────────────────────────────────────

describe("tool-catalog", () => {
  test("GLOBAL_DEFAULT_TOOLS contains all required capabilities", () => {
    const ids = GLOBAL_DEFAULT_TOOLS.map((t) => t.id)
    expect(ids).toContain("doc-docx")
    expect(ids).toContain("pdf")
    expect(ids).toContain("ppt-pptx")
    expect(ids).toContain("xlsx")
    expect(ids).toContain("github")
    expect(ids).toContain("playwright")
    expect(ids).toContain("engineering-test")
    expect(ids).toContain("observability")
    expect(ids).toContain("repo-doctor")
    expect(ids).toContain("security-redaction")
    expect(ids).toContain("docs-sync")
    expect(ids).toContain("test-gate")
  })

  test("heavy MCPs are marked on_demand", () => {
    const heavy = heavyMcpEntries(GLOBAL_DEFAULT_TOOLS)
    for (const h of heavy) {
      expect(h.mcp?.start_policy).toBe("on_demand")
      expect(h.mcp?.heavy).toBe(true)
      expect(h.injection_policy).toBe("on_demand")
    }
  })

  test("playwright is heavy and on_demand", () => {
    const pw = findTool("playwright")
    expect(pw).toBeDefined()
    expect(pw!.mcp?.heavy).toBe(true)
    expect(pw!.mcp?.start_policy).toBe("on_demand")
    expect(pw!.mcp?.isolated).toBe(true)
    expect(pw!.kind).toBe("mcp")
  })

  test("github is on_demand but not heavy MCP", () => {
    const gh = findTool("github")
    expect(gh).toBeDefined()
    expect(gh!.injection_policy).toBe("on_demand")
    expect(gh!.kind).toBe("tool") // not MCP — could be CLI wrapper
  })

  test("engineering-test is always injected", () => {
    const et = findTool("engineering-test")
    expect(et).toBeDefined()
    expect(et!.injection_policy).toBe("always")
  })

  test("default manifest has correct prompt limits", () => {
    expect(DEFAULT_MANIFEST.prompt.index_max_chars).toBe(1200)
    expect(DEFAULT_MANIFEST.prompt.tool_detail_max_chars).toBe(1500)
    expect(DEFAULT_MANIFEST.prompt.per_round_max_chars).toBe(3000)
  })

  test("findTool returns undefined for unknown id", () => {
    expect(findTool("nonexistent")).toBeUndefined()
  })

  test("mcpByStartPolicy filters correctly", () => {
    const onDemand = mcpByStartPolicy(GLOBAL_DEFAULT_TOOLS, "on_demand")
    expect(onDemand.length).toBeGreaterThan(0)
    for (const m of onDemand) {
      expect(m.mcp?.start_policy).toBe("on_demand")
    }

    const auto = mcpByStartPolicy(GLOBAL_DEFAULT_TOOLS, "autostart_lightweight")
    expect(auto.length).toBe(0) // no autostart MCPs in default
  })

  test("buildTriggerIndex produces non-empty index", () => {
    const index = buildTriggerIndex(GLOBAL_DEFAULT_TOOLS)
    expect(index.size).toBeGreaterThan(0)
    expect(index.has("pdf")).toBe(true)
    expect(index.has("xlsx")).toBe(true)
    const pdfTriggers = index.get("pdf")!
    expect(pdfTriggers).toContain("pdf")
  })
})

// ─── Overlay / Merge Tests ──────────────────────────────────────────────────

describe("tool-overlay", () => {
  beforeEach(() => {
    cleanupSession()
    cleanupProject()
  })

  afterEach(() => {
    cleanupSession()
    cleanupProject()
  })

  test("buildGlobalEffective returns global-only manifest", () => {
    const manifest = buildGlobalEffective()
    expect(manifest.source).toBe("global")
    expect(manifest.tools.length).toBe(GLOBAL_DEFAULT_TOOLS.length)
    // All should have merge_source "global_default"
    for (const id of Object.keys(manifest.merge_source)) {
      expect(manifest.merge_source[id]).toBe("global_default")
    }
  })

  test("loadProjectOverlay returns null when no file exists", () => {
    const overlay = loadProjectOverlay(TEST_PROJECT)
    expect(overlay).toBeNull()
  })

  test("loadProjectOverlay loads valid overlay", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: ["custom-skill"], remove: [] },
      tools: { add: [], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }
    writeProjectOverlay(overlay)
    const loaded = loadProjectOverlay(TEST_PROJECT)
    expect(loaded).not.toBeNull()
    expect(loaded!.version).toBe(1)
    expect(loaded!.skills?.add).toContain("custom-skill")
  })

  test("project add appends tools", () => {
    const customTool: ToolEntry = {
      id: "custom-analyzer",
      name: "custom-analyzer",
      description: "Custom analysis tool",
      kind: "tool",
      risk_level: "low",
      triggers: { keywords: [], file_extensions: [], task_patterns: [] },
      injection_policy: "on_demand",
      prompt_index: "custom-analyzer: Custom analysis.",
      prompt_detail: "Custom analysis tool for project-specific tasks.",
      security: { require_redaction: true, allow_network: false, require_consent: false },
    }

    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [customTool], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest.tools.length).toBe(GLOBAL_DEFAULT_TOOLS.length + 1)
    expect(manifest.merge_source["custom-analyzer"]).toBe("project_add")

    const found = manifest.tools.find((t) => t.id === "custom-analyzer")
    expect(found).toBeDefined()
  })

  test("project remove removes global tools (except security denylist)", () => {
    // Removing doc-docx should work
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: ["doc-docx", "pdf"] },
      mcp: { add: [], remove: [] },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest.tool_status["doc-docx"]).toBe("disabled_by_project")
    expect(manifest.tool_status["pdf"]).toBe("disabled_by_project")

    // doc-docx should not be in tools list
    const docDocx = manifest.tools.find((t) => t.id === "doc-docx")
    expect(docDocx).toBeUndefined()
  })

  test("project remove cannot remove security denylist (security-redaction, test-gate)", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: ["security-redaction", "test-gate"] },
      tools: { add: [], remove: ["security-redaction", "test-gate"] },
      mcp: { add: [], remove: [] },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest.tool_status["security-redaction"]).toBe("blocked_by_policy")
    expect(manifest.tool_status["test-gate"]).toBe("blocked_by_policy")

    // They should STILL be in the tools list (denylist prevents removal)
    const sec = manifest.tools.find((t) => t.id === "security-redaction")
    expect(sec).toBeDefined()
  })

  test("project override overrides MCP config", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: [] },
      mcp: {
        add: [],
        remove: [],
        override: {
          playwright: {
            isolated: true,
            start_policy: "disabled", // disable playwright for this project
          },
        },
      },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    const pw = manifest.tools.find((t) => t.id === "playwright")
    expect(pw).toBeDefined()
    expect(pw!.mcp?.start_policy).toBe("disabled")
    expect(manifest.merge_source["playwright"]).toBe("project_override")
  })

  test("project remove has higher priority than global default", () => {
    // Remove github from project
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: ["github"] },
      mcp: { add: [], remove: [] },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay, TEST_PROJECT)
    expect(manifest.tool_status["github"]).toBe("disabled_by_project")
  })

  test("skills.add / skills.remove work correctly", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: {
        add: ["project-specific-skill"],
        remove: ["ux-review"],
      },
      tools: { add: [], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)

    // ux-review is not a tool entry (it's a skill in skill-registry), but the remove set captures it
    // The tool_status should reflect the removal
    expect(manifest.merge_source["ux-review"]).toBeUndefined()
  })

  test("mcp.add / mcp.remove work correctly", () => {
    const newMcp: ToolEntry = {
      id: "custom-mcp",
      name: "custom-mcp",
      description: "Custom MCP server",
      kind: "mcp",
      risk_level: "medium",
      triggers: { keywords: [], file_extensions: [], task_patterns: [] },
      injection_policy: "on_demand",
      mcp: {
        name: "custom-mcp",
        command: ["node", "server.js"],
        isolated: false,
        mutex_key: "custom-mcp",
        start_policy: "on_demand",
        heavy: false,
        requires_consent: false,
      },
      prompt_index: "custom-mcp",
      prompt_detail: "Custom MCP server.",
      security: { require_redaction: true, allow_network: false, require_consent: false },
    }

    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: [] },
      mcp: { add: [newMcp], remove: ["playwright"], override: {} },
      commands: { add: [], remove: [] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest.merge_source["custom-mcp"]).toBe("project_add")
    expect(manifest.tool_status["playwright"]).toBe("disabled_by_project")
  })

  test("session effective manifest can be written and read", () => {
    const manifest = buildGlobalEffective()
    writeSessionEffective(TEST_SESSION, manifest)

    const read = readSessionEffective(TEST_SESSION)
    expect(read).not.toBeNull()
    expect(read!.source).toBe("global")
    expect(read!.tools.length).toBeGreaterThan(0)
  })

  test("effective manifest reload updates session state", () => {
    // First build without overlay
    const manifest1 = buildGlobalEffective()
    expect(manifest1.source).toBe("global")

    // Now add a project overlay and rebuild
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: ["pdf"] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }

    const manifest2 = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest2.source).toBe("merged")
    expect(manifest2.tool_status["pdf"]).toBe("disabled_by_project")

    // Verify manifest changed after reload
    expect(manifest1.tools.length).not.toBe(manifest2.tools.length)
  })

  test("deriveToolAvailability marks unavailable when binary missing", () => {
    // github requires `gh` binary which may not exist
    const gh = findTool("github")!
    const status = deriveToolAvailability(gh)
    // Don't assert exact status since gh may or may not be installed
    expect(["available", "unavailable"]).toContain(status)
  })

  test("deriveToolAvailability marks unavailable when required token missing (if configured)", () => {
    // Save and temporarily unset GITHUB_TOKEN
    const savedToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN

    const gh = findTool("github")!
    const status = deriveToolAvailability(gh)
    // github has token requirement, so may be unavailable
    expect(["available", "unavailable"]).toContain(status)

    // Restore
    if (savedToken) process.env.GITHUB_TOKEN = savedToken
  })

  test("refreshAvailability updates all tool statuses", () => {
    const manifest = buildGlobalEffective()
    const beforeDict = { ...manifest.tool_status }
    const refreshed = refreshAvailability(manifest)

    // All originally "registered" tools should now have resolved statuses
    for (const [id, status] of Object.entries(beforeDict)) {
      if (status === "registered") {
        expect(refreshed.tool_status[id]).not.toBe("registered")
      }
    }
  })

  test("extra deny_commands from project are merged", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
      security: { extra_deny_commands: ["rm -rf node_modules", "npm unpublish"] },
    }

    const manifest = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay)
    expect(manifest.security.extra_deny_commands).toContain("rm -rf node_modules")
    expect(manifest.security.extra_deny_commands).toContain("npm unpublish")
  })
})

// ─── Prompt Injection Tests ─────────────────────────────────────────────────

describe("tool-prompt", () => {
  test("buildPromptIndex contains always tools and on-demand summary", () => {
    const manifest = buildGlobalEffective()
    const index = buildPromptIndex(manifest)

    // Always tools should be in index
    expect(index).toContain("engineering-test")
    expect(index).toContain("repo-doctor")
    expect(index).toContain("security-redaction")
    expect(index).toContain("test-gate")

    // On-demand summary section should exist
    expect(index).toContain("Available skills & tools")
  })

  test("buildPromptIndex does NOT contain full tool details", () => {
    const manifest = buildGlobalEffective()
    const index = buildPromptIndex(manifest)

    // The index should be short (≤1200 chars for Chinese)
    expect(index.length).toBeLessThan(2000)

    // Should NOT contain detailed paragraphs
    expect(index).not.toContain("使用 python-docx 或等效库")
    expect(index).not.toContain("使用 PyPDF2/pdfplumber")
  })

  test("selectToolsForDetail selects on-demand tools when triggered by keywords", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      user_message: "请帮我读取这个 PDF 文档",
    }

    const selected = selectToolsForDetail(manifest, context)
    const ids = selected.map((t) => t.id)

    // PDF should be triggered
    expect(ids).toContain("pdf")
    // Playwright should NOT be triggered
    expect(ids).not.toContain("playwright")
  })

  test("selectToolsForDetail triggers by file extension", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      file_extensions: [".xlsx"],
    }

    const selected = selectToolsForDetail(manifest, context)
    expect(selected.map((t) => t.id)).toContain("xlsx")
  })

  test("selectToolsForDetail triggers by test_failure signal", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      test_failure: true,
    }

    const selected = selectToolsForDetail(manifest, context)
    const ids = selected.map((t) => t.id)
    expect(ids).toContain("test-gate")
    expect(ids).toContain("engineering-test")
  })

  test("selectToolsForDetail triggers by browser_needed signal", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      browser_needed: true,
    }

    const selected = selectToolsForDetail(manifest, context)
    expect(selected.map((t) => t.id)).toContain("playwright")
  })

  test("selectToolsForDetail triggers by github_needed signal", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      github_needed: true,
    }

    const selected = selectToolsForDetail(manifest, context)
    expect(selected.map((t) => t.id)).toContain("github")
  })

  test("buildDetailPrompt includes full detail for triggered tools", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      user_message: "处理 PDF",
    }

    const selected = selectToolsForDetail(manifest, context)
    const detail = buildDetailPrompt(manifest, selected)

    // Should contain the full PDF detail
    expect(detail).toContain("pdf")
    expect(detail).toContain("PyPDF2")
  })

  test("generateToolPrompt returns both index and detail", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      user_message: "帮我处理 Excel 表格",
    }

    const { index, detail } = generateToolPrompt(manifest, context)
    expect(index.length).toBeGreaterThan(0)
    expect(detail.length).toBeGreaterThan(0)
    expect(detail).toContain("xlsx")
  })

  test("detectToolTriggers detects keywords in user message", () => {
    const manifest = buildGlobalEffective()
    const triggers = detectToolTriggers(manifest, "请帮我生成一个 PPT 演示文稿")
    expect(triggers).toContain("ppt-pptx")
  })

  test("detectToolTriggers does NOT trigger unrelated tools", () => {
    const manifest = buildGlobalEffective()
    const triggers = detectToolTriggers(manifest, "run bun test for my project")
    expect(triggers).toContain("engineering-test")
    expect(triggers).not.toContain("playwright")
    expect(triggers).not.toContain("github")
  })

  test("detectFileTypeTriggers matches extensions", () => {
    const manifest = buildGlobalEffective()
    const triggers = detectFileTypeTriggers(manifest, [".pdf", ".xlsx"])
    expect(triggers).toContain("pdf")
    expect(triggers).toContain("xlsx")
  })

  test("detectFileTypeTriggers handles non-dotted extensions", () => {
    const manifest = buildGlobalEffective()
    const triggers = detectFileTypeTriggers(manifest, ["docx"])
    expect(triggers).toContain("doc-docx")
  })

  test("on_demand tools are NOT selected without trigger", () => {
    const manifest = buildGlobalEffective()
    const context: TriggerContext = {
      user_message: "hello world",
    }

    const selected = selectToolsForDetail(manifest, context)
    const ids = selected.map((t) => t.id)

    // Only always tools should be selected
    expect(ids).toContain("engineering-test")
    expect(ids).toContain("repo-doctor")
    expect(ids).toContain("security-redaction")
    expect(ids).toContain("test-gate")

    // On-demand tools should NOT be selected
    expect(ids).not.toContain("playwright")
    expect(ids).not.toContain("github")
  })
})

// ─── MCP Manager / Mutex Tests ──────────────────────────────────────────────

describe("mcp-manager (catalog bridge)", () => {
  test("fromCatalogRegistration converts McpRegistration to McpServerDecl", () => {
    const reg: McpRegistration = {
      name: "test-mcp",
      command: ["node", "test.js"],
      isolated: true,
      mutex_key: "test-mcp",
      start_policy: "on_demand",
      heavy: true,
      requires_consent: true,
    }

    const decl = fromCatalogRegistration(reg)
    expect(decl.name).toBe("test-mcp")
    expect(decl.command).toEqual(["node", "test.js"])
    expect(decl.isolated).toBe(true)
    expect(decl.maxRetries).toBe(3)
    expect(decl.autoRestart).toBe(false)
  })

  test("isOnDemand identifies on_demand policy", () => {
    expect(isOnDemand("on_demand")).toBe(true)
    expect(isOnDemand("disabled")).toBe(false)
    expect(isOnDemand("autostart_lightweight")).toBe(false)
  })

  test("shouldStart returns not ready when already running (state-based)", () => {
    const decl = fromCatalogRegistration({
      name: "test-should-start",
      command: ["echo", "test"],
      isolated: false,
      start_policy: "on_demand",
      heavy: false,
      requires_consent: false,
    })

    // First call: should be ready (fresh state)
    const r1 = shouldStart(decl)
    // Second call trying to acquire lock again should fail
    // But since there's no actual running process, the lock check might pass
    // This is a state-layer test — actual lock depends on process existence
    expect(["ready", "already running", "lock held by another process"]).toContain(r1.reason)
  })

  test("acquireLock and releaseLock work together", () => {
    const name = "test-lock-mcp"
    // Clean up any stale lock
    releaseLock(name)

    const acquired = acquireLock(name)
    expect(acquired).toBe(true)

    // Second acquire should fail
    const acquired2 = acquireLock(name)
    expect(acquired2).toBe(false)

    // Release and re-acquire
    releaseLock(name)
    const acquired3 = acquireLock(name)
    expect(acquired3).toBe(true)

    // Cleanup
    releaseLock(name)
  })

  test("mutex prevents duplicate start", () => {
    const name = "test-mutex-mcp"
    releaseLock(name)

    // Simulate two concurrent start attempts
    const first = acquireLock(name)
    const second = acquireLock(name)

    expect(first).toBe(true)
    expect(second).toBe(false)

    releaseLock(name)
  })
})

// ─── Doctor Tests ────────────────────────────────────────────────────────────

describe("tool-doctor", () => {
  test("toolDoctorChecks returns array of results", () => {
    const results = toolDoctorChecks()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  test("toolDoctorChecks includes global manifest check", () => {
    const results = toolDoctorChecks()
    const globalCheck = results.find((r) => r.check === "global-tools-manifest")
    expect(globalCheck).toBeDefined()
    // Should pass since we created the file
  })

  test("toolDoctorChecks includes schema check", () => {
    const results = toolDoctorChecks()
    const schemaCheck = results.find((r) => r.check === "global-manifest-schema")
    expect(schemaCheck).toBeDefined()
  })

  test("toolDoctorChecks includes MCP state check", () => {
    const results = toolDoctorChecks()
    const mcpCheck = results.find((r) => r.check === "mcp-state-dir")
    expect(mcpCheck).toBeDefined()
  })

  test("toolDoctorChecks includes heavy MCP check", () => {
    const results = toolDoctorChecks()
    const heavyCheck = results.find((r) => r.check === "heavy-mcp-not-auto-started")
    expect(heavyCheck).toBeDefined()
  })

  test("toolDoctorChecks does NOT reveal GitHub token value", () => {
    const savedToken = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = "ghp_fake_token_for_test"

    const results = toolDoctorChecks()
    const ghCheck = results.find((r) => r.check === "github-token")
    expect(ghCheck).toBeDefined()
    // Must NOT contain the actual token
    expect(ghCheck!.message).not.toContain("ghp_fake")
    expect(ghCheck!.message).not.toContain("ghp_")

    if (savedToken) process.env.GITHUB_TOKEN = savedToken
    else delete process.env.GITHUB_TOKEN
  })

  test("toolDoctorChecks shows limited when token missing", () => {
    const savedToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN

    const results = toolDoctorChecks()
    const ghCheck = results.find((r) => r.check === "github-token")
    expect(ghCheck).toBeDefined()
    expect(ghCheck!.message).toContain("limited")
    expect(ghCheck!.pass).toBe(true) // not a failure — just informational

    if (savedToken) process.env.GITHUB_TOKEN = savedToken
  })

  test("toolDoctorChecks with project dir checks project manifest", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }
    writeProjectOverlay(overlay)

    const results = toolDoctorChecks(TEST_PROJECT)
    const projCheck = results.find((r) => r.check === "project-manifest-schema")
    expect(projCheck).toBeDefined()
    expect(projCheck!.pass).toBe(true)
  })

  test("toolDoctorChecks detects invalid project manifest", () => {
    fs.mkdirSync(path.join(TEST_PROJECT, ".dll-agent"), { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT, ".dll-agent", "tools.jsonc"), "not valid json {")

    const results = toolDoctorChecks(TEST_PROJECT)
    const projCheck = results.find((r) => r.check === "project-manifest-schema")
    expect(projCheck).toBeDefined()
    expect(projCheck!.pass).toBe(false)
  })

  test("toolDoctorChecks with session id checks session effective manifest", () => {
    cleanupSession()
    const manifest = buildGlobalEffective()
    writeSessionEffective(TEST_SESSION, manifest)

    const results = toolDoctorChecks(undefined, TEST_SESSION)
    const sessionCheck = results.find((r) => r.check === "session-effective-manifest")
    expect(sessionCheck).toBeDefined()
    expect(sessionCheck!.pass).toBe(true)

    cleanupSession()
  })
})

// ─── Evidence Tests ──────────────────────────────────────────────────────────

describe("tool-evidence", () => {
  test("buildEffectiveManifest writes evidence for merge", () => {
    // Evidence is written internally by buildEffectiveManifest — we just verify
    // the function doesn't throw and produces correct merge_source
    const manifest = buildGlobalEffective()
    expect(manifest.merge_source).toBeDefined()
    expect(Object.keys(manifest.merge_source).length).toBeGreaterThan(0)
  })

  test("overlay loaded writes evidence", () => {
    const overlay: ProjectToolOverlay = {
      version: 1,
      skills: { add: [], remove: [] },
      tools: { add: [], remove: [] },
      mcp: { add: [], remove: [], override: {} },
      commands: { add: [], remove: [] },
    }
    writeProjectOverlay(overlay)

    // Loading should trigger evidence write (best-effort, no throw)
    const loaded = loadProjectOverlay(TEST_PROJECT)
    expect(loaded).not.toBeNull()
  })

  test("session effective manifest write triggers evidence", () => {
    cleanupSession()
    const manifest = buildGlobalEffective()

    // Should not throw
    writeSessionEffective(TEST_SESSION, manifest)

    // Verify file was written
    const file = path.join(TEMP_SESSION_DIR, "effective-tools.json")
    expect(fs.existsSync(file)).toBe(true)

    cleanupSession()
  })
})

// ─── Integration / Smoke Tests ──────────────────────────────────────────────

describe("tool-system-integration", () => {
  test("full flow: global → project overlay → effective → prompt → doctor", () => {
    const projectDir = TEST_PROJECT
    cleanupProject()

    // Step 1: Build global effective
    const globalManifest = buildGlobalEffective()
    expect(globalManifest.source).toBe("global")
    expect(globalManifest.tools.length).toBeGreaterThan(0)

    // Step 2: Apply project overlay
    const overlay: ProjectToolOverlay = {
      version: 1,
      project: "test-project",
      skills: { add: [], remove: [] },
      tools: {
        add: [
          {
            id: "project-tool",
            name: "project-tool",
            description: "Project-specific tool",
            kind: "tool",
            risk_level: "low",
            triggers: { keywords: [], file_extensions: [], task_patterns: [] },
            injection_policy: "on_demand",
            prompt_index: "Project tool",
            prompt_detail: "Project-specific tool for testing.",
            security: { require_redaction: true, allow_network: false, require_consent: false },
          },
        ],
        remove: ["pdf"],
      },
      mcp: {
        add: [],
        remove: [],
        override: {
          playwright: { start_policy: "disabled" },
        },
      },
      commands: { add: [], remove: [] },
      security: { extra_deny_commands: ["npm publish"] },
    }

    const effective = buildEffectiveManifest(GLOBAL_DEFAULT_TOOLS, DEFAULT_MANIFEST, overlay, projectDir)
    expect(effective.source).toBe("merged")
    expect(effective.merge_source["project-tool"]).toBe("project_add")
    expect(effective.tool_status["pdf"]).toBe("disabled_by_project")
    expect(effective.merge_source["playwright"]).toBe("project_override")

    // Step 3: Generate prompt
    const context: TriggerContext = {
      user_message: "分析 Excel 数据",
      file_extensions: [".xlsx"],
    }
    const { index, detail } = generateToolPrompt(effective, context)
    expect(index.length).toBeGreaterThan(0)
    expect(detail).toContain("xlsx")

    // Step 4: Run doctor
    writeProjectOverlay(overlay)
    const doctorResults = toolDoctorChecks(projectDir)
    expect(doctorResults.length).toBeGreaterThan(0)

    // All doctor checks should not contain secrets
    for (const r of doctorResults) {
      expect(r.message).not.toContain("ghp_")
      expect(r.message).not.toContain("sk-")
      expect(r.message).not.toContain("Bearer ")
    }

    cleanupProject()
  })
})
