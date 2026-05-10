import type { MessageV2 } from "@/session/message-v2"

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
 * false positive（例如 "reviewer conflict" 关键词会让 conflictPattern 永远命中）。
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
  ]
  if (tagPrefixes.some((p) => firstNonEmpty.startsWith(p))) return ""

  // Local dll-agent slash commands are handled without an LLM but are still
  // persisted as session messages. Do not let their status text pollute the
  // next user prompt's routing scan (for example /role-models mentions
  // "long-context-archivist" and "role model", which would otherwise look like
  // a long-context/high-risk governance task).
  if (isLocalCommandEchoOrResponse(firstNonEmpty, text)) return ""

  // 检测 reviewer output JSON 结构：若消息同时包含 version/reviewer/findings/verdict
  // 等典型字段（≥3 个命中），则视为 supervisor 注入的 reviewer 输出，避免其内的
  // "reviewer conflict" / "证据不足" 等文本被误判为新的 conflict / correction 信号。
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
      return true
    })
    .join("\n")
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
  return /(?:^|\s)(?:\.{0,2}\/|~\/|\/Users\/|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|md|json|jsonc|yaml|yml|toml|sh|sql|html|css|png|jpg|jpeg|pdf|docx|pptx|xlsx))\b/.test(text)
}

export function isTrivialNoToolPromptText(text: string) {
  const normalized = text.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim()
  if (!normalized || normalized.length > 80) return false
  if (hasFileOrPathIntent(normalized)) return false
  if (/(改|修改|修复|实现|新增|删除|重构|检查|分析|读取|打开|执行命令|运行(?:命令|测试|脚本|程序)|测试|typecheck|build|doctor|报错|错误|失败|日志|stack trace|traceback|error|failed|fix|implement|edit|write|delete|refactor|inspect|analyze|run\s+(?:command|test|build)|test)/i.test(normalized)) return false

  const simpleAnswer =
    /(只|仅|就|直接)?\s*(回答|回复|输出|说|answer|reply|respond|say)\s*[：:]?\s*["'“”]?\s*(OK|ok|好的|是|否|yes|no|收到|done|pass|fail)\s*["'“”]?/i.test(normalized)
  const noTools =
    /(不要|别|无需|不需要|禁止|do\s*not|don't|without|no)\s*(执行|使用|调用|运行|use|call|run)?\s*(工具|命令|tool|tools|command|commands|bash|shell)/i.test(normalized)

  return simpleAnswer && noTools
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

export function metrics(messages: MessageV2.WithParts[], contextLimit?: number): Metrics {
  const recent = messages.slice(-12)
  const lastUser = [...messages].reverse().find((message) => message.info.role === "user")
  const lastAssistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  const lastAssistantText = messageText(lastAssistant)
  const allText = recent.map(messageText).join("\n")
  const lastUserText = messageText(lastUser)

  // 只把真正的方向/需求纠偏计入 requirements-inspector 触发。
  // "再次检查/仔细检查/有问题/失败/报错/Permission denied" 这类复查或运行时问题
  // 不再算作需求纠偏，避免 GLM reviewer 被普通复查请求反复拉起。
  const correctionPattern =
    /(不对|不是这个|跑偏|方向(变|错|偏)|不符合|你误解|理解错|搞错|做错|改错|需求(变更|改变|改了)|目标(变更|改变|改了)|不要按原来|推倒重来|重新来|wrong|off[- ]?track|misunderstood|incorrect|mistaken|that'?s wrong|not what i (asked|wanted|meant)|start over|backtrack|revert)/i
  const longContextPattern = /(长上下文|长日志|日志很多|baseline|文档|docx|ppt|报告|全部日志|context|memory|历史|总结|压缩|long context|long log|big document|summarize|condense|consolidate)/i
  const finalClaimPattern =
    /(完成了|已完成|已经完成|已修复|修复完成|验证通过|最终结论|最终 verdict|可以交付|done|fixed|implemented|verified|all tests pass|successfully|task[- ]?complete|ready to merge|ship it|all green|完工)/i
  const evidencePattern =
    /(运行了|执行了|验证|测试|typecheck|doctor|smoke|pytest|npm test|bun run|日志|log\/|docs\/|路径|命令|observed|output|checkpoint|metrics|tsgo|exit code|stdout|stderr|exited with)/i
  const conflictPattern = /(冲突|相互矛盾|reviewer conflict|意见不一致|无法判断|证据不足|insufficient evidence|disagree|contradict)/i

  // Phase 6: New trigger signal patterns
  // Unfinished indicators for Kimi completion check
  const unfinishedPattern =
    /(未完成|待完成|下一步|后续|TODO|roadmap|不是.*本轮|仍有.*未|尚未.*完成|PARTIAL|BLOCKED|推迟|不在.*范围)/i
  // GLM completion claim check: completion claim without real evidence or with medium+ risk
  // (computed from combined conditions in metrics() return)
  // Scope expansion detection: compare file edit scope vs initial task scope
  const scopeExpansionPattern =
    /(扩大.*范围|增加.*需求|额外.*功能|scope.*(creep|expand)|feature.*creep|gold.?plating|超出.*(计划|预期|范围))/i
  // Phase switch detection: user explicitly changes task direction
  const phaseSwitchPattern =
    /(先.*不要|先.*别|暂停|换个.*方向|先做|先修|先处理|改做|改为|转而|切换.*任务|switch.*task|change.*direction|scrap.*that|new.*plan|重新.*计划)/i

  // Phase 8: Multimodal input patterns
  const multimodalPattern =
    /(截图|screenshot|图片|image|photo|网页.*(?:视觉|截图|布局)|webpage.*visual|PPT.*(?:图示|figure|截图)|slides?.*figure|流程图|flowchart|图表|chart|graph|视频|video|音频|audio|录音|UI.*(?:截图|视觉|screenshot)|界面.*(?:截图|视觉)|\.(?:png|jpg|jpeg|gif|webp|bmp|mp4|mov|avi|webm|mp3|wav|ogg)\b)/i
  const highRiskTaskPattern =
    /(provider|routing|route|gate|evidence|result ledger|dedup|permission|secrets?|auth|model switching|role model|doctor failed|quota|cost policy|MCP runtime|上游同步|远程发布|删除|覆盖|破坏性|权限|凭据|模型切换|结果账本|证据|审查路由)/i

  const SCANNABLE_TOOLS = new Set(["bash", "edit", "write", "task"])
  const toolErrors: string[] = []
  let permissionDenied = 0
  for (const message of recent) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
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
  const verificationEvidence = evidencePattern.test(allText)
  const realToolEvidence = verifiedToolEvidence(messages)
  const reviewerConflictSignal = conflictPattern.test(allText)
  const longContextSignal = (() => {
    // 防止审查员名称导致误触发：
    // 当文本以 [dll-agent supervisor auto-trigger] 或 [dll-agent finalization 开头，
    // 说明这是系统注入的 compact context / reviewer prompt，不应触发长上下文审查。
    // 额外的保护：当 allText 很短（< 200 字符）且无非上下文关键词（排除单独出现 "context"），
    // 不触发，避免指挥官回复"审查员确认了 context..."一行触发无限循环。
    if (contextPercent >= 40) return true
    if (longContextPattern.test(allText)) {
      // "context" 单独出现且文本很短 → 很可能是对审查员的引用，不是真正的长上下文任务
      const isBareContextWord = /^context$/im.test(allText) && allText.length < 500
      if (isBareContextWord) return false
      // "长上下文" + "审查员" 同时出现 → 是对审查员的引用
      if (/长上下文.*审查员/i.test(allText)) return false
      return true
    }
    return false
  })()
  const highRiskTaskSignal = highRiskTaskPattern.test(allText)
  const multimodalSignal = multimodalPattern.test(allText)
  const trivialNoToolTask =
    isTrivialNoToolPromptText(lastUserText) &&
    !recentUserCorrection &&
    userCorrections === 0 &&
    toolErrors.length === 0 &&
    ![...repeated.values()].some((count) => count >= 2) &&
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
    repeatedToolFailure: [...repeated.values()].some((count) => count >= 2),
    contextTokens,
    contextPercent,
    longContextSignal,
    finalClaim,
    verificationEvidence,
    realToolEvidence,
    reviewerConflictSignal,

    // Phase 6: New trigger signals
    // Kimi completion check: final claim + any unfinished indicator
    kimiCompletionCheckSignal: finalClaimPattern.test(lastAssistantText) && unfinishedPattern.test(lastAssistantText),
    // GLM completion claim check: final claim + (no real tool evidence OR medium+ risk implied)
    glmCompletionClaimSignal:
      finalClaim &&
      (!realToolEvidence || correctionPattern.test(lastAssistantText)),
    // Kimi pre-report: context >=30% AND final claim (proactive compression before report)
    kimiPreReportSignal: contextPercent >= 30 && finalClaim,
    // Scope expansion: detected only via explicit scope expansion patterns (not generic corrections)
    scopeExpandedSignal: scopeExpansionPattern.test(allText),
    // Phase switch: user changes direction explicitly
    phaseSwitchSignal: phaseSwitchPattern.test(lastUserText),
    // Phase 8: Multimodal input signal
    multimodalSignal,
    highRiskTaskSignal,
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
