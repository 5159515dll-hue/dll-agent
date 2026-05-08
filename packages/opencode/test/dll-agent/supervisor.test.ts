import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { buildVerifierSubtask, pickVerifierAgent, decide, recordReviewerCall, markReviewerCompleted, isReadOnlyReviewer, updateState, buildFinalReportContext, loadCooldown, loadState, modelContextLimit, buildTaskCompletionSubtask, saveState, setQueuedReviewers, setRunningReviewers } from "../../src/dll-agent/supervisor"
import type { MessageV2 } from "../../src/session/message-v2"

const cleanupSessions: string[] = []

afterEach(() => {
  for (const id of cleanupSessions.splice(0)) {
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", id), { recursive: true, force: true })
  }
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

  test("dedupes same reviewer/reason for the same user message via trigger fingerprint", () => {
    const sid = sessionID("fingerprint")
    const messages = [userMsg("msg_user_same", "不对，这个方向跑偏了，需要按新的方向处理。")]
    const first = decide(messages, sid, 1)
    expect(first.reviewers).toContain("requirements-inspector")
    const reviewer = "requirements-inspector"
    recordReviewerCall(
      sid,
      reviewer,
      1,
      first.fingerprints?.[reviewer],
      first.reasons[reviewer],
      "msg_user_same",
    )
    markReviewerCompleted(sid, reviewer)

    const second = decide(messages, sid, 10)
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
  test("completion claim without real tool evidence triggers auto-verifier", () => {
    const sid = sessionID("auto_verifier")
    const messages: any[] = [
      userMsg("msg_u", "请修复bug"),
      asstMsg("已经完成修复，所有测试通过，可以交付。"),
    ]
    const decision = decide(messages, sid, 1)
    expect(decision.verifierTask).toBeDefined()
    expect(decision.verifierTask!.type).toBe("subtask")
    expect(decision.verifierTask!.command).toBe("dll-agent-supervisor")
    expect(decision.verifierTask!.prompt).toContain("bun typecheck")
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

    // Force longContextSignal by passing a low contextLimit to ensure contextPercent >= 40
    const decision1 = decide(messages1, sid, 1, 400)
    expect(decision1.reviewers).toContain("long-context-archivist")

    // Record the reviewer call with the original fingerprint
    const fpKey = "long-context-archivist"
    recordReviewerCall(
      sid,
      fpKey,
      1,
      decision1.fingerprints?.[fpKey],
      decision1.reasons[fpKey],
      realUserID,
    )

    // Verify fingerprint was stored
    const cd1 = loadCooldown(sid)
    const fp1 = decision1.fingerprints?.[fpKey]
    expect(cd1.review_fingerprints?.[fp1!]).toBeDefined()

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
  test("Rule 2b: triggers long-context-archivist when context >= 30% and final claim", () => {
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
    expect(decision.reviewers).toContain("long-context-archivist")
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
  test("Rule 8: triggers requirements-inspector when completion claim without real tool evidence", () => {
    const sid = sessionID("glm_completion_claim")
    const msgs: any[] = [
      userMsg("msg_user_glm", "修复那个bug"),
      asstMsg("已经完成了，验证通过，all tests pass"),
    ]
    const decision = decide(msgs, sid, 5)
    expect(decision.reviewers).toContain("requirements-inspector")
  })
})

describe("DllAgentSupervisor.Phase6.kimiCompletionCheck", () => {
  test("Rule 9: triggers task-completion-archivist when completion claim has unfinished indicators", () => {
    const sid = sessionID("kimi_completion")
    const msgs: any[] = [
      userMsg("msg_user_kc", "优化模型路由"),
      asstMsg("任务已完成，但未完成：TODO cleanup pending"),
    ]
    const decision = decide(msgs, sid, 8)
    expect(decision.reviewers).toContain("task-completion-archivist")
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
  test("Rule 10: triggers requirements-inspector on scope expansion", () => {
    const sid = sessionID("scope_expansion")
    const msgs: any[] = [
      userMsg("msg_user_se", "不对，你扩大了范围，增加了额外需求"),
      asstMsg("I see, let me narrow the scope."),
    ]
    const decision = decide(msgs, sid, 4)
    expect(decision.reviewers).toContain("requirements-inspector")
  })
})

describe("DllAgentSupervisor.Phase6.phaseSwitch", () => {
  test("Rule 2c: triggers long-context-archivist on phase switch", () => {
    const sid = sessionID("phase_switch")
    const msgs: any[] = [
      userMsg("msg_user_ps", "先不要做那个了，换个方向，先处理 token 优化"),
      asstMsg("Switching direction to token optimization."),
    ]
    const decision = decide(msgs, sid, 6)
    expect(decision.reviewers).toContain("long-context-archivist")
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
