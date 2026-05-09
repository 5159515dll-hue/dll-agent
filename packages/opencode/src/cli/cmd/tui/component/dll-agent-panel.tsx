import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useProject } from "@tui/context/project"
import { Locale } from "@/util/locale"
import { enabled as dllEnabled } from "@/dll-agent/profile"
import { idleAwareInterval, isIdleBySupervisorState } from "./dll-agent-idle"
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
  const [taskStatus, setTaskStatus] = createSignal(readTaskObservabilityStatus(projectDir(), sessionID()))

  onMount(() => {
    let lastUpdated = ""
    const cleanup = idleAwareInterval(
      () => {
        const sv = readSupervisorState()
        setSupervisor(sv)
        setCostStatus(readCostStatus())
        setQuota(readQuotaFile())
        setTaskStatus(readTaskObservabilityStatus(projectDir(), sessionID()))
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
        <text>{buildObservableTaskLine({ report: taskStatus(), width: contentWidth() })}</text>
        <text>{buildObservableVerificationLine({ report: taskStatus(), width: contentWidth() })}</text>
        <text>{buildReviewStatusLine({ supervisor: supervisor(), width: contentWidth() })}</text>
        <text>{buildObservableLedgerLine({ report: taskStatus(), width: contentWidth() })}</text>
        <text>{buildObservabilitySummaryLine({ report: taskStatus(), width: contentWidth() })}</text>
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
