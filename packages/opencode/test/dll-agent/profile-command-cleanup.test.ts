import { afterEach, describe, expect, it } from "bun:test"
import { modeSummary, roleCommands, systemPrompt } from "../../src/dll-agent/profile"

const removedPromptOnlyCommands = [
  "role-model-reset",
  "role-model-test",
  "role-model-fallback-add",
  "role-model-fallback-remove",
  "multimodal-context-test",
  "tools",
  "tools-reload",
  "tools-status",
  "mcp-status",
  "mcp-start",
  "mcp-stop",
  "mcp-health",
  "capabilities",
  "capability-discover",
  "capability-plan",
  "capability-refresh",
  "capability-doctor",
]

describe("dll-agent profile command cleanup", () => {
  afterEach(() => {
    delete process.env.DLL_AGENT_ENABLED
    delete process.env.DLL_AGENT_ROLE_ROSTER
  })

  it("does not register prompt-only mutation/status commands as dll-agent role commands", () => {
    const commands = roleCommands()
    for (const name of removedPromptOnlyCommands) {
      expect(commands).not.toHaveProperty(name)
    }
  })

  it("keeps only current runtime-backed or active reviewer commands in the summary", () => {
    const summary = modeSummary()
    expect(summary.commands).toContain("permissions")
    expect(summary.commands).toContain("role-model-set")
    expect(summary.commands).toContain("task-status")
    expect(summary.commands).toContain("capability-status")
    for (const name of removedPromptOnlyCommands) {
      expect(summary.commands).not.toContain(name)
    }
  })

  it("does not advertise removed prompt-only commands in the system prompt", () => {
    process.env.DLL_AGENT_ENABLED = "1"
    const prompt = systemPrompt() ?? ""
    expect(prompt).toContain("/permissions")
    expect(prompt).toContain("/role-model-set")
    for (const name of removedPromptOnlyCommands) {
      expect(prompt).not.toContain(`/${name}`)
    }
  })

  it("does not treat legacy DLL_AGENT_ROLE_ROSTER as an enable switch", () => {
    process.env.DLL_AGENT_ROLE_ROSTER = "commander=legacy/model"
    expect(systemPrompt()).toBeUndefined()
  })
})
