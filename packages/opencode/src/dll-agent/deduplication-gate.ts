/**
 * dll-agent deduplication-gate.ts
 *
 * Prevents models from redundantly re-executing tasks that have already been
 * completed by another model. Before any model starts a subtask, this gate
 * checks the Result Ledger for existing results covering the same scope.
 *
 * If a reusable result exists:
 *   - The task is NOT re-dispatched
 *   - A synthetic hint is injected to guide the model to reuse/review
 *   - Evidence is written for the dedup decision
 *
 * If the model insists on redoing the work:
 *   - It must provide explicit justification with evidence
 *   - The justification is logged to the Result Ledger
 *
 * Builds on: result-ledger.ts, result-sufficiency-gate.ts
 * Consumed by: supervisor.ts, prompt.ts
 */
import { buildResultsSummary, type ResultPacket } from "./result-ledger"
import { checkResultSufficiency, type SufficiencyCheck } from "./result-sufficiency-gate"
import { write as writeEvidence } from "./evidence"

// ─── Deduplication Check ───────────────────────────────────────────────────

export interface DedupCheck {
  /** Whether the proposed task is redundant */
  isRedundant: boolean
  /** The matching result packets */
  existingResults: ResultPacket[]
  /** Whether existing results can be safely reused */
  canReuse: boolean
  /** The sufficiency verdict (if results exist) */
  sufficiency: SufficiencyCheck | null
  /** Reason the result can or cannot be reused */
  reason: string
  /** Action the downstream model should take */
  recommendedAction:
    | "reuse_existing"
    | "review_existing"
    | "continue_from_existing"
    | "repair_existing"
    | "verify_existing"
    | "blocked_missing_evidence"
    | "blocked_stale"
    | "redo_allowed"
    | "redo_not_allowed"
    | "no_existing_result"
  /** Synthetic hint to inject into the model's context */
  syntheticHint: string | null
  /** Evidence references */
  evidenceRefs: string[]
}

export interface DedupDispatchDecision {
  shouldDispatch: boolean
  mustJustifyRedo: boolean
  action: DedupCheck["recommendedAction"]
  reason: string
  syntheticHint: string | null
  existingPacketId?: string
  evidenceRefs: string[]
}

/**
 * Check whether a proposed task has already been completed in a reusable form.
 *
 * Call this BEFORE dispatching any subtask or tool execution.
 *
 * @param sessionID — current session ID
 * @param taskGoal — what the downstream model plans to do
 * @param options.requiredFilePaths — files the task would touch
 * @param options.maxAgeMinutes — max age for reusable results (default 60 min)
 * @param options.forceRedo — user explicitly asked to redo (overrides dedup)
 * @param options.redoJustification — if forceRedo, why
 */
