/**
 * dll-agent interfaces.ts
 *
 * 全量 TypeScript 接口定义：SupervisorState、ReviewerOutput、EvidenceGateResult、
 * CooldownStatus、CostCap、TriggerDecision 等。
 *
 * 这些接口是 supervisor、gates、cooldown、cost-cap 模块的共享契约。
 * 所有机器可读 reviewer 输出都遵循 ReviewerOutput 结构。
 */

import type { MessageV2 } from "@/session/message-v2"

// ─── 基础枚举 ────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high"

export type PhaseName = string

export type ReviewerRole =
  | "requirements-inspector"
  | "long-context-archivist"
  | "task-completion-archivist"
  | "chief-engineer"
  | "final-auditor"
  | "role-cross"
  | "multimodal-context-interpreter"

// ─── Reviewer 输出（机器可读）────────────────────────────────────────────────

/** 单条 reviewer 发现 */
export interface ReviewerFinding {
  /** 严重程度 */
  severity: "info" | "warning" | "block"
  /** 分类 */
  category:
    | "phase_drift"
    | "requirement_miss"
    | "evidence_missing"
    | "evidence_insufficient"
    | "logic_contradiction"
    | "context_drift"
    | "baseline_broken"
    | "memory_lost"
    | "document_inconsistency"
    | "tool_failure_unresolved"
    | "overclaim"
    | "strategic_risk"
    | "security_concern"
  /** 人类可读摘要 */
  summary: string
  /** 精确引用（文件路径、行号、消息 ID） */
  citations: string[]
  /** 建议修正动作 */
  recommended_action?: string
}

/** 机器可读 reviewer 输出 */
export interface ReviewerOutput {
  /** 输出格式版本 */
  version: 1
  /** reviewer 身份 */
  reviewer: ReviewerRole
  /** 触发原因 */
  trigger_reason: string
  /** 整体判定 */
  verdict: "pass" | "pass_with_notes" | "fail_block" | "fail_warn"
  /** 发现列表 */
  findings: ReviewerFinding[]
  /** 评分 0-100 */
  score: number
  /** 是否阻断完成（只有 verdict=fail_block 时为 true） */
  block_completion: boolean
  /** 建议的下一步操作 */
  next_actions: string[]
  /** evidence 完整性指数 0-100 */
  evidence_confidence: number
  /** 时间戳 */
  ts: string
}

/** 将 old-style text reviewer 输出尝试解析为 ReviewerOutput；失败返回 undefined */
export function parseReviewerOutput(text: string): ReviewerOutput | undefined {
  try {
    // 尝试从文本中提取 JSON 块
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text
    const parsed = JSON.parse(jsonStr)
    if (parsed.version === 1 && parsed.reviewer && parsed.verdict) {
      return parsed as ReviewerOutput
    }
    return undefined
  } catch {
    return undefined
  }
}

// ─── Supervisor 状态 ────────────────────────────────────────────────────────

