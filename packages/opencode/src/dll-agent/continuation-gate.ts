/**
 * dll-agent continuation-gate.ts
 *
 * Task completion continuation gate: prevents dll-agent from stopping
 * when there are blocking unfinished items in the completion report.
 *
 * Runs BEFORE evidence gate. If blocking unfinished items are detected,
 * generates a ContinuationPacket and triggers Kimi task-completion-archivist.
 *
 * Principle: "listing unfinished items" is not "completing the task".
 * The gate scans for unfinished indicators in the final text and
 * classifies them as blocking / non-blocking / requires_user_input.
 */
import type { MessageV2 } from "@/session/message-v2"
import type {
  CompletionStatus,
  UnfinishedItem,
  ContinuationPacket,
  ContinuationGateResult,
  ReviewerRole,
  RiskLevel,
  SupervisorState,
} from "./interfaces"
import { write as writeEvidence } from "./evidence"
import { loadResults } from "./result-ledger"
import { detectUnfinishedIndicators, extractUnfinishedItems } from "./continuation-parser"

export { classifyUnfinishedItem, detectUnfinishedIndicators, extractUnfinishedItems } from "./continuation-parser"

// ─── Continuation Packet Builder ───────────────────────────────────────────

/**
 * Build a ContinuationPacket from the extracted unfinished items.
 */
export function buildContinuationPacket(params: {
  sessionID: string
  userGoal: string
  currentPhase: string
  completionClaim: string
  items: UnfinishedItem[]
  state: SupervisorState
}): ContinuationPacket {
  const blocking = params.items.filter((i) => i.kind === "blocking_unfinished")
  const nonBlocking = params.items.filter((i) => i.kind === "non_blocking_followup")
  const userInput = params.items.filter((i) => i.kind === "requires_user_input")

  let completionStatus: CompletionStatus
  if (blocking.length > 0) {
    completionStatus = "PARTIAL_CONTINUED"
  } else if (userInput.length > 0) {
    completionStatus = "BLOCKED_USER_REQUIRED"
  } else if (nonBlocking.length > 0) {
    completionStatus = "UNVERIFIED_COMPLETE"
  } else {
    completionStatus = "VERIFIED_COMPLETE"
  }

  const nextPlan = blocking.map((item, idx) => ({
    step: idx + 1,
    role: item.recommended_role,
    action: item.required_action,
    verification: item.verification_required.join(", ") || "run typecheck + tests + doctor",
  }))

  // Phase 7: Populate already_completed, files_involved, commands_run from ResultLedger
  let alreadyCompleted: string[] = []
  let filesInvolved: string[] = []
  let commandsRun: string[] = []
  try {
    const results = loadResults(params.sessionID)
    for (const r of results) {
      if (r.completion_status === "VERIFIED_COMPLETE") {
        alreadyCompleted.push(`${r.executing_role}: ${r.subtask_goal.slice(0, 120)} (${r.packet_id})`)
      }
      for (const fc of r.files_changed) {
        filesInvolved.push(fc.filePath)
      }
      for (const cr of r.commands_run) {
        commandsRun.push(cr.command)
      }
    }
  } catch {
    // Best-effort; ledger unavailable → empty arrays
  }

  return {
    packet_type: "task_continuation",
    packet_id: `cont_${Date.now()}`,
    session_id: params.sessionID,
    user_goal: params.userGoal.slice(0, 500),
    current_phase: params.currentPhase,
    completion_claim: params.completionClaim.slice(0, 300),
    completion_status: completionStatus,
    blocking_unfinished: blocking,
    non_blocking_followup: nonBlocking,
    requires_user_input: userInput,
    already_completed: alreadyCompleted,
    files_involved: filesInvolved.slice(0, 20),
    commands_run: commandsRun.slice(0, 20),
    verification_results: [
      `real_tool_evidence=${params.state.metrics.real_tool_evidence}`,
      `typecheck=${params.state.metrics.verification_evidence}`,
    ],
    reviewer_blocks: params.state.block_reason ? [params.state.block_reason] : [],
    next_execution_plan: nextPlan.slice(0, 5),
    stop_reason: userInput.length > 0
      ? "Requires user input before continuing"
      : null,
    redaction_status: "redacted",
  }
}

