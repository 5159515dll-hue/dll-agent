import { describe, expect, test } from "bun:test"
import {
  buildBlockedRecoveryReport,
  buildRecoveryHint,
  planRecovery,
  type LatestFailure,
} from "../../src/dll-agent/recovery-loop"

function failure(stderr: string): LatestFailure {
  return {
    whatFailed: "bun test",
    stderr,
    evidenceRef: "tool:bash:call_1",
  }
}

describe("recovery-loop", () => {
  test("typecheck failure gets automatic repair action", () => {
    const decision = planRecovery({
      failure: failure("src/foo.ts(1,1): error TS2322: Type 'string' is not assignable"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.category).toBe("typecheck_error")
    expect(decision.userActionRequired).toBe(false)
    expect(decision.nextAutomaticAction).toContain("type error")
    expect(decision.verification).toContain("rerun typecheck")
  })

  test("test failure gets automatic repair action", () => {
    const decision = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError: expected true to be false"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.category).toBe("test_failure")
    expect(decision.userActionRequired).toBe(false)
  })

  test("same failure second attempt escalates to chief-engineer", () => {
    const first = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError: expected true to be false"),
      repairCounts: {},
    })
    const second = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError: expected true to be false"),
      repairCounts: { [first.fingerprint]: 1 },
    })

    expect(second.status).toBe("ESCALATE_REVIEWER")
    expect(second.reviewer).toBe("chief-engineer")
  })

  test("same failure third attempt escalates to role-cross", () => {
    const first = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError: expected true to be false"),
      repairCounts: {},
    })
    const third = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError: expected true to be false"),
      repairCounts: { [first.fingerprint]: 2 },
    })

    expect(third.status).toBe("ESCALATE_REVIEWER")
    expect(third.reviewer).toBe("role-cross")
  })

  test("permission denied requires user authorization", () => {
    const decision = planRecovery({
      failure: failure("Permission denied: cannot write to /etc/hosts"),
      repairCounts: {},
    })

    expect(decision.status).toBe("BLOCKED_USER_REQUIRED")
    expect(decision.userActionRequired).toBe(true)
    expect(decision.shouldContinue).toBe(false)
  })

  test("destructive action is blocked for user decision", () => {
    const decision = planRecovery({
      failure: failure("Refusing destructive command: rm -rf /"),
      repairCounts: {},
    })

    expect(decision.status).toBe("BLOCKED_USER_REQUIRED")
    expect(decision.userActionRequired).toBe(true)
  })

  test("secrets/token requirement is blocked for user input", () => {
    const decision = planRecovery({
      failure: failure("Missing API key token for provider login"),
      repairCounts: {},
    })

    expect(decision.status).toBe("BLOCKED_USER_REQUIRED")
    expect(decision.reason).toContain("user input")
  })

  test("recovery budget exhausted outputs blocked status", () => {
    const first = planRecovery({
      failure: failure("src/foo.ts(1,1): error TS2322"),
      repairCounts: {},
      maxRecoveryAttempts: 3,
    })
    const exhausted = planRecovery({
      failure: failure("src/foo.ts(1,1): error TS2322"),
      repairCounts: { [first.fingerprint]: 3 },
      maxRecoveryAttempts: 3,
    })

    expect(exhausted.status).toBe("BLOCKED_BUDGET_EXHAUSTED")
    expect(exhausted.shouldContinue).toBe(false)
    expect(exhausted.userActionRequired).toBe(true)
  })

  test("provider normalization error remains automatically recoverable", () => {
    const decision = planRecovery({
      failure: failure("literal_error: Input should be 'low', 'medium' or 'high' for reasoning_effort=max"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.category).toBe("provider_normalization_error")
    expect(decision.userActionRequired).toBe(false)
  })

  test("config error remains automatically recoverable", () => {
    const decision = planRecovery({
      failure: failure("config invalid: unexpected token in JSON config file"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.category).toBe("config_error")
    expect(decision.verification).toContain("rerun config validation or failed command")
  })

  test("recovery hint and blocked report are explicit", () => {
    const auto = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError"),
      repairCounts: {},
    })
    const hint = buildRecoveryHint(auto)
    expect(hint).toContain("AUTO_CONTINUE")
    expect(hint).toContain(auto.fingerprint)

    const blocked = planRecovery({
      failure: failure("Permission denied: cannot write to /etc/hosts"),
      repairCounts: {},
    })
    const report = buildBlockedRecoveryReport(blocked)
    expect(report).toContain("BLOCKED_USER_REQUIRED")
    expect(report).toContain("Do not claim VERIFIED_COMPLETE")
  })
})
