import fs from "fs"
import os from "os"
import path from "path"
import { Locale } from "@/util/locale"
import { quality as dllQuality, verify as dllVerify } from "./profile"
import { type DllRole } from "./role-model-registry"
import { readRoleProviderSnapshot, resolveRoleProviderHint } from "./role-provider-bridge"
import {
  buildResultLedgerStatusLine,
  buildTaskObservabilityReport,
  buildTaskStatusLine,
  buildVerificationStatusLine,
  type TaskObservabilityReport,
} from "./task-observability"
import { buildRegressionStatusLine } from "./regression-scenarios"

export type SupervisorPanelState = ReturnType<typeof readSupervisorState>
export type CostPanelState = ReturnType<typeof readCostStatus>
export type ObservabilityPanelState = TaskObservabilityReport | undefined
export type PanelRoleModel = {
  role: DllRole
  primary: string
  fallback: string[]
  source: string
  enabled: boolean
  onDemandOnly: boolean
  parsed: { providerID: string; modelID: string }
  providerAvailable: boolean
  providerVerified?: boolean
}

export const STATUS_ROLES: DllRole[] = [
  "commander",
  "requirements-inspector",
  "task-completion-archivist",
  "final-auditor",
  "multimodal-context-interpreter",
]

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export const SESSION_CAP_USD: number = (() => {
  const env = process.env.DLL_AGENT_COST_CAP_USD
  if (env) {
    const n = parseFloat(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 5.0
})()

export function commandLine(compact: boolean) {
  if (compact) return "/task-status | /role-models | /role-model-set | /team-review"
  return "/task-status | /role-models | /role-model-set | /quality | /verify | /model-capability | /team-review"
}

export function modeLine() {
  return `autopilot | quality=${dllQuality()} | verify=${dllVerify()} | role-crossing=temporary`
}

export function truncate(value: string, width: number) {
  return Locale.truncate(value, Math.max(20, width))
}

export function shortModel(model: string, compact: boolean) {
  if (!compact) return model
  const slash = model.indexOf("/")
  if (slash === -1) return model
  return model.slice(slash + 1)
}

export function roleModel(role: DllRole, sessionID: string | undefined, projectDir: string | undefined) {
  const snapshot = readRoleProviderSnapshot(sessionID, role)
  const resolved = snapshot ?? resolveRoleProviderHint({ role, sessionID, projectDir })
  return {
    role,
    primary: `${resolved.providerID}/${resolved.modelID}`,
    fallback: [],
    source: resolved.source,
    enabled: true,
    onDemandOnly: false,
    parsed: { providerID: String(resolved.providerID), modelID: String(resolved.modelID) },
    providerAvailable: resolved.available,
    providerVerified: resolved.providerVerified,
  } satisfies PanelRoleModel
}

function formatRoleModel(model: PanelRoleModel, compact: boolean) {
  return `${shortModel(model.primary, compact)} [${model.source}]`
}

export function buildModelStatusLine(input: {
  commander: PanelRoleModel
  runningRoles?: string[]
  compact: boolean
  width: number
}) {
  const running = input.runningRoles?.length
    ? ` | running ${input.runningRoles.map((role) => role.replace("-archivist", "")).join("+")}`
    : ""
  return truncate(`model commander=${formatRoleModel(input.commander, input.compact)}${running}`, input.width)
}

export function buildWorkStatusLine(input: {
  supervisor: SupervisorPanelState
  width: number
}) {
  const s = input.supervisor
  if (!s) return "work ready | phase:default | risk:low | gate:open | verify:not_run"
  const m = s.metrics ?? {}
  const verify = m.real_tool_evidence ? "passed" : m.verification_evidence ? "partial" : "not_run"
  const gate = s.blocked_completion ? "blocked" : s.reviewer_conflict ? "conflict" : "open"
  return truncate(`work ${gate === "open" ? "ready" : gate} | phase:${s.phase} | risk:${s.risk} | gate:${gate} | verify:${verify}`, input.width)
}

export function buildReviewStatusLine(input: {
  supervisor: SupervisorPanelState
  width: number
}) {
  const s = input.supervisor
  if (!s) return "review idle | required:0 completed:0"
  const pending = s.required_reviews.filter((reviewer) => !s.completed_reviews.includes(reviewer))
  const running = s.running_reviewers ?? []
  const queued = s.queued_reviewers ?? []
  const parts = [
    running.length ? `running:${running.join("+")}` : "",
    queued.length ? `queued:${queued.join(",")}` : "",
    pending.length ? `pending:${pending.join(",")}` : "pending:none",
    `done:${s.completed_reviews.length}`,
  ].filter(Boolean)
  return truncate(`review ${parts.join(" | ")}`, input.width)
}

export function buildCostStatusLine(input: {
  cost: CostPanelState
  capUsd: number
  width: number
}) {
  const c = input.cost
  if (!c) return "cost local est. $0.00"
  const total = formatCostUsd(c.session_total_usd)
  const cap = formatCostUsd(input.capUsd)
  const pct = input.capUsd > 0 ? Math.round((c.session_total_usd / input.capUsd) * 100) : 0
  const flag = c.session_cap_exceeded ? " CAP" : pct >= 80 ? ` ${pct}%` : ""
  return truncate(`cost ${total}/${cap}${flag}`, input.width)
}

export function buildQuotaStatusLine(input: {
  quota: ReturnType<typeof readQuotaFile>
  width: number
}) {
  const providers = input.quota?.providers ?? {}
  const parts = [
    ["D", "deepseek"],
    ["K", "kimi"],
    ["O", "openai"],
    ["Z", "zai"],
    ["M", "mimo"],
  ].map(([label, provider]) => `${label}:${quotaLine(providers[provider]).replace("quota unavailable", "quota n/a").replace("local est. only", "local")}`)
  return truncate(`quota ${parts.join(" | ")}${quotaAgeLine(input.quota)}`, input.width)
}

export function buildNextActionLine(input: {
  supervisor: SupervisorPanelState
  cost: CostPanelState
  width: number
}) {
  const s = input.supervisor
  const c = input.cost
  if (c?.session_cap_exceeded) return truncate("next user decision required: cost cap exceeded", input.width)
  if (!s) return "next ready for a task"
  if (s.blocked_completion && s.block_reason) return truncate(`next resolve gate: ${s.block_reason}`, input.width)
  const running = s.running_reviewers ?? []
  if (running.length > 0) return truncate(`next wait for reviewer: ${running.join(", ")}`, input.width)
  const pending = s.required_reviews.filter((reviewer) => !s.completed_reviews.includes(reviewer))
  if (pending.length > 0) return truncate(`next complete reviewer: ${pending.join(", ")}`, input.width)
  return "next ready"
}

export function buildObservableTaskLine(input: {
  report: ObservabilityPanelState
  width: number
}) {
  if (!input.report) return "task UNKNOWN | goal:not_available"
  return truncate(buildTaskStatusLine({ report: input.report, width: input.width }), input.width)
}

export function buildObservableVerificationLine(input: {
  report: ObservabilityPanelState
  width: number
}) {
  if (!input.report) return "verify unknown | doctor:unknown"
  return truncate(buildVerificationStatusLine({ report: input.report, width: input.width }), input.width)
}

export function buildObservableLedgerLine(input: {
  report: ObservabilityPanelState
  width: number
}) {
  if (!input.report) return "ledger total:0 | continuation:unknown"
  return truncate(buildResultLedgerStatusLine({ report: input.report, width: input.width }), input.width)
}

export function buildObservabilitySummaryLine(input: {
  report: ObservabilityPanelState
  width: number
}) {
  if (!input.report) return truncate("observability trajectory:unknown routing:unknown doctor:unknown regression:not_available", input.width)
  const text = [
    `observability trajectory:${input.report.evidence.latest.length}`,
    `routing:${input.report.routing.decisions}`,
    `doctor:${input.report.doctor.status}`,
    buildRegressionStatusLine(64),
  ].join(" | ")
  return truncate(text, input.width)
}

export function readQuotaFile() {
  const file = process.env.DLL_AGENT_QUOTA_FILE
  if (!file) return
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as {
      updated_at?: number
      ttl_sec?: number
      refresh_errors?: { provider: string; error: string }[] | null
      providers?: Record<string, any>
    }
  } catch {
    return
  }
}

export function readSupervisorState(sessionID?: string) {
  try {
    const sid = sessionID || process.env.DLL_AGENT_SESSION_ID
    if (!sid) return
    const file = path.join(os.homedir(), ".dll-agent", "sessions", sid, "supervisor.json")
    if (!fs.existsSync(file)) return
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    if (raw.version === 1) {
      return raw as {
        version: number
        phase: string
        risk: string
        required_reviews: string[]
        completed_reviews: string[]
        blocked_completion: boolean
        block_reason: string | null
        reviewer_conflict: boolean
        updated_at: string
        metrics?: Record<string, any>
        queued_reviewers?: string[]
        running_reviewers?: string[]
        intent_judgement_status?: {
          message_id: string
          status: string
          action: string
          model?: string
          participants?: string[]
          reason: string
          started_at: string
          updated_at: string
        }
        intent_judgement?: {
          message_id: string
          source: string
          plan_action: string
          classification: {
            task_kind?: string
            interaction_level?: string
            confidence?: string
            finalization_policy?: string
          }
          reason: string
          created_at: string
        }
        answer_delivery?: {
          user_message_id: string
          assistant_message_id?: string
          mode: string
          status: string
          public_answer_emitted: boolean
          internal_review_allowed?: boolean
          council_allowed?: boolean
          public_followup_allowed: boolean
          accepted_reason?: string
          evidence_refs: string[]
          updated_at: string
        }
      }
    }
  } catch {
    return
  }
}

export function readCostStatus(sessionID?: string) {
  try {
    const sid = sessionID || process.env.DLL_AGENT_SESSION_ID
    if (!sid) return
    const file = path.join(os.homedir(), ".dll-agent", "sessions", sid, "cost.json")
    if (!fs.existsSync(file)) return
    return JSON.parse(fs.readFileSync(file, "utf8")) as {
      session_total_usd: number
      by_provider: Record<string, number>
      session_cap_exceeded: boolean
      provider_cap_exceeded: Record<string, boolean>
      last_warning: string | null
    }
  } catch {
    return
  }
}

export function readTaskObservabilityStatus(projectDir: string | undefined, sessionID: string | undefined) {
  if (!sessionID) return
  try {
    return buildTaskObservabilityReport({
      sessionID,
      projectDir: projectDir || process.cwd(),
      maxEvents: 4,
    })
  } catch {
    return
  }
}

function formatCostUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return money.format(value)
}

