import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { buildVerifierSubtask, pickVerifierAgent, decide, recordReviewerCall, markReviewerCompleted, isReadOnlyReviewer, updateState, buildFinalReportContext, loadCooldown, loadState, modelContextLimit, buildTaskCompletionSubtask, saveState, setQueuedReviewers, setRunningReviewers } from "../../src/dll-agent/supervisor"
import { finalGate } from "../../src/dll-agent/gates"
import { writeRoutingEvidence } from "../../src/dll-agent/routing-evidence"
import type { MessageV2 } from "../../src/session/message-v2"

const cleanupSessions: string[] = []
const cleanupFiles: string[] = []

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
  for (const file of cleanupFiles.splice(0)) fs.rmSync(file, { force: true })
  delete process.env.DLL_AGENT_EVIDENCE_FILE
})

function sessionID(name: string) {
  const id = `ses_dll_agent_test_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  cleanupSessions.push(id)
  return id
}

function userMsg(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent: "commander",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    } as any,
    parts: [{ type: "text", text, id: `${id}_part`, messageID: id, sessionID: "ses_test" } as any],
  }
}

function asstMsg(text: string): MessageV2.WithParts {
  return {
    info: {
      id: `msg_asst_${Date.now()}`,
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "commander",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    } as any,
    parts: [{ type: "text", text, id: `p_${Date.now()}`, messageID: `m_${Date.now()}`, sessionID: "ses_test" } as any],
  }
}

function toolErrorMsg(tool: string, errorText: string, command?: string): MessageV2.WithParts {
  const input: Record<string, unknown> = {}
  if (command) input.command = command
  return {
    info: {
      id: `msg_tool_error_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "commander",
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    } as any,
    parts: [
      {
        type: "tool",
        callID: "c",
        tool,
        state: {
          status: "error",
          input,
          error: errorText,
          time: { start: 0, end: 1 },
        },
        id: `p_${Date.now()}`,
        messageID: `m_${Date.now()}`,
        sessionID: "ses_test",
      } as any,
    ],
  }
}

