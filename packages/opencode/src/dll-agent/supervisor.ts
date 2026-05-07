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
    atomicWrite(stateFile(sessionID), JSON.stringify(redact(state), null, 2))
  } catch {
    // Non-critical; supervisor state persistence is best-effort
  }
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
    state.queued_reviewers = [...reviewers]
    state.updated_at = new Date().toISOString()
    saveState(sessionID, state)
  } catch {
    // best-effort
  }
}

export function setRunningReviewers(sessionID: string, reviewers: string[]) {
  try {
    const state = loadState(sessionID)
    state.running_reviewers = [...reviewers]
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
    .find((message) => message.info.role === "user" && messageText(message).trim().length > 0)
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

function gitDiffSummary(paths: string[]) {
  try {
    const cwd = process.env.DLL_AGENT_ROOT || process.cwd()
    const args = ["-C", cwd, "diff", "--stat", "--", ...paths.filter((p) => !p.startsWith("/Users/")).slice(0, 8)]
    const output = execFileSync("git", args, {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 12_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return truncate(output.trim(), 2_000)
  } catch {
    return ""
  }
}

function buildReviewerContext(
  reviewer: ReviewerRole,
  reason: string,
  metrics: SupervisorMetricsSnapshot,
  messages: MessageV2.WithParts[],
) {
  const user = latestRealUser(messages)
  const userGoal = user ? truncate(messageText(user).trim(), 1_500) : "(no recent user text)"
  const paths = extractRelatedPaths(messages)
  const failures = recentToolFailureSummary(messages)
  const diff = gitDiffSummary(paths)
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
  return truncate(contextLines.join("\n"), 6_000)
}

export function reviewerRuntimeMs(reviewer: string) {
  if (reviewer === "requirements-inspector") return COOLDOWN_CONFIG.reviewer_runtime_ms
  if (reviewer === "long-context-archivist") return COOLDOWN_CONFIG.reviewer_runtime_ms
  if (reviewer === "final-auditor") return 240_000
  return 300_000
}

export function isReadOnlyReviewer(reviewer: string) {
  return reviewer === "requirements-inspector" || reviewer === "long-context-archivist" || reviewer === "final-auditor"
}

// ─── 风险判定 ─────────────────────────────────────────────────────────────

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

  const addReviewer = (reviewer: ReviewerRole, reason: string) => {
    if (reviewers.includes(reviewer)) return
    const fingerprint = makeTriggerFingerprint(messages, reviewer, reason)
    if (isCooldown(sessionID, reviewer, currentStep, fingerprint)) return
    reviewers.push(reviewer)
    reasons[reviewer] = reason
    fingerprints[reviewer] = fingerprint
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

  // 规则 3：重复工具失败 → chief-engineer 或 role-cross
  if (metrics.repeatedToolFailure || metrics.toolFailures >= 3) {
    const reason = metrics.repeatedToolFailure
      ? "repeated tool failure detected (same error pattern)"
      : `${metrics.toolFailures} tool failures in recent messages`
    const chiefFingerprint = makeTriggerFingerprint(messages, "chief-engineer", reason)
    if (!isCooldown(sessionID, "chief-engineer", currentStep, chiefFingerprint)) {
      reviewers.push("chief-engineer")
      reasons["chief-engineer"] = reason
      fingerprints["chief-engineer"] = chiefFingerprint
    } else {
      addReviewer("role-cross", reason + " (chief-engineer in cooldown)")
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

  // 规则 6：高风险最终声明且缺验证 → 先阻断而非直接调 OpenAI
  if (metrics.finalClaim && !metrics.verificationEvidence) {
    // 这里不直接调 final-auditor，由 gates 层处理。
    // 只登记到 state 中。
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

  // Rate-limit: 每轮最多触发 5 个 reviewer
  if (reviewers.length > COOLDOWN_CONFIG.max_reviewers_per_round) {
    const skipped = reviewers.slice(COOLDOWN_CONFIG.max_reviewers_per_round)
    for (const r of skipped) {
      writeEvidence("cooldown.skipped", {
        reason: "max_reviewers_per_round",
        reviewer: r,
      }, sessionID)
    }
    reviewers.splice(COOLDOWN_CONFIG.max_reviewers_per_round)
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

function buildSubtask(
  reviewer: ReviewerRole,
  reason: string,
  metrics: SupervisorMetricsSnapshot,
  sessionID: string,
  messages: MessageV2.WithParts[],
): MessageV2.SubtaskPart {
  const modelMap: Record<ReviewerRole, { providerID: ProviderID; modelID: ModelID }> = {
    "requirements-inspector": { providerID: ProviderID.make("zai"), modelID: ModelID.make("glm-5.1") },
    "long-context-archivist": { providerID: ProviderID.make("kimi"), modelID: ModelID.make("kimi-k2.6") },
    "chief-engineer": { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4-pro") },
    "final-auditor": { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.5-pro") },
    "role-cross": { providerID: ProviderID.make("zai"), modelID: ModelID.make("glm-5.1") },
  }
  const compactContext = buildReviewerContext(reviewer, reason, metrics, messages)

  const promptTemplates: Record<ReviewerRole, string> = {
    "requirements-inspector": [
      `[dll-agent supervisor auto-trigger]`,
      `<compact-review-context>`,
      compactContext,
      `</compact-review-context>`,
      ``,
      `Act as the requirements inspector (GLM 5.1). Check:`,
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
      `Act as the long-context archivist (Kimi K2.6). Check:`,
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
      `Act as the chief engineer (DeepSeek V4 Pro). Diagnose the tool failures:`,
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
      `Act as the on-demand strategic/final auditor (GPT-5.5 Pro). Check:`,
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
      `Run a temporary role-crossing review. Inspect the problem from a different role's perspective:`,
      `1. Find blind spots that the current role may have missed.`,
      `2. Identify missing evidence.`,
      `3. Propose actionable recovery steps.`,
      ``,
      `This role crossing ends after this review round. Output in machine-readable JSON format.`,
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
    model: modelMap[reviewer],
    prompt: promptTemplates[reviewer].replace("repeated_tool_failure=${metrics.repeatedToolFailure}", ""),
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
