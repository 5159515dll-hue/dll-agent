/**
 * dll-agent gates.ts
 *
 * Evidence gate、reconciliation gate、final completion gate 的判定标准。
 * 所有 gate 判断基于代码（结构化逻辑），部分需要模型辅助时通过 reviewer 完成。
 */

import { verifiedToolEvidence } from "./triggers"
import { write as writeEvidence } from "./evidence"
import {
  type EvidenceGateInput,
  type EvidenceGateResult,
  type ReviewerOutput,
  type SupervisorState,
} from "./interfaces"
import type { MessageV2 } from "@/session/message-v2"
import { loadResults } from "./result-ledger"
import { checkResultSufficiency } from "./result-sufficiency-gate"
import { buildEvidenceSnapshot } from "./evidence-normalizer"
import { evaluateCompletionReadiness } from "./completion-readiness"
import { assessGoalCompletion, loadGoalContract } from "./goal-contract"

/** 同一 block reason 在同一 session 中最多允许自动重试次数 */
export const GATE_MAX_RETRIES = 2

// ─── Evidence Gate 判定标准 ──────────────────────────────────────────────

/**
 * evidence gate 判定标准（纯代码逻辑，不调模型）：
 *
 * 通过条件：
 * 1. 不是完成声明 → 直接 pass
 * 2. 是完成声明 → 需要至少满足以下一项：
 *    a. 包含命令（bash、npm、pytest 等）
 *    b. 包含命令输出/日志
 *    c. 包含文件路径引用
 *    d. 显式标记为 "未验证"
 *    e. 所有 required reviews 已完成
 *
 * 阻断条件：
 * - high risk + 完成声明 + 缺验证证据
 * - medium risk + 完成声明 + 缺验证证据 + 有 required reviews pending
 * - 任何级别 + block_reason 未解除
 */

export function checkEvidenceGate(input: EvidenceGateInput, messages?: MessageV2.WithParts[]): EvidenceGateResult {
  // 不是完成声明 → pass
  if (!input.isCompletionClaim) {
    return {
      passed: true,
      needs_evidence: false,
      needs_review: false,
      block_reason: null,
      synthetic_hint: null,
    }
  }

  // 优先使用"真工具证据"（实际跑过 typecheck/test/doctor 且工具输出 pass）；
  // 退化到字符串匹配作为兜底。这样模型在自然语言里写 "测试通过" 不再算证据。
  const toolEvidence = messages ? verifiedToolEvidence(messages) : false
  const evidenceSnapshot = buildEvidenceSnapshot({
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    toolEvidence,
  })
  const readiness = evaluateCompletionReadiness({ snapshot: evidenceSnapshot })
  if (!readiness.can_claim_verified && evidenceSnapshot.has_real_tool_evidence && (evidenceSnapshot.fail_count > 0 || evidenceSnapshot.blockers.length > 0)) {
    return {
      passed: false,
      needs_evidence: false,
      needs_review: true,
      block_reason: `evidence exists but completion is not verified: ${readiness.reasons.slice(0, 3).join("; ")}`,
      synthetic_hint: `<dll-agent-final-gate>
Completion claim is blocked because real evidence contains unresolved failures or contradictions.
Status: ${readiness.status}
Reasons:
${readiness.reasons.map((reason, index) => `${index + 1}. ${reason}`).join("\n")}
Required next actions:
${readiness.required_next_actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}
</dll-agent-final-gate>`,
    }
  }

  const realEvidence = evidenceSnapshot.has_real_tool_evidence
  // 高风险只接受真工具证据；其它风险允许字符串匹配作为兜底。
  const hasEvidence =
    realEvidence ||
    (input.risk !== "high" && input.hasVerificationEvidence && checkEvidencePresence(input.assistantText))

  if (hasEvidence) {
    // 有验证证据，还需要检查 reviewer 是否全部完成
    if (!input.allReviewsCompleted && input.risk !== "low") {
      // 中等或高风险 + 有 pending reviewer → 提示但不硬阻断
      return {
        passed: true,
        needs_evidence: false,
        needs_review: true,
        block_reason: null,
        synthetic_hint: `[dll-agent evidence gate: note] ${input.risk} risk completion with pending reviews. Consider running /team-review before finalizing.`,
      }
    }
    return {
      passed: true,
      needs_evidence: false,
      needs_review: false,
      block_reason: null,
      synthetic_hint: null,
    }
  }

  // 缺验证证据
  if (input.risk === "high") {
    // 高风险 + 缺验证 → 硬阻断
    return {
      passed: false,
      needs_evidence: true,
      needs_review: true,
      block_reason: "high-risk completion claim without verification evidence",
      synthetic_hint: `<dll-agent-final-gate>
Completion claim is blocked because real verification evidence is missing.
Risk level: ${input.risk}.
Required: actually run a verification command (e.g. \`bun typecheck\`, \`bun test\`, \`dll-agent doctor\`, \`pytest\`) AS A TOOL CALL and let the gate observe the tool output.
Writing "tests passed" in plain text no longer counts — the gate now inspects real tool stdout.
Alternatively, explicitly mark the claim as unverified with: "This claim is unverified."
</dll-agent-final-gate>`,
    }
  }

  if (input.risk === "medium" && !input.allReviewsCompleted) {
    // 中等风险 + 缺验证 + reviewer 未完成 → 软阻断
    return {
      passed: false,
      needs_evidence: true,
      needs_review: true,
      block_reason: "medium-risk completion without verification and pending reviews",
      synthetic_hint: `<dll-agent-final-gate>
Completion claim needs more evidence. Either run verification or mark the claim as unverified.
Pending reviews: ensure all required role reviews are completed.
</dll-agent-final-gate>`,
    }
  }

  // 低风险 → 提示但通过
  return {
    passed: true,
    needs_evidence: true,
    needs_review: false,
    block_reason: null,
    synthetic_hint: `<dll-agent-final-gate>
Note: completion claim was made without explicit verification evidence.
If this is intentional, mark as unverified: "This claim is unverified."
Otherwise, run verification before finalizing.
</dll-agent-final-gate>`,
  }
}

