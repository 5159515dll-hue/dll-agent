/**
 * dll-agent supervisor.ts
 *
 * 核心自动监督器：监听消息流、统计失败、上下文长度、用户纠偏，满足条件时自动
 * 强制插入 reviewer subtask。该逻辑由代码执行，不是提示词注入。
 */

import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"
import { metrics as computeMetrics, messageText, type Metrics } from "./triggers"
import { write as writeEvidence, redact } from "./evidence"
import { recordGateBlock, isGateRetryExhausted } from "./gates"
import { ProviderID, ModelID } from "@/provider/schema"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { resolveRoleModel, type DllRole } from "./role-model-registry"
import {
  type SupervisorState,
  type TriggerDecision,
  type ReviewerRole,
  type CooldownStatus,
  type RiskLevel,
  type ReviewerOutput,
  type SupervisorMetricsSnapshot,
  COOLDOWN_CONFIG,
} from "./interfaces"
import type { MessageV2 } from "@/session/message-v2"
import { buildContinuationSubtaskPrompt } from "./continuation-gate"
import { buildResultsSummary, buildResultPacket, writeResult as writeResultLedger, type ResultPacket } from "./result-ledger"
import { checkDeduplication } from "./deduplication-gate"
import os from "os"

// ─── State management ──────────────────────────────────────────────────────

export function stateFile(sessionID: string) {
  return path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "supervisor.json")
}

export function loadState(sessionID: string): SupervisorState {
  const file = stateFile(sessionID)
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"))
      if (raw.version === 1) return raw as SupervisorState
    }
  } catch {
    // Corrupted state file — start fresh
  }
  return freshState()
}

function atomicWrite(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function saveState(sessionID: string, state: SupervisorState) {
  try {
    normalizeReviewerState(state)
    atomicWrite(stateFile(sessionID), JSON.stringify(redact(state), null, 2))
  } catch {
    // Non-critical; supervisor state persistence is best-effort
  }
}

function normalizeReviewerState(state: SupervisorState) {
  state.completed_reviews = [...new Set(state.completed_reviews ?? [])]
  const completed = new Set(state.completed_reviews)
  state.required_reviews = [...new Set((state.required_reviews ?? []).filter((r) => !completed.has(r)))]
  state.queued_reviewers = [...new Set((state.queued_reviewers ?? []).filter((r) => !completed.has(r as ReviewerRole)))]
    .map((r) => r as ReviewerRole)
  state.running_reviewers = [...new Set((state.running_reviewers ?? []).filter((r) => !completed.has(r as ReviewerRole)))]
    .map((r) => r as ReviewerRole)
  if (completed.has("role-cross") && state.required_reviews.length === 0) state.reviewer_conflict = false
}

function freshState(): SupervisorState {
  return {
    version: 1,
    phase: "default",
    risk: "low",
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
      final_claim: false,
      verification_evidence: false,
      reviewer_conflict_signal: false,
      repeated_tool_failure: false,
      real_tool_evidence: false,
    },
    active_skills: [],
    queued_reviewers: [],
    running_reviewers: [],
    gate_block_retries: {},
    updated_at: new Date().toISOString(),
  }
}

// ─── Cooldown ──────────────────────────────────────────────────────────────

export function cooldownFile(sessionID: string) {
  return path.join(os.homedir(), ".dll-agent", "sessions", sessionID, "cooldown.json")
}

// ─── Reviewer queue / running visibility (TUI) ─────────────────────────────

export function setQueuedReviewers(sessionID: string, reviewers: string[]) {
  try {
    const state = loadState(sessionID)
    const completed = new Set(state.completed_reviews ?? [])
    const running = new Set(state.running_reviewers ?? [])
    state.queued_reviewers = [...new Set(reviewers)]
      .filter((reviewer) => !completed.has(reviewer as ReviewerRole))
      .filter((reviewer) => !running.has(reviewer as ReviewerRole))
      .map((reviewer) => reviewer as ReviewerRole)
    state.updated_at = new Date().toISOString()
    saveState(sessionID, state)
  } catch {
    // best-effort
  }
}

export function setRunningReviewers(sessionID: string, reviewers: string[]) {
  try {
    const state = loadState(sessionID)
    const completed = new Set(state.completed_reviews ?? [])
    state.running_reviewers = [...new Set(reviewers)]
      .filter((reviewer) => !completed.has(reviewer as ReviewerRole))
      .map((reviewer) => reviewer as ReviewerRole)
    const running = new Set(state.running_reviewers)
    state.queued_reviewers = (state.queued_reviewers ?? []).filter((reviewer) => !running.has(reviewer))
    state.updated_at = new Date().toISOString()
    saveState(sessionID, state)
  } catch {
    // best-effort
  }
}

export function loadCooldown(sessionID: string): CooldownStatus {
  const file = cooldownFile(sessionID)
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CooldownStatus
      parsed.active_fingerprint_by_reviewer ??= {}
      parsed.review_fingerprints ??= {}
      return parsed
    }
  } catch {
    // Corrupted — start fresh
  }
  return {
    last_called_step: {} as Record<ReviewerRole, number | undefined>,
    call_count: {} as Record<ReviewerRole, number>,
    last_review_step: 0,
    active_fingerprint_by_reviewer: {},
    review_fingerprints: {},
  }
}

export function saveCooldown(sessionID: string, cd: CooldownStatus) {
  try {
    atomicWrite(cooldownFile(sessionID), JSON.stringify(redact(cd), null, 2))
  } catch {
    // Best-effort
  }
}

/**
 * 检测指定 reviewer 是否在 cooldown。
 * 返回 true = 跳过（冷却中），false = 可以调用。
 */
export function isCooldown(
  sessionID: string,
  reviewer: ReviewerRole,
  currentStep: number,
  fingerprint?: string,
): boolean {
  const cd = loadCooldown(sessionID)
  const lastStep = cd.last_called_step[reviewer]
  const callCount = cd.call_count[reviewer] ?? 0

  // 同一用户消息 + 同一原因 + 同一 reviewer 已经调用或完成时，不再重复触发。
  if (fingerprint) {
    const seen = cd.review_fingerprints?.[fingerprint]
    if (seen) {
      writeEvidence("cooldown.skipped", {
        reason: "trigger_fingerprint_seen",
        reviewer,
        fingerprint,
        status: seen.status,
        first_step: seen.first_step,
        last_step: seen.last_step,
      }, sessionID)
      return true
    }
  }

  // 超过每 reviewer 最大调用次数
  if (callCount >= COOLDOWN_CONFIG.max_calls_per_reviewer) {
    writeEvidence("cooldown.skipped", {
      reason: "max_calls_per_reviewer",
      reviewer,
      call_count: callCount,
    }, sessionID)
    return true
  }

  // 全局最大 reviewer 调用次数
  const totalCalls = Object.values(cd.call_count).reduce((sum, c) => sum + (c ?? 0), 0)
  if (totalCalls >= COOLDOWN_CONFIG.max_total_reviewer_calls) {
    writeEvidence("cooldown.skipped", {
      reason: "max_total_reviewer_calls",
      total_calls: totalCalls,
    }, sessionID)
    return true
  }

  // 步数间隔检查
  if (lastStep !== undefined && currentStep - lastStep < COOLDOWN_CONFIG.min_step_interval) {
    writeEvidence("cooldown.skipped", {
      reason: "min_step_interval",
      reviewer,
      last_step: lastStep,
      current_step: currentStep,
    }, sessionID)
    return true
  }

  return false
}