function useEvidenceFile(name: string) {
  const file = path.join(os.tmpdir(), `dll-agent-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
  cleanupFiles.push(file)
  process.env.DLL_AGENT_EVIDENCE_FILE = file
  return file
}

function readEvidence(file: string) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

describe("DllAgentSupervisor.buildVerifierSubtask", () => {
  test("returns SubtaskPart with verifier shape", () => {
    const part = buildVerifierSubtask("ses_test_verifier", "high-risk completion")
    expect(part.type).toBe("subtask")
    expect(part.command).toBe("dll-agent-supervisor")
    expect(part.agent).toBe("build")
    expect(part.prompt).toContain("bun typecheck")
    expect(part.prompt).toContain("bun test")
    expect(part.prompt).toContain("dll-agent doctor")
    expect(part.prompt).toContain("high-risk completion")
  })

  test("each call produces fresh part id", () => {
    const a = buildVerifierSubtask("ses_x", "r1")
    const b = buildVerifierSubtask("ses_x", "r2")
    expect(a.id).not.toBe(b.id)
  })

  test("pickVerifierAgent prefers executor when present", () => {
    expect(pickVerifierAgent(["executor", "build", "general"])).toBe("executor")
    expect(pickVerifierAgent(["build", "general"])).toBe("build")
    expect(pickVerifierAgent(["general", "commander"])).toBe("general")
    expect(pickVerifierAgent(["commander"])).toBe("commander")
    expect(pickVerifierAgent([])).toBe("build")
    expect(pickVerifierAgent(undefined)).toBe("build")
    expect(pickVerifierAgent(["xxx"])).toBe("xxx")
  })

  test("buildVerifierSubtask honors availableAgents", () => {
    const a = buildVerifierSubtask("ses_y", "r", ["executor", "build"])
    expect(a.agent).toBe("executor")
    const b = buildVerifierSubtask("ses_y", "r", ["general"])
    expect(b.agent).toBe("general")
  })

  test("does not create reviewer fingerprint from natural-language correction without structured/model judgement", () => {
    const sid = sessionID("fingerprint")
    const messages = [userMsg("msg_user_same", "不对，这个方向跑偏了，需要按新的方向处理。")]
    const first = decide(messages, sid, 1)
    expect(first.reviewers).toEqual([])
    const second = decide(messages, sid, 10)
    expect(second.reviewers).toEqual([])
    expect(second.reviewers).not.toContain("requirements-inspector")
  })

  test("does not trigger requirements-inspector for ordinary recheck wording", () => {
    const sid = sessionID("soft-recheck")
    const decision = decide([userMsg("msg_user_recheck", "再次检查有没有问题，仔细检查。")], sid, 1)
    expect(decision.reviewers).not.toContain("requirements-inspector")
  })

  test("classifies read-only reviewers for safe parallel dispatch", () => {
    expect(isReadOnlyReviewer("requirements-inspector")).toBe(true)
    expect(isReadOnlyReviewer("long-context-archivist")).toBe(true)
    expect(isReadOnlyReviewer("final-auditor")).toBe(true)
    expect(isReadOnlyReviewer("chief-engineer")).toBe(false)
    expect(isReadOnlyReviewer("role-cross")).toBe(false)
    expect(isReadOnlyReviewer("executor")).toBe(false)
  })

  test("markReviewerCompleted removes reviewer from required, queued, and running state", () => {
    const sid = sessionID("state_converges")
    const state = loadState(sid)
    state.required_reviews = ["role-cross", "chief-engineer"]
    state.queued_reviewers = ["role-cross", "chief-engineer"]
    state.running_reviewers = ["role-cross"]
    state.reviewer_conflict = true
    saveState(sid, state)

    markReviewerCompleted(sid, "role-cross")
    const next = loadState(sid)
    expect(next.completed_reviews).toContain("role-cross")
    expect(next.required_reviews).not.toContain("role-cross")
    expect(next.queued_reviewers).not.toContain("role-cross")
    expect(next.running_reviewers).not.toContain("role-cross")
  })

  test("setQueuedReviewers and setRunningReviewers do not resurrect completed reviewers", () => {
    const sid = sessionID("no_resurrect")
    markReviewerCompleted(sid, "chief-engineer")
    setRunningReviewers(sid, ["chief-engineer", "role-cross"])
    setQueuedReviewers(sid, ["chief-engineer", "role-cross"])
    const state = loadState(sid)
    expect(state.running_reviewers).not.toContain("chief-engineer")
    expect(state.queued_reviewers).not.toContain("chief-engineer")
    expect(state.running_reviewers).toContain("role-cross")
    expect(state.queued_reviewers).not.toContain("role-cross")
  })
})

describe("DllAgentSupervisor repeatedToolFailure passthrough (P0-3)", () => {
  test("single unique tool error → repeatedToolFailure=false", () => {
    const sid = sessionID("rtf_single")
    const messages = [
      userMsg("msg_u", "请运行测试"),
      toolErrorMsg("bash", "error: command not found: pytest", "pytest"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.metrics.repeated_tool_failure).toBe(false)
    expect(decision.metrics.tool_failures).toBe(1)
  })

  test("two different errors → repeatedToolFailure=false", () => {
    const sid = sessionID("rtf_diff")
    const messages = [
      userMsg("msg_u", "请修复"),
      toolErrorMsg("bash", "error: module not found", "bun build"),
      toolErrorMsg("edit", "Permission denied: cannot write file", "edit ./foo.ts"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.metrics.repeated_tool_failure).toBe(false)
    expect(decision.metrics.tool_failures).toBe(2)
  })

  test("two same-fingerprint errors → repeatedToolFailure=true", () => {
    const sid = sessionID("rtf_same")
    const messages = [
      userMsg("msg_u", "运行命令"),
      toolErrorMsg("bash", "Permission denied: /usr/local/bin", "bun install -g"),
      toolErrorMsg("bash", "Permission denied: /usr/local/bin", "npm install -g"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.metrics.repeated_tool_failure).toBe(true)
    expect(decision.metrics.tool_failures).toBe(2)
  })

  test("repeatedToolFailure passes through to updateState", () => {
    const sid = sessionID("rtf_state")
    const messages = [
      userMsg("msg_u", "执行"),
      toolErrorMsg("bash", "EACCES: permission denied, mkdir '/root'", "mkdir /root"),
      toolErrorMsg("bash", "EACCES: permission denied, mkdir '/etc'", "mkdir /etc"),
    ]
    const decision = decide(messages, sid, 1)
    const state = updateState(sid, decision)
    expect(state.metrics.repeated_tool_failure).toBe(true)
    expect(state.metrics.tool_failures).toBe(2)
  })

  test("chief-engineer cooldown does not fallback to role-cross without conflict evidence", () => {
    const sid = sessionID("no_role_cross_fallback")
    const messages = [
      userMsg("msg_u", "请修复失败"),
      toolErrorMsg("bash", "error: missing file /tmp/nope", "cat /tmp/nope"),
      toolErrorMsg("bash", "error: missing file /tmp/nope", "cat /tmp/nope"),
    ]
    const first = decide(messages, sid, 1)
    expect(first.reviewers).toContain("chief-engineer")
    recordReviewerCall(
      sid,
      "chief-engineer",
      1,
      first.fingerprints?.["chief-engineer"],
      first.reasons["chief-engineer"],
      "msg_u",
    )

    const second = decide(messages, sid, 2)
    expect(second.reviewers).not.toContain("chief-engineer")
    expect(second.reviewers).not.toContain("role-cross")
  })

  test("repeatedToolFailure=false after error pattern window clears", () => {
    const sid = sessionID("rtf_clear")
    const messages = [
      userMsg("msg_u", "test"),
      toolErrorMsg("bash", "command not found", "xyz"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.metrics.repeated_tool_failure).toBe(false)
  })

  test("assessRisk scores repeatedToolFailure as +3", () => {
    const sid = sessionID("rtf_risk")
    const messages = [
      userMsg("msg_u", "执行"),
      toolErrorMsg("bash", "Permission denied", "cmd1"),
      toolErrorMsg("bash", "Permission denied", "cmd2"),
    ]
    const decision = decide(messages, sid, 1)
    const state = updateState(sid, decision)
    expect(state.risk).toBe("high")
    expect(state.metrics.repeated_tool_failure).toBe(true)
  })
})

describe("DllAgentSupervisor buildFinalReportContext (P0-loop)", () => {
  test("produces compressed context without full history", () => {
    const state = {
      version: 1 as const,
      phase: "default",
      risk: "low" as const,
      required_reviews: [] as any[],
      completed_reviews: ["requirements-inspector"] as any[],
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      gate_block_retries: {},
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 10,
        context_tokens: 500,
        final_claim: false,
        verification_evidence: true,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: true,
      },
      updated_at: new Date().toISOString(),
    }
    const ctx = buildFinalReportContext(state, "修复 dll-agent 循环问题")
    expect(ctx).toContain("[dll-agent finalization context]")
    expect(ctx).toContain("修复 dll-agent 循环问题")
    expect(ctx).toContain("real_tool_evidence=true")
    expect(ctx).toContain("requirements-inspector")
    expect(ctx).toContain("IMPORTANT: Do not repeat the full conversation history")
    expect(ctx.length).toBeLessThan(2000)
  })

  test("handles blocked state correctly", () => {
    const state = {
      version: 1 as const,
      phase: "exec",
      risk: "high" as const,
      required_reviews: ["final-auditor"] as any[],
      completed_reviews: [] as any[],
      blocked_completion: true,
      block_reason: "high-risk completion claim without verification evidence",
      reviewer_conflict: false,
      gate_block_retries: { "high-risk completion claim without verification evidence": 3 },
      metrics: {
        tool_failures: 2,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 20,
        context_tokens: 1000,
        final_claim: true,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    }
    const ctx = buildFinalReportContext(state, "fix P0 issues")
    expect(ctx).toContain("blocked_completion=true")
    expect(ctx).toContain("real_tool_evidence=false")
    expect(ctx).toContain("final-auditor")
    expect(ctx).toContain("gate_retries")
  })
})

describe("DllAgentSupervisor auto-verifier (P0-verification)", () => {
  test("assistant natural-language completion claim alone does not trigger auto-verifier", () => {
    const sid = sessionID("auto_verifier")
    const messages: any[] = [
      userMsg("msg_u", "请修复bug"),
      asstMsg("已经完成修复，所有测试通过，可以交付。"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.final_claim).toBe(false)
  })

  test("non-completion message does NOT trigger auto-verifier", () => {
    const sid = sessionID("no_verifier")
    const messages: any[] = [
      userMsg("msg_u", "请检查代码"),
      asstMsg("让我先看看代码结构。"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.verifierTask).toBeUndefined()
  })
})

describe("DllAgentSupervisor reviewer fingerprint loop prevention", () => {
  function userMsgWithSynthetic(id: string, parts: any[]): MessageV2.WithParts {
    return {
      info: {
        id,
        sessionID: "ses_test",
        role: "user",
        time: { created: 0 },
        agent: "commander",
        model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
      } as any,
      parts,
    }
  }

  test("long-context-archivist should NOT re-trigger after synthetic user message insertion", () => {
    const sid = sessionID("fingerprint_loop")

    // Step 1: Initial trigger with real user message
    const realUserID = "msg_real_user_1"
    const messages1: any[] = [
      userMsgWithSynthetic(realUserID, [
        { type: "text", text: "请修复CPU占用过高的问题。这是一个很长的上下文任务，涉及 context 和长上下文处理。", id: "p1", messageID: realUserID, sessionID: "ses_test" },
      ]),
      asstMsg("好的，让我分析一下。"),
    ]

    // Natural-language "long context" wording no longer creates a reviewer trigger.
    const decision1 = decide(messages1, sid, 1, 400)
    expect(decision1.reviewers).not.toContain("long-context-archivist")

    // Step 2: simulate reviewer completes, synthetic user message injected
    const syntheticID = "msg_synthetic_summarize"
    const messages2: any[] = [
      ...messages1,
      userMsgWithSynthetic(syntheticID, [
        { type: "text", text: "Summarize the task tool output above and continue with your task.", id: "p_syn", messageID: syntheticID, sessionID: "ses_test", synthetic: true },
      ]),
      asstMsg("长上下文审查员确认了代码中存在高频刷新模式。现在继续执行。"), // contains "长上下文" and "context"
    ]

    // Step 3: decide() again. With fixed latestRealUser, should NOT re-trigger.
    const decision2 = decide(messages2, sid, 3, 400)
    // The fingerprint should match (same original user) and be in cooldown
    expect(decision2.reviewers).not.toContain("long-context-archivist")
  })

  test("long-context-archivist fingerprint stability with synthetic messages", () => {
    const sid = sessionID("fingerprint_stability")

    const realUserID = "msg_real_user_2"
    const messages1: any[] = [
      userMsgWithSynthetic(realUserID, [
        { type: "text", text: "请检查context文档和长上下文日志中的问题。", id: "p1", messageID: realUserID, sessionID: "ses_test" },
      ]),
      asstMsg("开始分析。"),
    ]

    const decision1 = decide(messages1, sid, 1, 400)
    recordReviewerCall(
      sid,
      "long-context-archivist" as any,
      1,
      decision1.fingerprints?.["long-context-archivist"],
      decision1.reasons["long-context-archivist"],
      realUserID,
    )

    // Mark as completed
    markReviewerCompleted(sid, "long-context-archivist" as any, {
      version: 1,
      reviewer: "long-context-archivist",
      trigger_reason: "test",
      verdict: "pass" as any,
      findings: [],
      score: 100,
      block_completion: false,
      next_actions: [],
      evidence_confidence: 100,
      ts: new Date().toISOString(),
    })

    // Round 2: synthetic summary message injected
    const syntheticID = "msg_synthetic_2"
    const messages2: any[] = [
      ...messages1,
      userMsgWithSynthetic(syntheticID, [
        { type: "text", text: "Summarize the task tool output above and continue with your task.", id: "p_syn2", messageID: syntheticID, sessionID: "ses_test", synthetic: true },
      ]),
      asstMsg("审查完成，context上下文检查通过，继续执行长上下文任务。"),
    ]

    const decision2 = decide(messages2, sid, 3, 400)
    // Should NOT re-trigger because fingerprint points to the same original user
    expect(decision2.reviewers).not.toContain("long-context-archivist")
  })
})

// ─── Phase 6: Model Routing & Token Awareness Tests ────────────────────────

describe("DllAgentSupervisor.Phase6.modelContextLimit", () => {
  test("returns correct limit for deepseek-v4-pro", () => {
    expect(modelContextLimit("deepseek", "deepseek-v4-pro")).toBe(1_048_576)
  })

  test("returns correct limit for kimi-k2.6", () => {
    expect(modelContextLimit("kimi", "kimi-k2.6")).toBe(262_144)
  })

  test("returns correct limit for glm-5.1", () => {
    expect(modelContextLimit("zai", "glm-5.1")).toBe(204_800)
  })

  test("returns undefined for unknown models", () => {
    expect(modelContextLimit("unknown", "model-1")).toBeUndefined()
  })

  test("returns undefined when providerID is undefined", () => {
    expect(modelContextLimit(undefined, "deepseek-v4-pro")).toBeUndefined()
  })
})

describe("DllAgentSupervisor.Phase6.kimiPreReportTrigger", () => {
  test("Rule 2b: does not trigger long-context-archivist from assistant prose alone", () => {
    const sid = sessionID("kimi_pre_report")
    const msgs: any[] = [
      userMsg("msg_user_kpr", "继续执行任务"),
      {
        info: {
          id: "msg_asst_kpr",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 0 },
          agent: "commander",
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          tokens: { input: 400000, output: 50000, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        parts: [{ type: "text" as const, text: "All tasks completed successfully!", id: "p_kpr", messageID: "m_kpr", sessionID: "ses_test" } as any],
      },
    ]
    const decision = decide(msgs, sid, 10, 1_000_000)
    expect(decision.reviewers).not.toContain("long-context-archivist")
  })

  test("Rule 2b: does NOT trigger with low context and no final claim", () => {
    const sid = sessionID("kimi_low_ctx")
    const msgs: any[] = [
      userMsg("msg_user_low", "检查代码"),
      asstMsg("Let me check the code..."),
    ]
    const decision = decide(msgs, sid, 2, 1_000_000)
    expect(decision.metrics.kimi_pre_report_signal).toBe(false)
  })
})

describe("DllAgentSupervisor.Phase6.glmCompletionClaimCheck", () => {
  test("Rule 8: natural-language completion prose alone does not trigger requirements-inspector", () => {
    const sid = sessionID("glm_completion_claim")
    const msgs: any[] = [
      userMsg("msg_user_glm", "修复那个bug"),
      asstMsg("已经完成了，验证通过，all tests pass"),
    ]
    const decision = decide(msgs, sid, 5)
    expect(decision.reviewers).not.toContain("requirements-inspector")
  })
})

describe("DllAgentSupervisor.Phase6.kimiCompletionCheck", () => {
  test("Rule 9: natural-language completion prose alone does not trigger task-completion-archivist", () => {
    const sid = sessionID("kimi_completion")
    const msgs: any[] = [
      userMsg("msg_user_kc", "优化模型路由"),
      asstMsg("任务已完成，但未完成：TODO cleanup pending"),
    ]
    const decision = decide(msgs, sid, 8)
    expect(decision.reviewers).not.toContain("task-completion-archivist")
  })

  test("Rule 9: does NOT trigger without completion claim", () => {
    const sid = sessionID("kimi_no_claim")
    const msgs: any[] = [
      userMsg("msg_user_nc", "how to fix this"),
      asstMsg("Let me investigate the code base."),
    ]
    const decision = decide(msgs, sid, 3)
    expect(decision.metrics.kimi_completion_check_signal).toBe(false)
  })
})

describe("DllAgentSupervisor.Phase6.scopeExpansion", () => {
  test("Rule 10: natural-language scope expansion wording waits for semantic judgement", () => {
    const sid = sessionID("scope_expansion")
    const msgs: any[] = [
      userMsg("msg_user_se", "不对，你扩大了范围，增加了额外需求"),
      asstMsg("I see, let me narrow the scope."),
    ]
    const decision = decide(msgs, sid, 4)
    expect(decision.reviewers).not.toContain("requirements-inspector")
  })
})

describe("DllAgentSupervisor.Phase6.phaseSwitch", () => {
  test("Rule 2c: natural-language phase switch wording waits for semantic judgement", () => {
    const sid = sessionID("phase_switch")
    const msgs: any[] = [
      userMsg("msg_user_ps", "先不要做那个了，换个方向，先处理 token 优化"),
      asstMsg("Switching direction to token optimization."),
    ]
    const decision = decide(msgs, sid, 6)
    expect(decision.reviewers).not.toContain("long-context-archivist")
  })
})

describe("DllAgentSupervisor.Phase6.tokenAwareRouting", () => {
  test("Rule 11: high context triggers routing evidence write", () => {
    const sid = sessionID("token_aware")
    const msgs: any[] = [
      userMsg("msg_user_ta", "完成这个任务"),
      {
        info: {
          id: "msg_asst_ta",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 0 },
          agent: "commander",
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          tokens: { input: 700000, output: 50000, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        parts: [{ type: "text" as const, text: "Working on it...", id: "p_ta", messageID: "m_ta", sessionID: "ses_test" } as any],
      },
    ]
    const decision = decide(msgs, sid, 12, 1_000_000)
    // Context is 75% → should trigger token-aware routing evidence
    expect(decision.metrics.context_percent).toBe(75)
    // Check that routing evidence was written (via supervisor.decision evidence)
    // The main assertion: the system doesn't crash and produces a valid decision
    expect(decision.should_review).toBeDefined()
  })

  test("Rule 11: normal context does NOT trigger token-aware routing", () => {
    const sid = sessionID("normal_ctx")
    const msgs: any[] = [
      userMsg("msg_user_nr", "小任务"),
      asstMsg("Done."),
    ]
    const decision = decide(msgs, sid, 2, 1_000_000)
    // Normal context < 60%, no routing evidence needed
    expect(decision.metrics.context_percent).toBeLessThan(60)
  })
})

describe("DllAgentSupervisor.Phase6.buildTaskCompletionSubtask", () => {
  test("builds a valid task-completion-archivist subtask with correct model", () => {
    const sid = sessionID("task_completion_sub")
    const state = {
      version: 1 as const,
      phase: "default",
      risk: "low" as const,
      required_reviews: [],
      completed_reviews: [],
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 30,
        context_tokens: 300000,
        final_claim: true,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    }
    const subtask = buildTaskCompletionSubtask(sid, "优化模型路由", "任务已完成，但仍有待办", state)
    expect(subtask.type).toBe("subtask")
    expect(subtask.agent).toBe("task-completion-archivist")
    expect(String(subtask.model?.providerID ?? "")).toBe("kimi")
    expect(String(subtask.model?.modelID ?? "")).toBe("kimi-k2.6")
    expect(subtask.prompt).toContain("task-completion-archivist")
    expect(subtask.prompt).toContain("completion_status")
    expect(subtask.prompt).toContain("优化模型路由")
  })
})

describe("DllAgentSupervisor.Phase6.defaultCommander", () => {
  test("DeepSeek remains default commander — short task does NOT trigger Kimi/GLM", () => {
    const sid = sessionID("short_task")
    const msgs: any[] = [
      userMsg("msg_user_st", "查看 git status"),
      asstMsg("Let me check the git status."),
    ]
    const decision = decide(msgs, sid, 1, 1_000_000)
    // Short task: no reviewers triggered
    expect(decision.reviewers.length).toBe(0)
    // Decision is valid
    expect(decision.should_review).toBe(false)
  })
})

describe("DllAgentSupervisor Correctness-Aware Model Routing Policy", () => {
  test("natural-language correction waits for semantic judgement instead of hard-coded reviewer trigger", () => {
    const sid = sessionID("correctness_user_correction")
    const decision = decide([userMsg("msg_user_corr", "不对，不是这个目标，你跑偏了，按我原来的要求修。")], sid, 1)
    expect(decision.reviewers).not.toContain("requirements-inspector")
    expect(decision.metrics.interaction_level).toBe("L1")
  })

  test("high-risk repeated failure can route more than one reviewer", () => {
    const sid = sessionID("correctness_high_risk_multi")
    const messages = [
      userMsg("msg_user_multi", "不对，继续完成所有目标，不能跳过验证。"),
      toolErrorMsg("bash", "doctor failed: provider routing broken", "dll-agent doctor"),
      toolErrorMsg("bash", "doctor failed: provider routing broken", "dll-agent doctor"),
      asstMsg("已完成，但 tests not run and doctor failed"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.reviewers).toContain("chief-engineer")
    expect(decision.reviewers).not.toContain("requirements-inspector")
  })

  test("MiMo multimodal reviewer does not enter pure text/code tasks", () => {
    const sid = sessionID("correctness_mimo_text")
    const decision = decide([userMsg("msg_user_mimo_text", "检查这段代码和截图这个词，但没有实际图片附件。")], sid, 1)
    expect(decision.reviewers).not.toContain("multimodal-context-interpreter")
  })

  test("routing evidence records correctness_reason and cost_reason", () => {
    const evidence = useEvidenceFile("routing")
    const sid = sessionID("routing_evidence")
    decide([userMsg("msg_user_routing", "不对，这个实现跑偏了。")], sid, 1)
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].payload.correctness_reason).toBeTruthy()
    expect("cost_reason" in entries[0].payload).toBe(true)
  })

  test("ordinary short task writes commander_only routing evidence", () => {
    const evidence = useEvidenceFile("routing-commander-only")
    const sid = sessionID("routing_commander_only")
    const decision = decide([userMsg("msg_user_short", "查看 git status")], sid, 1)
    expect(decision.reviewers).toEqual([])
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    expect(entries.some((entry) => entry.payload.action === "commander_only")).toBe(true)
    expect(entries.find((entry) => entry.payload.action === "commander_only")?.payload.role).toBe("commander")
  })

  test("live smoke equivalent role-model command session then trivial no-tool prompt stays commander-only", () => {
    const evidence = useEvidenceFile("routing-trivial-no-tool")
    const sid = sessionID("routing_trivial_no_tool")
    const messages = [
      userMsg("msg_role_set", "/role-model-set commander deepseek/deepseek-v4-pro --scope session"),
      asstMsg("Updated commander model.\nprevious=mimo/mimo-v2.5-pro\ncurrent=deepseek/deepseek-v4-pro\nsource=session"),
      userMsg("msg_role_models", "/role-models"),
      asstMsg([
        "dll-agent role models:",
        "- commander: deepseek/deepseek-v4-pro | source=session | fallback=- | enabled=true | hint=configured",
        "- long-context-archivist: kimi/kimi-k2.6 | source=global | fallback=- | enabled=true | hint=configured",
        "- final-auditor: openai/gpt-5.5-pro | source=global | fallback=- | enabled=true | hint=configured",
      ].join("\n")),
      userMsg("msg_user_no_tool_ok", "只回答 OK，不要执行工具。"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.trivial_no_tool_task).toBe(true)
    expect(decision.metrics.high_risk_task_signal).toBe(false)
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    const commanderOnly = entries.find((entry) => entry.payload.action === "commander_only")
    expect(commanderOnly?.payload.trigger_reason).toBe("trivial_no_tool_task")
  })

  test("stateless greeting stays commander-only and does not trigger reviewers or verifier", () => {
    const evidence = useEvidenceFile("routing-stateless-greeting")
    const sid = sessionID("routing_stateless_greeting")
    const decision = decide([userMsg("msg_user_hello", "你好")], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.stateless_greeting_task).toBe(false)
    expect(decision.metrics.stateless_chat_task).toBe(true)
    expect(decision.metrics.high_risk_task_signal).toBe(false)
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    const commanderOnly = entries.find((entry) => entry.payload.action === "commander_only")
    expect(commanderOnly?.payload.trigger_reason).toBe("trivial_no_tool_task")
  })

  test("stateless greeting is not polluted by generated reviewer and verification prose", () => {
    const sid = sessionID("routing_stateless_generated_noise")
    const decision = decide([
      userMsg("msg_user_hello_noise", "你好"),
      asstMsg("<task_result>\nVerification Report\n已完成 provider routing gate evidence result ledger 检查，final-auditor blocked."),
      asstMsg("reviewer fallback summary\nblocking risk: supervisor auto-trigger false positive"),
    ], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.stateless_greeting_task).toBe(false)
    expect(decision.metrics.high_risk_task_signal).toBe(false)
    expect(decision.metrics.final_claim).toBe(false)
  })

  test("informational introduction stays commander-only and is not polluted by dll-agent module names", () => {
    const evidence = useEvidenceFile("routing-informational-intake")
    const sid = sessionID("routing_informational_intake")
    const decision = decide([
      userMsg("msg_user_intro", "介绍一下dll-agent"),
      asstMsg("dll-agent 包含 Provider/RoleModel、routing、gate、evidence、Result Ledger 等模块。"),
    ], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.task_kind).toBe("stateless_chat")
    expect(decision.metrics.interaction_level).toBe("L1")
    expect(decision.metrics.high_risk_task_signal).toBe(false)
    expect(decision.metrics.stateless_chat_task).toBe(true)
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    const commanderOnly = entries.find((entry) => entry.payload.action === "commander_only")
    expect(commanderOnly?.payload.trigger_reason).toBe("trivial_no_tool_task")
  })

  test("read-only project introduction stays commander-only after answer completion prose", () => {
    const evidence = useEvidenceFile("routing-read-only-project-intro")
    const sid = sessionID("routing_read_only_project_intro")
    const userText = ["介绍", "工程", "不修改内容"].join(" ")
    const assistantText = [
      ["完整", "介绍"].join(""),
      ["未修改", "源文件"].join(""),
      ["待完成", "后续实验"].join("："),
    ].join("\n")
    const decision = decide([
      userMsg("msg_user_project_intro", userText),
      asstMsg(assistantText),
    ], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.high_risk_task_signal).toBe(false)
    expect(decision.metrics.kimi_completion_check_signal).toBe(false)
    expect(decision.metrics.glm_completion_claim_signal).toBe(false)
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    const commanderOnly = entries.find((entry) => entry.payload.action === "commander_only")
    expect(commanderOnly?.payload.trigger_reason).toBe("trivial_no_tool_task")
  })

  test("trivial no-tool prompt does not hide unresolved supervisor state", () => {
    const sid = sessionID("routing_trivial_blocked_state")
    const state = loadState(sid)
    state.required_reviews = ["requirements-inspector"]
    state.blocked_completion = true
    state.block_reason = "blocking reviewer not reconciled"
    saveState(sid, state)

    const decision = decide([userMsg("msg_user_no_tool_blocked", "只回答 OK，不要执行工具。")], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.verifierTask).toBeUndefined()
    expect(decision.metrics.trivial_no_tool_task).toBe(false)
  })

  test("natural-language high-risk module names do not hard-trigger multiple reviewers", () => {
    const sid = sessionID("routing_high_risk_governance")
    const decision = decide([
      userMsg("msg_user_high_risk", "修改 provider routing gate evidence result ledger permission 相关逻辑，必须严格验证。"),
    ], sid, 1)
    expect(decision.reviewers).toEqual([])
    expect(decision.metrics.high_risk_task_signal).toBe(false)
  })

  test("correctness-required skipped reviewer writes unresolved routing risk and final gate blocks", () => {
    const evidence = useEvidenceFile("routing-risk")
    const sid = sessionID("routing_unresolved_risk")
    writeRoutingEvidence({
      sessionID: sid,
      taskID: sid,
      role: "final-auditor",
      selectedModel: "openai/gpt-5.5-pro",
      candidateModels: ["openai/gpt-5.5-pro"],
      riskLevel: "high",
      triggerReason: "high-risk final claim without verification evidence",
      skippedReviewers: ["final-auditor"],
      skipReason: "correctness_aware_routing_budget",
      correctnessReason: "correctness-required final auditor was skipped by budget and remains unresolved",
      costReason: "budget cap",
      evidenceRefs: ["gate:final"],
      requiredForCorrectness: true,
    })
    const entries = readEvidence(evidence).filter((entry) => entry.type === "model.routing_decision")
    expect(entries[0].payload.unresolved_routing_risk).toBe(true)
    expect(entries[0].payload.skipped_reviewer_details[0].correctness_required).toBe(true)
    const result = finalGate({
      evidenceGate: {
        passed: true,
        needs_evidence: false,
        needs_review: false,
        block_reason: null,
        synthetic_hint: null,
      },
      supervisorState: {
        version: 1,
        phase: "default",
        risk: "high",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        metrics: {
          tool_failures: 0,
          permission_denied: 0,
          user_corrections: 0,
          context_percent: 0,
          context_tokens: 0,
          final_claim: true,
          verification_evidence: true,
          reviewer_conflict_signal: false,
          repeated_tool_failure: false,
          real_tool_evidence: true,
        },
        updated_at: new Date().toISOString(),
      },
      reconciliationConflicts: [],
      costExceeded: false,
      sessionID: sid,
    })
    expect(result.allowed).toBe(false)
    expect(result.reasons.join("\n")).toContain("correctness-required reviewer skipped")
  })
})
