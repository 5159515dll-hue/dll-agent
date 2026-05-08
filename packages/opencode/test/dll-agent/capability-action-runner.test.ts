import { describe, test, expect } from "bun:test"
import { runCapabilityActions } from "../../src/dll-agent/capability-action-runner"
import type { CapabilityAction } from "../../src/dll-agent/capability-orchestrator"
import { loadResults } from "../../src/dll-agent/result-ledger"

function action(overrides: Partial<CapabilityAction>): CapabilityAction {
  return {
    type: "auto_install",
    entry_id: "cap",
    risk_level: "low",
    reason: "test",
    auto_allowed: true,
    install_command: ["bun", "add", "-d", "cap"],
    ...overrides,
  }
}

describe("capability-action-runner", () => {
  test("executes low-risk project-local auto install via argv runner", () => {
    const calls: unknown[][] = []
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({})],
      runner: ((bin: string, args: string[], opts: object) => {
        calls.push([bin, args, opts])
        return { status: 0, stdout: "ok", stderr: "" }
      }) as any,
    })

    expect(result[0].status).toBe("passed")
    expect(calls[0][0]).toBe("bun")
    expect(calls[0][1]).toEqual(["add", "-d", "cap"])
  })

  test("runs verify commands after successful auto install", () => {
    const calls: string[] = []
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({ verify_command: ["which cap", "bun test test/dll-agent/capability-action-runner.test.ts"] })],
      runner: ((bin: string, args: string[]) => {
        calls.push([bin, ...args].join(" "))
        return { status: 0, stdout: "ok", stderr: "" }
      }) as any,
    })

    expect(result[0].status).toBe("passed")
    expect(result[0].verification?.map((v) => v.status)).toEqual(["passed", "passed"])
    expect(calls).toEqual([
      "bun add -d cap",
      "which cap",
      "bun test test/dll-agent/capability-action-runner.test.ts",
    ])
  })

  test("writes Result Ledger packet for verified auto install", () => {
    const sessionID = `cap_action_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const result = runCapabilityActions({
      sessionID,
      projectDir: process.cwd(),
      userGoal: "install test capability",
      actions: [action({ verify_command: ["which cap"] })],
      runner: (() => ({ status: 0, stdout: "ok", stderr: "" })) as any,
    })

    expect(result[0].status).toBe("passed")
    const packets = loadResults(sessionID)
    expect(packets.length).toBe(1)
    expect(packets[0].completion_status).toBe("VERIFIED_COMPLETE")
    expect(packets[0].verification_results[0].name).toBe("which cap")
  })

  test("marks Result Ledger partial when verification fails", () => {
    const sessionID = `cap_action_partial_${Date.now()}_${Math.random().toString(16).slice(2)}`
    let call = 0
    runCapabilityActions({
      sessionID,
      projectDir: process.cwd(),
      actions: [action({ verify_command: ["which cap"] })],
      runner: (() => {
        call++
        return { status: call === 1 ? 0 : 1, stdout: "", stderr: "missing" }
      }) as any,
    })

    const packets = loadResults(sessionID)
    expect(packets.length).toBe(1)
    expect(packets[0].completion_status).toBe("PARTIAL")
    expect(packets[0].unresolved_items[0]).toContain("which cap")
  })

  test("blocks high-risk auto install even if command looks local", () => {
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({ risk_level: "high" })],
      runner: (() => {
        throw new Error("should not run")
      }) as any,
    })

    expect(result[0].status).toBe("blocked")
  })

  test("blocks global npm install", () => {
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({ install_command: ["npm", "install", "-g", "x"] })],
      runner: (() => {
        throw new Error("should not run")
      }) as any,
    })

    expect(result[0].status).toBe("blocked")
    expect(result[0].reason).toContain("global")
  })

  test("blocks brew install", () => {
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({ install_command: ["brew", "install", "x"] })],
      runner: (() => {
        throw new Error("should not run")
      }) as any,
    })

    expect(result[0].status).toBe("blocked")
    expect(result[0].reason).toContain("blocked command")
  })
})
