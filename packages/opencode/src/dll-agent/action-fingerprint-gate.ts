import type { ReviewerRole } from "./interfaces"

export type GuardAction = "allow" | "ask" | "deny" | "skip"

export interface ActionFingerprintInput {
  role: ReviewerRole | "commander" | "executor"
  model: string
  contextPacketID?: string | null
  intendedAction: string
  files?: string[]
  failureFingerprint?: string | null
}

export interface FingerprintRecord {
  fingerprint: string
  role: string
  model: string
  ts: string
  context_packet_id?: string | null
}

export interface GuardDecision {
  guard: string
  action: GuardAction
  effective_action: GuardAction
  required_for_correctness: boolean
  reason: string
  audit_risk: string | null
}

function stablePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}./_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180)
}

function hash(text: string) {
  let result = 0
  for (let i = 0; i < text.length; i++) {
    result = ((result << 5) - result) + text.charCodeAt(i)
    result |= 0
  }
  return Math.abs(result).toString(16)
}

export function buildActionFingerprint(input: ActionFingerprintInput) {
  const files = [...new Set(input.files ?? [])].sort().map(stablePart).join(",")
  const seed = [
    input.role,
    input.model,
    input.contextPacketID ?? "no-context-packet",
    stablePart(input.intendedAction),
    files,
    input.failureFingerprint ?? "no-failure-fingerprint",
  ].join("|")
  return `act_${hash(seed)}`
}

export function checkActionFingerprintDuplicate(input: {
  records: FingerprintRecord[]
  fingerprint: string
  now?: Date
  cooldownMs?: number
}): { duplicate: boolean; existing?: FingerprintRecord; reason: string | null } {
  const now = input.now ?? new Date()
  const cooldownMs = input.cooldownMs ?? 30 * 60 * 1000
  const existing = [...input.records]
    .filter((record) => record.fingerprint === input.fingerprint)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]
  if (!existing) return { duplicate: false, reason: null }
  const age = now.getTime() - new Date(existing.ts).getTime()
  if (!Number.isFinite(age) || age > cooldownMs) return { duplicate: false, existing, reason: "fingerprint_seen_but_cooldown_expired" }
  return { duplicate: true, existing, reason: "same_action_fingerprint_in_cooldown" }
}

export function buildGuardDecision(input: {
  guard: string
  action: GuardAction
  requiredForCorrectness: boolean
  reason: string
  safetyCritical?: boolean
}): GuardDecision {
  if (input.requiredForCorrectness && input.action === "skip" && !input.safetyCritical) {
    return {
      guard: input.guard,
      action: input.action,
      effective_action: "ask",
      required_for_correctness: true,
      reason: input.reason,
      audit_risk: "correctness_required_action_was_about_to_be_skipped",
    }
  }
  return {
    guard: input.guard,
    action: input.action,
    effective_action: input.action,
    required_for_correctness: input.requiredForCorrectness,
    reason: input.reason,
    audit_risk: null,
  }
}

export * as ActionFingerprintGate from "./action-fingerprint-gate"