export function checkDeduplication(
  sessionID: string,
  taskGoal: string,
  options?: {
    requiredFilePaths?: string[]
    maxAgeMinutes?: number
    projectDir?: string
    forceRedo?: boolean
    redoJustification?: string
  },
): DedupCheck {
  const maxAge = options?.maxAgeMinutes ?? 60

  // If user explicitly requested redo with justification
  if (options?.forceRedo && options?.redoJustification) {
    writeEvidence("result.dedup_allowed", {
      reason: "user_explicit_redo",
      justification: options.redoJustification.slice(0, 300),
    }, sessionID)
    return {
      isRedundant: false,
      existingResults: [],
      canReuse: false,
      sufficiency: null,
      reason: `User requested re-execution: ${options.redoJustification.slice(0, 100)}`,
      recommendedAction: "redo_allowed",
      syntheticHint: null,
      evidenceRefs: [],
    }
  }

  // Check for existing results
  const sufficiency = checkResultSufficiency(sessionID, taskGoal, {
    requiredFilePaths: options?.requiredFilePaths,
    maxAgeMinutes: maxAge,
    projectDir: options?.projectDir,
  })

  if (sufficiency.verdict === "none") {
    return {
      isRedundant: false,
      existingResults: [],
      canReuse: false,
      sufficiency: null,
      reason: "No prior results for this task",
      recommendedAction: "no_existing_result",
      syntheticHint: null,
      evidenceRefs: [],
    }
  }

  // Results exist — determine what to do
  switch (sufficiency.verdict) {
    case "sufficient": {
      writeEvidence("result.dedup_blocked", {
        reason: "sufficient_result_exists",
        best_packet_id: sufficiency.bestResult?.packet_id,
        covered_files: sufficiency.coveredScope,
      }, sessionID)
      return {
        isRedundant: true,
        existingResults: sufficiency.matchingResults,
        canReuse: true,
        sufficiency,
        reason: `A verified complete result already exists for this task (${sufficiency.bestResult?.packet_id})`,
        recommendedAction: "reuse_existing",
        syntheticHint: `<dll-agent-dedup-gate>
Existing result found: ${sufficiency.bestResult?.packet_id}
Completed by: ${sufficiency.bestResult?.executing_role} (${sufficiency.bestResult?.model})
Files covered: ${sufficiency.coveredScope.join(", ") || "none"}

DO NOT re-execute this task. The result is verified and complete.
Instead: review the existing result, verify it meets the current goal, and continue to the next step.
If you believe redo is necessary, you MUST explain why with specific evidence.
</dll-agent-dedup-gate>`,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }

    case "sufficient_but_unverified": {
      const action = sufficiency.action === "blocked_missing_evidence" ? "blocked_missing_evidence" : "verify_existing"
      return {
        isRedundant: true,
        existingResults: sufficiency.matchingResults,
        canReuse: action === "verify_existing",
        sufficiency,
        reason: action === "blocked_missing_evidence"
          ? `Result exists but is missing reusable evidence (${sufficiency.bestResult?.packet_id})`
          : `Result exists but needs verification (${sufficiency.bestResult?.packet_id})`,
        recommendedAction: action,
        syntheticHint: `<dll-agent-dedup-gate>
Result exists but is UNVERIFIED: ${sufficiency.bestResult?.packet_id}
REQUIRED: run verification commands before claiming completion.
DO NOT re-implement the task — only verify.
</dll-agent-dedup-gate>`,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }

    case "partial":
    case "partial_with_gaps": {
      return {
        isRedundant: false,
        existingResults: sufficiency.matchingResults,
        canReuse: true,
        sufficiency,
        reason: `Partial result exists — continue from gaps (${sufficiency.remainingGaps.length} remaining)`,
        recommendedAction: "continue_from_existing",
        syntheticHint: `<dll-agent-dedup-gate>
Partial result exists: ${sufficiency.bestResult?.packet_id}
Already completed: ${sufficiency.coveredScope.join(", ") || "none"}
Remaining gaps:
${sufficiency.remainingGaps.map((g, i) => `  ${i + 1}. ${g}`).join("\n")}

Only address the remaining gaps. Do NOT redo what is already done.
</dll-agent-dedup-gate>`,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }

    case "failed_with_diagnosis": {
      return {
        isRedundant: false,
        existingResults: sufficiency.matchingResults,
        canReuse: false,
        sufficiency,
        reason: "Previous attempt failed — redo allowed with diagnosis awareness",
        recommendedAction: "repair_existing",
        syntheticHint: `<dll-agent-dedup-gate>
Previous attempt FAILED: ${sufficiency.bestResult?.packet_id}
Review the failure diagnosis before re-executing. Do not repeat the same approach.
</dll-agent-dedup-gate>`,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }

    case "stale":
    case "invalidated":
    case "insufficient": {
      if (sufficiency.verdict === "stale") {
        writeEvidence("result.stale_detected", {
          reason: "result_sufficiency_stale",
          best_packet_id: sufficiency.bestResult?.packet_id,
          stale_reasons: sufficiency.staleReasons ?? [],
        }, sessionID)
      }
      return {
        isRedundant: false,
        existingResults: sufficiency.matchingResults,
        canReuse: false,
        sufficiency,
        reason: `Existing result is ${sufficiency.verdict} — redo is allowed`,
        recommendedAction: sufficiency.verdict === "stale" ? "blocked_stale" : "redo_allowed",
        syntheticHint: null,
        evidenceRefs: sufficiency.evidenceRefs,
      }
    }

    default:
      return {
        isRedundant: false,
        existingResults: sufficiency.matchingResults,
        canReuse: false,
        sufficiency,
        reason: "Unable to determine result sufficiency",
        recommendedAction: "no_existing_result",
        syntheticHint: null,
        evidenceRefs: [],
      }
  }
}

/**
 * Convert the sufficiency/dedup verdict into a dispatch-layer decision.
 * A verified reusable result becomes a hard dispatch skip; weaker results
 * constrain the next action but still allow work to continue from existing state.
 */
export function buildDedupDispatchDecision(
  sessionID: string,
  taskGoal: string,
  role: string,
  options?: {
    requiredFilePaths?: string[]
    maxAgeMinutes?: number
    projectDir?: string
    forceRedo?: boolean
    redoJustification?: string
  },
): DedupDispatchDecision {
  const check = checkDeduplication(sessionID, taskGoal, options)
  const existingPacketId = check.existingResults[0]?.packet_id
  if (check.recommendedAction === "reuse_existing") {
    writeEvidence("result.dedup_blocked", {
      role,
      task_goal: taskGoal.slice(0, 300),
      action: "hard_block_reuse",
      existing_packet_id: existingPacketId,
      reason: check.reason,
    }, sessionID)
    return {
      shouldDispatch: false,
      mustJustifyRedo: true,
      action: check.recommendedAction,
      reason: check.reason,
      syntheticHint: check.syntheticHint,
      existingPacketId,
      evidenceRefs: check.evidenceRefs,
    }
  }
  if (check.recommendedAction === "blocked_missing_evidence" || check.recommendedAction === "blocked_stale") {
    writeEvidence(check.recommendedAction === "blocked_stale" ? "result.stale_detected" : "result.dedup_blocked", {
      role,
      task_goal: taskGoal.slice(0, 300),
      action: check.recommendedAction,
      existing_packet_id: existingPacketId,
      reason: check.reason,
      stale_reasons: check.sufficiency?.staleReasons ?? [],
    }, sessionID)
    return {
      shouldDispatch: false,
      mustJustifyRedo: true,
      action: check.recommendedAction,
      reason: check.reason,
      syntheticHint: check.syntheticHint,
      existingPacketId,
      evidenceRefs: check.evidenceRefs,
    }
  }
  return {
    shouldDispatch: true,
    mustJustifyRedo: check.existingResults.length > 0,
    action: check.recommendedAction,
    reason: check.reason,
    syntheticHint: check.syntheticHint,
    existingPacketId,
    evidenceRefs: check.evidenceRefs,
  }
}

export function isDedupReuseAcknowledged(text: string, existingPacketId?: string) {
  const normalized = text.toLowerCase()
  if (existingPacketId && normalized.includes(existingPacketId.toLowerCase())) return true
  return /(reuse|reused|existing result|result ledger|dedup|复用|复用了|已有结果|结果账本|不重复执行|无需重做)/i.test(text)
}

/**
 * Record a redo justification when a model explicitly decides to re-execute
 * work despite an existing result.
 */
export function recordRedoJustification(
  sessionID: string,
  existingPacketId: string,
  executedBy: string,
  justification: string,
  evidenceRefs: string[],
) {
  writeEvidence("result.dedup_allowed", {
    existing_packet_id: existingPacketId,
    executed_by: executedBy,
    justification: justification.slice(0, 500),
    evidence_refs: evidenceRefs,
  }, sessionID)
}

/**
 * Build a deduplication-aware context summary.
 * Called before subtask dispatch to inject existing results into the model's view.
 */
export function buildDedupContextSummary(sessionID: string, taskGoal?: string): string {
  const summary = buildResultsSummary(sessionID)
  if (summary === "No prior results in ledger.") return ""

  let context = `
[dll-agent deduplication context]
The Result Ledger contains prior work from other models. Before starting any task, check if
the work has already been completed by a previous model. If a VERIFIED_COMPLETE result exists,
do NOT re-execute — review and continue.

${summary}

Rule: DO NOT redo work that is already completed and verified.
Rule: If a result is PARTIAL, only fill the gaps.
Rule: If you need to redo, you MUST justify why the existing result is insufficient.
`

  if (taskGoal) {
    context += `\nYour task: ${taskGoal.slice(0, 200)}`
  }

  return context
}