/** 记录 reviewer 被触发 */
export function recordReviewerCall(
  sessionID: string,
  reviewer: ReviewerRole,
  currentStep: number,
  fingerprint?: string,
  reason?: string,
  userMessageID?: string,
) {
  const cd = loadCooldown(sessionID)
  cd.last_called_step[reviewer] = currentStep
  cd.call_count[reviewer] = (cd.call_count[reviewer] ?? 0) + 1
  cd.last_review_step = currentStep
  if (fingerprint) {
    cd.active_fingerprint_by_reviewer ??= {}
    cd.review_fingerprints ??= {}
    cd.active_fingerprint_by_reviewer[reviewer] = fingerprint
    const prev = cd.review_fingerprints[fingerprint]
    cd.review_fingerprints[fingerprint] = {
      reviewer,
      reason: reason ?? prev?.reason ?? "unknown",
      status: "called",
      first_step: prev?.first_step ?? currentStep,
      last_step: currentStep,
      user_message_id: userMessageID ?? prev?.user_message_id,
    }
  }
  saveCooldown(sessionID, cd)
}

function normalizeFingerprintPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
}

function latestRealUser(messages: MessageV2.WithParts[]) {
  return [...messages]
    .reverse()
    .find((message) => {
      if (message.info.role !== "user") return false
      if (messageText(message).trim().length === 0) return false
      // 过滤纯合成消息：reviewer subtask 完成后 prompt.ts 会注入 "Summarize ..." 合成用户消息。
      // 若不跳过，该消息会成为 latestRealUser，使 makeTriggerFingerprint 生成新指纹，
      // 导致 isCooldown 找不到原始指纹，审查员被无限重复触发。
      const textParts = message.parts.filter((p) => p.type === "text")
      if (textParts.length > 0 && textParts.every((p) => "synthetic" in p && (p as any).synthetic)) return false
      return true
    })
}

function makeTriggerFingerprint(messages: MessageV2.WithParts[], reviewer: ReviewerRole, reason: string) {
  const user = latestRealUser(messages)
  const userID = user?.info.id ?? "no-user"
  return [
    "v2",
    reviewer,
    String(userID),
    normalizeFingerprintPart(reason),
  ].join(":")
}

function triggerUserMessageID(messages: MessageV2.WithParts[]) {
  return String(latestRealUser(messages)?.info.id ?? "")
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, max - 20) + "\n...[truncated]"
}

