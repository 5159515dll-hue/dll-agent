import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { Locale } from "@/util/locale"
import { enabled as dllEnabled } from "@/dll-agent/profile"
import { idleAwareInterval, isIdleBySupervisorState } from "./dll-agent-idle"
import {
  buildCommandActivity,
  buildCommandActivityExpandedLines,
  buildCommandActivityMiniLines,
  buildToolActivitySummary,
} from "@/dll-agent/command-activity"
import {
  buildDllAgentPanelModel,
  readCapabilityPanelStatus,
} from "@/dll-agent/dll-agent-panel-model"
import {
  buildCostStatusLine,
  buildModelStatusLine,
  buildNextActionLine,
  buildObservableLedgerLine,
  buildObservableTaskLine,
  buildObservableVerificationLine,
  buildObservabilitySummaryLine,
  buildQuotaStatusLine,
  buildReviewStatusLine,
  buildWorkStatusLine,
  commandLine,
  modeLine,
  readCostStatus,
  readQuotaFile,
  readSupervisorState,
  readTaskObservabilityStatus,
  roleModel,
  SESSION_CAP_USD,
  shortModel,
  STATUS_ROLES,
  truncate,
} from "@/dll-agent/tui-status-adapter"

export {
  buildCostStatusLine,
  buildModelStatusLine,
  buildNextActionLine,
  buildObservableLedgerLine,
  buildObservableTaskLine,
  buildObservableVerificationLine,
  buildObservabilitySummaryLine,
  buildQuotaStatusLine,
  buildReviewStatusLine,
  buildWorkStatusLine,
} from "@/dll-agent/tui-status-adapter"
export {
  buildCommandActivity,
  buildCommandActivityExpandedLines,
  buildCommandActivityMiniLines,
  buildToolActivitySummary,
} from "@/dll-agent/command-activity"
export {
  buildDllAgentPanelModel,
} from "@/dll-agent/dll-agent-panel-model"

