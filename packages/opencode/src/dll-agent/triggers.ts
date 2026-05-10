import type { MessageV2 } from "@/session/message-v2"
import {
  canSuppressRoutineReview,
  canTreatReadOnlyToolFailureAsInformational,
  canUseReadOnlyAnswerFinalization,
  classifyTaskIntake,
  type TaskIntakeClassification,
} from "./task-intake-classifier"

export type Metrics = {
  userCorrections: number
  recentUserCorrection: boolean
  toolFailures: number
  permissionDenied: number
  repeatedToolFailure: boolean
  contextTokens: number
  contextPercent: number
  longContextSignal: boolean
  finalClaim: boolean
  verificationEvidence: boolean
  /** 真实从工具输出（bash/test runner 等）解析出的验证证据 */
  realToolEvidence: boolean
  reviewerConflictSignal: boolean
  /** Phase 6: Kimi completion check signal — trigger task-completion-archivist before final report */
  kimiCompletionCheckSignal: boolean
  /** Phase 6: GLM completion claim check signal — trigger requirements-inspector for completion claims */
  glmCompletionClaimSignal: boolean
  /** Phase 6: Kimi pre-report signal — trigger long-context-archivist before final report for context compression */
  kimiPreReportSignal: boolean
  /** Phase 6: Scope expansion signal — detected when commander significantly expands task scope */
  scopeExpandedSignal: boolean
  /** Phase 6: Phase switch signal — detected when user changes task direction */
  phaseSwitchSignal: boolean
  /** Phase 8: Multimodal signal — detected when non-text input (images, video, audio, etc.) is present */
  multimodalSignal: boolean
  /** High-risk governance/runtime area touched: provider/routing/gate/evidence/permission/quota/MCP/etc. */
  highRiskTaskSignal: boolean
  /** True for short user-origin input with no structural engineering/safety signal. */
  statelessGreetingTask: boolean
  /** Broader stateless short chat task. Includes trivial no-tool answer prompts. */
  statelessChatTask: boolean
  /** True for user-origin L2 read-only analysis/explanation that may finish as an answer, not a verified engineering delivery. */
  readOnlyAnswerTask: boolean
  /** True when the observed turn used only read-only tools and produced no failures, writes, shell commands, MCP calls, or subtasks. */
  readOnlyToolAnswerTask: boolean
  /** User-origin deterministic task intake classification. */
  taskClassification?: TaskIntakeClassification
  /**
   * True only for short, explicit no-tool answer requests such as
   * "只回答 OK，不要执行工具。". This suppresses reviewer/verifier triggers for
   * stateless acknowledgement tasks without weakening correctness-required
   * paths such as corrections, failures, final claims, high-risk changes, or
   * multimodal input.
   */
  trivialNoToolTask: boolean
}

