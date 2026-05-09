import fs from "fs"
import path from "path"
import os from "os"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useProject } from "@tui/context/project"
import { Locale } from "@/util/locale"
import { enabled as dllEnabled, quality as dllQuality, verify as dllVerify } from "@/dll-agent/profile"
import { idleAwareInterval, isIdleBySupervisorState } from "./dll-agent-idle"
import { resolveRoleModel, type DllRole, type EffectiveRoleModel } from "@/dll-agent/role-model-registry"

function enabled() {
  return dllEnabled()
}

function commandLine(compact: boolean) {
  if (compact) return "/task-status | /role-models | /role-model-set | /team-review"
  return "/task-status | /role-models | /role-model-set | /quality | /verify | /model-capability | /team-review"
}

function modeLine() {
  return `autopilot | quality=${dllQuality()} | verify=${dllVerify()} | role-crossing=temporary`
}

type SupervisorPanelState = ReturnType<typeof readSupervisorState>
type CostPanelState = ReturnType<typeof readCostStatus>

const STATUS_ROLES: DllRole[] = [
  "commander",
  "requirements-inspector",
  "task-completion-archivist",
  "final-auditor",
  "multimodal-context-interpreter",
]

function truncate(value: string, width: number) {
  return Locale.truncate(value, Math.max(20, width))
}

function shortModel(model: string, compact: boolean) {
  if (!compact) return model
  const slash = model.indexOf("/")
  if (slash === -1) return model
  return model.slice(slash + 1)
}

function roleModel(role: DllRole, sessionID: string | undefined, projectDir: string | undefined) {
  return resolveRoleModel(role, sessionID, projectDir)
}

function formatRoleModel(model: EffectiveRoleModel, compact: boolean) {
  return `${shortModel(model.primary, compact)} [${model.source}]`
}

