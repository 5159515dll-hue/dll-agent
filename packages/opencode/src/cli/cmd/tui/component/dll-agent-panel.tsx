import fs from "fs"
import path from "path"
import os from "os"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { Locale } from "@/util/locale"
import { enabled as dllEnabled, quality as dllQuality, verify as dllVerify } from "@/dll-agent/profile"

function enabled() {
  return dllEnabled()
}

function commandLine(compact: boolean) {
  if (compact) return "/ commands | /dll-status | /roles | /team-review"
  return "/ commands | /dll-status | /quality | /verify | /model-capability | /roles | /team-review"
}

function teamLine(compact: boolean) {
  if (compact) return "team: deepseek | inspect | openai audit"
  return "team: commander=deepseek-v4-pro | inspect=glm/kimi | openai=on-demand audit"
}

function modeLine() {
  return `autopilot | quality=${dllQuality()} | verify=${dllVerify()} | role-crossing=temporary`
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

function readSessionCapUsd() {
  const env = process.env.DLL_AGENT_COST_CAP_USD
  if (env) {
    const n = parseFloat(env)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 5.0
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
    if (typeof balances.available_balance === "number") return `balance ${money.format(balances.available_balance)}`
  }
  return "unknown"
}

function quotaAgeLine() {
  const q = readQuotaFile()
  if (!q?.updated_at) return ""
  const age = Math.floor((Date.now() / 1000 - q.updated_at))
  const ttl = q.ttl_sec ?? 300
  const stale = age > ttl
  const min = Math.floor(age / 60)
  const sec = age % 60
  const time = min > 0 ? `${min}m${sec}s ago` : `${sec}s ago`
  return stale ? ` (stale: ${time})` : ` (${time})`
}

export function DllAgentHomeStatus() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 106)
  const [quota, setQuota] = createSignal(readQuotaFile())
  const session = createMemo(() => {
    const sid = process.env.DLL_AGENT_SESSION_ID
    if (!sid) return "session: active"
    return "session: " + Locale.truncateMiddle(sid, compact() ? 24 : 36)
  })
  const width = createMemo(() => Math.max(62, Math.min(compact() ? 82 : 110, dimensions().width - 8)))

  onMount(() => {
    const timer = setInterval(() => setQuota(readQuotaFile()), 15_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={enabled()}>
      <box flexDirection="column" width={width()} gap={0}>
        <text fg={theme.text}>
          <b>dll-agent status: active.</b>
        </text>
        <text fg={theme.textMuted}>{session()}</text>
        <box height={1} />
        <text fg={theme.textMuted}>Show dll-agent status for this session.</text>
        <text fg={theme.textMuted}>
          Quality mode: {dllQuality()}. MAX: strongest role team by default; DeepSeek handles normal execution, OpenAI is reserved for escalation/audit triggers.
        </text>
        <text fg={theme.textMuted}>
          Verification mode: {dllVerify()}. STRICT: every important claim needs evidence; high-risk completion needs role review.
        </text>
        <text fg={theme.textMuted}>
          Default commander/executor: deepseek/deepseek-v4-pro, context 1,048,576, thinking=max.
        </text>
        <text fg={theme.textMuted}>Inspectors: zai/glm-5.1 and kimi/kimi-k2.6.</text>
        <text fg={theme.textMuted}>
          OpenAI strategic/final auditor: openai/gpt-5.5-pro, on-demand only for stuck/off-track/conflict/high-risk finalization.
        </text>
        <text fg={theme.textMuted}>
          Mention commands: /quality, /verify, /model-capability, /roles, /team-review, /chief-engineer, /cross-review.
        </text>
        <box height={1} />
        <text fg={theme.text}>
          <b>Quota</b>
        </text>
        <For each={["deepseek", "kimi", "openai", "zai"]}>
          {(name) => <text fg={theme.textMuted}>{name}: {quotaLine(quota()?.providers?.[name])}</text>}
        </For>
        <text fg={theme.textMuted}>updated: {quotaAgeLine()}</text>
      </box>
    </Show>
  )
}

export function DllAgentHomeLogo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 96)

  return (
    <Show when={enabled()}>
      <box flexDirection="column" alignItems="center" gap={1}>
        <text fg={theme.text}>
          <b>dll-agent</b>
        </text>
        <text fg={theme.textMuted}>{modeLine()}</text>
        <text fg={theme.textMuted}>{teamLine(compact())}</text>
      </box>
    </Show>
  )
}