function textOf(parts: MessageV2.Part[]) {
  return parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/**
 * 过滤 supervisor / gate 自身注入的提示文本，避免触发器对自身产生的内容产生
 * false positive.
 * 策略：若消息首个非空行以 [dll-agent ...] 标签开头，则视为系统注入，整段忽略；
 * 否则按行剔除单独的 [dll-agent ...] 提示行。
 */
function stripSelfInjections(text: string) {
  if (!text) return text
  const lines = text.split("\n")
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim() ?? ""
  const tagPrefixes = [
    "[dll-agent ",
    "[dll-agent-",
    "<compact-review-context",
    "<task_result",
    "<dll-agent-final-gate",
    "<dll-agent-continuation",
  ]
  if (tagPrefixes.some((p) => firstNonEmpty.startsWith(p))) return ""

  if (isSelfGeneratedReport(firstNonEmpty, text)) return ""

  // Local dll-agent slash commands are handled without an LLM but are still
  // persisted as session messages. Do not let their status text pollute the
  // next user prompt's routing scan (for example /role-models mentions
  // "long-context-archivist" and "role model", which would otherwise look like
  // a long-context/high-risk governance task).
  if (isLocalCommandEchoOrResponse(firstNonEmpty, text)) return ""

  // 检测 reviewer output JSON 结构：若消息同时包含 version/reviewer/findings/verdict
  // 等典型字段（≥3 个命中），则视为 supervisor 注入的 reviewer 输出。
  const reviewerOutputMarkers = [
    /"version"\s*:\s*1/,
    /"reviewer"\s*:/,
    /"findings"\s*:/,
    /"verdict"\s*:/,
  ]
  const markerHits = reviewerOutputMarkers.filter((re) => re.test(text)).length
  if (markerHits >= 3) return ""

  return lines
    .filter((line) => {
      const t = line.trim()
      if (tagPrefixes.some((p) => t.startsWith(p))) return false
      if (isSelfGeneratedReportLine(t)) return false
      return true
    })
    .join("\n")
}

function isSelfGeneratedReport(firstLine: string, text: string) {
  if (isSelfGeneratedReportLine(firstLine)) return true
  const strongMarkers = [
    /<task_result[\s>]/i,
    /<compact-review-context[\s>]/i,
    /<dll-agent-final-gate[\s>]/i,
    /<dll-agent-continuation[\s>]/i,
    /^Verification Report\b/i,
    /^Reviewer fallback summary\b/i,
    /^reviewer result\b/i,
    /^task-completion-archivist output\b/i,
    /^final-auditor output\b/i,
    /^role-cross output\b/i,
    /^subtask resume\b/i,
    /^result ledger summary\b/i,
    /^routing evidence summary\b/i,
    /^dll-agent doctor\b/i,
    /^doctor report\b/i,
  ]
  return strongMarkers.some((re) => re.test(text.trim()))
}

function isSelfGeneratedReportLine(line: string) {
  return /^(?:Verification Report|Reviewer fallback summary|reviewer result|task-completion-archivist output|final-auditor output|role-cross output|subtask resume|task_id:\s*ses_|result ledger summary|routing evidence summary|doctor report|TUI\/status panel|task selected|task verified|task blocked|runtime idle\/on-demand|Model usage \(local est\.\)|Quota|Capabilities|LSP|Todo)\b/i.test(line)
}

function isLocalCommandEchoOrResponse(firstLine: string, text: string) {
  if (/^\/(?:role-models|role-model-set|role-model-reset|dll-status|task-status|model-usage|routing-report|doctor-next|regression-status|capability-status|permissions)\b/.test(firstLine)) return true
  if (firstLine === "dll-agent role models:") return true
  if (/^Updated\s+[\w-]+\s+model\./.test(firstLine)) return true
  if (/^dll-agent (?:status|task status|capability status|permissions|routing report|model usage)/i.test(firstLine)) return true
  if (text.includes("source=session") && text.includes("fallback=") && text.includes("hint=configured")) return true
  return false
}

function hasFileOrPathIntent(text: string) {
  return /(?:^|\s)(?:\.{0,2}\/|~\/|\/Users\/|[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|md|json|jsonc|yaml|yml|toml|sh|sql|html|css|png|jpg|jpeg|pdf|docx|pptx|xlsx))\b/.test(text)
}

export function isTrivialNoToolPromptText(text: string) {
  const normalized = text.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim()
  if (!normalized || normalized.length > 40) return false
  if (hasFileOrPathIntent(normalized)) return false
  if (/```|(?:^|\n)\s*(?:traceback|stack trace|panic:|TS\d{4}|npm ERR!|typecheck|doctor|bun\s+test|npm\s+test|pytest)\b/i.test(normalized)) return false
  return true
}

export function isStatelessGreetingPromptText(text: string) {
  const normalized = text.trim().replace(/^["'“”]+|["'“”。.!?？！]+$/g, "").trim().toLowerCase()
  return isTrivialNoToolPromptText(normalized)
}

export function isStatelessChatPromptText(text: string) {
  const classification = classifyTaskIntake({ userText: text })
  return isStatelessGreetingPromptText(text) || isTrivialNoToolPromptText(text) || canSuppressRoutineReview(classification)
}

export function messageText(message: MessageV2.WithParts | undefined) {
  if (!message) return ""
  return stripSelfInjections(textOf(message.parts))
}

function normalizeError(text: string) {
  return text
    .replace(/\d+/g, "N")
    .replace(/\/[^\s'"]+/g, "/PATH")
    .slice(0, 160)
}

function isReadOnlyTool(tool: string) {
  return tool === "read" || tool === "glob" || tool === "grep" || tool === "list" || tool === "webfetch"
}

function isPermissionOrSecretFailure(text: string) {
  return /permission denied|not allowed|could not request permission|denied|secret|token|cookie|ssh key|\.env|credential/i.test(text)
}

export function metrics(messages: MessageV2.WithParts[], contextLimit?: number): Metrics {
  const recent = messages.slice(-12)
  const lastUser = [...messages].reverse().find((message) => message.info.role === "user")
  const lastAssistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  const lastAssistantText = messageText(lastAssistant)
  const userOriginText = recent
    .filter((message) => message.info.role === "user")
    .map(messageText)
    .join("\n")
  const lastUserText = messageText(lastUser)
  const classification = classifyTaskIntake({ userText: lastUserText })

  // User intent is no longer inferred from hard-coded natural-language phrases.
  // Language-level intent should come from TaskIntake policy/model judgement.
  const correctionPattern = /(?!)/
  const longContextPattern = /(?!)/
  const finalClaimPattern = /(?!)/
  const evidencePattern =
    /(运行了|执行了|验证|测试|typecheck|doctor|smoke|pytest|npm test|bun run|日志|log\/|docs\/|路径|命令|observed|output|checkpoint|metrics|tsgo|exit code|stdout|stderr|exited with)/i
  const conflictPattern = /(?!)/

  // Phase 6: New trigger signal patterns
  // Unfinished indicators for Kimi completion check
  const unfinishedPattern = /\b(?:TODO|PARTIAL|BLOCKED|CONTINUATION_REQUIRED|BLOCKED_USER_REQUIRED|BLOCKED_BUDGET_EXHAUSTED)\b/i
  // GLM completion claim check: completion claim without real evidence or with medium+ risk
  // (computed from combined conditions in metrics() return)
  // Scope expansion detection: compare file edit scope vs initial task scope
  const scopeExpansionPattern = /\b(?:scope[-_ ]?creep|feature[-_ ]?creep|gold[-_ ]?plating)\b/i
  // Phase switch detection: user explicitly changes task direction
  const phaseSwitchPattern = /\b(?:switch[-_ ]?task|change[-_ ]?direction|new[-_ ]?plan)\b/i

  // Phase 8: Multimodal input patterns
  const multimodalPattern = /\.(?:png|jpg|jpeg|gif|webp|bmp|svg|mp4|mov|avi|webm|mp3|wav|ogg)\b/i
  const highRiskTaskPattern =
    /\b(?:sudo|rm\s+-rf|git\s+push|git\s+reset\s+--hard|git\s+clean\s+-fdx|curl\s+[^|]+?\|\s*(?:sh|bash)|chmod\s+[0-7]{3,4}|chown\s+|brew\s+install|npm\s+install\s+-g|pip\s+install\s+--user|docker\s+run)\b/i

  const SCANNABLE_TOOLS = new Set(["bash", "edit", "write", "task"])
  const informationalReadOnlyFailureMode = canTreatReadOnlyToolFailureAsInformational(classification)
  const toolErrors: string[] = []
  let permissionDenied = 0
  let readOnlyToolCalls = 0
  let mutatingOrCommandToolCalls = 0
  let mcpToolCalls = 0
  let subtaskCalls = 0
  for (const message of recent) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (isReadOnlyTool(part.tool)) readOnlyToolCalls++
      else if (/mcp/i.test(part.tool)) mcpToolCalls++
      else if (part.tool === "task") subtaskCalls++
      else mutatingOrCommandToolCalls++
      if (part.state.status === "error") {
        if (informationalReadOnlyFailureMode && isReadOnlyTool(part.tool) && !isPermissionOrSecretFailure(part.state.error)) continue
        toolErrors.push(part.state.error)
        if (/permission denied|not allowed|could not request permission|denied/i.test(part.state.error)) permissionDenied++
      }
      if (SCANNABLE_TOOLS.has(part.tool) && part.state.status === "completed" && /permission denied|not allowed|error:|failed|exception/i.test(part.state.output)) {
        toolErrors.push(part.state.output.slice(0, 500))
        if (/permission denied|not allowed|could not request permission|denied/i.test(part.state.output)) permissionDenied++
      }
    }
  }

  const repeated = new Map<string, number>()
  for (const err of toolErrors) repeated.set(normalizeError(err), (repeated.get(normalizeError(err)) ?? 0) + 1)

  const tokenSource = lastAssistant?.info.role === "assistant" ? lastAssistant.info.tokens : undefined
  const contextTokens = tokenSource
    ? tokenSource.input + tokenSource.output + tokenSource.reasoning + tokenSource.cache.read + tokenSource.cache.write
    : 0
  const contextPercent = contextLimit ? Math.round((contextTokens / contextLimit) * 100) : 0

  const userCorrections = recent.filter((message) => message.info.role === "user" && correctionPattern.test(messageText(message))).length
  const recentUserCorrection = !!lastUser && correctionPattern.test(lastUserText)
  const finalClaim = finalClaimPattern.test(lastAssistantText)
  const realToolEvidence = verifiedToolEvidence(messages)
  const verificationEvidence = evidencePattern.test(userOriginText) || realToolEvidence
  const reviewerConflictSignal = conflictPattern.test(userOriginText)
  const longContextSignal = (() => {
    if (contextPercent >= 40) return true
    return longContextPattern.test(userOriginText)
  })()
  const highRiskTaskSignal = classification.task_kind === "high_risk" || highRiskTaskPattern.test(userOriginText)
  const multimodalSignal = classification.task_kind === "multimodal" || multimodalPattern.test(userOriginText)
  const repeatedToolFailure = [...repeated.values()].some((count) => count >= 2)
  const anyToolCalls = readOnlyToolCalls + mutatingOrCommandToolCalls + mcpToolCalls + subtaskCalls > 0
  const readOnlyToolAnswerTask =
    readOnlyToolCalls > 0 &&
    mutatingOrCommandToolCalls === 0 &&
    mcpToolCalls === 0 &&
    subtaskCalls === 0 &&
    toolErrors.length === 0 &&
    permissionDenied === 0 &&
    !classification.reviewer_required &&
    !classification.verification_required &&
    !classification.safety_overrides.length
  const readOnlyAnswerTask =
    (canUseReadOnlyAnswerFinalization(classification) || readOnlyToolAnswerTask) &&
    !recentUserCorrection &&
    userCorrections === 0 &&
    toolErrors.length === 0 &&
    !repeatedToolFailure &&
    !permissionDenied &&
    !reviewerConflictSignal &&
    !longContextSignal &&
    !highRiskTaskSignal &&
    !multimodalSignal
  const statelessGreetingTask =
    classification.task_kind === "greeting" &&
    !anyToolCalls &&
    !recentUserCorrection &&
    userCorrections === 0 &&
    toolErrors.length === 0 &&
    !repeatedToolFailure &&
    !finalClaim &&
    !reviewerConflictSignal &&
    !longContextSignal &&
    !highRiskTaskSignal &&
    !multimodalSignal
  const trivialNoToolTask =
    isTrivialNoToolPromptText(lastUserText) &&
    !anyToolCalls &&
    !recentUserCorrection &&
    userCorrections === 0 &&
    toolErrors.length === 0 &&
    !repeatedToolFailure &&
    !finalClaim &&
    !reviewerConflictSignal &&
    !longContextSignal &&
    !highRiskTaskSignal &&
    !multimodalSignal
  const statelessChatTask =
    (canSuppressRoutineReview(classification) || statelessGreetingTask || trivialNoToolTask) &&
    !recentUserCorrection &&
    userCorrections === 0 &&
    toolErrors.length === 0 &&
    !repeatedToolFailure &&
    !finalClaim &&
    !reviewerConflictSignal &&
    !longContextSignal &&
    !highRiskTaskSignal &&
    !multimodalSignal

  return {
    userCorrections,
    recentUserCorrection,
    toolFailures: toolErrors.length,
    permissionDenied,
    repeatedToolFailure,
    contextTokens,
    contextPercent,
    longContextSignal,
    finalClaim,
    verificationEvidence,
    realToolEvidence,
    reviewerConflictSignal,

    // Phase 6: New trigger signals
    // Kimi completion check: final claim + any unfinished indicator
    kimiCompletionCheckSignal: !readOnlyAnswerTask && finalClaimPattern.test(lastAssistantText) && unfinishedPattern.test(lastAssistantText),
    // GLM completion claim check: final claim + (no real tool evidence OR medium+ risk implied)
    glmCompletionClaimSignal:
      finalClaim &&
      !readOnlyAnswerTask &&
      (!realToolEvidence || correctionPattern.test(lastAssistantText)),
    // Kimi pre-report: context >=30% AND final claim (proactive compression before report)
    kimiPreReportSignal: !readOnlyAnswerTask && contextPercent >= 30 && finalClaim,
    // Scope expansion is user-origin only. Assistant/reviewer/report prose can
    // mention "scope" while summarizing a finished answer; it must not create
    // a new reviewer trigger.
    scopeExpandedSignal: scopeExpansionPattern.test(userOriginText),
    // Phase switch: user changes direction explicitly
    phaseSwitchSignal: phaseSwitchPattern.test(lastUserText),
    // Phase 8: Multimodal input signal
    multimodalSignal,
    highRiskTaskSignal,
    statelessGreetingTask,
    statelessChatTask,
    readOnlyAnswerTask,
    readOnlyToolAnswerTask,
    taskClassification: classification,
    trivialNoToolTask,
  }
}

/**
 * 扫描最近的 bash/test 工具输出，判断是否存在真实验证证据。
 *
 * "真证据" = 模型实际调用了 verification 工具且工具返回了可被识别为 pass/exit-0
 * 的输出，而不是模型在自然语言里写 "测试通过"。
 *
 * 检查最近 12 条消息的 tool parts：command 包含 typecheck/test/doctor/build/lint，
 * 且 status=completed，且 output 包含 pass/ok/exit code 0/类似关键词，且不包含
 * fail/error/exception。
 */
const VERIFICATION_COMMAND_PATTERN =
  /(typecheck|tsgo|tsc|bun test|pytest|npm test|npm run test|go test|cargo test|jest|vitest|mocha|doctor|python3 -m py_compile|git diff --check|dll-agent doctor)/i
const AUDIT_EVIDENCE_COMMAND_PATTERN =
  /(playwright|browser.*audit|audit-full-browser|click-through|点击审计|浏览器.*审计|e2e)/i
const AUDIT_ARTIFACT_OUTPUT_PATTERN =
  /(Report saved to:|full-crm-browser-flow-audit-report|screenshots? captured|test-screenshots|Browser Click-Through Audit|📸 Screenshots)/i
const POSITIVE_OUTPUT_PATTERN =
  /(0 errors?|all tests? pass|exit(ed)? (with )?(code )?0|exited with code 0|^ok$|✓|PASS\b|^pass\b|Build succeeded|completed successfully|no error|0 problems|result:\s*(ok|warn)|passed|success)/im
const NEGATIVE_OUTPUT_PATTERN =
  /(error\b|failed?\b|exception|FAIL\b|✗|exit(ed)? (with )?(code )?[1-9]|traceback|panic:)/i

export function verifiedToolEvidence(messages: MessageV2.WithParts[]): boolean {
  const recent = messages.slice(-12)
  for (const message of recent) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      const tool = part.tool
      const input = part.state.input as Record<string, unknown> | undefined
      const command = typeof input?.command === "string" ? input.command : ""
      const description = typeof input?.description === "string" ? input.description : ""
      const haystack = `${tool} ${command} ${description}`
      const output = typeof part.state.output === "string" ? part.state.output : ""
      if (AUDIT_EVIDENCE_COMMAND_PATTERN.test(haystack) && AUDIT_ARTIFACT_OUTPUT_PATTERN.test(output)) return true
      if (!VERIFICATION_COMMAND_PATTERN.test(haystack)) continue
      if (NEGATIVE_OUTPUT_PATTERN.test(output)) continue
      if (POSITIVE_OUTPUT_PATTERN.test(output) || output.trim().length === 0) return true
    }
  }
  return false
}