export function buildModelStatusLine(input: {
  commander: EffectiveRoleModel
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

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function readQuotaFile() {
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

function readSupervisorState() {
  try {
    const sid = process.env.DLL_AGENT_SESSION_ID
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
      }
    }
  } catch {
    return
  }
}

function readCostStatus() {
  try {
    const sid = process.env.DLL_AGENT_SESSION_ID
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

const SESSION_CAP_USD: number = (() => {
  const env = process.env.DLL_AGENT_COST_CAP_USD
  if (env) {
    const n = parseFloat(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 5.0
})()

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

export function DllAgentHomeStatus() {
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 106)
  const [quota, setQuota] = createSignal(readQuotaFile())
  const session = createMemo(() => {
    const sid = process.env.DLL_AGENT_SESSION_ID
    if (!sid) return "session: active"
    return "session: " + Locale.truncateMiddle(sid, compact() ? 24 : 36)
  })
  const width = createMemo(() => Math.max(62, Math.min(compact() ? 82 : 110, dimensions().width - 8)))
  const contentWidth = createMemo(() => width() - 2)
  const projectDir = createMemo(() => project.instance.path().worktree || project.instance.directory() || process.cwd())
  const commander = createMemo(() => roleModel("commander", process.env.DLL_AGENT_SESSION_ID, projectDir()))
  const rolesLine = createMemo(() => {
    const roles = STATUS_ROLES.map((role) => roleModel(role, process.env.DLL_AGENT_SESSION_ID, projectDir()))
    const line = roles.map((model) => `${model.role.replace("-context-interpreter", "").replace("-inspector", "")}=${shortModel(model.primary, true)}`).join(" | ")
    return truncate(line, contentWidth())
  })

  // Idle-aware: 15s active, 60s idle (quota doesn't change rapidly)
  onMount(() => {
    let lastAge = 0
    const cleanup = idleAwareInterval(
      () => {
        const q = readQuotaFile()
        setQuota(q)
        lastAge = q?.updated_at ? (Date.now() / 1000 - q.updated_at) : 0
      },
      15_000,
      60_000,
      () => lastAge > 120,
    )
    onCleanup(cleanup)
  })

  return (
    <Show when={enabled()}>
      <box flexDirection="column" width={width()} gap={0}>
        <text>
          <b>dll-agent</b> active
        </text>
        <text>{session()}</text>
        <box height={1} />
        <text>{buildModelStatusLine({ commander: commander(), compact: compact(), width: contentWidth() })}</text>
        <text>{truncate(modeLine(), contentWidth())}</text>
        <text>{rolesLine()}</text>
        <box height={1} />
        <text>{buildQuotaStatusLine({ quota: quota(), width: contentWidth() })}</text>
        <text>{truncate(commandLine(compact()), contentWidth())}</text>
      </box>
    </Show>
  )
}

export function DllAgentHomeLogo() {
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 96)
  const projectDir = createMemo(() => project.instance.path().worktree || project.instance.directory() || process.cwd())
  const commander = createMemo(() => roleModel("commander", process.env.DLL_AGENT_SESSION_ID, projectDir()))
  const lineWidth = createMemo(() => Math.max(24, Math.min(96, dimensions().width - 8)))

  return (
    <Show when={enabled()}>
      <box flexDirection="column" alignItems="center" gap={1}>
        <text>
          <b>dll-agent</b>
        </text>
        <text>{truncate(modeLine(), lineWidth())}</text>
        <text>{buildModelStatusLine({ commander: commander(), compact: compact(), width: lineWidth() })}</text>
      </box>
    </Show>
  )
}

export function DllAgentSessionPanel(props: { sessionID?: string }) {
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 106)
  const sessionID = createMemo(() => process.env.DLL_AGENT_SESSION_ID || props.sessionID)
  const session = createMemo(() => {
    const sid = sessionID()
    if (!sid) return "session: active"
    return "session: " + Locale.truncateMiddle(sid, compact() ? 24 : 36)
  })
  const contentWidth = createMemo(() => Math.max(34, dimensions().width - 4))
  const projectDir = createMemo(() => project.instance.path().worktree || project.instance.directory() || process.cwd())
  const commander = createMemo(() => roleModel("commander", sessionID(), projectDir()))

  // Supervisor state signal
  const [supervisor, setSupervisor] = createSignal(readSupervisorState())
  const [costStatus, setCostStatus] = createSignal(readCostStatus())
  const [quota, setQuota] = createSignal(readQuotaFile())

  onMount(() => {
    let lastUpdated = ""
    const cleanup = idleAwareInterval(
      () => {
        const sv = readSupervisorState()
        setSupervisor(sv)
        setCostStatus(readCostStatus())
        setQuota(readQuotaFile())
        lastUpdated = sv?.updated_at ?? ""
      },
      10_000, // active: 10s
      30_000, // idle: 30s
      () => isIdleBySupervisorState(lastUpdated, 60_000),
    )
    onCleanup(cleanup)
  })

  const costWarningLine = createMemo(() => {
    const w = costStatus()?.last_warning
    if (!w) return null
    return Locale.truncate(`warning ${w}`, contentWidth())
  })

  return (
    <Show when={enabled()}>
      <box
        flexDirection="column"
        gap={0}
        paddingTop={0}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <text>
          <b>dll-agent</b> {supervisor()?.blocked_completion ? "blocked" : "ready"}{" "}
          {truncate(session(), compact() ? 38 : 54)}
        </text>
        <text>
          {buildModelStatusLine({
            commander: commander(),
            runningRoles: supervisor()?.running_reviewers,
            compact: compact(),
            width: contentWidth(),
          })}
        </text>
        <text>{buildWorkStatusLine({ supervisor: supervisor(), width: contentWidth() })}</text>
        <text>{buildReviewStatusLine({ supervisor: supervisor(), width: contentWidth() })}</text>
        <text>
          {buildCostStatusLine({ cost: costStatus(), capUsd: SESSION_CAP_USD, width: contentWidth() })}
        </text>
        <text>{buildQuotaStatusLine({ quota: quota(), width: contentWidth() })}</text>
        <text>
          {buildNextActionLine({ supervisor: supervisor(), cost: costStatus(), width: contentWidth() })}
        </text>
        <Show when={costWarningLine()}>
          <text>{costWarningLine()}</text>
        </Show>
      </box>
    </Show>
  )
}

export function DllAgentPromptHint() {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 96)
  const text = createMemo(() => Locale.truncate(commandLine(compact()), Math.max(24, Math.floor(dimensions().width * 0.55))))

  return (
    <Show when={enabled()}>
      <text wrapMode="none">
        {text()}
      </text>
    </Show>
  )
}
