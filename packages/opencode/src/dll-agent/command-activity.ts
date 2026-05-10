import { readEntries, redact, type Entry as EvidenceEntry } from "./evidence"
import { loadResults } from "./result-ledger"

export type CommandActivityStatus = "running" | "passed" | "failed" | "blocked" | "skipped" | "unknown"

export interface CommandActivityEvent {
  command_id: string
  timestamp: string
  role: string
  tool: string
  command_summary: string
  status: CommandActivityStatus
  duration_ms?: number
  exit_code?: number
  failure_type?: string
  evidence_ref: string
  requires_user_action: boolean
  redaction_status: "redacted"
}

export interface ToolActivitySummary {
  readonly_tools: number
  writes: number
  mcp: number
  commands: number
  running: number
  failed: number
  total: number
  evidence_ref: string
  redaction_status: "redacted"
}

type ToolActivityPart = {
  type?: string
  tool?: string
  state?: {
    status?: string
  }
}

function payloadRecord(entry: EvidenceEntry | undefined) {
  return entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown>
    : {}
}

function redactedText(value: unknown, fallback: string) {
  const text = typeof value === "string" && value.trim() ? value : fallback
  return String(redact(text)).replace(/\s+/g, " ").trim().slice(0, 180)
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function statusFrom(input: { type: string; payload: Record<string, unknown>; exitCode?: number }): CommandActivityStatus {
  const values = [
    input.payload.status,
    input.payload.result,
    input.payload.overall,
    input.payload.action,
    input.type,
  ].map((value) => String(value ?? "").toLowerCase())
  if (input.exitCode !== undefined && input.exitCode !== 0) return "failed"
  if (values.some((value) => value.includes("blocked") || value.includes("block"))) return "blocked"
  if (values.some((value) => value.includes("skipped") || value.includes("skip"))) return "skipped"
  if (values.some((value) => value.includes("failed") || value.includes("fail") || value.includes("error"))) return "failed"
  if (values.some((value) => value.includes("running") || value.includes("started") || value.includes("start"))) return "running"
  if (values.some((value) => value.includes("passed") || value.includes("pass") || value.includes("ok") || value.includes("warn"))) return "passed"
  return "unknown"
}

function shouldIncludeEvidence(entry: EvidenceEntry) {
  if (entry.type === "doctor.run") return true
  if (entry.type.startsWith("mcp.")) return true
  if (entry.type.startsWith("capability.")) return true
  if (entry.type.startsWith("recovery.")) return true
  if (entry.type.includes("command")) return true
  if (entry.type.includes("tool")) return true
  return false
}

function normalizedToolName(value: unknown) {
  return String(value ?? "").toLowerCase()
}

function isReadOnlyTool(tool: string) {
  return ["read", "glob", "grep", "list", "webfetch"].includes(tool)
}

function isWriteTool(tool: string) {
  return ["write", "edit", "patch", "todowrite"].includes(tool)
}

function isCommandTool(tool: string) {
  return tool === "bash" || tool === "shell" || tool === "terminal"
}

function isMcpTool(tool: string) {
  return tool === "mcp" || tool.startsWith("mcp_") || tool.startsWith("mcp.") || tool.includes("mcp")
}

export function buildToolActivitySummary(input: {
  parts: ToolActivityPart[]
  evidenceRef?: string
}): ToolActivitySummary {
  const summary = input.parts
    .filter((part) => part.type === "tool")
    .reduce<ToolActivitySummary>((acc, part) => {
      const tool = normalizedToolName(part.tool)
      acc.total += 1
      if (isReadOnlyTool(tool)) acc.readonly_tools += 1
      if (isWriteTool(tool)) acc.writes += 1
      if (isMcpTool(tool)) acc.mcp += 1
      if (isCommandTool(tool)) acc.commands += 1
      if (part.state?.status === "running") acc.running += 1
      if (part.state?.status === "error") acc.failed += 1
      return acc
    }, {
      readonly_tools: 0,
      writes: 0,
      mcp: 0,
      commands: 0,
      running: 0,
      failed: 0,
      total: 0,
      evidence_ref: input.evidenceRef ?? "session tool parts",
      redaction_status: "redacted",
    })
  return redact(summary) as ToolActivitySummary
}

function eventFromEvidence(entry: EvidenceEntry, index: number): CommandActivityEvent {
  const payload = payloadRecord(entry)
  const command = payload.command ?? payload.command_summary ?? payload.next_command ?? payload.check ?? payload.action
  const exitCode = numberValue(payload.exit_code ?? payload.exitCode)
  const status = statusFrom({ type: entry.type, payload, exitCode })
  return redact({
    command_id: `${entry.type}:${entry.ts}:${index}`,
    timestamp: entry.ts,
    role: String(payload.role ?? payload.executing_role ?? payload.reviewer ?? "system"),
    tool: String(payload.tool ?? payload.kind ?? payload.check ?? entry.type.split(".")[0] ?? "system"),
    command_summary: redactedText(command, entry.type),
    status,
    duration_ms: numberValue(payload.duration_ms ?? payload.durationMs),
    exit_code: exitCode,
    failure_type: typeof payload.failure_type === "string" ? payload.failure_type : undefined,
    evidence_ref: `${entry.type}@${entry.ts}`,
    requires_user_action: status === "blocked" || payload.requires_user_action === true || payload.requires_user_authorization === true,
    redaction_status: "redacted",
  } satisfies CommandActivityEvent) as CommandActivityEvent
}

function eventFromResultCommand(input: {
  sessionID: string
  resultIndex: number
  commandIndex: number
  createdAt: string
  role: string
  command: string
  result: string
  exitCode?: number
  evidenceRef?: string
}): CommandActivityEvent {
  const status = input.result === "passed" ? "passed" : input.result === "failed" ? "failed" : input.result === "not_run" ? "skipped" : "unknown"
  return redact({
    command_id: `result-command:${input.sessionID}:${input.resultIndex}:${input.commandIndex}`,
    timestamp: input.createdAt,
    role: input.role,
    tool: "result-ledger",
    command_summary: redactedText(input.command, "result command"),
    status,
    exit_code: input.exitCode,
    evidence_ref: input.evidenceRef ?? `result-command:${input.resultIndex}:${input.commandIndex}`,
    requires_user_action: status === "failed",
    redaction_status: "redacted",
  } satisfies CommandActivityEvent) as CommandActivityEvent
}

export function buildCommandActivity(input: {
  sessionID?: string
  evidenceFile?: string
  maxEvents?: number
}): CommandActivityEvent[] {
  if (!input.sessionID) return []
  const evidenceEvents = readEntries(input.evidenceFile)
    .filter((entry) => entry.sessionID === input.sessionID)
    .filter(shouldIncludeEvidence)
    .map(eventFromEvidence)
  const resultEvents = loadResults(input.sessionID).flatMap((result, resultIndex) =>
    result.commands_run.map((command, commandIndex) =>
      eventFromResultCommand({
        sessionID: input.sessionID!,
        resultIndex,
        commandIndex,
        createdAt: result.created_at,
        role: result.executing_role,
        command: command.command,
        result: command.result,
        exitCode: command.exitCode,
        evidenceRef: command.evidenceRef,
      }),
    ),
  )
  return [...evidenceEvents, ...resultEvents]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-(input.maxEvents ?? 50))
}