function extractRelatedPaths(messages: MessageV2.WithParts[]) {
  const out = new Set<string>()
  const pathPattern =
    /(?:^|[\s"'`])((?:\/Users\/[^\s"'`]+|\.?\/?(?:packages|src|test|tests|docs|scripts|apps|lib|bin|config)\/[^\s"'`),;]+))/g
  for (const message of messages.slice(-16)) {
    const text = messageText(message)
    for (const match of text.matchAll(pathPattern)) out.add(match[1])
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const input = part.state.status === "completed" || part.state.status === "error"
        ? part.state.input as Record<string, unknown> | undefined
        : undefined
      for (const key of ["filePath", "path", "filepath", "target_file"]) {
        const value = input?.[key]
        if (typeof value === "string" && value) out.add(value)
      }
      const command = typeof input?.command === "string" ? input.command : ""
      for (const match of command.matchAll(pathPattern)) out.add(match[1])
    }
  }
  return [...out].slice(0, 8)
}

function recentToolFailureSummary(messages: MessageV2.WithParts[]) {
  const lines: string[] = []
  for (const message of messages.slice(-12)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
        lines.push(`- ${part.tool}: ${truncate(part.state.error, 320)}`)
      }
      if (part.state.status === "completed" && /permission denied|not allowed|error:|failed|exception|traceback/i.test(part.state.output)) {
        const input = part.state.input as Record<string, unknown> | undefined
        const command = typeof input?.command === "string" ? input.command : part.tool
        lines.push(`- ${command}: ${truncate(part.state.output, 320)}`)
      }
    }
  }
  return lines.slice(-5)
}

const gitDiffCache = new Map<string, { result: string; ts: number }>()
const GIT_DIFF_CACHE_TTL_MS = 30_000

function gitDiffSummary(paths: string[]) {
  const key = paths.slice(0, 8).sort().join("|")
  const cached = gitDiffCache.get(key)
  if (cached && Date.now() - cached.ts < GIT_DIFF_CACHE_TTL_MS) return cached.result

  try {
    const cwd = process.env.DLL_AGENT_ROOT || process.cwd()
    const args = ["-C", cwd, "diff", "--stat", "--", ...paths.filter((p) => !p.startsWith("/Users/")).slice(0, 8)]
    const output = execFileSync("git", args, {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 12_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const result = truncate(output.trim(), 2_000)
    gitDiffCache.set(key, { result, ts: Date.now() })
    return result
  } catch {
    const result = ""
    gitDiffCache.set(key, { result, ts: Date.now() })
    return result
  }
}

function buildReviewerContext(
  reviewer: ReviewerRole,
  reason: string,
  metrics: SupervisorMetricsSnapshot,
  messages: MessageV2.WithParts[],
  sessionID?: string,
) {
  const user = latestRealUser(messages)
  const userGoal = user ? truncate(messageText(user).trim(), 1_500) : "(no recent user text)"
  const paths = extractRelatedPaths(messages)
  const failures = recentToolFailureSummary(messages)
  const diff = gitDiffSummary(paths)

  // Phase 7: Include result ledger summary so reviewers know what's been done
  let resultSummary = ""
  if (sessionID) {
    try {
      resultSummary = buildResultsSummary(sessionID)
    } catch {
      // Non-critical — skip result summary if ledger unavailable
    }
  }

  const contextLines = [
    `Reviewer: ${reviewer}`,
    `Trigger reason: ${reason}`,
    `Recent user goal/message:`,
    userGoal,
    ``,
    `Supervisor metrics:`,
    `- tool_failures=${metrics.tool_failures}`,
    `- permission_denied=${metrics.permission_denied}`,
    `- user_corrections=${metrics.user_corrections}`,
    `- context_percent=${metrics.context_percent}`,
    `- final_claim=${metrics.final_claim}`,
    `- real_tool_evidence=${metrics.real_tool_evidence}`,
    ``,
    `Relevant file paths discovered from recent messages/tool calls:`,
    paths.length ? paths.map((p) => `- ${p}`).join("\n") : "- none",
    ``,
    `Relevant git diff summary:`,
    diff || "- unavailable or no local diff for discovered paths",
    ``,
    `Recent tool failure snippets:`,
    failures.length ? failures.join("\n") : "- none",
  ]

  if (resultSummary && resultSummary !== "No prior results in ledger.") {
    contextLines.push(``)
    contextLines.push(resultSummary)
  }

  return truncate(contextLines.join("\n"), 5_000)
}

export function reviewerRuntimeMs(reviewer: string) {
  if (reviewer === "requirements-inspector") return COOLDOWN_CONFIG.reviewer_runtime_ms
  if (reviewer === "long-context-archivist") return COOLDOWN_CONFIG.reviewer_runtime_ms
  if (reviewer === "task-completion-archivist") return COOLDOWN_CONFIG.reviewer_runtime_ms
  if (reviewer === "final-auditor") return 240_000
  return 300_000
}

export function isReadOnlyReviewer(reviewer: string) {
  return reviewer === "requirements-inspector" || reviewer === "long-context-archivist" || reviewer === "task-completion-archivist" || reviewer === "final-auditor" || reviewer === "multimodal-context-interpreter"
}

// ─── 风险判定 ─────────────────────────────────────────────────────────────

// Phase 6: Model context limit lookup for token-aware routing
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "deepseek/deepseek-v4-pro": 1_048_576,
  "deepseek/deepseek-v4": 1_048_576,
  "openai/gpt-5.5-pro": 1_050_000,
  "openai/gpt-5": 1_050_000,
  "kimi/kimi-k2.6": 262_144,
  "kimi/kimi-k2": 262_144,
  "zai/glm-5.1": 204_800,
  "zai/glm-5": 204_800,
}

export function modelContextLimit(providerID?: string, modelID?: string): number | undefined {
  if (!providerID || !modelID) return undefined
  const key = `${providerID}/${modelID}`.toLowerCase()
  if (MODEL_CONTEXT_LIMITS[key]) return MODEL_CONTEXT_LIMITS[key]
  // Fallback: try partial match (e.g. "deepseek/deepseek-v4-pro-beta")
  for (const [k, v] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key.includes(k.split("/")[1]?.replace(/-/g, "") ?? "")) return v
  }
  return undefined
}

export function assessRisk(metrics: Metrics): RiskLevel {
  let score = 0

  if (metrics.toolFailures >= 3) score += 3
  else if (metrics.toolFailures >= 1) score += 1

  if (metrics.permissionDenied >= 2) score += 2
  else if (metrics.permissionDenied >= 1) score += 1

  if (metrics.repeatedToolFailure) score += 3

  if (metrics.recentUserCorrection) score += 2
  if (metrics.userCorrections >= 3) score += 2
  else if (metrics.userCorrections >= 1) score += 1

  if (metrics.longContextSignal) score += 1

  if (metrics.reviewerConflictSignal) score += 2

  if (metrics.finalClaim && !metrics.verificationEvidence) score += 3

  // Risk threshold
  if (score >= 6) return "high"
  if (score >= 3) return "medium"
  return "low"
}

function hasNonTextInput(messages: MessageV2.WithParts[]) {
  return messages.slice(-8).some((message) =>
    message.parts.some((part) => {
      if (part.type !== "file") return false
      const mime = "mime" in part && typeof part.mime === "string" ? part.mime : ""
      return /^(image|audio|video)\//i.test(mime) || /pdf|presentation|powerpoint/i.test(mime)
    }),
  )
}

function reviewerModelCandidates(reviewer: ReviewerRole, sessionID: string) {
  const effective = resolveRoleModel(reviewerToDllRole(reviewer), sessionID, process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR)
  return {
    selected: effective.primary,
    candidates: [effective.primary, ...effective.fallback],
  }
}

function maxReviewersForRouting(risk: RiskLevel, metrics: Metrics) {
  if (
    risk === "high" ||
    metrics.reviewerConflictSignal ||
    metrics.repeatedToolFailure ||
    (metrics.finalClaim && !metrics.realToolEvidence)
  ) return 3
  if (risk === "medium" || metrics.recentUserCorrection || metrics.userCorrections > 0 || metrics.kimiCompletionCheckSignal) return 2
  return COOLDOWN_CONFIG.max_reviewers_per_round
}

function reviewerRequiredForCorrectness(reviewer: ReviewerRole, reason: string, risk: RiskLevel, metrics: Metrics) {
  if (risk === "high") return true
  if (reviewer === "requirements-inspector" && (metrics.recentUserCorrection || metrics.userCorrections > 0 || metrics.scopeExpandedSignal || metrics.glmCompletionClaimSignal)) return true
  if (reviewer === "chief-engineer" && (metrics.repeatedToolFailure || metrics.toolFailures >= 3 || metrics.permissionDenied > 0)) return true
  if (reviewer === "role-cross" && metrics.reviewerConflictSignal) return true
  if (reviewer === "task-completion-archivist" && metrics.kimiCompletionCheckSignal) return true
  if (reviewer === "final-auditor" && metrics.finalClaim) return true
  if (reviewer === "multimodal-context-interpreter" && reason.includes("multimodal input")) return true
  return false
}

function writeRoutingEvidence(input: {
  sessionID: string
  taskID: string
  role: ReviewerRole | "commander"
  selectedModel?: string
  candidateModels: string[]
  riskLevel: RiskLevel
  triggerReason: string
  skippedReviewers?: string[]
  skipReason?: string | null
  correctnessReason: string
  costReason?: string | null
  evidenceRefs?: string[]
  fallbackReason?: string | null
  requiredForCorrectness: boolean
}) {
  writeEvidence("model.routing_decision", {
    task_id: input.taskID,
    role: input.role,
    selected_model: input.selectedModel ?? null,
    candidate_models: input.candidateModels,
    risk_level: input.riskLevel,
    trigger_reason: input.triggerReason,
    skipped_reviewers: input.skippedReviewers ?? [],
    skip_reason: input.skipReason ?? null,
    correctness_reason: input.correctnessReason,
    cost_reason: input.costReason ?? null,
    evidence_refs: input.evidenceRefs ?? [],
    fallback_reason: input.fallbackReason ?? null,
    whether_required_for_correctness: input.requiredForCorrectness,
  }, input.sessionID)
}

// ─── 触发决策 ─────────────────────────────────────────────────────────────

/**
 * 分析消息流并决定需要触发哪些 reviewer。
 * 这是监督器的核心决策逻辑。
 */
export function decide(
  messages: MessageV2.WithParts[],
  sessionID: string,
  currentStep: number,
  contextLimit?: number,
  availableAgents?: string[],
): TriggerDecision {
  const metrics = computeMetrics(messages, contextLimit)
  const reasons: Record<ReviewerRole, string> = {} as Record<ReviewerRole, string>
  const reviewers: ReviewerRole[] = []
  const fingerprints: Partial<Record<ReviewerRole, string>> = {}
  const risk = assessRisk(metrics)

  const addReviewer = (reviewer: ReviewerRole, reason: string) => {
    if (reviewers.includes(reviewer)) return
    const state = loadState(sessionID)
    const model = reviewerModelCandidates(reviewer, sessionID)
    const required = reviewerRequiredForCorrectness(reviewer, reason, risk, metrics)
    if (state.completed_reviews?.includes(reviewer)) {
      writeEvidence("cooldown.skipped", {
        reason: "reviewer_already_completed_this_phase",
        reviewer,
        phase: state.phase,
      }, sessionID)
      writeRoutingEvidence({
        sessionID,
        taskID: sessionID,
        role: reviewer,
        selectedModel: model.selected,
        candidateModels: model.candidates,
        riskLevel: risk,
        triggerReason: reason,
        skippedReviewers: [reviewer],
        skipReason: "reviewer_already_completed_this_phase",
        correctnessReason: required ? "required reviewer already completed in this phase" : "reviewer not required after prior completion",
        costReason: "avoid repeating reviewer over the same phase evidence",
        evidenceRefs: [`reviewer:${reviewer}`],
        requiredForCorrectness: required,
      })
      return
    }
    if (state.queued_reviewers?.includes(reviewer) || state.running_reviewers?.includes(reviewer)) {
      writeEvidence("cooldown.skipped", {
        reason: "reviewer_already_queued_or_running",
        reviewer,
        queued: state.queued_reviewers ?? [],
        running: state.running_reviewers ?? [],
      }, sessionID)
      writeRoutingEvidence({
        sessionID,
        taskID: sessionID,
        role: reviewer,
        selectedModel: model.selected,
        candidateModels: model.candidates,
        riskLevel: risk,
        triggerReason: reason,
        skippedReviewers: [reviewer],
        skipReason: "reviewer_already_queued_or_running",
        correctnessReason: "existing queued/running reviewer will satisfy the trigger",
        costReason: "avoid duplicate reviewer dispatch",
        evidenceRefs: [`reviewer:${reviewer}`],
        requiredForCorrectness: required,
      })
      return
    }
    const fingerprint = makeTriggerFingerprint(messages, reviewer, reason)
    if (isCooldown(sessionID, reviewer, currentStep, fingerprint)) {
      writeRoutingEvidence({
        sessionID,
        taskID: sessionID,
        role: reviewer,
        selectedModel: model.selected,
        candidateModels: model.candidates,
        riskLevel: risk,
        triggerReason: reason,
        skippedReviewers: [reviewer],
        skipReason: "fingerprint_cooldown",
        correctnessReason: required ? "correctness-required reviewer deferred by cooldown; gate must not treat this as completed" : "reviewer not correctness-required for this duplicate fingerprint",
        costReason: "avoid repeating the same reviewer for the same failure/evidence fingerprint",
        evidenceRefs: [fingerprint],
        requiredForCorrectness: required,
      })
      return
    }
    reviewers.push(reviewer)
    reasons[reviewer] = reason
    fingerprints[reviewer] = fingerprint
    writeRoutingEvidence({
      sessionID,
      taskID: sessionID,
      role: reviewer,
      selectedModel: model.selected,
      candidateModels: model.candidates,
      riskLevel: risk,
      triggerReason: reason,
      skippedReviewers: [],
      correctnessReason: required ? "reviewer is required for correctness under current risk/trigger state" : "reviewer selected as useful supporting check",
      costReason: required ? null : "selected within low-value-call guard budget",
      evidenceRefs: [fingerprint],
      requiredForCorrectness: required,
    })
  }

  // 规则 1：用户纠偏 → requirements-inspector
  if (metrics.recentUserCorrection || metrics.userCorrections >= 1) {
    const reason = metrics.recentUserCorrection
      ? "user correction detected in most recent message"
      : `user corrections detected in ${metrics.userCorrections} recent messages`
    addReviewer("requirements-inspector", reason)
  }

  // 规则 2：长上下文 / 文档任务 → long-context-archivist
  if (metrics.longContextSignal) {
    const reason = metrics.contextPercent >= 40
      ? `context at ${metrics.contextPercent}% of limit`
      : "long-context or document-task signal detected in messages"
    addReviewer("long-context-archivist", reason)
  }

  // 规则 2b (Phase 6): Kimi pre-report context compression
  // When context is >=30% and final claim detected, proactively compress context
  // via Kimi before the final report. Reduces DeepSeek token consumption on the report turn.
  if (metrics.kimiPreReportSignal && !reviewers.includes("long-context-archivist")) {
    const reason = `pre-report context compression: context at ${metrics.contextPercent}% with final claim`
    addReviewer("long-context-archivist", reason)
  }

  // 规则 2c (Phase 6): Phase switch → long-context-archivist for handoff packet
  if (metrics.phaseSwitchSignal) {
    const reason = "phase switch or task direction change detected"
    addReviewer("long-context-archivist", reason)
  }

  // 规则 3：重复工具失败 → chief-engineer 或 role-cross
  if (metrics.repeatedToolFailure || metrics.toolFailures >= 3) {
    const reason = metrics.repeatedToolFailure
      ? "repeated tool failure detected (same error pattern)"
      : `${metrics.toolFailures} tool failures in recent messages`
    addReviewer("chief-engineer", reason)
    if (metrics.toolFailures >= 4 || metrics.reviewerConflictSignal) {
      addReviewer("role-cross", "third repeated failure or reviewer conflict requires cross-review")
    }
  }

  // 规则 4：权限拒绝 → chief-engineer
  if (metrics.permissionDenied >= 1 && !reviewers.includes("chief-engineer")) {
    addReviewer("chief-engineer", `permission denied detected in ${metrics.permissionDenied} tool call(s)`)
  }

  // 规则 5：reviewer 冲突 → role-cross
  if (metrics.reviewerConflictSignal) {
    addReviewer("role-cross", "reviewer conflict signal detected")
  }

  // 规则 6：高风险最终声明且缺验证 → final gate + high-risk auditor
  if (metrics.finalClaim && !metrics.verificationEvidence) {
    if (risk === "high") {
      addReviewer("final-auditor", "high-risk final claim without verification evidence")
    }
  }

  // 规则 8 (Phase 6): GLM completion-claim-check
  // Trigger requirements-inspector when a completion claim is made
  // without real tool evidence OR when the claim contradicts unfinished indicators
  if (metrics.glmCompletionClaimSignal && !reviewers.includes("requirements-inspector")) {
    const reason = metrics.realToolEvidence
      ? "completion claim with suspected contradiction (correction pattern in claim text)"
      : "completion claim without real tool evidence — requirements check needed"
    addReviewer("requirements-inspector", reason)
  }

  // 规则 9 (Phase 6): Kimi task-completion-archivist — completion claim with unfinished items
  // Trigger Kimi to generate a continuation packet before allowing final stop
  if (metrics.kimiCompletionCheckSignal) {
    const reason = "completion claim with unfinished indicators detected"
    addReviewer("task-completion-archivist", reason)
  }

  // 规则 10 (Phase 6): Scope expansion → requirements-inspector
  if (metrics.scopeExpandedSignal && !reviewers.includes("requirements-inspector")) {
    const reason = "scope expansion or feature creep detected"
    addReviewer("requirements-inspector", reason)
  }

  // 规则 11 (Phase 6): Token-aware routing — when context is very high,
  // prioritize Kimi for context compression over DeepSeek for further tasks.
  // This is advisory; the actual routing happens in decide() return.
  if (contextLimit && (metrics.contextPercent >= 60 || metrics.contextTokens > contextLimit * 0.6)) {
    writeEvidence("routing.token_aware", {
      reason: "high context — Kimi prioritization recommended",
      context_percent: metrics.contextPercent,
      context_tokens: metrics.contextTokens,
      context_limit: contextLimit,
      step: currentStep,
    }, sessionID)
  }

  // 规则 12 (Phase 8): Multimodal input signal → multimodal-context-interpreter
  // Trigger the multimodal role when non-text inputs (images, video, audio, etc.)
  // are detected but only on-demand — not for every task.
  if (metrics.multimodalSignal && hasNonTextInput(messages)) {
    const reason = "multimodal input detected (screenshot, image, video, audio, PPT figure, chart, etc.)"
    addReviewer("multimodal-context-interpreter" as ReviewerRole, reason)
  } else if (metrics.multimodalSignal) {
    writeRoutingEvidence({
      sessionID,
      taskID: sessionID,
      role: "multimodal-context-interpreter",
      selectedModel: reviewerModelCandidates("multimodal-context-interpreter" as ReviewerRole, sessionID).selected,
      candidateModels: reviewerModelCandidates("multimodal-context-interpreter" as ReviewerRole, sessionID).candidates,
      riskLevel: risk,
      triggerReason: "multimodal keyword signal without non-text input",
      skippedReviewers: ["multimodal-context-interpreter"],
      skipReason: "pure_text_or_code_task",
      correctnessReason: "MiMo multimodal reviewer is not required without actual non-text input",
      costReason: "prevent multimodal/TTS model from entering a pure code task",
      evidenceRefs: [],
      requiredForCorrectness: false,
    })
  }

  // 规则 7（auto-verifier）：completion blocked + 缺真实 tool evidence → 自动注入 verifier subtask
  // 这使得模型不需要"记得"运行验证 — supervisor 在代码层强制注入验证任务。
  const needsVerifier =
    metrics.finalClaim && !metrics.realToolEvidence && (metrics.toolFailures === 0)
  let verifierTask: MessageV2.SubtaskPart | undefined
  if (needsVerifier) {
    verifierTask = buildVerifierSubtask(
      sessionID,
      "completion claim without real tool evidence (auto-verifier)",
      availableAgents,
    )
    writeEvidence("supervisor.verifier_auto_injected", {
      reason: "completion claim without real tool evidence",
      step: currentStep,
    }, sessionID)
  }

  const maxReviewers = maxReviewersForRouting(risk, metrics)
  if (reviewers.length > maxReviewers) {
    const required = reviewers.filter((reviewer) => reviewerRequiredForCorrectness(reviewer, reasons[reviewer], risk, metrics))
    const optional = reviewers.filter((reviewer) => !required.includes(reviewer))
    const selected = required.length >= maxReviewers
      ? required
      : [...required, ...optional.slice(0, maxReviewers - required.length)]
    const skipped = reviewers.filter((reviewer) => !selected.includes(reviewer))
    for (const r of skipped) {
      writeEvidence("cooldown.skipped", {
        reason: "correctness_aware_routing_budget",
        reviewer: r,
        risk,
        max_reviewers: maxReviewers,
      }, sessionID)
      const model = reviewerModelCandidates(r, sessionID)
      writeRoutingEvidence({
        sessionID,
        taskID: sessionID,
        role: r,
        selectedModel: model.selected,
        candidateModels: model.candidates,
        riskLevel: risk,
        triggerReason: reasons[r],
        skippedReviewers: [r],
        skipReason: "correctness_aware_routing_budget",
        correctnessReason: "reviewer was not required for correctness after required reviewers were selected",
        costReason: "avoid low-value multi-model meeting beyond the current risk budget",
        evidenceRefs: fingerprints[r] ? [fingerprints[r]!] : [],
        requiredForCorrectness: false,
      })
    }
    reviewers.splice(0, reviewers.length, ...selected)
  }

  writeEvidence("supervisor.decision", {
    reviewers,
    reasons,
    fingerprints,
    metrics,
    step: currentStep,
  }, sessionID)

  return {
    should_review: reviewers.length > 0 || !!verifierTask,
    reviewers,
    reasons,
    fingerprints,
    verifierTask,
    metrics: {
      tool_failures: metrics.toolFailures,
      permission_denied: metrics.permissionDenied,
      user_corrections: metrics.userCorrections,
      context_percent: metrics.contextPercent,
      context_tokens: metrics.contextTokens,
      final_claim: metrics.finalClaim,
      verification_evidence: metrics.verificationEvidence,
      reviewer_conflict_signal: metrics.reviewerConflictSignal,
      repeated_tool_failure: metrics.repeatedToolFailure,
      real_tool_evidence: metrics.realToolEvidence,
      kimi_completion_check_signal: metrics.kimiCompletionCheckSignal,
      glm_completion_claim_signal: metrics.glmCompletionClaimSignal,
      kimi_pre_report_signal: metrics.kimiPreReportSignal,
      scope_expanded_signal: metrics.scopeExpandedSignal,
      phase_switch_signal: metrics.phaseSwitchSignal,
      multimodal_signal: metrics.multimodalSignal,
    },
  }
}

// ─── State update ─────────────────────────────────────────────────────────

export function updateState(
  sessionID: string,
  decision: TriggerDecision,
  currentState?: SupervisorState,
): SupervisorState {
  const state = currentState ?? loadState(sessionID)
  const riskMetrics: Metrics = {
    userCorrections: decision.metrics.user_corrections,
    recentUserCorrection: decision.metrics.user_corrections > 0,
    toolFailures: decision.metrics.tool_failures,
    permissionDenied: decision.metrics.permission_denied,
    repeatedToolFailure: decision.metrics.repeated_tool_failure,
    contextTokens: decision.metrics.context_tokens,
    contextPercent: decision.metrics.context_percent,
    longContextSignal: decision.metrics.context_percent >= 40,
    finalClaim: decision.metrics.final_claim,
    verificationEvidence: decision.metrics.verification_evidence,
    realToolEvidence: decision.metrics.real_tool_evidence,
    reviewerConflictSignal: decision.metrics.reviewer_conflict_signal,
    kimiCompletionCheckSignal: decision.metrics.kimi_completion_check_signal ?? false,
    glmCompletionClaimSignal: decision.metrics.glm_completion_claim_signal ?? false,
    kimiPreReportSignal: decision.metrics.kimi_pre_report_signal ?? false,
    scopeExpandedSignal: decision.metrics.scope_expanded_signal ?? false,
    phaseSwitchSignal: decision.metrics.phase_switch_signal ?? false,
    multimodalSignal: decision.metrics.multimodal_signal ?? false,
  }
  const risk = assessRisk(riskMetrics)

  state.phase = state.phase || "default"
  state.risk = risk
  state.metrics = decision.metrics
  state.updated_at = new Date().toISOString()

  for (const r of decision.reviewers) {
    if (!state.required_reviews.includes(r)) {
      state.required_reviews.push(r)
    }
  }

  if (decision.metrics.final_claim && !decision.metrics.verification_evidence) {
    state.blocked_completion = true
    state.block_reason = "completion claim without verification evidence"
  }

  if (state.blocked_completion && state.block_reason) {
    recordGateBlock(state, state.block_reason)
  }

  if (decision.metrics.reviewer_conflict_signal) {
    state.reviewer_conflict = true
  }

  // Continuation budget tracking
  if (decision.metrics.final_claim && !decision.metrics.verification_evidence) {
    state.continuation_count ??= 0
    state.continuation_count++
    state.repair_counts ??= {}
    // Persist updated budget
    writeEvidence("continuation.budget_tracked", {
      continuation_count: state.continuation_count,
      step: decision.metrics.context_tokens,
    })
  }

  saveState(sessionID, state)
  return state
}

export function markReviewerCompleted(
  sessionID: string,
  reviewer: ReviewerRole,
  output?: ReviewerOutput,
) {
  const state = loadState(sessionID)
  if (!state.completed_reviews.includes(reviewer)) {
    state.completed_reviews.push(reviewer)
  }
  state.required_reviews = state.required_reviews.filter((r) => r !== reviewer)
  state.queued_reviewers = (state.queued_reviewers ?? []).filter((r) => r !== reviewer)
  state.running_reviewers = (state.running_reviewers ?? []).filter((r) => r !== reviewer)
  if (reviewer === "role-cross" && state.required_reviews.length === 0) state.reviewer_conflict = false

  if (output?.block_completion) {
    state.blocked_completion = true
    state.block_reason = `reviewer ${reviewer} blocked completion: ${output.findings.filter(f => f.severity === "block").map(f => f.summary).join("; ")}`
  }

  state.updated_at = new Date().toISOString()
  saveState(sessionID, state)

  try {
    const cd = loadCooldown(sessionID)
    const fingerprint = cd.active_fingerprint_by_reviewer?.[reviewer]
    if (fingerprint && cd.review_fingerprints?.[fingerprint]) {
      cd.review_fingerprints[fingerprint] = {
        ...cd.review_fingerprints[fingerprint],
        status: "completed",
        last_step: cd.last_review_step,
      }
      delete cd.active_fingerprint_by_reviewer?.[reviewer]
      saveCooldown(sessionID, cd)
    }
  } catch {
    // fingerprint persistence is diagnostic and must not block the session
  }

  writeEvidence("supervisor.reviewer_completed", {
    reviewer,
    block_completion: output?.block_completion ?? false,
    findings_count: output?.findings.length ?? 0,
  }, sessionID)

  // Phase 7: Record structured reviewer output to Result Ledger
  if (output) {
    try {
      const dllRole = reviewerToDllRole(reviewer)
      const effective = resolveRoleModel(dllRole, sessionID)
      const resultPacket = buildResultPacket({
        sessionID,
        executing_role: reviewer as ResultPacket["executing_role"],
        model: effective.primary,
        user_goal: state.metrics?.final_claim ? "completion claim" : "ongoing task",
        subtask_goal: `Review by ${reviewer}: ${output.trigger_reason}`,
        claimed_result: `Review verdict: ${output.verdict} | Score: ${output.score} | Evidence confidence: ${output.evidence_confidence}`,
        completion_status: output.block_completion ? "BLOCKED" : "VERIFIED_COMPLETE",
        evidence_refs: [`reviewer:${reviewer}`, `score:${output.score}`],
        unresolved_items: output.findings
          .filter((f) => f.severity === "block")
          .map((f) => f.summary),
        verification_results: [
          { name: "reviewer_score", status: output.score >= 70 ? "passed" : "failed" },
        ],
      })
      writeResultLedger(sessionID, resultPacket)
    } catch {
      // Result ledger write is best-effort; must not block completion tracking
    }
  }
}

export function clearBlockIfResolved(sessionID: string) {
  const state = loadState(sessionID)
  if (state.required_reviews.length === 0 && state.blocked_completion) {
    state.blocked_completion = false
    state.block_reason = null
    state.reviewer_conflict = false
    state.updated_at = new Date().toISOString()
    saveState(sessionID, state)
  }
  return state
}

// ─── Reviewer subtask 生成 ────────────────────────────────────────────────

export function generateSubtasks(
  decision: TriggerDecision,
  sessionID: string,
  messages: MessageV2.WithParts[] = [],
): MessageV2.SubtaskPart[] {
  const subtasks: MessageV2.SubtaskPart[] = []

  for (const reviewer of decision.reviewers) {
    const reason = decision.reasons[reviewer]

    // Phase 7: Deduplication gate — check if a reusable result already exists
    // for this reviewer's task. If a VERIFIED_COMPLETE result exists, skip
    // re-dispatching and inject a synthetic hint instead.
    try {
      const dedup = checkDeduplication(sessionID, reason, {
        requiredFilePaths: extractRelatedPaths(messages),
        maxAgeMinutes: 120,
      })
      if (dedup.isRedundant && dedup.recommendedAction === "reuse_existing") {
        const model = reviewerModelCandidates(reviewer, sessionID)
        writeEvidence("result.dedup_blocked", {
          reviewer,
          reason,
          existing_packet_id: dedup.existingResults[0]?.packet_id,
          covered_scope: dedup.sufficiency?.coveredScope,
        }, sessionID)
        writeRoutingEvidence({
          sessionID,
          taskID: sessionID,
          role: reviewer,
          selectedModel: model.selected,
          candidateModels: model.candidates,
          riskLevel: loadState(sessionID).risk,
          triggerReason: reason,
          skippedReviewers: [reviewer],
          skipReason: "verified_result_reused",
          correctnessReason: "existing result is verified, reusable, and not stale",
          costReason: "avoid repeating reviewer over equivalent verified evidence",
          evidenceRefs: dedup.evidenceRefs,
          requiredForCorrectness: false,
        })
        markReviewerCompleted(sessionID, reviewer)
        // Skip this subtask — a reusable result already exists
        continue
      }
      if (dedup.isRedundant && dedup.recommendedAction === "verify_existing") {
        writeEvidence("result.dedup_blocked", {
          reviewer,
          reason,
          existing_packet_id: dedup.existingResults[0]?.packet_id,
          action: "verify_existing",
        }, sessionID)
      }
    } catch {
      // Dedup check must not block subtask dispatch
    }

    const subtask = buildSubtask(reviewer, reason, decision.metrics, sessionID, messages)
    subtasks.push(subtask)
    writeEvidence("supervisor.reviewer_called", {
      reviewer,
      reason,
      fingerprint: decision.fingerprints?.[reviewer],
    }, sessionID)
  }

  return subtasks
}

/**
 * Convert a ReviewerRole to the corresponding DllRole for registry lookup.
 * Some supervisor reviewer roles map directly to DllRoles.
 */
function reviewerToDllRole(reviewer: ReviewerRole): DllRole {
  // Most supervisor reviewer roles have 1:1 mapping to DllRoles
  if (reviewer === "requirements-inspector") return "requirements-inspector"
  if (reviewer === "long-context-archivist") return "long-context-archivist"
  if (reviewer === "task-completion-archivist") return "task-completion-archivist"
  if (reviewer === "chief-engineer") return "chief-engineer"
  if (reviewer === "final-auditor") return "final-auditor"
  if (reviewer === "role-cross") return "role-cross"
  if (reviewer === "multimodal-context-interpreter") return "multimodal-context-interpreter"
  return "chief-engineer" // fallback
}

function buildSubtask(
  reviewer: ReviewerRole,
  reason: string,
  metrics: SupervisorMetricsSnapshot,
  sessionID: string,
  messages: MessageV2.WithParts[],
): MessageV2.SubtaskPart {
  // Resolve effective model from Role Model Registry
  // Uses session overrides if this session has role_model_overrides in supervisor state
  const dllRole = reviewerToDllRole(reviewer)
  const effective = resolveRoleModel(dllRole, sessionID, process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR)
  const model = {
    providerID: ProviderID.make(effective.parsed.providerID),
    modelID: ModelID.make(effective.parsed.modelID),
  }
  const compactContext = buildReviewerContext(reviewer, reason, metrics, messages, sessionID)

  const promptTemplates: Record<ReviewerRole, string> = {
    "requirements-inspector": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the requirements inspector (${effective.primary}). Check:`,
      `1. Is the current work still aligned with the user's original Chinese intent?`,
      `2. Are there any contradictions, phase drift, or rule violations?`,
      `3. Are all important claims backed by evidence?`,
      ``,
      `ROLE BOUNDARY: use the compact context first. Only read listed relevant files when needed. Do not scan the whole repo.`,
      `The runtime enforces this reviewer as read-only; bash/edit/web/task tools are denied.`,
      `Finish promptly and emit the JSON verdict.`,
      ``,
      `IMPORTANT: Output your findings in this exact machine-readable JSON format:`,
      `\`\`\`json`,
      JSON.stringify(emptyReviewerOutput("requirements-inspector", reason), null, 2),
      `\`\`\``,
      ``,
      `Cite precise evidence. If you find blockers, set "block_completion": true and add findings with severity "block".`,
    ].join("\n"),
    "long-context-archivist": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the long-context archivist (${effective.primary}). Check:`,
      `1. Are there logs, documents, baselines, or phase history that have been lost or misread?`,
      `2. Is the conversation context coherent across the full session?`,
      `3. Are there missing pieces of evidence from earlier phases?`,
      ``,
      `ROLE BOUNDARY: use the compact context first. Only read listed relevant files/logs when needed. Do not scan the whole repo.`,
      `The runtime enforces this reviewer as read-only; bash/edit/web/task tools are denied.`,
      `Finish promptly and emit the JSON verdict.`,
      ``,
      `IMPORTANT: Output in machine-readable JSON format as shown.`,
      `\`\`\`json`,
      JSON.stringify(emptyReviewerOutput("long-context-archivist", reason), null, 2),
      `\`\`\``,
    ].join("\n"),
    "chief-engineer": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the chief engineer (${effective.primary}). Diagnose the tool failures:`,
      `1. What is the root cause of the failures?`,
      `2. Can the failures be fixed with a different approach, tool, or permission?`,
      `3. Is the current task approach fundamentally broken?`,
      ``,
      `Propose actionable engineering fixes with exact commands/paths.`,
      `Output in machine-readable JSON format as shown.`,
    ].join("\n"),
    "final-auditor": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the on-demand strategic/final auditor (${effective.primary}). Check:`,
      `1. Is the user goal truly complete?`,
      `2. Is there sufficient evidence for the completion claim?`,
      `3. Are there outstanding engineering risks or unverified claims?`,
      `4. Is the strategic direction still sound?`,
      ``,
      `ROLE BOUNDARY: this is a read-only audit. Do not run commands, edit files, patch files, or create subtasks.`,
      `The runtime enforces this reviewer as read-only; write/exec/task tools are denied.`,
      ``,
      `Output in machine-readable JSON format as shown.`,
      `\`\`\`json`,
      JSON.stringify(emptyReviewerOutput("final-auditor", reason), null, 2),
      `\`\`\``,
    ].join("\n"),
    "role-cross": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Run a temporary role-crossing review (${effective.primary}). Inspect the problem from a different role's perspective:`,
      `1. Find blind spots that the current role may have missed.`,
      `2. Identify missing evidence.`,
      `3. Propose actionable recovery steps.`,
      ``,
      `This role crossing ends after this review round. Output in machine-readable JSON format.`,
      `\`\`\`json`,
      JSON.stringify(emptyReviewerOutput("role-cross", reason), null, 2),
      `\`\`\``,
    ].join("\n"),
    "task-completion-archivist": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the task-completion-archivist (${effective.primary}). Check whether the task is truly complete:`,
      `1. Is the user goal fully achieved?`,
      `2. Are there blocking unfinished items in the completion report?`,
      `3. Classify ALL unfinished items as: blocking_unfinished | non_blocking_followup | requires_user_input`,
      `4. If blocking items exist, generate a continuation packet with a next_execution_plan.`,
      `5. Never mark as VERIFIED_COMPLETE if blocking unfinished items exist.`,
      ``,
      `ROLE BOUNDARY: use the compact context first. Only read listed relevant files when needed.`,
      `The runtime enforces this reviewer as read-only; bash/edit/web/task tools are denied.`,
      `Output a CONTINUATION PACKET in the following JSON format:`,
      `\`\`\`json`,
      JSON.stringify({
        version: 1,
        reviewer: "task-completion-archivist",
        trigger_reason: reason,
        verdict: "pass",
        completion_status: "UNVERIFIED_COMPLETE",
        blocking_unfinished: [],
        non_blocking_followup: [],
        requires_user_input: [],
        already_completed: [],
        next_execution_plan: [],
        allow_final_report: false,
        findings: [],
        score: 100,
        block_completion: false,
        next_actions: [],
        evidence_confidence: 100,
        ts: new Date().toISOString(),
      }, null, 2),
      `\`\`\``,
    ].join("\n"),
    "multimodal-context-interpreter": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the multimodal context interpreter (${effective.primary}). Your role is to analyze non-text inputs:`,
      `1. Identify all non-text inputs (screenshots, images, webpage visuals, PPT figures, flowcharts, charts, video, audio)`,
      `2. Extract observations: text content, visual layout, structure, errors, warnings, important details`,
      `3. Assign confidence (low/medium/high) to each observation`,
      `4. Set context_sufficient=false if the input is too ambiguous`,
      `5. NEVER claim high confidence if uncertainties remain`,
      ``,
      `ROLE BOUNDARY: read-only analysis. Do not modify files, run code, or make engineering decisions.`,
      `The runtime enforces this reviewer as read-only; bash/edit/task tools are denied.`,
      `Output a structured multimodal_context_packet using the schema from multimodal-context.ts.`,
      ``,
      `IMPORTANT: Output in this JSON format:`,
      `\`\`\`json`,
      JSON.stringify({
        packet_type: "multimodal_context_packet",
        packet_id: "mmctx_placeholder",
        source_hash: "auto-generated",
        role: "multimodal-context-interpreter",
        model: effective.primary,
        input_type: "screenshot",
        user_goal: reason,
        source_ref: "",
        task_relevance: "",
        observations: [],
        detected_text: null,
        visual_structure: null,
        errors_or_warnings: [],
        important_details: [],
        uncertainties: [],
        overall_confidence: "medium",
        context_sufficient: true,
        recommended_next_role: null,
        evidence_refs: [],
        redaction_status: "none",
        created_at: new Date().toISOString(),
      }, null, 2),
      `\`\`\``,
    ].join("\n"),
  }

  return {
    type: "subtask" as const,
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    agent: reviewer,
    description: `Auto reviewer: ${reviewer} triggered by ${reason}`,
    command: "dll-agent-supervisor",
    model: model,
    prompt: promptTemplates[reviewer],
  }
}

