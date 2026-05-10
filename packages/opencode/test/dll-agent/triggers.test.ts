import { describe, expect, test } from "bun:test"
import {
  isStatelessChatPromptText,
  isStatelessGreetingPromptText,
  metrics,
  messageText,
  verifiedToolEvidence,
} from "../../src/dll-agent/triggers"
import type { MessageV2 } from "../../src/session/message-v2"

function userMsg(text: string): MessageV2.WithParts {
  return {
    info: {
      id: "msg_user_" + text.slice(0, 6),
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [{ type: "text", text, id: "p", messageID: "m", sessionID: "ses_test" } as any],
  }
}

function asstMsg(text: string): MessageV2.WithParts {
  return {
    info: {
      id: "msg_asst_" + text.slice(0, 6),
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "dll-agent-commander",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [{ type: "text", text, id: "p", messageID: "m", sessionID: "ses_test" } as any],
  }
}

function bashTool(command: string, output: string, status: "completed" | "error" = "completed"): MessageV2.WithParts {
  const state =
    status === "completed"
      ? { status: "completed", input: { command }, output, title: command, metadata: {}, time: { start: 0, end: 1 } }
      : { status: "error", input: { command }, error: output, time: { start: 0, end: 1 } }
  return {
    info: {
      id: "msg_tool",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "dll-agent-commander",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [
      {
        type: "tool",
        callID: "c",
        tool: "bash",
        state,
        id: "p",
        messageID: "m",
        sessionID: "ses_test",
      } as any,
    ],
  }
}

function readTool(output: string, filePath?: string): MessageV2.WithParts {
  const input: Record<string, unknown> = {}
  if (filePath) input.filePath = filePath
  return {
    info: {
      id: "msg_read",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "dll-agent-commander",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [
      {
        type: "tool",
        callID: "rc",
        tool: "read",
        state: {
          status: "completed",
          input,
          output,
          title: filePath ?? "read",
          metadata: {},
          time: { start: 0, end: 1 },
        },
        id: "rp",
        messageID: "rm",
        sessionID: "ses_test",
      } as any,
    ],
  }
}

function readToolError(error: string, filePath?: string): MessageV2.WithParts {
  const input: Record<string, unknown> = {}
  if (filePath) input.filePath = filePath
  return {
    info: {
      id: "msg_read_err",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      agent: "dll-agent-commander",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [
      {
        type: "tool",
        callID: "rec",
        tool: "read",
        state: {
          status: "error",
          input,
          error,
          time: { start: 0, end: 1 },
        },
        id: "rep",
        messageID: "rem",
        sessionID: "ses_test",
      } as any,
    ],
  }
}

describe("DllAgentTriggers.metrics", () => {
  test("does not infer user correction from hard-coded natural-language phrases", () => {
    const m = metrics([userMsg("That's wrong, let's redo it")])
    expect(m.recentUserCorrection).toBe(false)
    expect(m.taskClassification?.model_classifier_needed).toBe(true)
  })

  test("does not treat ordinary recheck wording as requirement correction", () => {
    const m = metrics([userMsg("再次检查一下有没有问题，仔细检查。")])
    expect(m.recentUserCorrection).toBe(false)
    expect(m.userCorrections).toBe(0)
  })

  test("does not infer final claim from assistant natural-language prose", () => {
    const m = metrics([asstMsg("已经完成 implementation, all tests pass")])
    expect(m.finalClaim).toBe(false)
  })

  test("does not flag plain conversation as final claim", () => {
    const m = metrics([asstMsg("Let me investigate the issue first.")])
    expect(m.finalClaim).toBe(false)
  })

  test("does not infer long-context intent from hard-coded natural-language phrases", () => {
    const m = metrics([userMsg("Please summarize the long log baseline document")])
    expect(m.longContextSignal).toBe(false)
  })
})

describe("DllAgentTriggers.verifiedToolEvidence", () => {
  test("returns true when bash typecheck output shows pass", () => {
    const ok = verifiedToolEvidence([
      bashTool("bun typecheck", "$ tsgo --noEmit\nexited with code 0"),
    ])
    expect(ok).toBe(true)
  })

  test("returns false when output contains error", () => {
    const ok = verifiedToolEvidence([
      bashTool("bun typecheck", "src/foo.ts(1,1): error TS2304: Cannot find name."),
    ])
    expect(ok).toBe(false)
  })

  test("returns false for non-verification commands even with positive output", () => {
    const ok = verifiedToolEvidence([bashTool("ls -la", "all good, success!")])
    expect(ok).toBe(false)
  })

  test("returns false on tool error", () => {
    const ok = verifiedToolEvidence([bashTool("bun test", "boom", "error")])
    expect(ok).toBe(false)
  })

  test("returns false for plain assistant text claiming pass without tool call", () => {
    const ok = verifiedToolEvidence([asstMsg("typecheck passed, all green")])
    expect(ok).toBe(false)
  })

  test("detects python3 -m py_compile as verification command", () => {
    const ok = verifiedToolEvidence([
      bashTool("python3 -m py_compile /usr/local/bin/script", "exited with code 0"),
    ])
    expect(ok).toBe(true)
  })

  test("detects git diff --check as verification command", () => {
    const ok = verifiedToolEvidence([
      bashTool("git diff --check", "exited with code 0"),
    ])
    expect(ok).toBe(true)
  })

  test("detects dll-agent doctor as verification command", () => {
    const ok = verifiedToolEvidence([
      bashTool("dll-agent doctor", "result: ok"),
    ])
    expect(ok).toBe(true)
  })

  test("doctor output with result: warn is still positive evidence", () => {
    const ok = verifiedToolEvidence([
      bashTool("dll-agent doctor", "result: warn\n  WARN: rendered runtime config contains API keys"),
    ])
    expect(ok).toBe(true)
  })

  test("doctor output with result: failed is NOT positive evidence", () => {
    const ok = verifiedToolEvidence([
      bashTool("dll-agent doctor", "result: failed\n  FAIL: missing registry"),
    ])
    expect(ok).toBe(false)
  })

  test("git diff --check with error output is NOT positive evidence", () => {
    const ok = verifiedToolEvidence([
      bashTool("git diff --check", "trailing whitespace error: src/foo.ts:10"),
    ])
    expect(ok).toBe(false)
  })

  test("browser audit artifact output is real tool evidence even when report has FAIL counts", () => {
    const ok = verifiedToolEvidence([
      bashTool(
        "node audit-full-browser.mjs",
        "Report saved to: files/full-crm-browser-flow-audit-report.md\n| ❌ FAIL | 5 |\nScreenshots captured: 55",
      ),
    ])
    expect(ok).toBe(true)
  })
})

describe("DllAgentTriggers.metrics self-injection filter (P0)", () => {
  test("ignores [dll-agent supervisor auto-trigger] lines for conflictPattern", () => {
    const m = metrics([
      asstMsg(
        [
          "[dll-agent supervisor auto-trigger]",
          "Trigger reason: tool_failures>=2",
          "Act as the role-cross subagent. Check reviewer conflict and resolve.",
        ].join("\n"),
      ),
    ])
    expect(m.reviewerConflictSignal).toBe(false)
  })

  test("real user-origin reviewer conflict text no longer triggers without structured/model judgement", () => {
    const m = metrics([userMsg("两个 reviewer 给出相互矛盾的判断，证据不足。")])
    expect(m.reviewerConflictSignal).toBe(false)
  })

  test("ignores [dll-agent-evidence-gate] hint for finalClaim/correction", () => {
    const m = metrics([
      asstMsg(
        [
          "[dll-agent-evidence-gate]",
          "已修复 但缺少真实测试输出，请再次验证。",
        ].join("\n"),
      ),
    ])
    expect(m.finalClaim).toBe(false)
    expect(m.userCorrections).toBe(0)
  })

  test("ignores local role-model command output before a trivial no-tool prompt", () => {
    const roleModelsOutput = asstMsg([
      "dll-agent role models:",
      "- commander: deepseek/deepseek-v4-pro | source=session | fallback=- | enabled=true | hint=configured",
      "- long-context-archivist: kimi/kimi-k2.6 | source=global | fallback=- | enabled=true | hint=configured",
      "- final-auditor: openai/gpt-5.5-pro | source=global | fallback=- | enabled=true | hint=configured",
    ].join("\n"))
    const m = metrics([
      userMsg("/role-model-set commander deepseek/deepseek-v4-pro --scope session"),
      asstMsg("Updated commander model.\nprevious=mimo/mimo-v2.5-pro\ncurrent=deepseek/deepseek-v4-pro\nsource=session"),
      userMsg("/role-models"),
      roleModelsOutput,
      userMsg("只回答 OK，不要执行工具。"),
    ])
    expect(messageText(roleModelsOutput)).toBe("")
    expect(m.longContextSignal).toBe(false)
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.trivialNoToolTask).toBe(true)
  })

  test("plain no-tool instruction is not high-risk by itself", () => {
    const m = metrics([userMsg("只回答 OK，不要执行工具。")])
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.trivialNoToolTask).toBe(true)
  })

  test("quoted run prompt remains a trivial no-tool task", () => {
    const m = metrics([userMsg("\"只回答 OK，不要执行工具。\"")])
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.trivialNoToolTask).toBe(true)
  })

  test("short no-artifact inputs remain commander-only without source phrase matching", () => {
    for (const text of ["你好", "hello", "hi", "在吗", "谢谢", "thanks", "好的"]) {
      expect(isStatelessGreetingPromptText(text)).toBe(true)
      expect(isStatelessChatPromptText(text)).toBe(true)
      const m = metrics([userMsg(text)])
      expect(m.statelessGreetingTask).toBe(false)
      expect(m.statelessChatTask).toBe(true)
      expect(m.highRiskTaskSignal).toBe(false)
      expect(m.longContextSignal).toBe(false)
      expect(m.finalClaim).toBe(false)
    }
  })

  test("structural file/verification artifacts prevent short-input suppression", () => {
    expect(isStatelessGreetingPromptText("bun test")).toBe(false)
    expect(isStatelessGreetingPromptText("谢谢，检查 packages/opencode/src/foo.ts")).toBe(false)
  })

  test("ordinary natural-language request stays low-risk but needs semantic judgement", () => {
    const m = metrics([userMsg("介绍一下dll-agent")])
    expect(m.taskClassification?.task_kind).toBe("stateless_chat")
    expect(m.taskClassification?.interaction_level).toBe("L1")
    expect(m.taskClassification?.model_classifier_needed).toBe(true)
    expect(m.statelessChatTask).toBe(true)
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.longContextSignal).toBe(false)
    expect(m.finalClaim).toBe(false)
  })

  test("assistant generated engineering terms do not turn short user input high-risk", () => {
    const m = metrics([
      userMsg("介绍一下dll-agent"),
      asstMsg("dll-agent 包含 Provider/RoleModel、routing、gate、evidence、Result Ledger 等模块。"),
    ])
    expect(m.taskClassification?.task_kind).toBe("stateless_chat")
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.longContextSignal).toBe(false)
    expect(m.finalClaim).toBe(false)
  })

  test("read-only project introduction does not convert answer text into governance completion triggers", () => {
    const userText = ["介绍", "工程", "不修改内容"].join(" ")
    const assistantText = [
      ["完整", "介绍"].join(""),
      ["未修改", "源文件"].join(""),
      ["待完成", "后续实验"].join("："),
    ].join("\n")
    const m = metrics([
      userMsg(userText),
      asstMsg(assistantText),
    ])
    expect(m.taskClassification?.verification_required).toBe(false)
    expect(m.readOnlyAnswerTask || m.statelessChatTask).toBe(true)
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.kimiCompletionCheckSignal).toBe(false)
    expect(m.glmCompletionClaimSignal).toBe(false)
    expect(m.kimiPreReportSignal).toBe(false)
  })

  test("read-only tool-only answer treats read-tool misses as informational gaps, not recovery failures", () => {
    const m = metrics([
      userMsg(["介绍", "工程", "不修改内容"].join(" ")),
      readToolError("ENOENT: no such file or directory, open 'docs/missing.md'", "docs/missing.md"),
      asstMsg("以上是该工程的介绍，未修改任何内容。"),
    ])
    expect(m.taskClassification?.interaction_level).toBe("L1")
    expect(m.readOnlyToolAnswerTask).toBe(true)
    expect(m.readOnlyAnswerTask).toBe(true)
    expect(m.toolFailures).toBe(0)
    expect(m.repeatedToolFailure).toBe(false)
    expect(m.kimiCompletionCheckSignal).toBe(false)
    expect(m.glmCompletionClaimSignal).toBe(false)
  })

  test("self-generated task result and verification reports do not pollute routing signals", () => {
    const m = metrics([
      userMsg("你好"),
      asstMsg("<task_result>\nVerification Report\n已完成 provider routing gate evidence result ledger 检查，final-auditor blocked."),
      asstMsg("reviewer fallback summary\nblocking risk: supervisor auto-trigger false positive"),
      asstMsg("subtask resume text\n用户说不对，重新检查 provider routing"),
    ])
    expect(m.statelessChatTask).toBe(true)
    expect(m.highRiskTaskSignal).toBe(false)
    expect(m.longContextSignal).toBe(false)
    expect(m.finalClaim).toBe(false)
    expect(m.recentUserCorrection).toBe(false)
  })
})

