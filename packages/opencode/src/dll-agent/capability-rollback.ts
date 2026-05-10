import fs from "fs"
import path from "path"
import { capabilityAcquisitionPaths, parseCapabilityJson, writeCapabilityEvidence } from "./capability-acquisition"

export interface CapabilityRollbackPlan {
  plan_id: string
  candidate_id: string
  managed_paths: string[]
  dry_run_required: true
  safe: boolean
  created_at: string
}

export interface CapabilityRollbackValidation {
  valid: boolean
  errors: string[]
}

export interface CapabilityRollbackDryRun {
  plan_id: string
  candidate_id: string
  would_delete: string[]
  skipped: string[]
  dry_run: true
}

function now() {
  return new Date().toISOString()
}

function safeID(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)
}

function rollbackPath(root: string, candidateID: string) {
  return path.join(capabilityAcquisitionPaths(root).sandbox, safeID(candidateID), "rollback-plan.json")
}

function isInside(base: string, target: string) {
  const relative = path.relative(base, target)
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function allowedManagedPath(root: string, target: string) {
  const paths = capabilityAcquisitionPaths(root)
  return isInside(paths.quarantine, target) || isInside(paths.sandbox, target)
}

function sensitivePath(target: string) {
  return /(^|\/)(\.ssh|\.env|secrets?|credentials?|cookies?|keychain)(\/|$)/i.test(target)
}

export function buildRollbackPlan(input: {
  root: string
  candidateID: string
  managedPaths?: string[]
  sessionID?: string
}): CapabilityRollbackPlan {
  const paths = capabilityAcquisitionPaths(input.root)
  const candidateID = safeID(input.candidateID)
  const managedPaths = input.managedPaths ?? [
    path.join(paths.sandbox, candidateID),
    path.join(paths.quarantine, candidateID),
  ]
  const plan: CapabilityRollbackPlan = {
    plan_id: `rollback-${candidateID}`,
    candidate_id: candidateID,
    managed_paths: managedPaths,
    dry_run_required: true,
    safe: true,
    created_at: now(),
  }
  const validation = validateRollbackPlan(input.root, plan)
  if (!validation.valid) throw new Error(`invalid rollback plan: ${validation.errors.join("; ")}`)
  fs.mkdirSync(path.dirname(rollbackPath(input.root, candidateID)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(rollbackPath(input.root, candidateID), JSON.stringify(plan, null, 2), { mode: 0o600 })
  writeCapabilityEvidence(
    "capability.rollback_planned",
    { candidate_id: candidateID, managed_paths: managedPaths, dry_run_required: true },
    input.sessionID,
  )
  return plan
}

export function validateRollbackPlan(root: string, plan: CapabilityRollbackPlan): CapabilityRollbackValidation {
  const errors: string[] = []
  if (!plan.managed_paths.length) errors.push("rollback plan requires managed paths")
  if (!plan.safe) errors.push("rollback plan must be marked safe")
  for (const item of plan.managed_paths) {
    const target = path.resolve(item)
    if (!allowedManagedPath(root, target)) errors.push(`unmanaged rollback path: ${target}`)
    if (sensitivePath(target)) errors.push(`rollback path may contain secrets: ${target}`)
    if (/\/sessions?(\/|$)/i.test(target)) errors.push(`rollback must not delete sessions: ${target}`)
  }
  return { valid: errors.length === 0, errors }
}

export function rollbackDryRun(input: {
  root: string
  plan: CapabilityRollbackPlan
  sessionID?: string
}): CapabilityRollbackDryRun {
  const validation = validateRollbackPlan(input.root, input.plan)
  if (!validation.valid) throw new Error(`invalid rollback plan: ${validation.errors.join("; ")}`)
  const result: CapabilityRollbackDryRun = {
    plan_id: input.plan.plan_id,
    candidate_id: input.plan.candidate_id,
    would_delete: input.plan.managed_paths.filter((item) => fs.existsSync(item)),
    skipped: input.plan.managed_paths.filter((item) => !fs.existsSync(item)),
    dry_run: true,
  }
  writeCapabilityEvidence("capability.rollback_dry_run", result, input.sessionID)
  return result
}

export function executeRollbackForFixture(input: {
  root: string
  plan: CapabilityRollbackPlan
  dryRun: CapabilityRollbackDryRun
  sessionID?: string
}) {
  const validation = validateRollbackPlan(input.root, input.plan)
  if (!validation.valid) throw new Error(`invalid rollback plan: ${validation.errors.join("; ")}`)
  if (input.dryRun.plan_id !== input.plan.plan_id || !input.dryRun.dry_run) {
    throw new Error("rollback execution requires matching dry-run result")
  }
  const deleted: string[] = []
  const failed: string[] = []
  for (const target of input.dryRun.would_delete) {
    try {
      if (!allowedManagedPath(input.root, path.resolve(target))) throw new Error("unmanaged target")
      fs.rmSync(target, { recursive: true, force: true })
      deleted.push(target)
    } catch {
      failed.push(target)
    }
  }
  const event = failed.length ? "capability.rollback_failed" : "capability.rollback_executed"
  writeCapabilityEvidence(event, { candidate_id: input.plan.candidate_id, deleted, failed }, input.sessionID)
  return { deleted, failed, status: failed.length ? "failed" : "rolled_back" as const }
}

export function markRolledBack(input: { root: string; candidateID: string; sessionID?: string }) {
  const file = rollbackPath(input.root, input.candidateID)
  if (!fs.existsSync(file)) throw new Error("rollback plan not found")
  const plan = parseCapabilityJson(fs.readFileSync(file, "utf8")) as CapabilityRollbackPlan
  writeCapabilityEvidence("capability.rollback", { candidate_id: plan.candidate_id, plan_id: plan.plan_id }, input.sessionID)
  return plan
}

export * as CapabilityRollback from "./capability-rollback"