function enabled() {
  return dllEnabled()
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

export function DllAgentSessionPanel(props: { sessionID?: string; variant?: "bottom" | "sidebar" }) {
  const project = useProject()
  const sync = useSync()
  const dimensions = useTerminalDimensions()
  const sidebar = createMemo(() => props.variant === "sidebar")
  const compact = createMemo(() => sidebar() || dimensions().width < 106)
  const narrow = createMemo(() => sidebar() || dimensions().width < 120)
  const sessionID = createMemo(() => process.env.DLL_AGENT_SESSION_ID || props.sessionID)
  const session = createMemo(() => {
    const sid = sessionID()
    if (!sid) return "session: active"
    return "session: " + Locale.truncateMiddle(sid, compact() ? 24 : 36)
  })
  const contentWidth = createMemo(() => sidebar() ? 36 : Math.max(34, dimensions().width - 4))
  const projectDir = createMemo(() => project.instance.path().worktree || project.instance.directory() || process.cwd())
  const projectLabel = createMemo(() => Locale.truncateMiddle(projectDir(), sidebar() ? 20 : compact() ? 24 : 38))
  const commander = createMemo(() => roleModel("commander", sessionID(), projectDir()))

  // Supervisor state signal
  const [supervisor, setSupervisor] = createSignal(readSupervisorState())
  const [costStatus, setCostStatus] = createSignal(readCostStatus())
  const [quota, setQuota] = createSignal(readQuotaFile())
  const [taskStatus, setTaskStatus] = createSignal(readTaskObservabilityStatus(projectDir(), sessionID()))
  const [capabilityStatus, setCapabilityStatus] = createSignal(readCapabilityPanelStatus(projectDir()))
  const [commandActivity, setCommandActivity] = createSignal(buildCommandActivity({ sessionID: sessionID(), maxEvents: 30 }))
  const [commandExpanded, setCommandExpanded] = createSignal(false)
  const [commandOffset, setCommandOffset] = createSignal(0)

  onMount(() => {
    let lastUpdated = ""
    const cleanup = idleAwareInterval(
      () => {
        const sv = readSupervisorState()
        setSupervisor(sv)
        setCostStatus(readCostStatus())
        setQuota(readQuotaFile())
        setTaskStatus(readTaskObservabilityStatus(projectDir(), sessionID()))
        setCapabilityStatus(readCapabilityPanelStatus(projectDir()))
        setCommandActivity(buildCommandActivity({ sessionID: sessionID(), maxEvents: 30 }))
        lastUpdated = sv?.updated_at ?? ""
      },
      10_000, // active: 10s
      30_000, // idle: 30s
      () => isIdleBySupervisorState(lastUpdated, 60_000),
    )
    onCleanup(cleanup)
  })

  useKeyboard((evt) => {
    if (!commandExpanded()) return
    if (evt.name === "escape") {
      evt.preventDefault()
      setCommandExpanded(false)
      setCommandOffset(0)
      return
    }
    if (evt.name === "up") {
      evt.preventDefault()
      setCommandOffset((value) => Math.max(0, value - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setCommandOffset((value) => Math.min(Math.max(0, commandActivity().length - 1), value + 1))
    }
  })

  const costWarningLine = createMemo(() => {
    const w = costStatus()?.last_warning
    if (!w) return null
    return Locale.truncate(`warning ${w}`, contentWidth())
  })
  const panel = createMemo(() =>
    buildDllAgentPanelModel({
      projectLabel: projectLabel(),
      sessionLabel: session(),
      commander: commander(),
      supervisor: supervisor(),
      task: taskStatus(),
      capability: capabilityStatus(),
      cost: costStatus(),
      quota: quota(),
      width: contentWidth(),
      compact: compact(),
    }),
  )
  const toolActivitySummary = createMemo(() => {
    const sid = sessionID()
    const messages = sid ? sync.data.message[sid] ?? [] : []
    return buildToolActivitySummary({
      parts: messages.flatMap((message) => sync.data.part[message.id] ?? []),
      evidenceRef: sid ? `session:${Locale.truncateMiddle(sid, 18)}` : "session tool parts",
    })
  })
  const miniCommandLines = createMemo(() =>
    buildCommandActivityMiniLines({
      events: commandActivity(),
      toolSummary: toolActivitySummary(),
      width: contentWidth(),
      limit: narrow() ? 3 : 4,
    }),
  )
  const expandedCommandLines = createMemo(() =>
    buildCommandActivityExpandedLines({
      events: commandActivity(),
      toolSummary: toolActivitySummary(),
      width: contentWidth(),
      offset: commandOffset(),
      limit: Math.min(12, Math.max(5, Math.floor(dimensions().height * 0.2))),
    }),
  )
  const hasCommandActivity = createMemo(() => commandActivity().length > 0 || toolActivitySummary().total > 0)
  const showCommandActivity = createMemo(() => !sidebar() || hasCommandActivity() || !panel().isIdle)
  createEffect(() => {
    if (!hasCommandActivity()) {
      setCommandExpanded(false)
      setCommandOffset(0)
    }
  })
  const sectionTitle = (title: string) => <text><b>{title}</b></text>

  return (
    <Show when={enabled()}>
      <box
        flexDirection="column"
        gap={0}
        paddingTop={0}
        paddingBottom={sidebar() ? 0 : 1}
        paddingLeft={sidebar() ? 0 : 1}
        paddingRight={sidebar() ? 0 : 1}
      >
        <Show when={!sidebar()}>
          <For each={panel().global}>
            {(line) => <text>{line}</text>}
          </For>
          <box height={1} />
        </Show>
        <Show when={sidebar()}>
          <Show
            when={!panel().isIdle}
            fallback={
              <box flexDirection="column" gap={0}>
                <text><b>状态</b> {panel().idle[0]?.replace(/^状态：/, "")}</text>
                <text>{panel().idle[1]}</text>
                <text>{panel().idle[2]}</text>
              </box>
            }
          >
            <text><b>状态</b> {panel().global[0]?.replace(/^dll-agent：/, "")}</text>
            <text>{panel().global[1]?.replace(/^模型：/, "模型 ")}</text>
          </Show>
        </Show>
        <Show when={!sidebar() || !panel().isIdle}>
          <box flexDirection="column" gap={0}>
            {sectionTitle(panel().hasBlocker ? "任务（阻断）" : "任务")}
            <For each={sidebar() ? panel().task.filter((line) => !line.includes("目标：未建立目标")).slice(0, 2) : panel().task}>
              {(line) => <text>{line}</text>}
            </For>
            <For each={sidebar() ? panel().verification.slice(0, 1) : panel().verification}>{(line) => <text>{line}</text>}</For>
            {sectionTitle(sidebar() ? "模型" : "模型 / 能力")}
            <For each={panel().modelRole.slice(0, narrow() ? 2 : 3)}>{(line) => <text>{line}</text>}</For>
            <Show when={sidebar()}>
              {sectionTitle("能力")}
            </Show>
            <For each={panel().capability.slice(0, narrow() ? 1 : 2)}>{(line) => <text>{line}</text>}</For>
          </box>
        </Show>
        <Show when={showCommandActivity()}>
          <box height={1} />
          <box flexDirection="column" gap={0} onMouseDown={() => hasCommandActivity() && setCommandExpanded(true)}>
            <text>
              <b>{commandExpanded() ? "命令活动（展开）" : "命令活动"}</b>{" "}
              {hasCommandActivity() ? commandExpanded() ? "Esc 收起 | ↑/↓ 滚动" : "点击展开" : "暂无"}
            </text>
            <For each={commandExpanded() ? expandedCommandLines() : miniCommandLines()}>
              {(line) => <text>{line}</text>}
            </For>
          </box>
        </Show>
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
