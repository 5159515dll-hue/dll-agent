import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  buildBlockedRecoveryReport,
  buildRecoveryHint,
  classifyFailure,
  extractLatestFailure,
  planRecoveryFromContinuationPacket,
  planRecovery,
  writeRecoveryDecision,
  type LatestFailure,
} from "../../src/dll-agent/recovery-loop"
import type { ContinuationPacket } from "../../src/dll-agent/interfaces"
import { classifyRoleToolRequest } from "../../src/dll-agent/role-tool-policy"
import { finalGate } from "../../src/dll-agent/gates"
import { buildResultPacket, writeResult } from "../../src/dll-agent/result-ledger"

function failure(stderr: string): LatestFailure {
  return {
    whatFailed: "bun test",
    stderr,
    evidenceRef: "tool:bash:call_1",
  }
}

function toolMessage(tool: string, status: "completed" | "error", text: string): any {
  return {
    info: {
      id: `msg_${tool}_${status}`,
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "dll-agent-commander",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{
      type: "tool",
      callID: `call_${tool}`,
      tool,
      state: status === "completed"
        ? { status: "completed", input: { command: tool }, output: text, title: tool, metadata: {}, time: { start: 0, end: 1 } }
        : { status: "error", input: { command: tool }, error: text, time: { start: 0, end: 1 } },
      id: `part_${tool}`,
      messageID: `msg_${tool}_${status}`,
      sessionID: "ses_test",
    }],
  }
}

let evidenceFile = ""

afterEach(() => {
  if (evidenceFile) fs.rmSync(path.dirname(evidenceFile), { recursive: true, force: true })
  evidenceFile = ""
  delete process.env.DLL_AGENT_EVIDENCE_FILE
})

function continuationPacket(overrides: Partial<ContinuationPacket> = {}): ContinuationPacket {
  return {
    packet_type: "task_continuation",
    packet_id: "cont_test",
    session_id: "recovery-continuation",
    user_goal: "finish task",
    goal_contract_ref: "goal_contract:test",
    current_phase: "phase-3",
    completion_claim: "done",
    completion_status: "PARTIAL_CONTINUED",
    final_status: "CONTINUATION_REQUIRED",
    blocking_unfinished: [],
    non_blocking_followup: [],
    requires_user_input: [],
    missing_verification: [],
    blocking_reviewer_findings: [],
    missing_result_refs: [],
    required_actions: [],
    recommended_next_role: "commander",
    verification_required: [],
    evidence_refs: ["gate:continuation"],
    context_packet_refs: ["context_handoff:ctx_1"],
    budget_state: {
      continuation_count: 0,
      max_continuations: 5,
      max_repairs_per_item: 2,
    },
    already_completed: [],
    files_involved: [],
    commands_run: [],
    verification_results: [],
    reviewer_blocks: [],
    next_execution_plan: [],
    stop_reason: null,
    redaction_status: "redacted",
    ...overrides,
  }
}