describe("DllAgentTriggers.metrics read-tool false positive (P0-2)", () => {
  test("read tool returning source code with 'permission denied' is NOT a tool failure", () => {
    // Source files like triggers.ts contain 'permission denied' in regex patterns.
    // Reading them should not be counted as tool failures.
    const m = metrics([
      readTool("const pat = /permission denied|not allowed/i\n// check for permission denied errors", "triggers.ts"),
    ])
    expect(m.toolFailures).toBe(0)
    expect(m.permissionDenied).toBe(0)
  })

  test("read tool returning source code with 'error:' is NOT a tool failure", () => {
    // Source files like supervisor.ts contain 'error:' in code, e.g. catch blocks.
    const m = metrics([
      readTool("if (part.state.status === 'error') {\n  console.log('error: tool failed')\n}", "supervisor.ts"),
    ])
    expect(m.toolFailures).toBe(0)
  })

  test("real bash tool error is still counted correctly", () => {
    const m = metrics([
      bashTool("bun build", "error: module not found\nfailed to compile", "error"),
    ])
    expect(m.toolFailures).toBe(1)
  })

  test("real bash completed with error output is still counted", () => {
    const m = metrics([
      bashTool("pytest", "FAILED tests/test_foo.py::test_bar - assert 1 == 2\n1 failed, 4 passed"),
    ])
    expect(m.toolFailures).toBe(1)
  })
})