export interface SupervisorState {
  version: 1
  /** 当前 phase */
  phase: PhaseName
  /** 风险等级 */
  risk: RiskLevel
  /** 所需 reviewer 列表 */
  required_reviews: ReviewerRole[]
  /** 已完成 reviewer 列表 */
  completed_reviews: ReviewerRole[]
  /** 是否阻断完成 */
  blocked_completion: boolean
  /** 阻断原因 */
  block_reason: string | null
  /** 上一轮 reviewer 冲突 */
  reviewer_conflict: boolean
  /** 指标快照 */
  metrics: SupervisorMetricsSnapshot
  /** 当前激活的技能名 (Phase 3) */
  active_skills?: string[]
  /** 已入队但尚未开始 dispatch 的 reviewer（用于 TUI 展示） */
  queued_reviewers?: string[]
  /** 当前正在并发 dispatch 的 reviewer（用于 TUI 展示） */
  running_reviewers?: string[]
  /** reviewer 最近一次输入上下文 packet，用于 reviewer result / gate 追踪 */
  reviewer_context_packets?: Partial<Record<ReviewerRole, {
    context_packet_id: string
    built_at: string
  }>>
  /** reviewer run envelopes isolate same-model multi-role decisions and link results to their input context */
  role_run_envelopes?: Partial<Record<ReviewerRole, {
    role_run_id: string
    role_instance_id: string
    model: string
    context_packet_id?: string | null
    action_fingerprint: string
    independence_mode: "isolated" | "arbitration"
    built_at: string
  }>>
  /** gate block 重试计数: block_reason → 已重试次数 (防止无限循环) */
  gate_block_retries?: Record<string, number>
  /** 已迁移/归档的旧 gate retry，避免历史阻断污染当前 readiness */
  gate_block_history?: Record<string, { retries: number; archived_at: string; reason: string }>
  /** Continuation tracking (防止无限 continuation 循环) */
  continuation_count?: number
  repair_counts?: Record<string, number>
  last_continuation_packet_id?: string
  /** Autonomous recovery budget tracking */
  recovery_phase_counts?: Record<string, number>
  recovery_total_count?: number
  /** Session-level role model overrides: role name → { primary, fallback, enabled } */
  role_model_overrides?: Record<string, { primary: string; fallback?: string[]; enabled?: boolean }>
  /** 最后更新时间 */
  updated_at: string
}

export interface SupervisorMetricsSnapshot {
  tool_failures: number
  permission_denied: number
  user_corrections: number
  context_percent: number
  context_tokens: number
  final_claim: boolean
  verification_evidence: boolean
  reviewer_conflict_signal: boolean
  repeated_tool_failure: boolean
  real_tool_evidence: boolean
  /** Phase 6: Kimi completion check signal */
  kimi_completion_check_signal?: boolean
  /** Phase 6: GLM completion claim signal */
  glm_completion_claim_signal?: boolean
  /** Phase 6: Kimi pre-report signal */
  kimi_pre_report_signal?: boolean
  /** Phase 6: Scope expansion signal */
  scope_expanded_signal?: boolean
  /** Phase 6: Phase switch signal */
  phase_switch_signal?: boolean
  /** Phase 8: Multimodal input signal */
  multimodal_signal?: boolean
  /** Phase 5: high-risk governance/runtime task signal */
  high_risk_task_signal?: boolean
}

// ─── Trigger 决策 ───────────────────────────────────────────────────────────

export interface TriggerDecision {
  /** 是否需要 reviewer */
  should_review: boolean
  /** 需要调用的 reviewer 列表 */
  reviewers: ReviewerRole[]
  /** 每个 reviewer 的触发原因 */
  reasons: Record<ReviewerRole, string>
  /** 每个 reviewer 对应的触发指纹；用于防止同一用户消息/同一原因重复触发 */
  fingerprints?: Partial<Record<ReviewerRole, string>>
  /** 原生触发指标 */
  metrics: SupervisorMetricsSnapshot
  /** 自动验证任务：当 completion 被 block 且缺 tool evidence 时，由 supervisor 自动注入 */
  verifierTask?: MessageV2.SubtaskPart
}

// ─── Cooldown 状态 ──────────────────────────────────────────────────────────

export interface CooldownStatus {
  /** 每个 reviewer 上一次被调用的 step 编号 */
  last_called_step: Record<ReviewerRole, number | undefined>
  /** 每个 reviewer 在当前 session 中被调用的总次数 */
  call_count: Record<ReviewerRole, number>
  /** 最近一次被调用的 step */
  last_review_step: number
  /** reviewer 当前正在处理的触发指纹 */
  active_fingerprint_by_reviewer?: Partial<Record<ReviewerRole, string>>
  /** 已调用/已完成的触发指纹，用于同一用户消息、同一原因、同一 reviewer 去重 */
  review_fingerprints?: Record<
    string,
    {
      reviewer: ReviewerRole
      reason: string
      status: "called" | "completed"
      first_step: number
      last_step: number
      user_message_id?: string
    }
  >
}

