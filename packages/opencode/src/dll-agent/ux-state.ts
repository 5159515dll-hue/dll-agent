/**
 * dll-agent ux-state.ts
 *
 * Unified UX state model aggregating all system state for user display.
 * Provides compact/normal/debug output modes.
 *
 * Purposes:
 * 1. Task state (goal, phase, blockers, verification)
 * 2. Supervisor state (reviewers, gates, recovery)
 * 3. Permission state (risk, auto-allow, denied)
 * 4. Tools/Skills/MCP state (registered, active, unavailable)
 * 5. Cost/Quota state
 * 6. Evidence state
 */

import type { RiskLevel, ReviewerRole } from "./interfaces"

// ─── UX State Types ─────────────────────────────────────────────────────────

export type UxDisplayMode = "compact" | "normal" | "verbose" | "debug"

export interface UxTaskState {
  goal: string
  phase: string
  plan: string | null
  blocker: string | null
  risk: RiskLevel
  modifiedFiles: string[]
  verificationStatus: "not_run" | "running" | "passed" | "failed" | "partial"
  nextAction: string | null
  requiresUserInput: boolean
  userInputReason: string | null
}

export interface UxSupervisorState {
  active: boolean
  recoveryActive: boolean
  recoveryAttempts: number
  maxRecoveryAttempts: number
  reviewers: {
    required: ReviewerRole[]
    completed: ReviewerRole[]
    queued: string[]
    running: string[]
  }
  gateBlocked: boolean
  gateBlockReason: string | null
  gateRetriesExhausted: boolean
  crossReviewActive: boolean
}

export interface UxPermissionState {
  mode: "default" | "auto-review" | "full-access" | "risk-based-auto" | "strict" | "manual"
  lowRiskAutoAllow: boolean
  mediumRiskConfirmOnce: boolean
  highRiskAlwaysConfirm: boolean
  lastDenied: string | null
  secretsBlocked: boolean
}

export interface UxToolsState {
  tools: { registered: number; active: number; unavailable: number }
  skills: { registered: number; active: string[]; available: number }
  mcp: { registered: number; running: string[]; onDemand: string[]; unavailable: string[] }
}

export interface UxCostState {
  sessionTotalUsd: number
  capUsd: number
  exceeded: boolean
  lastWarning: string | null
}

export interface UxEvidenceState {
  evidenceCount: number
  lastEvidencePath: string | null
  verificationClaims: number
  verifiedClaims: number
  unverifiedClaims: number
}

export interface UxState {
  task: UxTaskState
  supervisor: UxSupervisorState
  permissions: UxPermissionState
  tools: UxToolsState
  cost: UxCostState
  evidence: UxEvidenceState
  timestamp: string
}

// ─── Default State ──────────────────────────────────────────────────────────

export function defaultUxState(): UxState {
  return {
    task: {
      goal: "",
      phase: "init",
      plan: null,
      blocker: null,
      risk: "low",
      modifiedFiles: [],
      verificationStatus: "not_run",
      nextAction: null,
      requiresUserInput: false,
      userInputReason: null,
    },
    supervisor: {
      active: false,
      recoveryActive: false,
      recoveryAttempts: 0,
      maxRecoveryAttempts: 5,
      reviewers: { required: [], completed: [], queued: [], running: [] },
      gateBlocked: false,
      gateBlockReason: null,
      gateRetriesExhausted: false,
      crossReviewActive: false,
    },
    permissions: {
      mode: "full-access",
      lowRiskAutoAllow: true,
      mediumRiskConfirmOnce: true,
      highRiskAlwaysConfirm: true,
      lastDenied: null,
      secretsBlocked: false,
    },
    tools: {
      tools: { registered: 0, active: 0, unavailable: 0 },
      skills: { registered: 0, active: [], available: 0 },
      mcp: { registered: 0, running: [], onDemand: [], unavailable: [] },
    },
    cost: {
      sessionTotalUsd: 0,
      capUsd: 5.0,
      exceeded: false,
      lastWarning: null,
    },
    evidence: {
      evidenceCount: 0,
      lastEvidencePath: null,
      verificationClaims: 0,
      verifiedClaims: 0,
      unverifiedClaims: 0,
    },
    timestamp: new Date().toISOString(),
  }
}

// ─── Summary Builders ───────────────────────────────────────────────────────

function bullet(items: string[], prefix = "  - "): string {
  if (items.length === 0) return `${prefix}(none)`
  return items.map((i) => `${prefix}${i}`).join("\n")
}

export function buildCompactSummary(state: UxState): string {
  const t = state.task
  const s = state.supervisor
  const p = state.permissions
  const c = state.cost

  return [
    `Phase: ${t.phase} | Risk: ${t.risk} | Goal: ${t.goal.slice(0, 60) || "(none)"}`,
    `Reviews: ${s.reviewers.completed.length}/${s.reviewers.required.length + s.reviewers.completed.length} done`,
    `Verification: ${t.verificationStatus}${t.blocker ? ` (blocked: ${t.blocker.slice(0, 40)})` : ""}`,
    `Cost: $${c.sessionTotalUsd.toFixed(3)} / $${c.capUsd.toFixed(2)}`,
  ].join(" | ")
}