export function DllAgentSessionPanel(props: { sessionID?: string }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 106)
  const session = createMemo(() => {
    const sid = process.env.DLL_AGENT_SESSION_ID || props.sessionID
    if (!sid) return "session: active"
    return "session: " + Locale.truncateMiddle(sid, compact() ? 24 : 36)
  })
  const left = createMemo(() => Locale.truncate(`dll-agent | ${session()} | ${modeLine()}`, Math.max(30, dimensions().width - 4)))
  const right = createMemo(() => Locale.truncate(teamLine(compact()), Math.max(30, dimensions().width - 4)))

  // Supervisor state signal
  const [supervisor, setSupervisor] = createSignal(readSupervisorState())
  const [costStatus, setCostStatus] = createSignal(readCostStatus())

  onMount(() => {
    const timer = setInterval(() => {
      setSupervisor(readSupervisorState())
      setCostStatus(readCostStatus())
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const riskColor = createMemo(() => {
    const risk = supervisor()?.risk
    if (risk === "high") return "#ef4444" // red
    if (risk === "medium") return "#f59e0b" // amber
    return theme.textMuted
  })

  const supervisorLine = createMemo(() => {
    const s = supervisor()
    if (!s) return null
    const parts: string[] = []
    parts.push(`phase:${s.phase}`)
    parts.push(`risk:${s.risk}`)
    if (s.blocked_completion) parts.push("BLOCKED")
    const pending = s.required_reviews.filter((r: string) => !s.completed_reviews.includes(r))
    if (pending.length > 0) parts.push(`reviews:${pending.join(",")}`)
    const running = s.running_reviewers ?? []
    if (running.length > 0) parts.push(`running:${running.join("+")}(parallel x${running.length})`)
    const queued = s.queued_reviewers ?? []
    if (queued.length > 0) parts.push(`queued:${queued.join(",")}`)
    return Locale.truncate(parts.join(" | "), Math.max(28, dimensions().width - 6))
  })

  const costLine = createMemo(() => {
    const c = costStatus()
    if (!c) return null
    const sessionCap = readSessionCapUsd()
    const total = formatCostUsd(c.session_total_usd)
    const cap = formatCostUsd(sessionCap)
    const pct = sessionCap > 0 ? Math.round((c.session_total_usd / sessionCap) * 100) : 0
    const flag = c.session_cap_exceeded ? " CAP!" : pct >= 80 ? ` ${pct}%` : ""
    return `local est. ${total}/${cap}${flag}`
  })

  const costByProviderLine = createMemo(() => {
    const c = costStatus()
    if (!c) return null
    const entries = Object.entries(c.by_provider ?? {})
      .filter(([, v]) => Number.isFinite(v) && v > 0)
      .sort(([, a], [, b]) => b - a)
    if (entries.length === 0) return null
    const exceededMap = c.provider_cap_exceeded ?? {}
    const parts = entries.map(([provider, cost]) => {
      const flag = exceededMap[provider] ? "!" : ""
      return `${provider}${flag}=${formatCostUsd(cost)}`
    })
    return Locale.truncate(`local est.: ${parts.join("  ")}`, Math.max(28, dimensions().width - 6))
  })

  const costWarningLine = createMemo(() => {
    const w = costStatus()?.last_warning
    if (!w) return null
    return Locale.truncate(`! ${w}`, Math.max(28, dimensions().width - 6))
  })

  return (
    <Show when={enabled()}>
      <box
        flexDirection="column"
        gap={0}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.backgroundPanel}
      >
        <text fg={theme.text}>{left()}</text>
        <text fg={theme.textMuted}>{right()}</text>
        <Show when={supervisorLine()}>
          <text fg={riskColor()}>{supervisorLine()}</text>
        </Show>
        <Show when={costLine()}>
          <text fg={costStatus()?.session_cap_exceeded ? "#ef4444" : theme.textMuted}>{costLine()}</text>
        </Show>
        <Show when={costByProviderLine()}>
          <text fg={theme.textMuted}>{costByProviderLine()}</text>
        </Show>
        <Show when={costWarningLine()}>
          <text fg="#f59e0b">{costWarningLine()}</text>
        </Show>
      </box>
    </Show>
  )
}

export function DllAgentPromptHint() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 96)
  const text = createMemo(() => Locale.truncate(commandLine(compact()), Math.max(24, Math.floor(dimensions().width * 0.55))))

  return (
    <Show when={enabled()}>
      <text fg={theme.textMuted} wrapMode="none">
        {text()}
      </text>
    </Show>
  )
}