export function pickVerifierAgent(availableAgents?: string[]): string {
  const order = ["executor", "build", "general", "commander"]
  if (!availableAgents || availableAgents.length === 0) return "build"
  for (const name of order) if (availableAgents.includes(name)) return name
  return availableAgents[0]
}

export function buildVerifierSubtask(
  sessionID: string,
  blockReason: string,
  availableAgents?: string[],
): MessageV2.SubtaskPart {
  const projectDir = process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR || process.cwd()
  const dllAgentBin = process.env.DLL_AGENT_BIN_PATH || path.join(os.homedir(), ".local", "bin", "dll-agent")
  const cmd = [
    "set -e",
    `cd "${projectDir}/packages/opencode"`,
    "echo '--- bun typecheck ---'",
    "bun typecheck 2>&1 | tail -20 || true",
    "echo '--- bun test test/dll-agent/ ---'",
    "bun test test/dll-agent/ 2>&1 | tail -10 || true",
    "echo '--- dll-agent doctor ---'",
    `"${dllAgentBin}" doctor 2>&1 | tail -10 || true`,
  ].join("\n")
  const prompt = [
    `[dll-agent supervisor: verifier auto-task]`,
    `Block reason: ${blockReason}`,
    ``,
    `Run the following bash command via the bash tool, then summarize stdout. Do not paraphrase — paste the actual exit codes / pass/fail lines verbatim. This is the only acceptable evidence for unblocking the high-risk completion gate:`,
    ``,
    `\`\`\`bash`,
    cmd,
    `\`\`\``,
    ``,
    `After running, report: typecheck=ok|fail, tests=ok|fail, doctor=ok|fail, plus any error excerpts.`,
  ].join("\n")
  writeEvidence("supervisor.verifier_injected", { reason: blockReason }, sessionID)
  const agent = pickVerifierAgent(availableAgents)
  return {
    type: "subtask" as const,
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    agent,
    description: "Auto verifier: typecheck + tests + doctor",
    command: "dll-agent-supervisor",
    prompt,
  }
}