export function buildNormalSummary(state: UxState): string {
  const t = state.task
  const s = state.supervisor
  const p = state.permissions
  const tools = state.tools
  const c = state.cost

  return [
    `=== dll-agent Status ===`,
    ``,
    `Task:`,
    `  Goal: ${t.goal || "(not set)"}`,
    `  Phase: ${t.phase} | Risk: ${t.risk}`,
    `  Plan: ${t.plan || "(none)"}`,
    `  Blocker: ${t.blocker || "(none)"}`,
    `  Verification: ${t.verificationStatus}`,
    `  Modified files: ${t.modifiedFiles.length}`,
    `  Next action: ${t.nextAction || "(none)"}`,
    `  Needs user: ${t.requiresUserInput ? `YES — ${t.userInputReason}` : "no"}`,
    ``,
    `Supervisor:`,
    `  Active: ${s.active} | Recovery: ${s.recoveryActive} (${s.recoveryAttempts}/${s.maxRecoveryAttempts})`,
    `  Reviewers: required=[${s.reviewers.required.join(",")}] completed=[${s.reviewers.completed.join(",")}]`,
    `  Queued: [${s.reviewers.queued.join(",")}] Running: [${s.reviewers.running.join(",")}]`,
    `  Gate: ${s.gateBlocked ? `BLOCKED — ${s.gateBlockReason}` : "open"}`,
    `  Cross-review: ${s.crossReviewActive ? "active" : "idle"}`,
    ``,
    `Permissions:`,
    `  Mode: ${p.mode}`,
    `  Low → ${p.lowRiskAutoAllow ? "auto-allow" : "ask"} | Medium → ${p.mediumRiskConfirmOnce ? "confirm-once" : "ask"} | High → ask`,
    `  Last denied: ${p.lastDenied || "(none)"}`,
    ``,
    `Tools:`,
    `  Registered: ${tools.tools.registered} tools, ${tools.skills.registered} skills, ${tools.mcp.registered} MCP`,
    `  Active skills: [${tools.skills.active.join(",")}]`,
    `  MCP running: [${tools.mcp.running.join(",")}] on-demand: [${tools.mcp.onDemand.join(",")}]`,
    ``,
    `Cost: $${c.sessionTotalUsd.toFixed(4)} / $${c.capUsd.toFixed(2)}${c.exceeded ? " EXCEEDED" : ""}`,
    `Evidence: ${state.evidence.evidenceCount} records | ${state.evidence.verifiedClaims}/${state.evidence.verificationClaims} verified claims`,
  ].join("\n")
}

export function buildDebugSummary(state: UxState): string {
  return [
    buildNormalSummary(state),
    ``,
    `=== Debug ===`,
    `Timestamp: ${state.timestamp}`,
    `Raw state: ${JSON.stringify(state, null, 2)}`,
  ].join("\n")
}

export function buildSummary(state: UxState, mode: UxDisplayMode = "normal"): string {
  switch (mode) {
    case "compact": return buildCompactSummary(state)
    case "normal": return buildNormalSummary(state)
    case "verbose": return buildNormalSummary(state) // verbose = normal for now
    case "debug": return buildDebugSummary(state)
  }
}

// ─── State Mutations ────────────────────────────────────────────────────────

export function setGoal(state: UxState, goal: string): UxState {
  return { ...state, task: { ...state.task, goal } }
}

export function setPhase(state: UxState, phase: string, plan?: string): UxState {
  return { ...state, task: { ...state.task, phase, plan: plan ?? state.task.plan } }
}

export function setBlocker(state: UxState, blocker: string | null): UxState {
  return { ...state, task: { ...state.task, blocker } }
}

export function addModifiedFile(state: UxState, file: string): UxState {
  if (state.task.modifiedFiles.includes(file)) return state
  return { ...state, task: { ...state.task, modifiedFiles: [...state.task.modifiedFiles, file] } }
}

export function setVerificationStatus(
  state: UxState,
  status: UxTaskState["verificationStatus"],
): UxState {
  return { ...state, task: { ...state.task, verificationStatus: status } }
}

export function markRecoveryAttempt(state: UxState): UxState {
  return {
    ...state,
    supervisor: {
      ...state.supervisor,
      recoveryActive: true,
      recoveryAttempts: state.supervisor.recoveryAttempts + 1,
    },
  }
}

export function markGateBlocked(state: UxState, reason: string): UxState {
  return {
    ...state,
    supervisor: { ...state.supervisor, gateBlocked: true, gateBlockReason: reason },
  }
}

export function markGateOpen(state: UxState): UxState {
  return {
    ...state,
    supervisor: { ...state.supervisor, gateBlocked: false, gateBlockReason: null },
  }
}