// ─── Continuation Gate ─────────────────────────────────────────────────────

/**
 * Main continuation gate: checks if a completion claim contains unfinished items.
 *
 * Returns:
 * - passed=false if blocking_unfinished or requires_user_input found
 * - passed=true (with notes) if only non_blocking_followup found
 * - passed=true if no unfinished items found
 */
export function checkContinuationGate(params: {
  assistantText: string
  isCompletionClaim: boolean
  state: SupervisorState
  sessionID: string
  userGoal?: string
}): ContinuationGateResult {
  // Not a completion claim → pass
  if (!params.isCompletionClaim) {
    return {
      passed: true,
      completion_status: "UNVERIFIED_COMPLETE",
      has_blocking_unfinished: false,
      has_user_input_required: false,
      has_non_blocking: false,
      blocking_items: [],
      continuation_packet: null,
      synthetic_hint: null,
      block_reason: null,
    }
  }

  const detection = detectUnfinishedIndicators(params.assistantText)
  if (!detection.hasUnfinished) {
    return {
      passed: true,
      completion_status: "UNVERIFIED_COMPLETE",
      has_blocking_unfinished: false,
      has_user_input_required: false,
      has_non_blocking: false,
      blocking_items: [],
      continuation_packet: null,
      synthetic_hint: null,
      block_reason: null,
    }
  }

  const items = extractUnfinishedItems(params.assistantText, params.state.phase)
  const blocking = items.filter((i) => i.kind === "blocking_unfinished")
  const userInput = items.filter((i) => i.kind === "requires_user_input")
  const hasBlocking = blocking.length > 0
  const hasUserInput = userInput.length > 0

  if (!hasBlocking && !hasUserInput) {
    // Only non-blocking followups — pass with note
    return {
      passed: true,
      completion_status: "UNVERIFIED_COMPLETE",
      has_blocking_unfinished: false,
      has_user_input_required: false,
      has_non_blocking: true,
      blocking_items: [],
      continuation_packet: null,
      synthetic_hint: null,
      block_reason: null,
    }
  }

  // Blocking or user-input-required — build continuation packet
  const packet = buildContinuationPacket({
    sessionID: params.sessionID,
    userGoal: params.userGoal ?? "Not available",
    currentPhase: params.state.phase,
    completionClaim: params.assistantText,
    items,
    state: params.state,
  })

  let blockReason: string
  let syntheticHint: string
  let completionStatus: CompletionStatus

  if (hasBlocking) {
    blockReason = `Blocking unfinished items detected: ${blocking.map((b) => b.description).join("; ")}`
    syntheticHint = `<dll-agent-continuation-gate>
Task NOT complete. ${blocking.length} blocking unfinished item(s) detected:
${blocking.map((b, i) => `${i + 1}. [${b.risk_level}] ${b.description}`).join("\n")}

Continuation required. Run /team-review or continue execution of the remaining items.
This completion claim is blocked because blocking unfinished work remains.
</dll-agent-continuation-gate>`
    completionStatus = "PARTIAL_CONTINUED"
  } else {
    blockReason = `User input required: ${userInput.map((u) => u.description).join("; ")}`
    syntheticHint = `<dll-agent-continuation-gate>
Task BLOCKED. User input is required before continuing:
${userInput.map((u, i) => `${i + 1}. ${u.description}`).join("\n")}

Cannot proceed automatically. The user must provide the requested input.
</dll-agent-continuation-gate>`
    completionStatus = "BLOCKED_USER_REQUIRED"
  }

  writeEvidence("continuation_gate.blocked", {
    block_reason: blockReason,
    blocking_count: blocking.length,
    user_input_count: userInput.length,
    non_blocking_count: items.length - blocking.length - userInput.length,
  })

  return {
    passed: false,
    completion_status: completionStatus,
    has_blocking_unfinished: hasBlocking,
    has_user_input_required: hasUserInput,
    has_non_blocking: !hasBlocking && !hasUserInput,
    blocking_items: blocking,
    continuation_packet: packet,
    synthetic_hint: syntheticHint,
    block_reason: blockReason,
  }
}

