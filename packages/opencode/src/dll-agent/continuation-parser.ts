import type { UnfinishedItem, UnfinishedKind } from "./interfaces"

const UNFINISHED_INDICATOR_PATTERNS: RegExp[] = [
  /未完成\s*[：:]/i,
  /待完成\s*[：:]/i,
  /下一步\s*(建议|任务|计划)\s*[：:]/i,
  /后续\s*(任务|工作|计划)\s*[：:]/i,
  /TODO\s*[：:]/i,
  /roadmap/i,
  /下轮\s*[：:]/i,
  /仍有.*(待|未).*完成/i,
  /尚未.*(完成|实现|修复|接入)/i,
  /(still|remains)\s+(pending|todo|incomplete|unresolved)/i,
  /推迟/i,
  /不在.*(本轮|本次).*范围/i,
  /需要.*(继续|进一步|下一步)/i,
  /(must|should|need|require)\s+(be|to)\s+(complete|finish|implement|fix)/i,
]

const BLOCKING_UNFINISHED_PATTERNS: RegExp[] = [
  /核心\s*(功能|目标|任务).*未/i,
  /关键\s*(bridge|桥接|模块).*未.*接入/i,
  /final\s*gate.*(未|失败|not)/i,
  /(test|测试).*未.*(运行|通过|run|pass)/i,
  /doctor.*(failed|失败)/i,
  /reviewer.*(block|阻断|blocking)/i,
  /permission.*(未|not).*(接入|connected|wired)/i,
  /(LSP|lsp).*(未|not).*(接入|launch|wired)/i,
  /cross[- ]?review.*(未|not).*(接入|connected)/i,
  /(纯函数|pure\s*function).*(岛屿|island)/i,
  /clean\s*(up|up).*未完成/i,
  /需要.*(集成测试|integration\s*test)/i,
  /(blocking|阻断).*(unfinished|未完成)/i,
  /project\s*overlay.*未.*加载/i,
  /ux[- ]?(state|状态).*(未|not).*(接入|wired|rendered)/i,
  /(未.*接入|not.*wired|not.*connected).*(运行路径|runtime|session\s*loop)/i,
]

const USER_INPUT_PATTERNS: RegExp[] = [
  /需要.*(token|API\s*key|登录|login|凭据|credential)/i,
  /需要.*(破坏性|destructive).*操作/i,
  /需要.*(push|release|发布)/i,
  /需要.*(确认|authorize|approve)/i,
  /需要.*(全局|global|system)/i,
  /超出.*(预算|budget|cost)/i,
  /(需求互斥|相互矛盾)/i,
  /无法.*(自动|判断|auto)/i,
]

export function detectUnfinishedIndicators(text: string): {
  hasUnfinished: boolean
  matchedPatterns: string[]
} {
  const scanText = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join("\n")
  const matchedPatterns: string[] = []
  for (const pattern of UNFINISHED_INDICATOR_PATTERNS) {
    const match = scanText.match(pattern)
    if (match) {
      matchedPatterns.push(match[0])
    }
  }
  return {
    hasUnfinished: matchedPatterns.length > 0,
    matchedPatterns,
  }
}

export function classifyUnfinishedItem(description: string, defaultKind?: UnfinishedKind): UnfinishedKind {
  for (const pattern of BLOCKING_UNFINISHED_PATTERNS) {
    if (pattern.test(description)) return "blocking_unfinished"
  }
  for (const pattern of USER_INPUT_PATTERNS) {
    if (pattern.test(description)) return "requires_user_input"
  }
  return defaultKind ?? "non_blocking_followup"
}

export function extractUnfinishedItems(
  text: string,
  currentPhase: string,
): UnfinishedItem[] {
  const items: UnfinishedItem[] = []
  const lines = text.split("\n")
  let inUnfinishedSection = false
  let sectionKind: UnfinishedKind = "non_blocking_followup"

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith("|")) continue
    const isListLine = /^[-*•]\s+|^\d+[.)]\s+/.test(line)
    if (/^#+\s*(最终报告|验证结果|已实现|部分实现|未实现|当前状态|状态说明|final report|verification|implemented|partial|not implemented)/i.test(line)) {
      inUnfinishedSection = false
      sectionKind = "non_blocking_followup"
      continue
    }

    const blockingMatch = line.match(
      /(blocking.*unfinished|阻断.*未完成|blocked|P1|核心.*未完成)/i,
    )
    const userInputMatch = line.match(
      /(requires.*user|需要.*用户|需.*介入|user.*input)/i,
    )
    const followupMatch = line.match(
      /(non.?blocking|下一步|follow.?up|后续|P2|P3|roadmap)/i,
    )
    const unfinishedMatch = line.match(/^(#+\s*)?(未完成|待完成|TODO|todo|unfinished|incomplete)\s*[:：]?$/i)

    if (!isListLine && blockingMatch) {
      inUnfinishedSection = true
      sectionKind = "blocking_unfinished"
      continue
    }
    if (!isListLine && userInputMatch) {
      inUnfinishedSection = true
      sectionKind = "requires_user_input"
      continue
    }
    if (!isListLine && followupMatch) {
      inUnfinishedSection = true
      sectionKind = "non_blocking_followup"
      continue
    }
    if (!isListLine && unfinishedMatch) {
      inUnfinishedSection = true
      sectionKind = "non_blocking_followup"
      continue
    }

    const itemMatch = line.match(/^[-*•]\s+(.+)$|^\d+[.)]\s+(.+)$/)
    if (!itemMatch) continue

    const description = (itemMatch[1] || itemMatch[2] || itemMatch[3] || "").trim()
    if (description.length < 3) continue

    let kind: UnfinishedKind = sectionKind
    if (inUnfinishedSection) {
      kind = classifyUnfinishedItem(description, sectionKind)
    } else {
      kind = classifyUnfinishedItem(description, "non_blocking_followup")
    }

    const item: UnfinishedItem = {
      id: `unfinished_${items.length + 1}`,
      kind,
      description,
      why_blocking: kind === "blocking_unfinished" ? "Detected blocking pattern in completion report" : undefined,
      evidence_refs: [currentPhase],
      required_action: `Address: ${description}`,
      recommended_role: kind === "blocking_unfinished"
        ? "chief-engineer"
        : kind === "requires_user_input"
        ? "requirements-inspector"
        : "chief-engineer",
      verification_required: [],
      risk_level: kind === "blocking_unfinished"
        ? "high"
        : kind === "requires_user_input"
        ? "medium"
        : "low",
    }
    items.push(item)
  }

  return items
}
