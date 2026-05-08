/**
 * dll-agent actionable-error tests
 */
import { describe, it, expect } from "bun:test"
import {
  buildActionableError,
  formatActionableError,
  buildFailureFingerprint,
} from "../../src/dll-agent/actionable-error"
import type { ActionableError } from "../../src/dll-agent/actionable-error"

describe("actionable-error", () => {
  describe("buildActionableError", () => {
    it("classifies typecheck errors", () => {
      const err = buildActionableError({
        whatFailed: "TypeScript compilation failed",
        stderr: "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      })
      expect(err.category).toBe("typecheck_error")
      expect(err.nextAutomaticAction).toBeTruthy()
      expect(err.userActionRequired).toBe(false)
    })

    it("classifies test failures", () => {
      const err = buildActionableError({
        whatFailed: "Tests failed",
        stderr: "FAIL test/foo.test.ts > should work\nAssertionError: expected true to be false",
      })
      expect(err.category).toBe("test_failure")
    })

    it("classifies permission denied", () => {
      const err = buildActionableError({
        whatFailed: "Access denied",
        stderr: "Permission denied: cannot write to /etc/hosts",
      })
      expect(err.category).toBe("permission_denied")
      expect(err.userActionRequired).toBe(true)
    })

    it("classifies file not found", () => {
      const err = buildActionableError({
        whatFailed: "Module not found",
        stderr: "Error: ENOENT: no such file or directory, open 'missing.ts'",
      })
      expect(err.category).toBe("file_not_found")
    })

    it("classifies gate blocked", () => {
      const err = buildActionableError({
        whatFailed: "Completion blocked",
        stderr: "gate: insufficient evidence for completion claim",
      })
      expect(err.category).toBe("gate_blocked")
    })

    it("returns unknown for unrecognized errors", () => {
      const err = buildActionableError({
        whatFailed: "Something went wrong",
        stderr: "xyzzy unexpected foobar",
      })
      expect(err.category).toBe("unknown")
    })

    it("marks user action required when recovery exhausted", () => {
      const err = buildActionableError({
        whatFailed: "TypeScript compilation failed",
        stderr: "src/foo.ts(10,5): error TS2322",
        recoveryAttempts: 5,
        maxRecoveryAttempts: 5,
      })
      expect(err.recoveryAttempts).toBe(5)
      expect(err.userActionRequired).toBe(true)
      expect(err.nextAutomaticAction).toBe(null)
    })

    it("does not require user action within recovery budget", () => {
      const err = buildActionableError({
        whatFailed: "TypeScript compilation failed",
        stderr: "src/foo.ts(10,5): error TS2322",
        recoveryAttempts: 2,
        maxRecoveryAttempts: 5,
      })
      expect(err.userActionRequired).toBe(false)
      expect(err.nextAutomaticAction).toBeTruthy()
    })

    it("sets evidence path when provided", () => {
      const err = buildActionableError({
        whatFailed: "Failed",
        evidencePath: "/tmp/evidence.json",
      })
      expect(err.evidencePath).toBe("/tmp/evidence.json")
    })
  })

  describe("formatActionableError", () => {
    it("formats error with all sections", () => {
      const err = buildActionableError({
        whatFailed: "TypeScript compilation failed",
        stderr: "src/foo.ts(10,5): error TS2322",
        recoveryAttempts: 1,
        maxRecoveryAttempts: 5,
        evidencePath: "/tmp/ev.json",
      })

      const formatted = formatActionableError(err)
      expect(formatted).toContain("typecheck_error")
      expect(formatted).toContain("TypeScript compilation failed")
      expect(formatted).toContain("Recovery attempts: 1/5")
      expect(formatted).toContain("Next automatic action:")
      expect(formatted).toContain("/tmp/ev.json")
    })

    it("formats exhausted recovery", () => {
      const err = buildActionableError({
        whatFailed: "Failed",
        recoveryAttempts: 5,
        maxRecoveryAttempts: 5,
      })

      const formatted = formatActionableError(err)
      expect(formatted).toContain("Automatic recovery exhausted")
      expect(formatted).toContain("User action required")
    })
  })

  describe("buildFailureFingerprint", () => {
    it("normalizes numbers and paths", () => {
      const fp = buildFailureFingerprint(
        "typecheck_error",
        "src/foo.ts(10,5): error TS2322: Type 'string' at line 42 is wrong",
      )
      expect(fp).toContain("typecheck_error")
      expect(fp).toContain("FILE")
      expect(fp).toContain("N")  // numbers normalized
    })

    it("produces stable fingerprints for same error pattern", () => {
      const fp1 = buildFailureFingerprint(
        "test_failure",
        "FAIL test/a.test.ts line 10: expected 1 to be 2",
      )
      const fp2 = buildFailureFingerprint(
        "test_failure",
        "FAIL test/b.test.ts line 20: expected 3 to be 4",
      )
      // Same category and pattern should produce similar fingerprints
      expect(fp1.split(":")[0]).toBe(fp2.split(":")[0])
    })
  })
})