/** 默认 cooldown：同一 reviewer 两轮内不重复调用，每个 reviewer 每 session 最多 5 次 */
export const COOLDOWN_CONFIG = {
  /** 最小 step 间隔 */
  min_step_interval: 2,
  /** 单轮最多自动触发的 reviewer 数量 */
  max_reviewers_per_round: 1,
  /** 每个 reviewer 每 session 最大调用次数 */
  max_calls_per_reviewer: 5,
  /** 全局每 session 最大 reviewer 调用次数 */
  max_total_reviewer_calls: 12,
  /** 自动 reviewer 的默认硬运行时间预算，避免长时间抢占主流程 */
  reviewer_runtime_ms: 180_000,
} as const

// ─── Cost Cap ───────────────────────────────────────────────────────────────

export interface CostCapConfig {
  /** 是否启用 */
  enabled: boolean
  /** 每 session 最大 USD（默认 $5.00） */
  session_cap_usd: number
  /** 各 provider 的 session 子上限 */
  provider_caps: Partial<Record<string, number>>
  /** 单次 LLM 调用最大 USD（默认 $1.00） */
  single_call_cap_usd: number
}

export const DEFAULT_COST_CAP: CostCapConfig = {
  enabled: true,
  session_cap_usd: 5.0,
  provider_caps: {
    deepseek: 3.0,
    // Phase 6: Increase Kimi cap — Kimi is ~5x cheaper per token than DeepSeek
    // and should be used MORE for summarization/context compression tasks.
    kimi: 2.5,
    openai: 1.0,
    zai: 1.5,
  },
  single_call_cap_usd: 1.0,
}

export interface CostStatus {
  /** 当前 session 累计成本 */
  session_total_usd: number
  /** 各 provider 累计成本 */
  by_provider: Record<string, number>
  /** 是否已达 session 上限 */
  session_cap_exceeded: boolean
  /** 是否已达 provider 上限 */
  provider_cap_exceeded: Record<string, boolean>
  /** 最后警告消息 */
  last_warning: string | null
}

// ─── Evidence Gate 判定标准 ─────────────────────────────────────────────────

export interface EvidenceGateInput {
  /** assistant 消息文本 */
  assistantText: string
  /** 是否包含完成类声明 */
  isCompletionClaim: boolean
  /** 是否包含验证证据 */
  hasVerificationEvidence: boolean
  /** 风险等级 */
  risk: RiskLevel
  /** 是否已完成所有 reviewer */
  allReviewsCompleted: boolean
  /** 是否有 reviewer 冲突未解决 */
  hasUnresolvedConflict: boolean
  /** 成本是否超出上限 */
  costExceeded: boolean
  /** 当前 session，用于读取 Result Ledger */
  sessionID?: string
  /** 当前项目目录，用于读取 Artifact Ledger */
  projectDir?: string
}

export interface EvidenceGateResult {
  /** 是否通过 */
  passed: boolean
  /** 是否需要更多证据 */
  needs_evidence: boolean
  /** 是否需要 reviewer */
  needs_review: boolean
  /** 阻断原因 */
  block_reason: string | null
  /** 应注入的 synthetic hint（如果未通过） */
  synthetic_hint: string | null
}

// ─── Continuation Gate ──────────────────────────────────────────────────────

export type CompletionStatus =
  | "VERIFIED_COMPLETE"
  | "PARTIAL_CONTINUED"
  | "BLOCKED_USER_REQUIRED"
  | "BLOCKED_BUDGET_EXHAUSTED"
  | "UNVERIFIED_COMPLETE"
  | "FAILED"

export type UnfinishedKind =
  | "blocking_unfinished"
  | "non_blocking_followup"
  | "requires_user_input"

export interface UnfinishedItem {
  id: string
  kind: UnfinishedKind
  description: string
  why_blocking?: string
  evidence_refs: string[]
  required_action: string
  recommended_role: ReviewerRole
  verification_required: string[]
  risk_level: RiskLevel
}