describe("DllAgentTriggers.metrics reviewer output filter (P0-2)", () => {
  test("reviewer JSON output containing 'reviewer conflict' does NOT trigger conflict signal", () => {
    const reviewerJson = `\`\`\`json
{
  "version": 1,
  "reviewer": "role-cross",
  "trigger_reason": "reviewer conflict signal detected in messages",
  "verdict": "pass",
  "findings": [
    {"severity": "info", "category": "phase_drift", "summary": "reviewer conflict resolved"}
  ],
  "score": 80,
  "block_completion": false,
  "next_actions": [],
  "evidence_confidence": 90,
  "ts": "2024-01-01T00:00:00.000Z"
}
\`\`\``
    const m = metrics([asstMsg(reviewerJson)])
    expect(m.reviewerConflictSignal).toBe(false)
  })

  test("reviewer JSON output containing '证据不足' does NOT trigger conflict signal", () => {
    const reviewerJson = `\`\`\`json
{
  "version": 1,
  "reviewer": "requirements-inspector",
  "trigger_reason": "verification step check",
  "verdict": "pass_with_notes",
  "findings": [
    {"severity": "warning", "category": "evidence_missing", "summary": "证据不足：未提供实际运行输出"}
  ],
  "score": 70,
  "block_completion": false,
  "next_actions": [],
  "evidence_confidence": 60,
  "ts": "2024-01-01T00:00:00.000Z"
}
\`\`\``
    const m = metrics([asstMsg(reviewerJson)])
    expect(m.reviewerConflictSignal).toBe(false)
  })

  test("real user natural-language conflict text waits for semantic judgement", () => {
    const m = metrics([userMsg("两个 reviewer 输出有冲突，无法判断谁对谁错")])
    expect(m.reviewerConflictSignal).toBe(false)
  })

  test("code containing trigger field names does NOT create false conflict signal", () => {
    // Source code comments or variable names should not trigger patterns
    const m = metrics([
      asstMsg("The reviewerConflictSignal should be checked against user messages only."),
    ])
    expect(m.reviewerConflictSignal).toBe(false)
  })
})