/**
 * Phase 6: Build a task-completion-archivist subtask with the dedicated
 * continuation prompt template from continuation-gate.ts.
 *
 * Previously, the continuation gate reused buildVerifierSubtask() and overrode
 * agent/description/command — but the prompt was still a verification prompt,
 * not a completion-check prompt. This function uses the correct template.
 */
export function buildTaskCompletionSubtask(
  sessionID: string,
  userGoal: string,
  completionClaim: string,
  state: SupervisorState,
): MessageV2.SubtaskPart {
  const prompt = buildContinuationSubtaskPrompt({
    userGoal,
    completionClaim,
    state,
  })

  writeEvidence("supervisor.task_completion_archivist_injected", {
    reason: "continuation gate triggered",
    userGoal: userGoal.slice(0, 100),
  }, sessionID)

  const effective = resolveRoleModel("task-completion-archivist", sessionID, process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR)

  return {
    type: "subtask" as const,
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    agent: "task-completion-archivist",
    description: "Kimi task-completion-archivist: check unfinished items",
    command: "dll-agent-supervisor",
    model: { providerID: ProviderID.make(effective.parsed.providerID), modelID: ModelID.make(effective.parsed.modelID) },
    prompt,
  }
}

function emptyReviewerOutput(reviewer: ReviewerRole, reason: string) {
  return {
    version: 1,
    reviewer,
    trigger_reason: reason,
    verdict: "pass" as const,
    findings: [],
    score: 100,
    block_completion: false,
    next_actions: [],
    evidence_confidence: 100,
    ts: new Date().toISOString(),
  }
}

