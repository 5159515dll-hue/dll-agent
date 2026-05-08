import { describe, test, expect } from "bun:test"
import {
  CAPABILITY_ORCHESTRATOR_VERSION,
  formatCapabilitySystemSummary,
  orchestrateCapabilities,
} from "../../src/dll-agent/capability-orchestrator"

describe("capability-orchestrator", () => {
  test("selects and prepares Playwright MCP for browser click-through work", () => {
    const result = orchestrateCapabilities({
      projectDir: process.cwd(),
      userGoal: "Full CRM browser click-through audit with console and network inspection",
      messageID: "msg_browser",
      allowMcpAutoConnect: true,
      recordEvidence: false,
    })

    expect(result.version).toBe(CAPABILITY_ORCHESTRATOR_VERSION)
    expect(result.plan.required_tags).toContain("browser-automation")
    expect(result.plan.selected.some((m) => m.entry.id === "playwright")).toBe(true)
    const request = result.mcpRequests.find((m) => m.entry_id === "playwright")
    expect(request).toBeDefined()
    expect(request!.auto_connect).toBe(true)
    expect(request!.config.type).toBe("local")
    expect(request!.config.command[0]).toBe("npx")
    expect(request!.config.command).toContain("-y")
    expect(result.systemSummary).toContain("capability plan")
  })

  test("does not auto-connect browser MCP when task mentions credential risk", () => {
    const result = orchestrateCapabilities({
      projectDir: process.cwd(),
      userGoal: "Use browser automation with cookies and password login session",
      messageID: "msg_sensitive",
      allowMcpAutoConnect: true,
      recordEvidence: false,
    })

    const request = result.mcpRequests.find((m) => m.entry_id === "playwright")
    expect(request).toBeDefined()
    expect(request!.auto_connect).toBe(false)
    expect(request!.requires_consent).toBe(true)
    expect(result.blockedReasons.some((r) => r.includes("playwright"))).toBe(true)
  })

  test("does auto-connect browser MCP when unrelated SSH baseline is in task plan", () => {
    const result = orchestrateCapabilities({
      projectDir: process.cwd(),
      userGoal: [
        "Full CRM browser click-through audit",
        "Part 1: Baseline verification - SSH to server, check HEAD, alembic, healthz",
        "Part 3: Core sales-domain flows - browser click-through testing",
        "Part 8: Browser and network requirements - console/network error recording",
      ].join("\n"),
      messageID: "msg_browser_with_ssh",
      allowMcpAutoConnect: true,
      recordEvidence: false,
    })

    const request = result.mcpRequests.find((m) => m.entry_id === "playwright")
    expect(request).toBeDefined()
    expect(request!.auto_connect).toBe(true)
    expect(result.blockedReasons.some((r) => r.includes("playwright"))).toBe(false)
  })

  test("returns skill intents from selected capability tags", () => {
    const result = orchestrateCapabilities({
      projectDir: process.cwd(),
      userGoal: "run typecheck and bun test for dll-agent",
      messageID: "msg_test",
      recordEvidence: false,
    })

    expect(result.skillIntents).toContain("typecheck")
    expect(result.toolPromptTags.length).toBeGreaterThan(0)
  })

  test("system summary is bounded", () => {
    const result = orchestrateCapabilities({
      projectDir: process.cwd(),
      userGoal: "browser automation ".repeat(100),
      messageID: "msg_long",
      recordEvidence: false,
    })

    const summary = formatCapabilitySystemSummary(result, 160)
    expect(summary.length).toBeLessThanOrEqual(160)
  })
})
