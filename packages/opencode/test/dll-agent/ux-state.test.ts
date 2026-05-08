/**
 * dll-agent ux-state tests
 */
import { describe, it, expect } from "bun:test"
import {
  defaultUxState,
  buildCompactSummary,
  buildNormalSummary,
  buildDebugSummary,
  setGoal,
  setPhase,
  setBlocker,
  addModifiedFile,
  markRecoveryAttempt,
  markGateBlocked,
  markGateOpen,
} from "../../src/dll-agent/ux-state"

describe("ux-state", () => {
  describe("defaultUxState", () => {
    it("returns default state with all fields", () => {
      const state = defaultUxState()
      expect(state.task.phase).toBe("init")
      expect(state.task.risk).toBe("low")
      expect(state.supervisor.active).toBe(false)
      expect(state.permissions.mode).toBe("risk-based-auto")
    })
  })

  describe("setGoal", () => {
    it("sets the task goal", () => {
      const state = setGoal(defaultUxState(), "Fix type errors")
      expect(state.task.goal).toBe("Fix type errors")
    })
  })

  describe("setPhase", () => {
    it("updates phase and optionally plan", () => {
      const state = setPhase(defaultUxState(), "implementation", "Add auth module")
      expect(state.task.phase).toBe("implementation")
      expect(state.task.plan).toBe("Add auth module")
    })
  })

  describe("setBlocker", () => {
    it("sets blocker", () => {
      const state = setBlocker(defaultUxState(), "Typecheck failed")
      expect(state.task.blocker).toBe("Typecheck failed")
    })

    it("clears blocker with null", () => {
      const blocked = setBlocker(defaultUxState(), "blocked")
      const cleared = setBlocker(blocked, null)
      expect(cleared.task.blocker).toBe(null)
    })
  })

  describe("addModifiedFile", () => {
    it("adds a file to modified files list", () => {
      const state = addModifiedFile(defaultUxState(), "src/foo.ts")
      expect(state.task.modifiedFiles).toContain("src/foo.ts")
    })

    it("deduplicates files", () => {
      let state = addModifiedFile(defaultUxState(), "src/foo.ts")
      state = addModifiedFile(state, "src/foo.ts")
      expect(state.task.modifiedFiles.length).toBe(1)
    })
  })

  describe("markRecoveryAttempt", () => {
    it("increments recovery attempts", () => {
      let state = defaultUxState()
      state = markRecoveryAttempt(state)
      expect(state.supervisor.recoveryAttempts).toBe(1)
      expect(state.supervisor.recoveryActive).toBe(true)

      state = markRecoveryAttempt(state)
      expect(state.supervisor.recoveryAttempts).toBe(2)
    })
  })

  describe("markGateBlocked / markGateOpen", () => {
    it("marks gate as blocked with reason", () => {
      const state = markGateBlocked(defaultUxState(), "missing evidence")
      expect(state.supervisor.gateBlocked).toBe(true)
      expect(state.supervisor.gateBlockReason).toBe("missing evidence")
    })

    it("marks gate as open", () => {
      const blocked = markGateBlocked(defaultUxState(), "test")
      const opened = markGateOpen(blocked)
      expect(opened.supervisor.gateBlocked).toBe(false)
      expect(opened.supervisor.gateBlockReason).toBe(null)
    })
  })

  describe("summary builders", () => {
    it("buildCompactSummary returns non-empty string", () => {
      const summary = buildCompactSummary(defaultUxState())
      expect(summary.length).toBeGreaterThan(0)
      expect(summary).toContain("Phase:")
    })

    it("buildNormalSummary includes all sections", () => {
      const summary = buildNormalSummary(defaultUxState())
      expect(summary).toContain("Task:")
      expect(summary).toContain("Supervisor:")
      expect(summary).toContain("Permissions:")
      expect(summary).toContain("Tools:")
      expect(summary).toContain("Cost:")
    })

    it("buildDebugSummary includes JSON state", () => {
      const summary = buildDebugSummary(defaultUxState())
      expect(summary).toContain("Debug")
      expect(summary).toContain("Timestamp")
    })

    it("compact summary is shorter than normal", () => {
      const compact = buildCompactSummary(defaultUxState())
      const normal = buildNormalSummary(defaultUxState())
      expect(compact.length).toBeLessThan(normal.length)
    })
  })
})
