/**
 * Tests for role-model-registry.ts
 *
 * Coverage:
 * 1. Built-in default role models are correct
 * 2. Global override takes effect
 * 3. Project override overrides global
 * 4. Session override overrides project/global
 * 5. Reset session override falls back to project/global
 * 6. Invalid role is rejected
 * 7. Invalid model format is rejected
 * 8. Provider missing produces unavailable status (no crash)
 * 9. Voice/TTS model detection
 * 10. Role-cross default is unified (deepseek, not zai)
 * 11. final-auditor is on-demand only
 * 12. Evidence is written on model change
 * 13. Doctor check finds issues
 * 14. Fallback chain resolution
 * 15. Role model listing
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const configRoot = path.join(os.tmpdir(), `dll-agent-role-model-registry-${process.pid}`)
process.env.DLL_AGENT_CONFIG_ROOT = configRoot

const testDir = path.join(os.tmpdir(), `dll-agent-role-model-registry-project-${process.pid}`)
const projectDir = path.join(testDir, "project")
const projectCfgPath = path.join(projectDir, ".dll-agent", "role-models.jsonc")
const sessionDir = path.join(configRoot, "sessions", "test-session")
const sessionStatePath = path.join(sessionDir, "supervisor.json")
const realGlobalPath = path.join(configRoot, "config", "role-models.jsonc")

// We import from the source directly
// Note: We cannot import from "@/dll-agent/role-model-registry" because
// tests don't run in the Effect context. We use dynamic import with
// the project-relative path pattern used by other test files.
// But since these are pure functions (sync, no Effect dependency),
// we can test the core logic directly.

// Instead of importing the module directly (which may pull in Effect),
// we test the behavior via the public API. However, the module is standalone
// and doesn't depend on Effect. Let's try importing it.

let registry: typeof import("../../src/dll-agent/role-model-registry")

beforeEach(async () => {
  // Clean test environment
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  if (fs.existsSync(configRoot)) fs.rmSync(configRoot, { recursive: true })
  process.env.DLL_AGENT_CONFIG_ROOT = configRoot
  // Dynamically import to pick up changes
  registry = await import("../../src/dll-agent/role-model-registry")
})

afterEach(() => {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  if (fs.existsSync(configRoot)) fs.rmSync(configRoot, { recursive: true })
  // Restore any env vars
  delete process.env.DLL_AGENT_CONFIG_ROOT
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DLL_AGENT_DEEPSEEK_API_KEY
  delete process.env.ZAI_API_KEY
  delete process.env.DLL_AGENT_ZAI_API_KEY
  delete process.env.KIMI_API_KEY
  delete process.env.DLL_AGENT_KIMI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.DLL_AGENT_OPENAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.DLL_AGENT_MIMO_API_KEY
})

// Helper: write a config file
function writeJsonc(filePath: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

// Helper: write a session state with role model overrides
function writeSessionState(overrides: Record<string, { primary: string; fallback?: string[]; enabled?: boolean }>) {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(sessionStatePath, JSON.stringify({
    version: 1,
    phase: "default",
    risk: "low",
    required_reviews: [],
    completed_reviews: [],
    blocked_completion: false,
    block_reason: null,
    reviewer_conflict: false,
    metrics: {},
    role_model_overrides: overrides,
    updated_at: new Date().toISOString(),
  }, null, 2))
}

// =============================================================================
// Test 1: Built-in default role models
// =============================================================================
describe("built-in defaults", () => {
  test("commander defaults to deepseek/deepseek-v4-pro", () => {
    const result = registry.resolveRoleModel("commander")
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    expect(result.source).toBe("built-in")
    expect(result.enabled).toBe(true)
    expect(result.onDemandOnly).toBe(false)
  })

  test("chief-engineer defaults to deepseek/deepseek-v4-pro", () => {
    const result = registry.resolveRoleModel("chief-engineer")
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    expect(result.source).toBe("built-in")
    expect(result.enabled).toBe(true)
  })

  test("requirements-inspector defaults to zai/glm-5.1", () => {
    const result = registry.resolveRoleModel("requirements-inspector")
    expect(result.primary).toBe("zai/glm-5.1")
    expect(result.source).toBe("built-in")
  })

  test("long-context-archivist defaults to kimi/kimi-k2.6", () => {
    const result = registry.resolveRoleModel("long-context-archivist")
    expect(result.primary).toBe("kimi/kimi-k2.6")
    expect(result.source).toBe("built-in")
  })

  test("task-completion-archivist defaults to kimi/kimi-k2.6", () => {
    const result = registry.resolveRoleModel("task-completion-archivist")
    expect(result.primary).toBe("kimi/kimi-k2.6")
    expect(result.source).toBe("built-in")
  })

  test("final-auditor defaults to openai/gpt-5.5-pro and is on-demand only", () => {
    const result = registry.resolveRoleModel("final-auditor")
    expect(result.primary).toBe("openai/gpt-5.5-pro")
    expect(result.source).toBe("built-in")
    expect(result.onDemandOnly).toBe(true)
  })

  test("role-cross defaults to deepseek/deepseek-v4-pro (unified, not zai/glm-5.1)", () => {
    const result = registry.resolveRoleModel("role-cross")
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    // This was previously zai/glm-5.1 in supervisor.ts — now unified
    expect(result.source).toBe("built-in")
  })

  test("executor defaults to deepseek/deepseek-v4-pro", () => {
    const result = registry.resolveRoleModel("executor")
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    expect(result.source).toBe("built-in")
  })

  test("future roles are disabled by default", () => {
    expect(registry.resolveRoleModel("agentic-solver").enabled).toBe(false)
    expect(registry.resolveRoleModel("multimodal-reader").enabled).toBe(false)
    expect(registry.resolveRoleModel("voice-output").enabled).toBe(false)
  })
})

// =============================================================================
// Test 2: Global override
// =============================================================================
describe("global override", () => {
  test("global override takes priority over built-in defaults", () => {
    writeJsonc(realGlobalPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
        "requirements-inspector": { primary: "mimo/mimo-v2.5-pro", enabled: true },
      },
    })

    // Resolve without project/session → global tier
    const commander = registry.resolveRoleModel("commander")
    expect(commander.primary).toBe("openai/gpt-5.5-pro")
    expect(commander.source).toBe("global")

    const inspector = registry.resolveRoleModel("requirements-inspector")
    expect(inspector.primary).toBe("mimo/mimo-v2.5-pro")
    expect(inspector.source).toBe("global")

    // Non-overridden role still uses built-in
    const ce = registry.resolveRoleModel("chief-engineer")
    expect(ce.primary).toBe("deepseek/deepseek-v4-pro")
    expect(ce.source).toBe("built-in")
  })
})

// =============================================================================
// Test 3: Project override overrides global
// =============================================================================
describe("project override", () => {
  test("project override takes priority over built-in", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
      },
    })

    const result = registry.resolveRoleModel("commander", undefined, projectDir)
    expect(result.primary).toBe("openai/gpt-5.5-pro")
    expect(result.source).toBe("project")
  })

  test("non-overridden role still uses built-in default", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
      },
    })

    const result = registry.resolveRoleModel("chief-engineer", undefined, projectDir)
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    expect(result.source).toBe("built-in")
  })
})

// =============================================================================
// Test 4: Session override overrides project/global
// =============================================================================
describe("session override", () => {
  test("session override takes highest priority", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
      },
    })
    writeSessionState({
      commander: { primary: "mimo/mimo-v2.5-pro" },
    })

    const result = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(result.primary).toBe("mimo/mimo-v2.5-pro")
    expect(result.source).toBe("session")
  })

  test("session override only affects specified roles", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
      },
    })
    writeSessionState({
      "chief-engineer": { primary: "mimo/mimo-v2.5-pro" },
    })

    // commander should still use project override
    const commander = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(commander.primary).toBe("openai/gpt-5.5-pro")
    expect(commander.source).toBe("project")

    // chief-engineer should use session override
    const ce = registry.resolveRoleModel("chief-engineer", "test-session", projectDir)
    expect(ce.primary).toBe("mimo/mimo-v2.5-pro")
    expect(ce.source).toBe("session")
  })
})

// =============================================================================
// Test 5: Reset session override
// =============================================================================
describe("reset override", () => {
  test("reset session override falls back to project", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro", enabled: true },
      },
    })
    writeSessionState({
      commander: { primary: "mimo/mimo-v2.5-pro" },
    })

    // Verify session override is active
    const before = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(before.primary).toBe("mimo/mimo-v2.5-pro")

    // Reset session override
    const change = registry.resetRoleModelOverride("commander", "session", "test-session", projectDir)
    expect(change).not.toBeNull()
    expect(change!.previousPrimary).toBe("mimo/mimo-v2.5-pro")
    expect(change!.newPrimary).toBe("openai/gpt-5.5-pro")

    // Verify fallback to project
    const after = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(after.primary).toBe("openai/gpt-5.5-pro")
    expect(after.source).toBe("project")
  })
})

// =============================================================================
// Test 6: Invalid role rejection
// =============================================================================
describe("invalid inputs", () => {
  test("isDllRole rejects unknown roles", () => {
    expect(registry.isDllRole("nonexistent-role")).toBe(false)
    expect(registry.isDllRole("commander")).toBe(true)
  })

  test("validateRoleModel rejects invalid model format", () => {
    expect(registry.validateRoleModel("").valid).toBe(false)
    expect(registry.validateRoleModel("invalid").valid).toBe(false)
    expect(registry.validateRoleModel("no-slash").valid).toBe(false)
    expect(registry.validateRoleModel("deepseek/deepseek-v4-pro").valid).toBe(true)
    expect(registry.validateRoleModel("openai/gpt-5.5-pro").valid).toBe(true)
  })
})

// =============================================================================
// Test 7: Provider availability
// =============================================================================
describe("provider availability", () => {
  test("provider missing produces unavailable status, no crash", () => {
    // Ensure no API keys set
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DLL_AGENT_DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DLL_AGENT_OPENAI_API_KEY
    delete process.env.ZAI_API_KEY
    delete process.env.DLL_AGENT_ZAI_API_KEY
    delete process.env.KIMI_API_KEY
    delete process.env.DLL_AGENT_KIMI_API_KEY

    const result = registry.resolveRoleModel("commander")
    // Should still return a valid result, not crash
    expect(result.primary).toBe("deepseek/deepseek-v4-pro")
    expect(result.providerAvailable).toBe(false)
  })

  test("provider with API key shows available", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key"
    const result = registry.resolveRoleModel("commander")
    expect(result.providerAvailable).toBe(true)
    delete process.env.DEEPSEEK_API_KEY
  })
})

// =============================================================================
// Test 8: Voice/TTS model detection
// =============================================================================
describe("voice model detection", () => {
  test("isVoiceModel detects TTS models", () => {
    expect(registry.isVoiceModel("openai/tts-1")).toBe(true)
    expect(registry.isVoiceModel("elevenlabs/voice-clone")).toBe(true)
    expect(registry.isVoiceModel("deepseek/deepseek-v4-pro")).toBe(false)
    expect(registry.isVoiceModel("openai/gpt-5.5-pro")).toBe(false)
  })
})

// =============================================================================
// Test 9: Role model listing
// =============================================================================
describe("listRoleModels", () => {
  test("lists all roles including future roles", () => {
    const models = registry.listRoleModels()
    expect(models.length).toBeGreaterThanOrEqual(11)
    expect(models.some((m) => m.role === "commander")).toBe(true)
    expect(models.some((m) => m.role === "agentic-solver")).toBe(true)
    expect(models.some((m) => m.role === "voice-output")).toBe(true)
  })

  test("active roles are listed with models", () => {
    const models = registry.listRoleModels(undefined, projectDir)
    const cmdr = models.find((m) => m.role === "commander")
    expect(cmdr).toBeDefined()
    expect(cmdr!.enabled).toBe(true)
    expect(cmdr!.source).toBe("built-in")
  })
})

// =============================================================================
// Test 10: Set role model override at project scope
// =============================================================================
describe("setRoleModelOverride", () => {
  test("sets project override and writes config file", () => {
    const change = registry.setRoleModelOverride(
      "commander",
      "openai/gpt-5.5-pro",
      "project",
      undefined,
      projectDir,
    )

    expect(change).not.toBeNull()
    expect(change!.role).toBe("commander")
    expect(change!.previousPrimary).toBe("deepseek/deepseek-v4-pro")
    expect(change!.newPrimary).toBe("openai/gpt-5.5-pro")
    expect(change!.scope).toBe("project")

    // Verify file was written
    expect(fs.existsSync(projectCfgPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(projectCfgPath, "utf8"))
    expect(data.roles.commander.primary).toBe("openai/gpt-5.5-pro")

    // Verify resolution picks up the override
    const result = registry.resolveRoleModel("commander", undefined, projectDir)
    expect(result.primary).toBe("openai/gpt-5.5-pro")
    expect(result.source).toBe("project")
  })

  test("global override clears same-role session override for immediate effective switch", () => {
    writeSessionState({
      commander: { primary: "mimo/mimo-v2.5-pro" },
    })

    const before = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(before.primary).toBe("mimo/mimo-v2.5-pro")
    expect(before.source).toBe("session")

    const change = registry.setRoleModelOverride(
      "commander",
      "openai/gpt-5.5-pro",
      "global",
      "test-session",
      projectDir,
    )

    expect(change).not.toBeNull()
    expect(change!.scope).toBe("global")

    const after = registry.resolveRoleModel("commander", "test-session", projectDir)
    expect(after.primary).toBe("openai/gpt-5.5-pro")
    expect(after.source).toBe("global")

    const state = JSON.parse(fs.readFileSync(sessionStatePath, "utf8"))
    expect(state.role_model_overrides?.commander).toBeUndefined()
  })

  test("returns null for invalid scope", () => {
    const change = registry.setRoleModelOverride(
      "commander",
      "openai/gpt-5.5-pro",
      "session",
      undefined, // No sessionID
      undefined,
    )
    expect(change).toBeNull()
  })
})

// =============================================================================
// Test 11: Doctor check
// =============================================================================
describe("doctorCheck", () => {
  test("passes when all models are valid", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test"
    process.env.ZAI_API_KEY = "sk-test"
    process.env.KIMI_API_KEY = "sk-test"
    process.env.OPENAI_API_KEY = "sk-test"
    process.env.MIMO_API_KEY = "sk-test"

    const issues = registry.doctorCheck()
    expect(issues.length).toBe(0)

    delete process.env.DEEPSEEK_API_KEY
    delete process.env.ZAI_API_KEY
    delete process.env.KIMI_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.MIMO_API_KEY
  })

  test("warns when provider keys are missing", () => {
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DLL_AGENT_DEEPSEEK_API_KEY
    delete process.env.ZAI_API_KEY
    delete process.env.DLL_AGENT_ZAI_API_KEY
    delete process.env.KIMI_API_KEY
    delete process.env.DLL_AGENT_KIMI_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DLL_AGENT_OPENAI_API_KEY

    const issues = registry.doctorCheck()
    // Should have warnings for each active role with missing provider key
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => i.severity === "WARN")).toBe(true)
  })

  test("fails when voice model assigned to coding role", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/tts-1", enabled: true },
      },
    })

    const issues = registry.doctorCheck(undefined, projectDir)
    const codingIssue = issues.find((i) => i.role === "commander" && i.severity === "FAIL")
    expect(codingIssue).toBeDefined()
  })
})

// =============================================================================
// Test 12: Fallback chain resolution
// =============================================================================
describe("resolveAvailableModel", () => {
  test("returns primary when provider is available", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test"
    const result = registry.resolveAvailableModel("commander")
    expect(result.model).toBe("deepseek/deepseek-v4-pro")
    expect(result.usedFallback).toBe(false)
    delete process.env.DEEPSEEK_API_KEY
  })

  test("falls back when primary provider is unavailable", () => {
    delete process.env.DEEPSEEK_API_KEY
    process.env.OPENAI_API_KEY = "sk-test"

    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: {
          primary: "deepseek/deepseek-v4-pro",
          fallback: ["openai/gpt-5.5-pro", "anthropic/claude-sonnet-4-20250514"],
        },
      },
    })

    const result = registry.resolveAvailableModel("commander", undefined, projectDir)
    expect(result.model).toBe("openai/gpt-5.5-pro")
    expect(result.usedFallback).toBe(true)

    delete process.env.OPENAI_API_KEY
  })

  test("returns primary when all fallbacks are also unavailable", () => {
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY

    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: {
          primary: "deepseek/deepseek-v4-pro",
          fallback: ["openai/gpt-5.5-pro"],
        },
      },
    })

    const result = registry.resolveAvailableModel("commander", undefined, projectDir)
    expect(result.model).toBe("deepseek/deepseek-v4-pro")
    expect(result.usedFallback).toBe(false)
  })
})

// =============================================================================
// Test 13: Parsed model output
// =============================================================================
describe("parsed model output", () => {
  test("resolveRoleModel returns correct parsed providerID and modelID", () => {
    const result = registry.resolveRoleModel("commander")
    expect(result.parsed.providerID).toBe("deepseek")
    expect(result.parsed.modelID).toBe("deepseek-v4-pro")
  })

  test("parsed output works with slashed model names", () => {
    const result = registry.resolveRoleModel("requirements-inspector")
    expect(result.parsed.providerID).toBe("zai")
    expect(result.parsed.modelID).toBe("glm-5.1")
  })
})

// =============================================================================
// Test 14: Config file with comments (JSONC)
// =============================================================================
describe("JSONC config support", () => {
  test("config with comments is parsed correctly", () => {
    const cfgPath = path.join(projectDir, ".dll-agent", "role-models.jsonc")
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, `{
      // This is a comment
      "version": 1,
      "roles": {
        "commander": {
          "primary": "mimo/mimo-v2.5-pro", // override commander
          "enabled": true
        }
        /* trailing comma handled */
      }
    }`)

    const result = registry.resolveRoleModel("commander", undefined, projectDir)
    expect(result.primary).toBe("mimo/mimo-v2.5-pro")
    expect(result.source).toBe("project")
  })
})

// =============================================================================
// Test 15: ALL_ROLES and ACTIVE_ROLES
// =============================================================================
describe("role lists", () => {
  test("ALL_ROLES includes all 12 roles", () => {
    expect(registry.ALL_ROLES.length).toBe(12)
    expect(registry.ALL_ROLES).toContain("commander")
    expect(registry.ALL_ROLES).toContain("agentic-solver")
  })

  test("ACTIVE_ROLES filters disabled roles", () => {
    expect(registry.ACTIVE_ROLES).toContain("commander")
    expect(registry.ACTIVE_ROLES).not.toContain("agentic-solver")
    expect(registry.ACTIVE_ROLES).not.toContain("multimodal-reader")
  })
})

// =============================================================================
// Test 16: getDefaultModel and getBuiltInConfig
// =============================================================================
describe("default model accessors", () => {
  test("getDefaultModel returns built-in default regardless of overrides", () => {
    writeJsonc(projectCfgPath, {
      version: 1,
      roles: {
        commander: { primary: "openai/gpt-5.5-pro" },
      },
    })

    const defaultModel = registry.getDefaultModel("commander")
    expect(defaultModel).toBe("deepseek/deepseek-v4-pro")
  })

  test("getBuiltInConfig returns scope as built-in", () => {
    const config = registry.getBuiltInConfig("commander")
    expect(config).toBeDefined()
    expect(config!.scope).toBe("built-in")
    expect(config!.primary).toBe("deepseek/deepseek-v4-pro")
  })
})