/**
 * Check if continuation budget has been exhausted.
 * Prevents infinite automatic continuation loops.
 */
export function isContinuationBudgetExhausted(params: {
  continuationCount: number
  repairCounts: Record<string, number>
  blockingItems: UnfinishedItem[]
}): { exhausted: boolean; reason: string | null } {
  if (params.continuationCount >= 5) {
    return {
      exhausted: true,
      reason: `Maximum continuation count (5) reached. ${params.continuationCount} continuations attempted.`,
    }
  }
  for (const item of params.blockingItems) {
    const repairCount = params.repairCounts[item.id] ?? 0
    if (repairCount >= 2) {
      return {
        exhausted: true,
        reason: `Item "${item.description}" has been attempted ${repairCount} times (max 2). Budget exhausted.`,
      }
    }
  }
  return { exhausted: false, reason: null }
}

// ─── Continuation Subtask Builder ──────────────────────────────────────────

/**
 * Build a Kimi task-completion-archivist subtask prompt.
 * Includes structured JSON output template.
 */
export function buildContinuationSubtaskPrompt(params: {
  userGoal: string
  completionClaim: string
  state: SupervisorState
}): string {
  const emptyPacket: ContinuationPacket = {
    packet_type: "task_continuation",
    packet_id: "cont_TODO",
    session_id: "",
    user_goal: params.userGoal.slice(0, 500),
    current_phase: params.state.phase,
    completion_claim: params.completionClaim.slice(0, 300),
    completion_status: "UNVERIFIED_COMPLETE",
    blocking_unfinished: [],
    non_blocking_followup: [],
    requires_user_input: [],
    already_completed: [],
    files_involved: [],
    commands_run: [],
    verification_results: [],
    reviewer_blocks: [],
    next_execution_plan: [],
    stop_reason: null,
    redaction_status: "redacted",
  }

  return [
    `[dll-agent supervisor: task-completion-archivist]`,
    ``,
    `Act as the task-completion-archivist (Kimi K2.6). Inspect the completion claim:`,
    ``,
    `User goal: ${params.userGoal.slice(0, 800)}`,
    ``,
    `Completion claim:`,
    params.completionClaim.slice(0, 1500),
    ``,
    `Check:`,
    `1. Is the user goal truly complete?`,
    `2. Are there blocking unfinished items in the report?`,
    `3. Should the system continue executing, or can it truly stop?`,
    `4. Classify unfinished items: blocking_unfinished | non_blocking_followup | requires_user_input`,
    ``,
    `IMPORTANT: Output a CONTINUATION PACKET in the following JSON format:`,
    `\`\`\`json`,
    JSON.stringify(emptyPacket, null, 2),
    `\`\`\``,
    ``,
    `Set completion_status to:`,
    `- "PARTIAL_CONTINUED" if there are blocking items`,
    `- "BLOCKED_USER_REQUIRED" if user input is needed`,
    `- "VERIFIED_COMPLETE" only if truly complete`,
    ``,
    `Populate blocking_unfinished, non_blocking_followup, and requires_user_input arrays.`,
    `Populate next_execution_plan with concrete next steps.`,
    `Never mark as VERIFIED_COMPLETE if blocking items exist.`,
  ].join("\n")
}

// ─── Continuation Packet Consumption ─────────────────────────────────────────

/** Action item extracted from a continuation packet */
export interface ContinuationActionItem {
  role: ReviewerRole
  description: string
  action: string
  verification: string
  step: number
}