/** 检查文本中是否包含验证证据 */
function checkEvidencePresence(text: string): boolean {
  const evidencePatterns = [
    /(运行了|执行了|验证|测试|typecheck|doctor|smoke|pytest|npm test|bun run|vitest|go test)/i,
    /(pass|passed|通过|success|成功|ok|green|all tests)/i,
    /(命令输出|output:|observed:|log output|checkpoint)/i,
    /(文件路径|file path|路径验证|path verified)/i,
    /(已通过|已验证|确认无问题|diff --check.*ok)/i,
    /(build.*success|编译通过|type.*check.*pass)/i,
  ]

  return evidencePatterns.some((pattern) => pattern.test(text))
}

// ─── Reconciliation Gate ──────────────────────────────────────────────────

/**
 * Reconciliation gate：检查 reviewer 输出是否一致，是否有冲突。
 *
 * 输入：已完成的 reviewer 输出列表。
 * 输出：是否需要 reconciliation，以及冲突详情。
 */
export function checkReconciliation(reviewerOutputs: ReviewerOutput[]): {
  needs_reconciliation: boolean
  conflicts: string[]
  unified_verdict: "pass" | "fail" | "conflict"
} {
  if (reviewerOutputs.length < 2) {
    return { needs_reconciliation: false, conflicts: [], unified_verdict: "pass" }
  }

  const conflicts: string[] = []
  const verdicts = reviewerOutputs.map((r) => r.verdict)

  // 检查 verdict 冲突
  const hasBlock = verdicts.some((v) => v === "fail_block")
  const hasPass = verdicts.some((v) => v === "pass")

  if (hasBlock && hasPass) {
    conflicts.push("reviewer verdict conflict: one reviewer blocks while another passes")
  }

  // 检查 finding category 冲突
  const allCategories = new Set<string>()
  for (const output of reviewerOutputs) {
    for (const finding of output.findings) {
      allCategories.add(`${output.reviewer}:${finding.category}`)
    }
  }

  // 检查证据信心差距
  const confidences = reviewerOutputs.map((r) => r.evidence_confidence)
  const maxConf = Math.max(...confidences)
  const minConf = Math.min(...confidences)
  if (maxConf - minConf >= 40) {
    conflicts.push(
      `evidence confidence gap: ${minConf} (by ${reviewerOutputs[confidences.indexOf(minConf)].reviewer}) vs ${maxConf} (by ${reviewerOutputs[confidences.indexOf(maxConf)].reviewer})`,
    )
  }

  const needsReconciliation = conflicts.length > 0
  const unifiedVerdict = hasBlock ? "fail" : hasPass ? "pass" : "conflict"

  return {
    needs_reconciliation: needsReconciliation,
    conflicts,
    unified_verdict: unifiedVerdict,
  }
}