// ─── Phase 6: New trigger signals ──────────────────────────────────────────

describe("DllAgentTriggers.Phase6.kimiCompletionCheckSignal", () => {
  test("does not trigger from assistant prose without structured completion state", () => {
    const m = metrics([
      asstMsg("全部任务已完成，但仍有 TODO：文档更新"),
      asstMsg("all done, TODO: clean up pending"),
    ])
    expect(m.finalClaim).toBe(false)
    expect(m.kimiCompletionCheckSignal).toBe(false)
  })

  test("does not trigger from natural-language unfinished wording alone", () => {
    const m = metrics([asstMsg("任务已完成，但未完成：集成测试未运行")])
    expect(m.kimiCompletionCheckSignal).toBe(false)
  })

  test("does NOT trigger without completion claim", () => {
    const m = metrics([asstMsg("Let me investigate the TODO list first.")])
    expect(m.kimiCompletionCheckSignal).toBe(false)
  })

  test("does NOT trigger when completion claim has no unfinished indicators", () => {
    const m = metrics([asstMsg("All tasks completed and verified. Ready to merge.")])
    expect(m.finalClaim).toBe(false)
    expect(m.kimiCompletionCheckSignal).toBe(false)
  })
})

describe("DllAgentTriggers.Phase6.glmCompletionClaimSignal", () => {
  test("does not trigger from assistant completion prose without structured gate state", () => {
    const m = metrics([asstMsg("All tasks are done, verified and completed.")])
    expect(m.glmCompletionClaimSignal).toBe(false)
  })

  test("does NOT trigger without completion claim", () => {
    const m = metrics([asstMsg("Still working on the bug fix...")])
    expect(m.glmCompletionClaimSignal).toBe(false)
  })
})

