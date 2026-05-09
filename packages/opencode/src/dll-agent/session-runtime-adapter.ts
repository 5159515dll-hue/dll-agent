/**
 * Session Runtime Adapter
 *
 * Converts dll-agent gate/recovery decisions into structured actions consumable
 * by the OpenCode session loop. This module does not call models, provider
 * transport, MCP, LSP, TUI, or session storage.
 */

import type { RecoveryDecision } from "./recovery-loop"
import { buildBlockedRecoveryReport, buildRecoveryHint, planRecoveryFromContinuationPacket } from "./recovery-loop"
import {
  type ContinuationGateResult,
  type ContinuationPacket,
  type SupervisorState,
} from "./interfaces"
import { isContinuationBudgetExhausted } from "./continuation-gate"

export type SessionRuntimeAction =
  | {
      type: "save_supervisor_state"
      state: SupervisorState
    }
  | {
      type: "write_evidence"
      event: string
      payload: unknown
    }
  | {
      type: "write_recovery_decision"
      decision: RecoveryDecision
    }
  | {
      type: "inject_synthetic_hint"
      hint: string
    }
  | {
      type: "queue_task_completion_check"
      userGoal: string
      assistantText: string
      state: SupervisorState
    }
  | {
      type: "continuation_budget_exhausted"
      userGoal: string
      reason: string
      packet: ContinuationPacket | null
    }

export function buildContinuationRuntimeActions(input: {
  sessionID: string
  state: SupervisorState
  continuationResult: ContinuationGateResult
  userGoal: string
  assistantText: string
  path?: "first-break" | "second-break"
}): SessionRuntimeAction[] {
  if (input.continuationResult.passed) return []

  const budgetCheck = isContinuationBudgetExhausted({
    continuationCount: input.state.continuation_count ?? 0,
    repairCounts: input.state.repair_counts ?? {},
    blockingItems: input.continuationResult.blocking_items,
  })

  if (budgetCheck.exhausted) {
    return [{
      type: "continuation_budget_exhausted",
      userGoal: input.userGoal,
      reason: budgetCheck.reason ?? "continuation budget exhausted",
      packet: input.continuationResult.continuation_packet,
    }]
  }

  const nextState: SupervisorState = {
    ...input.state,
    continuation_count: (input.state.continuation_count ?? 0) + 1,
    repair_counts: { ...(input.state.repair_counts ?? {}) },
    last_continuation_packet_id: input.continuationResult.continuation_packet?.packet_id,
    updated_at: new Date().toISOString(),
  }
  for (const item of input.continuationResult.blocking_items) {
    nextState.repair_counts![item.id] = (nextState.repair_counts![item.id] ?? 0) + 1
  }

  const recovery = input.continuationResult.continuation_packet
    ? planRecoveryFromContinuationPacket({
        packet: input.continuationResult.continuation_packet,
        repairCounts: nextState.repair_counts,
        phaseAttempts: nextState.recovery_phase_counts?.[nextState.phase] ?? 0,
        taskAttempts: nextState.recovery_total_count ?? 0,
      })
    : null

  const actions: SessionRuntimeAction[] = [
    { type: "save_supervisor_state", state: nextState },
    {
      type: "write_evidence",
      event: "continuation_gate.attempt_recorded",
      payload: {
        packet_id: input.continuationResult.continuation_packet?.packet_id ?? null,
        continuation_count: nextState.continuation_count,
        repair_counts: nextState.repair_counts,
        ...(input.path ? { path: input.path } : {}),
      },
    },
  ]

  if (recovery) {
    actions.push({ type: "write_recovery_decision", decision: recovery })
    actions.push({
      type: "inject_synthetic_hint",
      hint: recovery.userActionRequired
        ? buildBlockedRecoveryReport(recovery)
        : buildRecoveryHint(recovery),
    })
  }

  if (input.continuationResult.synthetic_hint) {
    actions.push({
      type: "inject_synthetic_hint",
      hint: input.continuationResult.synthetic_hint,
    })
  }

  if (!recovery?.userActionRequired) {
    actions.push({
      type: "queue_task_completion_check",
      userGoal: input.userGoal,
      assistantText: input.assistantText,
      state: input.state,
    })
  }

  return actions
}

export * as SessionRuntimeAdapter from "./session-runtime-adapter"