// ─── Reconciliation Hard-Block Gate (Phase 4) ─────────────────────────────

/**
 * Phase 4: 当 supervisor 已记录完成的 reviewer，但 commander 在最终声明里
 * 完全没有出现"采纳/吸收/反驳/根据 reviewer"等关键字时，硬阻断完成声明。
 *
 * 设计原则：宽松匹配关键词（多语言/同义词），命中即算"已吸收"。
 * 没有 completed_reviews 时不阻断；非完成声明时不阻断。
 */
const RECONCILIATION_ABSORPTION_PATTERNS: RegExp[] = [
  /reviewer.*(采纳|吸收|采用|参考|根据|按)/i,
  /(采纳|吸收|采用|按).*reviewer/i,
  /(根据|按照).*(reviewer|审查|审核|建议)/i,
  /(已修正|已修改|已根据|已对照).*(reviewer|审查|审核|建议)/i,
  /(adopted|incorporated|addressed|applied|reconciled|per reviewer|in response to reviewer)/i,
  /(reject|拒绝|不采纳).*reviewer/i,
  /(按 reviewer|按照 reviewer|经 reviewer)/i,
]

export function checkReconciliationGate(input: {
  isCompletionClaim: boolean
  assistantText: string
  state: SupervisorState
}): { passed: boolean; block_reason: string | null; synthetic_hint: string | null } {
  if (!input.isCompletionClaim) {
    return { passed: true, block_reason: null, synthetic_hint: null }
  }
  if (!input.state.completed_reviews || input.state.completed_reviews.length === 0) {
    return { passed: true, block_reason: null, synthetic_hint: null }
  }
  const hasAbsorption = RECONCILIATION_ABSORPTION_PATTERNS.some((re) => re.test(input.assistantText))
  if (hasAbsorption) {
    return { passed: true, block_reason: null, synthetic_hint: null }
  }
  return {
    passed: false,
    block_reason: `completion claim does not explicitly absorb reviewer findings: ${input.state.completed_reviews.join(", ")}`,
    synthetic_hint: `<dll-agent-reconciliation-gate>
Reviewers ran in this session but the completion claim does not reference them.
Required: explicitly state how each reviewer's findings were absorbed, fixed, or evidence-rejected.
Reviewers completed: ${input.state.completed_reviews.join(", ")}.
Acknowledge with phrasing such as "已采纳 reviewer 的 X 建议", "按 reviewer 修正 Y", or "evidence-rejected reviewer claim Z because ...".
</dll-agent-reconciliation-gate>`,
  }
}

/**
 * Final gate：综合所有条件判定是否允许完成。
 *
 * 通过条件（全部满足）：
 * 1. evidence gate 通过
 * 2. 所有 required reviews 已完成
 * 3. 无未解决的 reviewer 冲突
 * 4. block_reason 已清除
 * 5. 成本未超出上限
 */
