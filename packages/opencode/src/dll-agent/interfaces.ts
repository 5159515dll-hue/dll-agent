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
  | "chief-engineer"
  | "final-auditor"
  | "role-cross"

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
  /** gate block 重试计数: block_reason → 已重试次数 (防止无限循环) */
  gate_block_retries?: Record<string, number>
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
  max_reviewers_per_round: 5,
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
    kimi: 1.5,
    openai: 1.0,
    zai: 1.0,
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
  | "agent.profile.enabled"
  | "agent.get"
  | "system.environment"
