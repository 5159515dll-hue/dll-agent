import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import fs from "fs"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { idleAwareInterval } from "@tui/component/dll-agent-idle"

const id = "internal:sidebar-context"

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

function quotaAgeLine(quota: any) {
  if (!quota?.updated_at) return ""
  const age = Math.floor((Date.now() / 1000 - quota.updated_at))
  const ttl = quota.ttl_sec ?? 300
  const stale = age > ttl
  const min = Math.floor(age / 60)
  const sec = age % 60
  const time = min > 0 ? `${min}m${sec}s ago` : `${sec}s ago`
  if (stale) return ` (stale: ${time}, TTL ${ttl}s)`
  return ` (${time})`
}

function quotaErrorLine(quota: any) {
  const errors = quota?.refresh_errors
  if (!errors || errors.length === 0) return null
  return errors.map((e: any) => `${e.provider}: ${e.error}`).join("; ")
}

function balanceLine(value: any) {
  if (!value) return "local est. only"
  if (value.stale) {
    // stale data — show old value with stale marker
    if (value.status === "missing_key") return "quota: missing key [stale]"
    if (value.status === "error") return "quota unavailable [stale]"
    if (value.kind === "token_fallback") return "local est. only [stale]"
    if (value.kind === "cost" && typeof value.cost_usd === "number") return `provider billed: ~${money.format(value.cost_usd)} [stale]`
  }
  if (value.status === "missing_key") return "quota: missing key"
  if (value.status === "requires_admin_key") return "quota: admin key needed"
  if (value.status === "endpoint_error") return "balance API rejected"
  if (value.status === "error") return "quota unavailable"
  if (value.kind === "cost") {
    if (typeof value.cost_usd === "number") return `provider billed: ~${money.format(value.cost_usd)}`
    return "quota: cost API"
  }
  if (value.kind === "token_fallback") return "local est. only"
  const balances = value.balances
  if (Array.isArray(balances)) {
    const item = balances.find((x: any) => x.currency === "CNY") ?? balances.find((x: any) => x.currency === "USD") ?? balances[0]
    if (item?.total_balance) return `provider balance: ${item.currency} ${item.total_balance}`
  }
  if (balances && typeof balances === "object") {
    if (typeof balances.available_balance === "number") return `provider balance: ${money.format(balances.available_balance)}`
  }
  return "quota: unknown"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  // Parent-only msgs for Context % (last assistant token count must be commander's).
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  // Parent + reviewer children for Model spend aggregation, so GLM/Kimi/OpenAI show up.
  const allMsgs = createMemo(() => {
    const own = msg()
    const children = props.api.state.session.children(props.session_id)
    const childMsgs = children.flatMap((c) => props.api.state.session.messages(c.id))
    return [...own, ...childMsgs]
  })
  const [quota, setQuota] = createSignal(readQuotaFile())
  onMount(() => {
    // Idle-aware: 15s active, 60s idle (use signal value to avoid double file read in isIdle check)
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
  const modelSpend = createMemo(() => {
    const rows = new Map<
      string,
      {
        providerID: string
        modelID: string
        name: string
        calls: number
        tokens: number
        cost: number
      }
    >()
    let totalCost = 0

    for (const item of allMsgs()) {
      if (item.role !== "assistant") continue
      const tokens =
        item.tokens.input + item.tokens.output + item.tokens.reasoning + item.tokens.cache.read + item.tokens.cache.write
      const cost = item.cost ?? 0
      totalCost += cost
      if (tokens <= 0 && cost <= 0) continue

      const provider = props.api.state.provider.find((provider) => provider.id === item.providerID)
      const model = provider?.models[item.modelID]
      const key = `${item.providerID}/${item.modelID}`
      const prev =
        rows.get(key) ??
        {
          providerID: item.providerID,
          modelID: item.modelID,
          name: model?.name ?? item.modelID,
          calls: 0,
          tokens: 0,
          cost: 0,
        }
      prev.calls += 1
      prev.tokens += tokens
      prev.cost += cost
      rows.set(key, prev)
    }

    return {
      rows: [...rows.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 6),
      totalCost,
    }
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens (all types incl. cache)</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>local est. spend {money.format(modelSpend().totalCost)}</text>
      <box paddingTop={1}>
        <text fg={theme().text}>
          <b>Model usage (local est.)</b>
        </text>
        <Show when={modelSpend().rows.length > 0} fallback={<text fg={theme().textMuted}>no paid calls yet</text>}>
          <For each={modelSpend().rows}>
            {(item) => (
              <box paddingBottom={1}>
                <text fg={theme().textMuted}>
                  {item.providerID}/{item.name}
                </text>
                <text fg={theme().textMuted}>
                  local est. {money.format(item.cost)} · {item.tokens.toLocaleString()} tokens · {item.calls} call
                  {item.calls === 1 ? "" : "s"}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
      <box paddingTop={1}>
        <text fg={theme().text}>
          <b>Quota</b>
        </text>
        <For each={["deepseek", "kimi", "openai", "zai"]}>
          {(name) => <text fg={theme().textMuted}>{name}: {balanceLine(quota()?.providers?.[name])}</text>}
        </For>
        <Show when={quota()}>
          <text fg={theme().textMuted}>updated: {quotaAgeLine(quota())}</text>
          <Show when={quotaErrorLine(quota())}>
            <text fg="#f59e0b">refresh errors: {quotaErrorLine(quota())}</text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
