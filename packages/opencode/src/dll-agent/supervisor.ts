/**
 * dll-agent supervisor.ts
 *
 * 核心自动监督器：监听消息流、统计失败、上下文长度、用户纠偏，满足条件时自动
 * 强制插入 reviewer subtask。该逻辑由代码执行，不是提示词注入。
 */

import fs from "fs"
import path from "path"
import { metrics as computeMetrics } from "./triggers"
import { write as writeEvidence, redact } from "./evidence"
import {
  applyReviewerCompletedToState,
  applySupervisorDecisionToState,
  clearResolvedBlockState,
  freshSupervisorState,
  metricsFromSupervisorSnapshot,
  normalizeSupervisorReviewerState,
} from "./supervisor-state-machine"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { resolveRoleProviderHint } from "./role-provider-bridge"
import {
  type SupervisorState,
  type TriggerDecision,
  type ReviewerRole,
  type CooldownStatus,
  type ReviewerOutput,
  type SupervisorMetricsSnapshot,
  COOLDOWN_CONFIG,
  parseReviewerOutput,
} from "./interfaces"
import type { MessageV2 } from "@/session/message-v2"
import { buildContinuationSubtaskPrompt } from "./continuation-gate"
import { checkDeduplication } from "./deduplication-gate"
import { writeReviewerResult } from "./reviewer-result-bridge"
import {
  assessRisk,
  maxReviewersForRouting,
  modelContextLimit,
  reviewerModelCandidates,
  reviewerRequiredForCorrectness,
  reviewerToDllRole,
} from "./routing-policy"
import { applySupervisorTriggerRules, needsAutoVerifier } from "./supervisor-trigger-rules"
import { buildReviewerPrompt } from "./reviewer-prompt-templates"
import { writeRoutingEvidence } from "./routing-evidence"
import { buildReviewerContextWithPacket, extractRelatedPaths, latestRealUser } from "./reviewer-context"
import { buildGuardDecision } from "./action-fingerprint-gate"
import { buildRoleRunEnvelope } from "./role-run-envelope"
import { roleToolPolicyFor } from "./role-tool-policy"
import os from "os"

export { assessRisk, modelContextLimit } from "./routing-policy"

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
  return freshSupervisorState()
}

function atomicWrite(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function saveState(sessionID: string, state: SupervisorState) {
  try {
    normalizeSupervisorReviewerState(state)
    atomicWrite(stateFile(sessionID), JSON.stringify(redact(state), null, 2))
  } catch {
    // Non-critical; supervisor state persistence is best-effort
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

  applySupervisorTriggerRules({
    metrics,
    messages,
    risk,
    contextLimit,
  }, {
    addReviewer,
    hasReviewer: (reviewer) => reviewers.includes(reviewer),
    writeTokenAwareEvidence: () => writeEvidence("routing.token_aware", {
      reason: "high context — Kimi prioritization recommended",
      context_percent: metrics.contextPercent,
      context_tokens: metrics.contextTokens,
      context_limit: contextLimit,
      step: currentStep,
    }, sessionID),
    writeMultimodalSkip: () => writeRoutingEvidence({
      sessionID,
      taskID: sessionID,
      role: "multimodal-context-interpreter",
      selectedModel: reviewerModelCandidates("multimodal-context-interpreter", sessionID).selected,
      candidateModels: reviewerModelCandidates("multimodal-context-interpreter", sessionID).candidates,
      riskLevel: risk,
      triggerReason: "multimodal keyword signal without non-text input",
      skippedReviewers: ["multimodal-context-interpreter"],
      skipReason: "pure_text_or_code_task",
      correctnessReason: "MiMo multimodal reviewer is not required without actual non-text input",
      costReason: "prevent multimodal/TTS model from entering a pure code task",
      evidenceRefs: [],
      requiredForCorrectness: false,
    }),
  })

  // 规则 7（auto-verifier）：completion blocked + 缺真实 tool evidence → 自动注入 verifier subtask
  // 这使得模型不需要"记得"运行验证 — supervisor 在代码层强制注入验证任务。
  let verifierTask: MessageV2.SubtaskPart | undefined
  if (needsAutoVerifier(metrics)) {
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
      ? required.slice(0, maxReviewers)
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
        correctnessReason: reviewerRequiredForCorrectness(r, reasons[r], risk, metrics)
          ? "correctness-required reviewer exceeded per-round budget and remains unresolved"
          : "reviewer was not required for correctness after required reviewers were selected",
        costReason: "avoid low-value multi-model meeting beyond the current risk budget",
        evidenceRefs: fingerprints[r] ? [fingerprints[r]!] : [],
        requiredForCorrectness: reviewerRequiredForCorrectness(r, reasons[r], risk, metrics),
      })
    }
    reviewers.splice(0, reviewers.length, ...selected)
  }

  if (reviewers.length === 0 && !verifierTask) {
    const commanderModel = resolveRoleProviderHint({
      role: "commander",
      sessionID,
      projectDir: process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR,
    })
    writeRoutingEvidence({
      sessionID,
      taskID: sessionID,
      role: "commander",
      action: "commander_only",
      selectedModel: `${commanderModel.providerID}/${commanderModel.modelID}`,
      candidateModels: [`${commanderModel.providerID}/${commanderModel.modelID}`],
      riskLevel: risk,
      triggerReason: "ordinary low-risk task or no correctness-required reviewer trigger",
      skippedReviewers: [],
      correctnessReason: "commander can proceed alone because no correction, repeated failure, evidence gap, high-risk, conflict, long-context, or multimodal trigger was present",
      costReason: "avoid unnecessary multi-model review when correctness does not require it",
      evidenceRefs: [],
      requiredForCorrectness: false,
    })
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
      high_risk_task_signal: metrics.highRiskTaskSignal,
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
  applySupervisorDecisionToState(state, decision)
  if (decision.metrics.final_claim && !decision.metrics.verification_evidence) {
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
  options?: {
    rawText?: string
    reusedFromPacketID?: string
  },
) {
  const state = loadState(sessionID)
  const contextPacketID = state.reviewer_context_packets?.[reviewer]?.context_packet_id
  const roleRun = state.role_run_envelopes?.[reviewer]
  const normalizedOutput = output ?? (options?.rawText ? parseReviewerOutput(options.rawText) : undefined)
  const completed = applyReviewerCompletedToState(state, reviewer, {
    output: normalizedOutput,
    rawText: options?.rawText,
    reusedFromPacketID: options?.reusedFromPacketID,
  })
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
    block_completion: normalizedOutput?.block_completion ?? completed.blockCompletion,
    findings_count: normalizedOutput?.findings.length ?? 0,
    context_packet_id: contextPacketID ?? null,
    missing_context_packet: !contextPacketID,
    role_run_id: roleRun?.role_run_id ?? null,
    missing_role_run_envelope: !roleRun?.role_run_id,
    structured_output_missing: !normalizedOutput && !options?.reusedFromPacketID,
    fallback_result: !normalizedOutput,
    reused_from: options?.reusedFromPacketID ?? null,
  }, sessionID)

  writeReviewerResult({
    sessionID,
    reviewer,
    output: normalizedOutput,
    state,
    projectDir: process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR,
    contextPacketID,
    roleRunID: roleRun?.role_run_id,
    roleInstanceID: roleRun?.role_instance_id,
    actionFingerprint: roleRun?.action_fingerprint,
    rawText: options?.rawText,
    reusedFromPacketID: options?.reusedFromPacketID,
  })
}

