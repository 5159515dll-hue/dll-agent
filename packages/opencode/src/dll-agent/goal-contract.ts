/**
 * Runtime Goal Contract for dll-agent.
 *
 * The contract is intentionally small and local. It records the user's goal,
 * success criteria, required verification, and active plan state so gates and
 * UX can check completion against structured state instead of final prose.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { write as writeEvidence, redact } from "./evidence"

export type GoalFinalStatus =
  | "VERIFIED_COMPLETE"
  | "CONTINUATION_REQUIRED"
  | "BLOCKED_USER_REQUIRED"
  | "BLOCKED_BUDGET_EXHAUSTED"
  | "UNVERIFIED_PARTIAL"
  | "FAILED"

export type GoalPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked" | "non_blocking"
export type GoalCriterionStatus = "pending" | "satisfied" | "blocked" | "non_blocking"

export interface GoalPlanItem {
  id: string
  description: string
  status: GoalPlanItemStatus
  evidence_refs: string[]
  blocker?: string
}

export interface GoalSuccessCriterion {
  id: string
  description: string
  status: GoalCriterionStatus
  evidence_refs: string[]
  blocker?: string
}

export interface GoalContract {
  version: 1
  task_id: string
  session_id: string
  user_goal: string
  success_criteria: string[]
  success_criteria_status: GoalSuccessCriterion[]
  non_goals: string[]
  constraints: string[]
  required_verification: string[]
  active_plan: GoalPlanItem[]
  evidence_refs: string[]
  created_at: string
  updated_at: string
  redaction_status: "redacted"
}

export interface GoalCompletionAssessment {
  final_status: GoalFinalStatus
  can_claim_complete: boolean
  reasons: string[]
  blocking_items: string[]
  required_next_actions: string[]
}

function configRoot() {
  return process.env.DLL_AGENT_CONFIG_ROOT || path.join(os.homedir(), ".dll-agent")
}

export function goalContractPath(sessionID: string) {
  return path.join(configRoot(), "sessions", sessionID, "goal-contract.json")
}

function normalizeText(text: string, max = 1000) {
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}

function makeTaskID(sessionID: string, userGoal: string) {
  let hash = 0
  for (let i = 0; i < userGoal.length; i++) {
    hash = ((hash << 5) - hash) + userGoal.charCodeAt(i)
    hash |= 0
  }
  return `goal_${sessionID.slice(0, 12)}_${Math.abs(hash).toString(36)}`
}

function defaultSuccessCriteria(userGoal: string) {
  const goal = normalizeText(userGoal, 160)
  return [
    goal ? `User goal is satisfied: ${goal}` : "User goal is satisfied",
    "Blocking active plan items are completed or explicitly classified as blocked/user-required",
    "Required verification is run or the final status explicitly remains unverified/partial",
  ]
}

export function buildGoalContract(input: {
  sessionID: string
  userGoal: string
  successCriteria?: string[]
  successCriteriaStatus?: GoalSuccessCriterion[]
  nonGoals?: string[]
  constraints?: string[]
  requiredVerification?: string[]
  activePlan?: GoalPlanItem[]
  evidenceRefs?: string[]
  now?: string
}): GoalContract {
  const goal = normalizeText(input.userGoal)
  const now = input.now ?? new Date().toISOString()
  const successCriteria = (input.successCriteria?.length ? input.successCriteria : defaultSuccessCriteria(goal))
    .map((item) => normalizeText(item, 240))
    .filter(Boolean)
  return {
    version: 1,
    task_id: makeTaskID(input.sessionID, goal),
    session_id: input.sessionID,
    user_goal: goal,
    success_criteria: successCriteria,
    success_criteria_status: (input.successCriteriaStatus ?? []).map((item, index) => ({
      ...item,
      id: item.id || `criterion_${index + 1}`,
      description: normalizeText(item.description, 240),
      evidence_refs: item.evidence_refs ?? [],
      blocker: item.blocker ? normalizeText(item.blocker, 240) : undefined,
    })),
    non_goals: (input.nonGoals ?? []).map((item) => normalizeText(item, 240)).filter(Boolean),
    constraints: (input.constraints ?? []).map((item) => normalizeText(item, 240)).filter(Boolean),
    required_verification: (input.requiredVerification?.length
      ? input.requiredVerification
      : ["run relevant typecheck/test/doctor/diff checks or mark verification as not_run"])
      .map((item) => normalizeText(item, 240))
      .filter(Boolean),
    active_plan: input.activePlan ?? [],
    evidence_refs: input.evidenceRefs ?? [],
    created_at: now,
    updated_at: now,
    redaction_status: "redacted",
  }
}

export function loadGoalContract(sessionID: string): GoalContract | null {
  try {
    const file = goalContractPath(sessionID)
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    if (parsed?.version !== 1 || parsed?.session_id !== sessionID || typeof parsed?.user_goal !== "string") return null
    return {
      ...parsed,
      success_criteria_status: Array.isArray(parsed.success_criteria_status) ? parsed.success_criteria_status : [],
      non_goals: Array.isArray(parsed.non_goals) ? parsed.non_goals : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      required_verification: Array.isArray(parsed.required_verification) ? parsed.required_verification : [],
      active_plan: Array.isArray(parsed.active_plan) ? parsed.active_plan : [],
      evidence_refs: Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [],
    } as GoalContract
  } catch {
    return null
  }
}

export function saveGoalContract(contract: GoalContract) {
  const file = goalContractPath(contract.session_id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(redact({ ...contract, redaction_status: "redacted" }), null, 2))
  fs.renameSync(tmp, file)
  writeEvidence("goal_contract.updated", {
    task_id: contract.task_id,
    success_criteria: contract.success_criteria.length,
    active_plan: contract.active_plan.length,
  }, contract.session_id)
}

export function ensureGoalContract(input: {
  sessionID: string
  userGoal: string
  successCriteria?: string[]
  constraints?: string[]
  requiredVerification?: string[]
  evidenceRefs?: string[]
}) {
  const goal = normalizeText(input.userGoal)
  if (!goal) return null
  const existing = loadGoalContract(input.sessionID)
  if (existing) return existing
  const contract = buildGoalContract({ ...input, userGoal: goal })
  saveGoalContract(contract)
  writeEvidence("goal_contract.created", {
    task_id: contract.task_id,
    user_goal: contract.user_goal,
    success_criteria: contract.success_criteria,
  }, input.sessionID)
  return contract
}

export function refineGoalContract(sessionID: string, input: {
  successCriteria?: string[]
  successCriteriaStatus?: GoalSuccessCriterion[]
  nonGoals?: string[]
  constraints?: string[]
  requiredVerification?: string[]
  evidenceRefs?: string[]
}) {
  const existing = loadGoalContract(sessionID)
  if (!existing) return null
  const merge = (current: string[], added?: string[]) => [
    ...new Set([...current, ...(added ?? []).map((item) => normalizeText(item, 240)).filter(Boolean)]),
  ]
  const statusByID = new Map(existing.success_criteria_status.map((item) => [item.id, item]))
  for (const item of input.successCriteriaStatus ?? []) {
    const id = item.id || `criterion_${statusByID.size + 1}`
    statusByID.set(id, {
      ...item,
      id,
      description: normalizeText(item.description, 240),
      evidence_refs: item.evidence_refs ?? [],
      blocker: item.blocker ? normalizeText(item.blocker, 240) : undefined,
    })
  }
  const next = {
    ...existing,
    success_criteria: merge(existing.success_criteria, input.successCriteria),
    success_criteria_status: [...statusByID.values()],
    non_goals: merge(existing.non_goals, input.nonGoals),
    constraints: merge(existing.constraints, input.constraints),
    required_verification: merge(existing.required_verification, input.requiredVerification),
    evidence_refs: merge(existing.evidence_refs, input.evidenceRefs),
    updated_at: new Date().toISOString(),
  }
  saveGoalContract(next)
  writeEvidence("goal_contract.refined", {
    task_id: next.task_id,
    user_goal: next.user_goal,
    success_criteria: input.successCriteria ?? [],
    non_goals: input.nonGoals ?? [],
    constraints: input.constraints ?? [],
    required_verification: input.requiredVerification ?? [],
  }, sessionID)
  return next
}

export function updateGoalPlan(sessionID: string, activePlan: GoalPlanItem[]) {
  const existing = loadGoalContract(sessionID)
  if (!existing) return null
  const next = {
    ...existing,
    active_plan: activePlan.map((item, index) => ({
      ...item,
      id: item.id || `plan_${index + 1}`,
      description: normalizeText(item.description, 240),
      evidence_refs: item.evidence_refs ?? [],
    })),
    updated_at: new Date().toISOString(),
  }
  saveGoalContract(next)
  return next
}

export function assessGoalCompletion(input: {
  contract: GoalContract
  verificationResults?: { name: string; status: "passed" | "failed" | "not_run"; evidenceRef?: string }[]
  resultStatuses?: string[]
  blockers?: string[]
  doctorFailed?: boolean
  budgetExhausted?: boolean
  requiresUserInput?: string[]
}): GoalCompletionAssessment {
  const reasons: string[] = []
  const blockingItems: string[] = []
  const requiredNextActions: string[] = []

  const failedVerification = (input.verificationResults ?? []).filter((item) => item.status === "failed")
  const notRunVerification = (input.verificationResults ?? []).filter((item) => item.status === "not_run")
  const blockedPlan = input.contract.active_plan.filter((item) => item.status === "blocked")
  const unfinishedPlan = input.contract.active_plan.filter((item) => item.status === "pending" || item.status === "in_progress")
  const blockingCriteria = input.contract.success_criteria_status.filter((item) => item.status === "blocked")
  const unfinishedCriteria = input.contract.success_criteria_status.filter((item) => item.status === "pending")
  const resultStatuses = input.resultStatuses ?? []

  if (input.doctorFailed) {
    reasons.push("doctor failed")
    requiredNextActions.push("fix doctor failed checks before final PASS")
    return { final_status: "FAILED", can_claim_complete: false, reasons, blocking_items: blockingItems, required_next_actions: requiredNextActions }
  }
  if (failedVerification.length > 0 || resultStatuses.includes("FAILED")) {
    reasons.push("verification or result ledger failure exists")
    blockingItems.push(...failedVerification.map((item) => item.name))
    requiredNextActions.push("repair failures and rerun verification")
    return { final_status: "FAILED", can_claim_complete: false, reasons, blocking_items: blockingItems, required_next_actions: requiredNextActions }
  }
  if (input.budgetExhausted) {
    reasons.push("recovery or model budget exhausted")
    requiredNextActions.push("produce blocked report with evidence and request user decision")
    return { final_status: "BLOCKED_BUDGET_EXHAUSTED", can_claim_complete: false, reasons, blocking_items: blockingItems, required_next_actions: requiredNextActions }
  }
  if ((input.requiresUserInput ?? []).length > 0) {
    reasons.push("user input required")
    blockingItems.push(...(input.requiresUserInput ?? []))
    requiredNextActions.push("ask the user for the missing decision/input")
    return { final_status: "BLOCKED_USER_REQUIRED", can_claim_complete: false, reasons, blocking_items: blockingItems, required_next_actions: requiredNextActions }
  }

  blockingItems.push(
    ...(input.blockers ?? []),
    ...blockedPlan.map((item) => item.blocker ?? item.description),
    ...blockingCriteria.map((item) => item.blocker ?? item.description),
  )
  if (blockingItems.length > 0 || unfinishedPlan.length > 0 || unfinishedCriteria.length > 0) {
    reasons.push("blocking or unfinished goal contract items remain")
    blockingItems.push(...unfinishedPlan.map((item) => item.description))
    blockingItems.push(...unfinishedCriteria.map((item) => item.description))
    requiredNextActions.push("continue execution until blocking plan items are completed or classified")
    return { final_status: "CONTINUATION_REQUIRED", can_claim_complete: false, reasons, blocking_items: [...new Set(blockingItems)], required_next_actions: requiredNextActions }
  }

  if (notRunVerification.length > 0 || (input.verificationResults?.length ?? 0) === 0) {
    reasons.push("required verification has not been run")
    requiredNextActions.push("run required verification or mark the final status as unverified/partial")
    return { final_status: "UNVERIFIED_PARTIAL", can_claim_complete: false, reasons, blocking_items: [], required_next_actions: requiredNextActions }
  }

  reasons.push("goal contract criteria satisfied with verification evidence")
  return { final_status: "VERIFIED_COMPLETE", can_claim_complete: true, reasons, blocking_items: [], required_next_actions: [] }
}

export function doctorCheckGoalContracts(sessionLimit = 20): { ok: boolean; issues: string[]; checked: number } {
  const sessionsDir = path.join(configRoot(), "sessions")
  const issues: string[] = []
  let checked = 0
  try {
    if (!fs.existsSync(sessionsDir)) return { ok: true, issues, checked }
    for (const sessionID of fs.readdirSync(sessionsDir).slice(-sessionLimit)) {
      const file = path.join(sessionsDir, sessionID, "goal-contract.json")
      if (!fs.existsSync(file)) continue
      checked++
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GoalContract
      if (parsed.version !== 1) issues.push(`${sessionID}: unsupported goal contract version`)
      if (!parsed.user_goal) issues.push(`${sessionID}: missing user_goal`)
      if (!Array.isArray(parsed.success_criteria) || parsed.success_criteria.length === 0) {
        issues.push(`${sessionID}: missing success_criteria`)
      }
      if (!Array.isArray(parsed.required_verification) || parsed.required_verification.length === 0) {
        issues.push(`${sessionID}: missing required_verification`)
      }
    }
  } catch (error) {
    issues.push(`goal contract doctor failed: ${String(error)}`)
  }
  return { ok: issues.length === 0, issues, checked }
}