describe("DllAgentTriggers.Phase6.kimiPreReportSignal", () => {
  test("does not trigger pre-report archivist from context alone without structured final claim", () => {
    // Use lastAssistant tokens to simulate high token count
    const highTokenAsst = {
      info: {
        id: "msg_asst_high",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 0 },
        agent: "commander",
        model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
        tokens: { input: 350000, output: 50000, reasoning: 0, cache: { read: 0, write: 0 } },
      } as any,
      parts: [{ type: "text" as const, text: "All done, completed successfully!", id: "p", messageID: "m", sessionID: "ses_test" } as any],
    }
    const m = metrics([highTokenAsst], 1_000_000)
    expect(m.contextPercent).toBe(40)
    expect(m.kimiPreReportSignal).toBe(false)
  })

  test("does NOT trigger when context is below 30%", () => {
    const lowTokenAsst = {
      info: {
        id: "msg_asst_low",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 0 },
        agent: "commander",
        model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
        tokens: { input: 100000, output: 50000, reasoning: 0, cache: { read: 0, write: 0 } },
      } as any,
      parts: [{ type: "text" as const, text: "All done!", id: "p", messageID: "m", sessionID: "ses_test" } as any],
    }
    const m = metrics([lowTokenAsst], 1_000_000)
    expect(m.kimiPreReportSignal).toBe(false)
  })
})

describe("DllAgentTriggers.Phase6.scopeExpandedSignal", () => {
  test("does not trigger scope expansion from natural-language wording alone", () => {
    const m = metrics([userMsg("不对，你扩大了范围，增加了额外功能")])
    expect(m.scopeExpandedSignal).toBe(false)
  })

  test("does NOT trigger in normal flow", () => {
    const m = metrics([userMsg("继续执行下一步")])
    expect(m.scopeExpandedSignal).toBe(false)
  })
})

describe("DllAgentTriggers.Phase6.phaseSwitchSignal", () => {
  test("does not trigger phase switch from natural-language wording alone", () => {
    const m = metrics([userMsg("先不要做那个了，换个方向，先修这个bug")])
    expect(m.phaseSwitchSignal).toBe(false)
  })

  test("structural private-token wording does not become phase switch", () => {
    const m = metrics([userMsg("暂停当前任务，改为检查 token 使用")])
    expect(m.phaseSwitchSignal).toBe(false)
  })

  test("does NOT trigger in normal continuation", () => {
    const m = metrics([userMsg("继续刚才的工作")])
    expect(m.phaseSwitchSignal).toBe(false)
  })
})