export function clearBlockIfResolved(sessionID: string) {
  const state = loadState(sessionID)
  const shouldSave = state.required_reviews.length === 0 && state.blocked_completion
  clearResolvedBlockState(state)
  if (shouldSave) saveState(sessionID, state)
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
          resultRefs: dedup.existingResults[0]?.packet_id ? [dedup.existingResults[0].packet_id] : [],
          requiredForCorrectness: false,
        })
        markReviewerCompleted(sessionID, reviewer, undefined, {
          reusedFromPacketID: dedup.existingResults[0]?.packet_id,
        })
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
    const contextPacketID = loadState(sessionID).reviewer_context_packets?.[reviewer]?.context_packet_id
    writeEvidence("supervisor.reviewer_called", {
      reviewer,
      reason,
      fingerprint: decision.fingerprints?.[reviewer],
      context_packet_id: contextPacketID ?? null,
      missing_context_packet: !contextPacketID,
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
  // Resolve effective model from Role Model Registry
  // Uses session overrides if this session has role_model_overrides in supervisor state
  const dllRole = reviewerToDllRole(reviewer)
  const effective = resolveRoleProviderHint({
    role: dllRole,
    sessionID,
    projectDir: process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR,
  })
  const effectiveModel = `${effective.providerID}/${effective.modelID}`
  const model = {
    providerID: effective.providerID,
    modelID: effective.modelID,
  }
  const projectDir = process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR
  const context = buildReviewerContextWithPacket(reviewer, reason, metrics, messages, sessionID, {
    state: loadState(sessionID),
    projectDir,
  })
  const compactContext = context.text
  if (context.contextPacketID) {
    const state = loadState(sessionID)
    state.reviewer_context_packets ??= {}
    state.reviewer_context_packets[reviewer] = {
      context_packet_id: context.contextPacketID,
      built_at: new Date().toISOString(),
    }
    const policy = roleToolPolicyFor(dllRole)
    const envelope = buildRoleRunEnvelope({
      sessionID,
      role: reviewer,
      model: effectiveModel,
      contextPacketID: context.contextPacketID,
      triggerReason: reason,
      riskLevel: state.risk,
      allowedActions: policy.allow,
      forbiddenActions: policy.deny,
      files: extractRelatedPaths(messages),
      failureFingerprint: metrics.repeated_tool_failure ? reason : null,
    })
    state.role_run_envelopes ??= {}
    state.role_run_envelopes[reviewer] = {
      role_run_id: envelope.role_run_id,
      role_instance_id: envelope.role_instance_id,
      model: envelope.model,
      context_packet_id: envelope.context_packet_id,
      action_fingerprint: envelope.action_fingerprint,
      independence_mode: envelope.independence_mode,
      built_at: envelope.created_at,
    }
    writeEvidence("role_run.envelope_built", envelope, sessionID)
    writeEvidence("model.guard_decision", buildGuardDecision({
      guard: "role_run_envelope",
      action: "allow",
      requiredForCorrectness: reviewerRequiredForCorrectness(reviewer, reason, state.risk, metricsFromSupervisorSnapshot(metrics)),
      reason: "role run envelope preserves role boundary without changing model capability",
    }), sessionID)
    state.updated_at = new Date().toISOString()
    saveState(sessionID, state)
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
    prompt: buildReviewerPrompt({ reviewer, reason, compactContext, effectiveModel }),
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

  const effective = resolveRoleProviderHint({
    role: "task-completion-archivist",
    sessionID,
    projectDir: process.env.DLL_AGENT_ROOT || process.env.OPENER_DIR,
  })

  return {
    type: "subtask" as const,
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    agent: "task-completion-archivist",
    description: "Kimi task-completion-archivist: check unfinished items",
    command: "dll-agent-supervisor",
    model: { providerID: effective.providerID, modelID: effective.modelID },
    prompt,
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