describe("recovery-loop", () => {
  test("read-only tool failures can be ignored for answer-only L2 flows", () => {
    const messages = [
      toolMessage("read", "error", "ENOENT: no such file or directory, open 'docs/missing.md'"),
      toolMessage("glob", "error", "No files matched pattern"),
    ]

    expect(extractLatestFailure(messages)).not.toBeNull()
    expect(extractLatestFailure(messages, { ignoreReadOnlyToolFailures: true })).toBeNull()
  })

  test("read-only failure ignore mode still keeps bash/security failures visible", () => {
    expect(extractLatestFailure([
      toolMessage("bash", "error", "FAIL test/foo.test.ts"),
    ], { ignoreReadOnlyToolFailures: true })?.whatFailed).toBe("bash")
    expect(extractLatestFailure([
      toolMessage("read", "error", "permission denied reading .env"),
    ], { ignoreReadOnlyToolFailures: true })?.whatFailed).toBe("read")
  })

  test("typecheck failure gets automatic repair action", () => {
    const decision = planRecovery({
      failure: failure("src/foo.ts(1,1): error TS2322: Type 'string' is not assignable"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.action).toBe("continue_local_repair")
    expect(decision.failure_type).toBe("typecheck_failure")
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
    expect(decision.failure_type).toBe("test_failure")
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
    expect(second.action).toBe("trigger_reviewer")
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
    expect(third.action).toBe("trigger_cross_review")
    expect(third.reviewer).toBe("role-cross")
  })

  test("permission denied requires user authorization", () => {
    const decision = planRecovery({
      failure: failure("Permission denied: cannot write to /etc/hosts"),
      repairCounts: {},
    })

    expect(decision.status).toBe("BLOCKED_USER_REQUIRED")
    expect(decision.action).toBe("request_user_input")
    expect(decision.userActionRequired).toBe(true)
    expect(decision.shouldContinue).toBe(false)
  })

  test("destructive action is blocked for user decision", () => {
    const decision = planRecovery({
      failure: failure("Refusing destructive command: rm -rf /"),
      repairCounts: {},
    })

    expect(decision.status).toBe("BLOCKED_USER_REQUIRED")
    expect(decision.action).toBe("blocked_security")
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
    expect(exhausted.action).toBe("blocked_budget_exhausted")
    expect(exhausted.shouldContinue).toBe(false)
    expect(exhausted.userActionRequired).toBe(true)
  })

  test("provider normalization error remains automatically recoverable", () => {
    const decision = planRecovery({
      failure: failure("literal_error: Input should be 'low', 'medium' or 'high' for reasoning_effort=max"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.failure_type).toBe("reasoning_param_error")
    expect(decision.category).toBe("provider_normalization_error")
    expect(decision.userActionRequired).toBe(false)
  })

  test("config error remains automatically recoverable", () => {
    const decision = planRecovery({
      failure: failure("config invalid: unexpected token in JSON config file"),
      repairCounts: {},
    })

    expect(decision.status).toBe("AUTO_CONTINUE")
    expect(decision.failure_type).toBe("config_error")
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

  test("command error -> failure_type command_error", () => {
    const classified = classifyFailure({
      failure: failure("command exited with code 1"),
      repairCounts: {},
    })
    expect(classified.failure_type).toBe("command_error")
    expect(classified.auto_recoverable).toBe(true)
  })

  test("missing dependency -> dependency_missing", () => {
    const classified = classifyFailure({
      failure: failure("Cannot find module '@missing/pkg'"),
      repairCounts: {},
    })
    expect(classified.failure_type).toBe("dependency_missing")
    expect(classified.required_verification).toContain("rerun command that failed after dependency/path fix")
  })

  test("lint and build failures are classified", () => {
    expect(classifyFailure({ failure: failure("oxlint failed: no-unused-vars"), repairCounts: {} }).failure_type).toBe("lint_failure")
    expect(classifyFailure({ failure: failure("vite build failed with error"), repairCounts: {} }).failure_type).toBe("build_failure")
  })

  test("auth/token missing requests user input", () => {
    const decision = planRecovery({
      failure: failure("Missing bearer token for login"),
      repairCounts: {},
    })
    expect(decision.failure_type).toBe("secret_or_auth_missing")
    expect(decision.action).toBe("request_user_input")
    expect(decision.safe_to_auto_execute).toBe(false)
  })

  test("doctor failed is classified and requires doctor verification", () => {
    const decision = planRecovery({
      failure: failure("dll-agent doctor result: failed"),
      repairCounts: {},
    })
    expect(decision.failure_type).toBe("doctor_failed")
    expect(decision.verification).toContain("rerun dll-agent doctor")
  })

  test("reviewer blocking -> reconciliation-style local repair first", () => {
    const decision = planRecovery({
      failure: failure("reviewer chief-engineer blocked completion: missing verification"),
      repairCounts: {},
    })
    expect(decision.failure_type).toBe("reviewer_block")
    expect(decision.action).toBe("continue_local_repair")
    expect(decision.userActionRequired).toBe(false)
  })

  test("phase and task budget exhaustion block recovery", () => {
    const phase = planRecovery({
      failure: failure("FAIL test/foo.test.ts"),
      repairCounts: {},
      phaseAttempts: 5,
      taskAttempts: 0,
    })
    expect(phase.status).toBe("BLOCKED_BUDGET_EXHAUSTED")
    expect(phase.budget_state.phase_attempts).toBe(5)

    const task = planRecovery({
      failure: failure("FAIL test/foo.test.ts"),
      repairCounts: {},
      phaseAttempts: 0,
      taskAttempts: 8,
    })
    expect(task.status).toBe("BLOCKED_BUDGET_EXHAUSTED")
    expect(task.budget_state.task_attempts).toBe(8)
  })

  test("final gate does not allow budget exhausted PASS", () => {
    const gate = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: {
        version: 1,
        phase: "phase-3",
        risk: "medium",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: true,
        block_reason: "BLOCKED_BUDGET_EXHAUSTED: recovery budget exhausted",
        reviewer_conflict: false,
        metrics: {
          tool_failures: 3,
          permission_denied: 0,
          user_corrections: 0,
          context_percent: 0,
          context_tokens: 0,
          final_claim: true,
          verification_evidence: true,
          reviewer_conflict_signal: false,
          repeated_tool_failure: true,
          real_tool_evidence: true,
        },
        updated_at: new Date().toISOString(),
      },
      reconciliationConflicts: [],
      costExceeded: false,
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join("\n")).toContain("BLOCKED_BUDGET_EXHAUSTED")
  })

  test("missing verification from continuation -> run_verification", () => {
    const decision = planRecoveryFromContinuationPacket({
      packet: continuationPacket({
        missing_verification: ["bun test --cwd packages/opencode test/dll-agent/"],
      }),
      repairCounts: {},
    })
    expect(decision.action).toBe("run_verification")
    expect(decision.failure_type).toBe("continuation_required")
    expect(decision.verification).toContain("bun test --cwd packages/opencode test/dll-agent/")
  })

  test("failed verification continuation -> continue_local_repair", () => {
    const decision = planRecoveryFromContinuationPacket({
      packet: continuationPacket({
        blocking_unfinished: [{
          id: "failed-verification",
          kind: "blocking_unfinished",
          description: "verification failed: bun test",
          evidence_refs: ["verification:test"],
          required_action: "fix failing test",
          recommended_role: "chief-engineer",
          verification_required: ["bun test"],
          risk_level: "medium",
        }],
      }),
      repairCounts: {},
    })
    expect(decision.action).toBe("continue_local_repair")
    expect(decision.shouldContinue).toBe(true)
  })

  test("continuation user input -> blocked user required", () => {
    const decision = planRecoveryFromContinuationPacket({
      packet: continuationPacket({
        completion_status: "BLOCKED_USER_REQUIRED",
        final_status: "BLOCKED_USER_REQUIRED",
        requires_user_input: [{
          id: "auth",
          kind: "requires_user_input",
          description: "需要用户提供 API key token",
          evidence_refs: ["gate:user"],
          required_action: "ask user for token",
          recommended_role: "requirements-inspector",
          verification_required: [],
          risk_level: "high",
        }],
      }),
      repairCounts: {},
    })
    expect(decision.action).toBe("request_user_input")
    expect(decision.shouldContinue).toBe(false)
  })

  test("recovery evidence writes redacted structured decision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-recovery-evidence-"))
    evidenceFile = path.join(root, "evidence.jsonl")
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    const decision = planRecovery({
      failure: failure("Missing API key token=abc123 for login"),
      repairCounts: {},
    })
    writeRecoveryDecision("recovery-evidence", decision)
    const text = fs.readFileSync(evidenceFile, "utf8")
    expect(text).toContain("recovery.failure_classified")
    expect(text).toContain("recovery.user_input_required")
    expect(text).not.toContain("abc123")
    expect(text).toContain("REDACTED")
  })

  test("role-tool-policy is not bypassed by recovery escalation", () => {
    const decision = planRecovery({
      failure: failure("FAIL test/foo.test.ts\nAssertionError"),
      repairCounts: { [planRecovery({ failure: failure("FAIL test/foo.test.ts\nAssertionError"), repairCounts: {} }).fingerprint]: 1 },
    })
    expect(decision.reviewer).toBe("chief-engineer")
    const readOnlyReviewerWrite = classifyRoleToolRequest({
      role: "final-auditor",
      permission: "write",
      patterns: ["packages/opencode/src/a.ts"],
      writeEvidence: false,
    })
    expect(readOnlyReviewerWrite.action).toBe("deny")
  })

  test("Recovery Loop reuses existing verified result instead of repairing again", () => {
    const sessionID = `ses_recovery_reuse_${Date.now()}_${Math.random().toString(16).slice(2)}`
    try {
      writeResult(sessionID, buildResultPacket({
        sessionID,
        executing_role: "commander",
        model: "deepseek/deepseek-v4-pro",
        user_goal: "fix reused task",
        subtask_goal: "fix reused task",
        claimed_result: "already fixed and verified",
        completion_status: "VERIFIED_COMPLETE",
        verification_results: [{ name: "typecheck", status: "passed", evidenceRef: "tool:typecheck" }],
        evidence_refs: ["tool:typecheck"],
      }))
      const decision = planRecovery({
        failure: failure("FAIL reused task assertion"),
        repairCounts: {},
        sessionID,
        taskGoal: "fix reused task",
      })
      expect(decision.action).toBe("reuse_existing_result")
      expect(decision.reason).toContain("result ledger")
    } finally {
      fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", sessionID), { recursive: true, force: true })
    }
  })
})