// ─── Final Report Context Compression ──────────────────────────────────────

/** 生成压缩的 finalization 上下文，避免在报告循环中反复携带全量历史 */
export function buildFinalReportContext(
  state: SupervisorState,
  latestUserGoal?: string,
): string {
  const completed = state.completed_reviews
  const pending = state.required_reviews
  const metrics = state.metrics
  const lines = [
    `[dll-agent finalization context]`,
    `Phase: ${state.phase} | Risk: ${state.risk}`,
    ``,
    `User goal: ${latestUserGoal?.slice(0, 500) ?? "(not available)"}`,
    ``,
    `Completed reviews: ${completed.length > 0 ? completed.join(", ") : "none"}`,
    `Pending reviews: ${pending.length > 0 ? pending.join(", ") : "none"}`,
    ``,
    `Verification status:`,
    `  real_tool_evidence=${metrics.real_tool_evidence}`,
    `  typecheck_passed=${metrics.verification_evidence}`,
    ``,
    `Gate block status:`,
    `  blocked_completion=${state.blocked_completion}`,
    `  block_reason=${state.block_reason ?? "none"}`,
    `  gate_retries=${JSON.stringify(state.gate_block_retries ?? {})}`,
    ``,
    `Unresolved: ${state.blocked_completion ? state.block_reason : "none"}`,
    ``,
    `IMPORTANT: Do not repeat the full conversation history.`,
    `Only the above summary is needed for finalization decisions.`,
    `If blocked, run verification commands as TOOL CALLS, not text descriptions.`,
  ]
  return lines.join("\n")
}