function durationText(value: number | undefined) {
  if (value === undefined) return ""
  if (value < 1_000) return ` ${Math.round(value)}ms`
  return ` ${(value / 1_000).toFixed(1)}s`
}

function exitText(value: number | undefined) {
  return value === undefined ? "" : ` exit:${value}`
}

function statusText(value: CommandActivityStatus) {
  const map: Record<CommandActivityStatus, string> = {
    running: "运行中",
    passed: "通过",
    failed: "失败",
    blocked: "阻断",
    skipped: "跳过",
    unknown: "未知",
  }
  return map[value]
}

function truncate(value: string, width: number) {
  if (value.length <= width) return value
  return value.slice(0, Math.max(0, width - 1)) + "…"
}

export function buildCommandActivityMiniLines(input: {
  events: CommandActivityEvent[]
  toolSummary?: ToolActivitySummary
  width: number
  limit?: number
}) {
  const width = Math.max(24, input.width)
  const summary = input.toolSummary && input.toolSummary.total > 0
    ? truncate(
      `只读工具 ${input.toolSummary.readonly_tools} 次｜写入 ${input.toolSummary.writes}｜MCP ${input.toolSummary.mcp}｜命令 ${input.toolSummary.commands}｜运行 ${input.toolSummary.running}｜失败 ${input.toolSummary.failed}`,
      width,
    )
    : undefined
  if (input.events.length === 0) return [summary ?? "暂无命令活动｜证据：不可用"]
  const events = input.events.slice(-(input.limit ?? 4)).reverse().map((event) => truncate(
    `${event.command_summary}：${statusText(event.status)}${durationText(event.duration_ms)}${exitText(event.exit_code)}｜${event.role}/${event.tool}｜${event.evidence_ref}`,
    width,
  ))
  return summary ? [summary, ...events] : events
}

export function buildCommandActivityExpandedLines(input: {
  events: CommandActivityEvent[]
  toolSummary?: ToolActivitySummary
  width: number
  offset?: number
  limit?: number
}) {
  const width = Math.max(24, input.width)
  const ordered = input.events.slice().reverse()
  const start = Math.max(0, input.offset ?? 0)
  const items = ordered.slice(start, start + (input.limit ?? 10))
  const summary = input.toolSummary && input.toolSummary.total > 0
    ? truncate(
      `汇总：只读工具 ${input.toolSummary.readonly_tools} 次｜写入 ${input.toolSummary.writes}｜MCP ${input.toolSummary.mcp}｜命令 ${input.toolSummary.commands}｜运行 ${input.toolSummary.running}｜失败 ${input.toolSummary.failed}｜证据=${input.toolSummary.evidence_ref}`,
      width,
    )
    : undefined
  if (items.length === 0) return [summary ?? "暂无命令活动｜证据：不可用"]
  const events = items.map((event, index) => truncate(
    `${start + index + 1}. ${event.timestamp} ${statusText(event.status)} ${event.role}/${event.tool} ${event.command_summary}${durationText(event.duration_ms)}${exitText(event.exit_code)} 证据=${event.evidence_ref}${event.requires_user_action ? " 需要用户处理" : ""}`,
    width,
  ))
  return summary ? [summary, ...events] : events
}

export * as CommandActivity from "./command-activity"