/**
 * Parse a Kimi subtask output and extract a ContinuationPacket.
 * Tries to find JSON block in the text output.
 */
export function parseKimiContinuationOutput(text: string): {
  packet: ContinuationPacket | null
  parsed: boolean
  error: string | null
} {
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text
    const parsed = JSON.parse(jsonStr)
    if (parsed.packet_type === "task_continuation") {
      return { packet: parsed as ContinuationPacket, parsed: true, error: null }
    }
    if (parsed.completion_status || parsed.blocking_unfinished) {
      // Convert from reviewer output format to packet
      const packet: ContinuationPacket = {
        packet_type: "task_continuation",
        packet_id: `cont_${Date.now()}`,
        session_id: "",
        user_goal: "",
        current_phase: "default",
        completion_claim: "",
        completion_status: parsed.completion_status ?? "UNVERIFIED_COMPLETE",
        blocking_unfinished: parsed.blocking_unfinished ?? [],
        non_blocking_followup: parsed.non_blocking_followup ?? [],
        requires_user_input: parsed.requires_user_input ?? [],
        already_completed: parsed.already_completed ?? [],
        files_involved: [],
        commands_run: [],
        verification_results: [],
        reviewer_blocks: [],
        next_execution_plan: parsed.next_execution_plan ?? [],
        stop_reason: null,
        redaction_status: "redacted",
      }
      return { packet, parsed: true, error: null }
    }
    return { packet: null, parsed: false, error: "No continuation packet or completion_status found in JSON" }
  } catch (err) {
    return { packet: null, parsed: false, error: `JSON parse error: ${String(err).slice(0, 120)}` }
  }
}

/**
 * Consume a continuation packet and generate action items for the supervisor.
 * Converts next_execution_plan entries into dispatcher-ready action items.
 */
export function consumeContinuationPacket(packet: ContinuationPacket): {
  shouldContinue: boolean
  actionItems: ContinuationActionItem[]
  summary: string
} {
  const actionItems: ContinuationActionItem[] = []

  if (packet.blocking_unfinished.length > 0) {
    for (let i = 0; i < packet.blocking_unfinished.length; i++) {
      const item = packet.blocking_unfinished[i]
      // Use next_execution_plan if available, otherwise create from item
      const planEntry = packet.next_execution_plan[i]
      actionItems.push({
        role: planEntry?.role ?? item.recommended_role ?? "chief-engineer",
        description: item.description.slice(0, 150),
        action: planEntry?.action ?? item.required_action ?? `Address: ${item.description}`,
        verification: planEntry?.verification ?? item.verification_required?.join(", ") ?? "run typecheck + tests + doctor",
        step: planEntry?.step ?? (i + 1),
      })
    }
  }

  if (packet.next_execution_plan.length > packet.blocking_unfinished.length) {
    for (let i = packet.blocking_unfinished.length; i < packet.next_execution_plan.length; i++) {
      const planEntry = packet.next_execution_plan[i]
      actionItems.push({
        role: planEntry.role,
        description: planEntry.action.slice(0, 150),
        action: planEntry.action,
        verification: planEntry.verification,
        step: planEntry.step,
      })
    }
  }

  const shouldContinue = packet.completion_status === "PARTIAL_CONTINUED" && actionItems.length > 0

  let summary = ""
  if (shouldContinue) {
    summary = `Continuation required: ${actionItems.length} action items to execute. ${packet.blocking_unfinished.length} blocking items.`
  } else if (packet.completion_status === "BLOCKED_USER_REQUIRED") {
    summary = `Blocked: user input required. ${packet.requires_user_input.length} items need user attention.`
  } else {
    summary = `No blocking items. Non-blocking followups: ${packet.non_blocking_followup.length}.`
  }

  writeEvidence("continuation_gate.consumed", {
    shouldContinue,
    actionItemCount: actionItems.length,
    blockingCount: packet.blocking_unfinished.length,
    completionStatus: packet.completion_status,
  })

  return { shouldContinue, actionItems, summary }
}