export function finalGate(params: {
  evidenceGate: EvidenceGateResult
  supervisorState: SupervisorState
  reconciliationConflicts: string[]
  costExceeded: boolean
  /** Phase 7: session ID for Result Ledger query */
  sessionID?: string
  /** Project directory for Artifact Ledger query */
  projectDir?: string
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (!params.evidenceGate.passed) {
    reasons.push(params.evidenceGate.block_reason ?? "evidence gate not passed")
  }

  if (params.supervisorState.blocked_completion) {
    reasons.push(params.supervisorState.block_reason ?? "completion blocked by supervisor")
  }

  if (params.supervisorState.required_reviews.length > 0) {
    reasons.push(
      `pending reviews: ${params.supervisorState.required_reviews.join(", ")}`,
    )
  }

  if (params.reconciliationConflicts.length > 0) {
    reasons.push(
      `reviewer conflicts unresolved: ${params.reconciliationConflicts.join("; ")}`,
    )
  }

  if (params.costExceeded) {
    reasons.push("session cost cap exceeded")
  }

  // Phase 7: Check Result Ledger for blocking unfinished subtasks
  if (params.sessionID) {
    try {
      const results = loadResults(params.sessionID)
      const blockers = results.filter((r) =>
        r.completion_status === "BLOCKED" || (r.completion_status === "PARTIAL" && r.unresolved_items.length > 0)
      )
      if (blockers.length > 0) {
        reasons.push(
          `result ledger has ${blockers.length} blocking/partial subtask(s): ` +
          blockers.map((b) => `${b.executing_role}: ${b.subtask_goal.slice(0, 80)}`).join("; "),
        )
      }
      // Check for unverified results
      const unverified = results.filter((r) => r.completion_status === "UNVERIFIED")
      if (unverified.length > 0) {
        reasons.push(
          `result ledger has ${unverified.length} unverified subtask(s) — verification needed before final PASS`,
        )
      }
    } catch {
      // Result ledger read is best-effort
    }
  }

  if (params.sessionID || params.projectDir) {
    const snapshot = buildEvidenceSnapshot({
      sessionID: params.sessionID,
      projectDir: params.projectDir,
      toolEvidence: params.evidenceGate.passed,
    })
    const readiness = evaluateCompletionReadiness({
      snapshot,
      state: params.supervisorState,
    })
    if (!readiness.can_claim_verified) {
      reasons.push(...readiness.reasons.map((reason) => `completion readiness: ${reason}`))
    }
  }

  if (params.sessionID) {
    const contract = loadGoalContract(params.sessionID)
    if (contract) {
      const resultSufficiency = checkResultSufficiency(params.sessionID, contract.user_goal, {
        requiredVerifications: contract.required_verification,
        projectDir: params.projectDir,
      })
      if (resultSufficiency.verdict !== "sufficient") {
        reasons.push(
          `result ledger missing verified result for goal contract: ${resultSufficiency.verdict} (${resultSufficiency.neededActions.join("; ")})`,
        )
      }
      const assessment = assessGoalCompletion({
        contract,
        verificationResults: params.evidenceGate.passed
          ? [{ name: "evidence_gate", status: "passed", evidenceRef: "gate:evidence" }]
          : [{ name: "evidence_gate", status: "not_run" }],
        blockers: params.supervisorState.blocked_completion && params.supervisorState.block_reason
          ? [params.supervisorState.block_reason]
          : [],
        budgetExhausted: params.costExceeded,
      })
      writeEvidence("goal_contract.evaluated", {
        task_id: contract.task_id,
        final_status: assessment.final_status,
        can_claim_complete: assessment.can_claim_complete,
        reasons: assessment.reasons,
        blocking_items: assessment.blocking_items,
      }, params.sessionID)
      if (!assessment.can_claim_complete) {
        reasons.push(
          `goal contract ${assessment.final_status}: ${assessment.reasons.join("; ")}${assessment.blocking_items.length ? ` (${assessment.blocking_items.join("; ")})` : ""}`,
        )
      }
    }
  }

  const allowed = reasons.length === 0

  if (!allowed) {
    writeEvidence("gate.blocked_completion", {
      reasons,
      evidence_gate: params.evidenceGate,
      required_reviews: params.supervisorState.required_reviews,
    })
  } else {
    writeEvidence("gate.passed", {
      evidenceGate: params.evidenceGate,
      required_reviews: params.supervisorState.required_reviews,
    })
  }

  return { allowed, reasons }
}

// ─── Gate Retry Tracking ──────────────────────────────────────────────────

/**
 * 记录一次 gate block 尝试。
 * 在 supervisor state 中递增对应 block_reason 的 retry 计数。
 */
export function recordGateBlock(state: SupervisorState, blockReason: string) {
  state.gate_block_retries ??= {}
  state.gate_block_retries[blockReason] = (state.gate_block_retries[blockReason] ?? 0) + 1
}

/**
 * 同一 block reason 在同一 session 中是否已超过自动重试上限。
 */
export function isGateRetryExhausted(state: SupervisorState, blockReason: string): boolean {
  const count = state.gate_block_retries?.[blockReason] ?? 0
  return count > GATE_MAX_RETRIES
}

/**
 * 生成 gate 阻断摘要。
 * 包含：block reason、缺少什么证据、下一步需要什么。
 */
export function buildGateBlockSummary(
  blockReason: string,
  gateResult: EvidenceGateResult,
  state: SupervisorState,
  exhausted: boolean,
): string {
  const lines = [
    `[dll-agent gate: block]`,
    `Block reason: ${blockReason}`,
    `Retries exhausted: ${exhausted}`,
    ``,
    `Missing evidence: ${gateResult.needs_evidence ? "real tool output from verification commands (typecheck, test, doctor)" : "none"}`,
    `Pending reviews: ${state.required_reviews.length > 0 ? state.required_reviews.join(", ") : "none"}`,
    ``,
    exhausted
      ? `HARD STOP: Maximum retries (${GATE_MAX_RETRIES}) exceeded for this block reason. The assistant MUST run verification commands as tool calls, NOT just describe them. Manual intervention or explicit 'unverified' marking required.`
      : `Next: run verification commands (typecheck, test, doctor) as actual tool calls, then claim completion.`,
  ]
  return lines.join("\n")
}

// ─── 测试矩阵 ─────────────────────────────────────────────────────────────

/**
 * 测试矩阵：定义所有 smoke test 场景。
 *
 * 每个场景的预期行为：
 * 1. 普通任务只用 DeepSeek — 不触发任何 reviewer，不调用 OpenAI
 * 2. 连续工具失败触发 chief-engineer/role-cross
 * 3. 用户纠偏触发 requirements-inspector
 * 4. 长日志/文档任务触发 context-check (long-context-archivist)
 * 5. 无证据完成声明触发 final evidence gate
 * 6. high risk 完成声明 + 缺验证 → 硬阻断
 * 7. reviewer 冲突 → 触发 role-cross
 * 8. 成本超限 → 阻断
 * 9. cooldown 防止 reviewer 滥用
 */
export const TEST_MATRIX = [
  {
    id: "SMOKE-001",
    name: "普通任务只用 DeepSeek",
    scenario: "用户提一个简单的代码问题，没有纠偏，没有工具失败",
    expected_triggers: [],
    expected_reviews: [],
    expected_gate: "pass",
    risk: "low",
  },
  {
    id: "SMOKE-002",
    name: "连续工具失败触发 chief-engineer",
    scenario: "连续 3 次工具调用返回 error",
    expected_triggers: ["chief-engineer"],
    expected_reviews: ["chief-engineer"],
    expected_gate: "pass",
    risk: "medium",
  },
  {
    id: "SMOKE-003",
    name: "用户纠偏触发 requirements-inspector",
    scenario: "用户输入 '不对，这个方向跑偏了，重新检查'",
    expected_triggers: ["requirements-inspector"],
    expected_reviews: ["requirements-inspector"],
    expected_gate: "pass",
    risk: "medium",
  },
  {
    id: "SMOKE-004",
    name: "长上下文触发 long-context-archivist",
    scenario: "上下文超过 40% 或对话中出现长文档/日志关键词",
    expected_triggers: ["long-context-archivist"],
    expected_reviews: ["long-context-archivist"],
    expected_gate: "pass",
    risk: "low",
  },
  {
    id: "SMOKE-005",
    name: "无证据完成声明触发 final gate",
    scenario: "assistant 输出 '完成了' 但没有验证命令/输出",
    expected_triggers: [],
    expected_reviews: [],
    expected_gate: "blocked",
    risk: "medium",
    gate_behavior: "soft-block with synthetic hint",
  },
  {
    id: "SMOKE-006",
    name: "高风险完成声明硬阻断",
    scenario: "high risk 任务 + 完成声明 + 无验证证据",
    expected_triggers: [],
    expected_reviews: ["final-auditor"],
    expected_gate: "blocked",
    risk: "high",
    gate_behavior: "hard-block, requires final-auditor or explicit unverified marking",
  },
  {
    id: "SMOKE-007",
    name: "reviewer 冲突触发 role-cross",
    scenario: "两个 reviewer 输出 verdict 冲突",
    expected_triggers: ["role-cross"],
    expected_reviews: ["role-cross"],
    expected_gate: "blocked_until_resolved",
    risk: "high",
  },
  {
    id: "SMOKE-008",
    name: "cooldown 防止滥用",
    scenario: "同一 reviewer 在同一轮或相邻轮被重复触发",
    expected_triggers: ["requirements-inspector"], // only first call
    expected_reviews: ["requirements-inspector"],
    expected_gate: "pass",
    risk: "low",
    cooldown_behavior: "second trigger blocked by cooldown",
  },
  {
    id: "SMOKE-009",
    name: "有证据完成声明正常通过",
    scenario: "assistant 输出 '已完成，测试通过：pytest 5/5, typecheck ok'",
    expected_triggers: [],
    expected_reviews: [],
    expected_gate: "pass",
    risk: "low",
  },
] as const
