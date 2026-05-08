import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { enabled as dllEnabled } from "@/dll-agent/profile"
import { buildCapabilitySidebarStatus, type CapabilitySidebarStatus } from "@/dll-agent/capability-status"
import { idleAwareInterval } from "@tui/component/dll-agent-idle"

const id = "internal:sidebar-capability"

interface SidebarCapabilityState {
  status?: CapabilitySidebarStatus
  error?: string
}

function updatedLine(status?: CapabilitySidebarStatus) {
  if (!status?.generated_at) return ""
  const age = Math.max(0, Math.floor((Date.now() - new Date(status.generated_at).getTime()) / 1000))
  if (age >= 60) return `updated ${Math.floor(age / 60)}m${age % 60}s ago`
  return `updated ${age}s ago`
}

function View(props: { api: TuiPluginApi; session_id: string; title?: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const taskGoal = createMemo(() => {
    const todo = props.api.state.session.todo(props.session_id).map((item) => item.content).join("\n")
    return [props.title, todo].filter(Boolean).join("\n")
  })
  const read = () => {
    try {
      return {
        status: buildCapabilitySidebarStatus(process.cwd(), 72, {
          userGoal: taskGoal(),
          sessionID: props.session_id,
        }),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const [state, setState] = createSignal<SidebarCapabilityState>(read())
  const lines = createMemo(() => state().status?.lines ?? [])
  const attention = createMemo(() => state().status?.has_attention ?? false)
  const errorLine = createMemo(() => state().error)

  createEffect(() => {
    setState(read())
  })

  onMount(() => {
    // Capability status reads local registry/runtime files; refresh slower than quota/model spend.
    const cleanup = idleAwareInterval(
      () => setState(read()),
      30_000,
      60_000,
      () => !attention(),
    )
    onCleanup(cleanup)
  })

  return (
    <Show when={dllEnabled()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Capabilities</b>
            <Show when={!open() && lines().length > 0}>
              <span style={{ fg: attention() ? theme().warning : theme().textMuted }}>
                {" "}
                ({lines()[1] ?? lines()[0]})
              </span>
            </Show>
          </text>
        </box>
        <Show when={open()}>
          <Show
            when={!errorLine()}
            fallback={<text fg={theme().warning}>status unavailable: {errorLine()}</text>}
          >
            <For each={lines()}>
              {(line) => <text fg={attention() && line.includes("permission") ? theme().warning : theme().textMuted}>{line}</text>}
            </For>
            <Show when={state().status}>
              <text fg={theme().textMuted}>{updatedLine(state().status)}</text>
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} title={props.title} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
