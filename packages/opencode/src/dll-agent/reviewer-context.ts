import { execFileSync } from "child_process"
import { messageText } from "./triggers"
import { buildResultsSummary } from "./result-ledger"
import type { MessageV2 } from "@/session/message-v2"
import type { ReviewerRole, SupervisorMetricsSnapshot } from "./interfaces"

export function latestRealUser(messages: MessageV2.WithParts[]) {
  return [...messages]
    .reverse()
    .find((message) => {
      if (message.info.role !== "user") return false
      if (messageText(message).trim().length === 0) return false
      const textParts = message.parts.filter((p) => p.type === "text")
      if (textParts.length > 0 && textParts.every((p) => "synthetic" in p && (p as any).synthetic)) return false
      return true
    })
}

export function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, max - 20) + "\n...[truncated]"
}

export function extractRelatedPaths(messages: MessageV2.WithParts[]) {
  const out = new Set<string>()
  const pathPattern =
    /(?:^|[\s"'`])((?:\/Users\/[^\s"'`]+|\.?\/?(?:packages|src|test|tests|docs|scripts|apps|lib|bin|config)\/[^\s"'`),;]+))/g
  for (const message of messages.slice(-16)) {
    const text = messageText(message)
    for (const match of text.matchAll(pathPattern)) out.add(match[1])
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const input = part.state.status === "completed" || part.state.status === "error"
        ? part.state.input as Record<string, unknown> | undefined
        : undefined
      for (const key of ["filePath", "path", "filepath", "target_file"]) {
        const value = input?.[key]
        if (typeof value === "string" && value) out.add(value)
      }
      const command = typeof input?.command === "string" ? input.command : ""
      for (const match of command.matchAll(pathPattern)) out.add(match[1])
    }
  }
  return [...out].slice(0, 8)
}

function recentToolFailureSummary(messages: MessageV2.WithParts[]) {
  const lines: string[] = []
  for (const message of messages.slice(-12)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
        lines.push(`- ${part.tool}: ${truncate(part.state.error, 320)}`)
      }
      if (part.state.status === "completed" && /permission denied|not allowed|error:|failed|exception|traceback/i.test(part.state.output)) {
        const input = part.state.input as Record<string, unknown> | undefined
        const command = typeof input?.command === "string" ? input.command : part.tool
        lines.push(`- ${command}: ${truncate(part.state.output, 320)}`)
      }
    }
  }
  return lines.slice(-5)
}

const gitDiffCache = new Map<string, { result: string; ts: number }>()
const GIT_DIFF_CACHE_TTL_MS = 30_000

function gitDiffSummary(paths: string[]) {
  const key = paths.slice(0, 8).sort().join("|")
  const cached = gitDiffCache.get(key)
  if (cached && Date.now() - cached.ts < GIT_DIFF_CACHE_TTL_MS) return cached.result

  try {
    const cwd = process.env.DLL_AGENT_ROOT || process.cwd()
    const args = ["-C", cwd, "diff", "--stat", "--", ...paths.filter((p) => !p.startsWith("/Users/")).slice(0, 8)]
    const output = execFileSync("git", args, {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 12_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const result = truncate(output.trim(), 2_000)
    gitDiffCache.set(key, { result, ts: Date.now() })
    return result
  } catch {
    const result = ""
    gitDiffCache.set(key, { result, ts: Date.now() })
    return result
  }
}

export function buildReviewerContext(
  reviewer: ReviewerRole,
  reason: string,
  metrics: SupervisorMetricsSnapshot,
  messages: MessageV2.WithParts[],
  sessionID?: string,
) {
  const user = latestRealUser(messages)
  const userGoal = user ? truncate(messageText(user).trim(), 1_500) : "(no recent user text)"
  const paths = extractRelatedPaths(messages)
  const failures = recentToolFailureSummary(messages)
  const diff = gitDiffSummary(paths)

  let resultSummary = ""
  if (sessionID) {
    try {
      resultSummary = buildResultsSummary(sessionID)
    } catch {
      // Non-critical: reviewer context can proceed without ledger summary.
    }
  }

  const contextLines = [
    `Reviewer: ${reviewer}`,
    `Trigger reason: ${reason}`,
    `Recent user goal/message:`,
    userGoal,
    ``,
    `Supervisor metrics:`,
    `- tool_failures=${metrics.tool_failures}`,
    `- permission_denied=${metrics.permission_denied}`,
    `- user_corrections=${metrics.user_corrections}`,
    `- context_percent=${metrics.context_percent}`,
    `- final_claim=${metrics.final_claim}`,
    `- real_tool_evidence=${metrics.real_tool_evidence}`,
    ``,
    `Relevant file paths discovered from recent messages/tool calls:`,
    paths.length ? paths.map((p) => `- ${p}`).join("\n") : "- none",
    ``,
    `Relevant git diff summary:`,
    diff || "- unavailable or no local diff for discovered paths",
    ``,
    `Recent tool failure snippets:`,
    failures.length ? failures.join("\n") : "- none",
  ]

  if (resultSummary && resultSummary !== "No prior results in ledger.") {
    contextLines.push(``)
    contextLines.push(resultSummary)
  }

  return truncate(contextLines.join("\n"), 5_000)
}