export interface ContinuationPacket {
  packet_type: "task_continuation"
  packet_id: string
  session_id: string
  user_goal: string
  goal_contract_ref: string | null
  current_phase: string
  completion_claim: string
  completion_status: CompletionStatus
  final_status:
    | "VERIFIED_COMPLETE"
    | "CONTINUATION_REQUIRED"
    | "BLOCKED_USER_REQUIRED"
    | "BLOCKED_BUDGET_EXHAUSTED"
    | "UNVERIFIED_PARTIAL"
    | "FAILED"
  blocking_unfinished: UnfinishedItem[]
  non_blocking_followup: UnfinishedItem[]
  requires_user_input: UnfinishedItem[]
  missing_verification: string[]
  blocking_reviewer_findings: string[]
  missing_result_refs: string[]
  required_actions: string[]
  recommended_next_role: ReviewerRole | "commander" | null
  verification_required: string[]
  evidence_refs: string[]
  context_packet_refs: string[]
  budget_state: {
    continuation_count: number
    max_continuations: number
    max_repairs_per_item: number
  }
  already_completed: string[]
  files_involved: string[]
  commands_run: string[]
  verification_results: string[]
  reviewer_blocks: string[]
  next_execution_plan: {
    step: number
    role: ReviewerRole | "commander"
    action: string
    verification: string
  }[]
  stop_reason: string | null
  redaction_status: "redacted"
}

export interface ContinuationGateResult {
  passed: boolean
  completion_status: CompletionStatus
  has_blocking_unfinished: boolean
  has_user_input_required: boolean
  has_non_blocking: boolean
  blocking_items: UnfinishedItem[]
  continuation_packet: ContinuationPacket | null
  synthetic_hint: string | null
  block_reason: string | null
}

export const CONTINUATION_BUDGET = {
  /** 同一 continuation packet 最多自动执行轮数 */
  max_auto_rounds: 2,
  /** 同一 blocking item 最多自动修复次数 */
  max_repairs_per_item: 2,
  /** 每个 task 最多 continuation 次数 */
  max_continuations: 5,
  /** 每轮最多触发的额外 reviewer */
  max_reviewers_per_continuation: 1,
  /** 每个 session 最多 cross-review council 次数 */
  max_council_per_session: 3,
} as const

// ─── Evidence 记录（增强版）─────────────────────────────────────────────────

export interface EvidenceRecord {
  ts: string
  type: EvidenceRecordType
  session_id?: string
  step?: number
  provider?: string
  model?: string
  cost_usd?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
  }
  payload: unknown
}

export type EvidenceRecordType =
  | "supervisor.trigger"
  | "supervisor.decision"
  | "supervisor.reviewer_called"
  | "supervisor.reviewer_completed"
  | "supervisor.blocked"
  | "gate.evidence_check"
  | "gate.blocked_completion"
  | "gate.passed"
  | "cost.session_total"
  | "cost.cap_warning"
  | "cost.cap_exceeded"
  | "cooldown.skipped"
  | "llm.call"
  | "model.routing_decision"
  | "context_handoff.packet_built"
  | "agent.profile.enabled"
  | "agent.get"
  | "system.environment"
  // Goal Contract evidence types
  | "goal_contract.created"
  | "goal_contract.updated"
  | "goal_contract.refined"
  | "goal_contract.evaluated"
  | "continuation_gate.blocked"
  | "continuation_gate.consumed"
  | "continuation_gate.dispatched"
  | "continuation_gate.budget_exhausted"
  | "recovery.failure_classified"
  | "recovery.decision"
  | "recovery.attempt_started"
  | "recovery.attempt_finished"
  | "recovery.verification_required"
  | "recovery.budget_exhausted"
  | "recovery.user_input_required"
  | "recovery.security_blocked"
  | "recovery.escalated_reviewer"
  | "recovery.prompt_injected"
  | "recovery.blocked"
  // Phase 7: Result Ledger evidence types
  | "result.produced"
  | "result.reused"
  | "result.invalidated"
  | "result.dedup_blocked"
  | "result.dedup_allowed"
  | "result.stale_detected"
  // Role Model Registry evidence types
  | "role-model.set"
  | "role-model.reset"
  | "role-model.fallback_used"
  | "role-model.fallback_exhausted"
  // Multimodal Context evidence types
  | "multimodal.context.produced"
  | "multimodal.context.reused"
  | "multimodal.context.invalidated"
  | "multimodal.context.low_confidence"