function quotaLine(value: any) {
  if (!value) return "local est. only"
  if (value.stale) {
    if (value.status === "missing_key") return "missing key [stale]"
    if (value.status === "configured") return "configured; quota unavailable [stale]"
    if (value.status === "expired") return "expired [stale]"
    if (value.status === "quota_unavailable" || value.status === "no_quota_endpoint") return "quota unavailable [stale]"
    if (value.status === "local_estimate_only") return "local est. only [stale]"
    if (value.status === "unavailable") return "unavailable [stale]"
    if (value.status === "requires_admin_key") return "admin key needed [stale]"
    if (value.status === "endpoint_error") return "balance API rejected [stale]"
    if (value.status === "error") return "quota unavailable [stale]"
    if (value.kind === "cost") {
      if (typeof value.cost_usd === "number") return `30d cost ${money.format(value.cost_usd)} [stale]`
      return "cost API [stale]"
    }
    if (value.kind === "token_fallback") return "local est. only [stale]"
  }
  if (value.status === "missing_key") return "missing key"
  if (value.status === "configured") return "configured; quota unavailable"
  if (value.status === "expired") return "expired"
  if (value.status === "quota_unavailable" || value.status === "no_quota_endpoint") return "quota unavailable"
  if (value.status === "local_estimate_only") return "local est. only"
  if (value.status === "unavailable") return "unavailable"
  if (value.status === "requires_admin_key") return "admin key needed"
  if (value.status === "endpoint_error") return "balance API rejected"
  if (value.status === "error") return "quota unavailable"
  if (value.kind === "cost") {
    if (typeof value.cost_usd === "number") return `provider billed: ~${money.format(value.cost_usd)}`
    return "cost API"
  }
  if (value.kind === "token_fallback") return "local est. only"
  const balances = value.balances
  if (Array.isArray(balances)) {
    const item = balances.find((x) => x.currency === "CNY") ?? balances.find((x) => x.currency === "USD") ?? balances[0]
    if (item?.total_balance) return `balance ${item.currency} ${item.total_balance}`
  }
  if (balances && typeof balances === "object") {
    if (typeof balances.available_balance === "number") {
      const currency = balances.currency ?? "CNY"
      return `balance ${currency} ${Number(balances.available_balance).toFixed(2)}`
    }
  }
  return "unknown"
}

function quotaAgeLine(value: any) {
  if (!value?.updated_at) return ""
  const age = Math.floor((Date.now() / 1000 - value.updated_at))
  const ttl = value.ttl_sec ?? 300
  const stale = age > ttl
  const min = Math.floor(age / 60)
  const sec = age % 60
  const time = min > 0 ? `${min}m${sec}s ago` : `${sec}s ago`
  return stale ? ` (stale: ${time})` : ` (${time})`
}

export * as TuiStatusAdapter from "./tui-status-adapter"
