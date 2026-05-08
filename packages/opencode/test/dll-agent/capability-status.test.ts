import { describe, expect, test } from "bun:test"
import {
  buildCapabilitySidebarStatus,
  buildCapabilityStatusReport,
  renderCapabilityStatus,
} from "../../src/dll-agent/capability-status"

describe("capability-status", () => {
  test("buildCapabilityStatusReport reads real registry and runtime state", () => {
    const report = buildCapabilityStatusReport(process.cwd())
    expect(report.total).toBeGreaterThan(0)
    expect(report.by_kind).toBeDefined()
    expect(report.by_status).toBeDefined()
    expect(Array.isArray(report.pending_permission)).toBe(true)
  })

  test("renderCapabilityStatus returns direct status text", () => {
    const text = renderCapabilityStatus(process.cwd())
    expect(text).toContain("dll-agent capability status")
    expect(text).toContain("by kind:")
    expect(text).toContain("runtime:")
    expect(text).not.toContain("Use the capability planner")
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
