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

  test("executes project-local python package auto install with PYTHONPATH verification", () => {
    const calls: unknown[][] = []
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({
        entry_id: "doc-docx",
        install_command: [
          "python3",
          "-m",
          "pip",
          "install",
          "--target",
          ".dll-agent/tools/python",
          "python-docx",
        ],
        verify_command: [`python3 -c "import docx"`],
      })],
      runner: ((bin: string, args: string[], opts: { env?: Record<string, string> }) => {
        calls.push([bin, args, opts])
        return { status: 0, stdout: "ok", stderr: "" }
      }) as any,
    })

    expect(result[0].status).toBe("passed")
    expect(calls[0][0]).toBe("python3")
    expect(calls[0][1]).toEqual([
      "-m",
      "pip",
      "install",
      "--target",
      ".dll-agent/tools/python",
      "python-docx",
    ])
    expect(calls[1][1]).toEqual(["-c", "import docx"])
    expect((calls[1][2] as { env?: Record<string, string> }).env?.PYTHONPATH).toContain(".dll-agent/tools/python")
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

  test("reuses verified capability result instead of reinstalling every turn", () => {
    const sessionID = `cap_action_reuse_${Date.now()}_${Math.random().toString(16).slice(2)}`
    let calls = 0
    const first = runCapabilityActions({
      sessionID,
      projectDir: process.cwd(),
      userGoal: "install reusable capability",
      actions: [action({ entry_id: "reusable-cap", verify_command: ["which reusable-cap"] })],
      runner: (() => {
        calls++
        return { status: 0, stdout: "ok", stderr: "" }
      }) as any,
    })
    const second = runCapabilityActions({
      sessionID,
      projectDir: process.cwd(),
      userGoal: "install reusable capability again",
      actions: [action({ entry_id: "reusable-cap", verify_command: ["which reusable-cap"] })],
      runner: (() => {
        throw new Error("should reuse verified result")
      }) as any,
    })

    expect(first[0].status).toBe("passed")
    expect(second[0].status).toBe("passed")
    expect(second[0].reason).toContain("reused verified capability result")
    expect(calls).toBe(2)
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

  test("blocks python pip auto install without project-local target", () => {
    const result = runCapabilityActions({
      projectDir: process.cwd(),
      actions: [action({ install_command: ["python3", "-m", "pip", "install", "python-docx"] })],
      runner: (() => {
        throw new Error("should not run")
      }) as any,
    })

    expect(result[0].status).toBe("blocked")
    expect(result[0].reason).toContain("--target")
  })
})
