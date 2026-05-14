/**
 * dll-agent Capability Planner
 *
 * 从用户任务中动态推断所需能力，在 registry 中自动选型。
 * 不再依赖硬编码的任务分类器——新能力只要在 registry 中声明就能被选中。
 *
 * Planner 输入：
 *   - 用户目标文本
 *   - 当前项目类型
 *   - 当前文件类型
 *   - 当前失败类型
 *   - 可用能力 registry
 *   - 风险/成本预算
 *
 * Planner 输出：
 *   - 需要的能力标签集合
 *   - 候选能力列表（排序后）
 *   - 自动安装/启动建议
 *   - 不可满足缺口
 */

import type { CapabilityEntry, CapabilityRiskLevel, CapabilityCostLevel } from "./capability-schema"
import { findByCapability } from "./capability-registry"

// ─── Task Analysis Input ────────────────────────────────────────────────────────

export interface TaskContext {
  /** User's goal text */
  user_goal: string
  /** Project type (e.g. "typescript", "python", "rust") */
  project_type?: string
  /** File extensions currently involved */
  file_extensions?: string[]
  /** Current failure/error pattern */
  failure_type?: string
  /** Excluded risk levels beyond budget */
  max_risk?: CapabilityRiskLevel
  /** Maximum cost level */
  max_cost?: CapabilityCostLevel
  /** Platform constraint */
  platform?: string
}

export interface CapabilityPlan {
  /** Required semantic capability tags */
  required_tags: string[]
  /** Selected capability entries (sorted by match quality) */
  selected: MatchedCapability[]
  /** Alternatives that could serve the same need */
  alternatives: MatchedCapability[]
  /** Ordered multi-capability workflow, when more than one role is useful */
  workflow: CapabilityWorkflowStep[]
  /** Capabilities that are needed but unavailable */
  gaps: CapabilityGap[]
  /** Suggested auto-install actions */
  install_suggestions: InstallSuggestion[]
  /** Explanation of the planning decision */
  rationale: string
}

export interface MatchedCapability {
  entry: CapabilityEntry
  /** Match score 0-100 */
  score: number
  /** Why this capability was selected */
  reason: string
  /** Whether it's immediately usable */
  ready: boolean
}

export interface CapabilityWorkflowStep {
  phase: "primary" | "support" | "validation" | "fallback"
  entry_id: string
  kind: CapabilityEntry["kind"]
  reason: string
  required: boolean
}

export interface CapabilityGap {
  /** Required semantic tag */
  tag: string
  /** Why it's needed */
  reason: string
  /** Minimal requirement to fill the gap */
  requirement: string
}

export interface InstallSuggestion {
  entry_id: string
  action: "auto_install" | "auto_start" | "ask_permission" | "degrade" | "skip"
  reason: string
  risk: CapabilityRiskLevel
}

// ─── Task-to-Capability Tag Inference ───────────────────────────────────────────

interface TagRule {
  /** Semantic capability tag */
  tag: string
  /** Patterns that suggest this capability is needed */
  patterns: RegExp[]
  /** File extensions that suggest this */
  file_extensions?: string[]
  /** Why this tag is relevant */
  description: string
}

const TAG_RULES: TagRule[] = [
  // Automation & Testing
  { tag: "browser-automation", patterns: [/browser|浏览器|playwright|puppeteer|e2e|端到端.*测试|截图.*验证|页面.*交互|点击流|前端审查|ui.*audit|console.*audit|network.*inspect/i], file_extensions: [".spec.ts", ".e2e.ts"], description: "Browser automation needed" },
  { tag: "typecheck", patterns: [/typecheck|类型检查|tsgo|noEmit|type.*check/i], file_extensions: [".ts", ".tsx"], description: "Type checking needed" },
  { tag: "lint", patterns: [/lint|eslint|prettier|format|格式化/i], file_extensions: [".ts", ".tsx", ".js", ".jsx"], description: "Linting needed" },
  { tag: "test", patterns: [/test|测试|bun test|vitest|pytest|验证/i], file_extensions: [".test.ts", ".spec.ts"], description: "Testing needed" },
  { tag: "build", patterns: [/build|构建|compile|编译|bun run build/i], description: "Build needed" },

  // GitHub & CI
  { tag: "github-api", patterns: [/github|issue|pull.*request|pr\b|release|workflow|github\.com/i], description: "GitHub operations needed" },
  { tag: "pr-management", patterns: [/pr\b|pull.*request|merge|review.*request/i], description: "PR management needed" },

  // Monitoring
  { tag: "process-monitor", patterns: [/监控|端口.*冲突|进程.*检查|ps\b|lsof|top\b/i], description: "Process monitoring needed" },
  { tag: "health-check", patterns: [/健康检查|healthcheck|health.*check|服务.*状态/i], description: "Health check needed" },

  // Diagnostics
  { tag: "repo-health", patterns: [/项目.*乱|repo.*health|诊断|diagnose|repo.*doctor|跑不起来/i], description: "Repository diagnostics needed" },
  { tag: "diagnostic", patterns: [/debug|诊断|排查|定位.*问题|fix|修复|error/i], description: "Diagnostics needed" },

  // Security
  { tag: "secret-detection", patterns: [/api[_-]?key|token|password|secret|脱敏|redact|credentials/i], description: "Secret detection needed" },

  // Engineering
  { tag: "self-repair", patterns: [/dll-agent.*启动失败|wrapper.*broken|supervisor.*broken|evidence.*写入.*异常/i], description: "dll-agent self-repair needed" },
  { tag: "cross-review", patterns: [/连续.*失败|需求.*冲突|实现.*冲突|reviewer.*conflict/i], description: "Cross-review needed" },
]

/**
 * Analyze user goal text to extract required capability tags.
 * Uses two-phase approach:
 *   1. Semantic TAG_RULES (base layer, cover common patterns)
 *   2. Registry entry triggers scan (auto-discovers capability tags from
 *      any entry whose triggers match the task — no rule editing needed)
 */
function analyzeTask(
  registry: CapabilityEntry[],
  userGoal: string,
  fileExtensions?: string[],
): { tags: string[]; reasons: Map<string, string> } {
  const tags = new Set<string>()
  const reasons = new Map<string, string>()
  const registryMatchedExtensions = new Set<string>()

  // Phase 1: Semantic TAG_RULES
  for (const rule of TAG_RULES) {
    let matched = false
    let reason = ""

    for (const pattern of rule.patterns) {
      if (pattern.test(userGoal)) {
        matched = true
        reason = rule.description
        break
      }
    }

    if (!matched && rule.file_extensions && fileExtensions) {
      for (const ext of fileExtensions) {
        if (rule.file_extensions.includes(ext)) {
          matched = true
          reason = `File type ${ext} detected`
          break
        }
      }
    }

    if (matched) {
      tags.add(rule.tag)
      reasons.set(rule.tag, reason)
    }
  }

  // Phase 2: Registry trigger scan — auto-discover capabilities
  // New entries with proper triggers get picked up without modifying TAG_RULES
  for (const entry of registry) {
    if (!entry.triggers) continue
    const trigger = entry.triggers

    // Keyword match
    if (trigger.keywords) {
      for (const kw of trigger.keywords) {
        try {
          if (new RegExp(kw, "i").test(userGoal)) {
            for (const cap of entry.capabilities) {
              if (!tags.has(cap)) {
                tags.add(cap)
                reasons.set(cap, `auto-matched via registry trigger: ${entry.id}`)
              }
            }
            break
          }
        } catch {
          // If the stored keyword isn't a valid regex, try literal match
          if (userGoal.toLowerCase().includes(kw.toLowerCase())) {
            for (const cap of entry.capabilities) {
              if (!tags.has(cap)) {
                tags.add(cap)
                reasons.set(cap, `auto-matched via registry keyword: ${entry.id}`)
              }
            }
            break
          }
        }
      }
    }

    // File extension match
    if (trigger.file_extensions && fileExtensions) {
      for (const ext of fileExtensions) {
        const normalExt = ext.startsWith(".") ? ext : `.${ext}`
        if (trigger.file_extensions.includes(normalExt)) {
          registryMatchedExtensions.add(normalExt)
          for (const cap of entry.capabilities) {
            if (!tags.has(cap)) {
              tags.add(cap)
              reasons.set(cap, `auto-matched via registry file extension: ${entry.id}`)
            }
          }
        }
      }
    }
  }

  // If a concrete file type is present but no registered capability declares
  // support for it, create a generic capability gap from the extension itself.
  // This keeps unknown future artifacts visible without listing every file type
  // in source code.
  for (const ext of fileExtensions ?? []) {
    const normalExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    if (registryMatchedExtensions.has(normalExt)) continue
    const tag = `${normalExt.slice(1)}-read`
    if (tags.has(tag)) continue
    tags.add(tag)
    reasons.set(tag, `File type ${normalExt} detected without a registered matching capability`)
  }

  return { tags: [...tags], reasons }
}

// ─── Capability Scoring ─────────────────────────────────────────────────────────

function scoreCapability(entry: CapabilityEntry, requiredTags: string[]): number {
  let score = 0

  // Tag match: each matched tag adds 15 points
  const matchedTags = entry.capabilities.filter((c) => requiredTags.includes(c))
  score += matchedTags.length * 15

  // Bonus for "available" status
  if (entry.status === "available" || entry.status === "running") score += 20
  else if (entry.status === "registered") score += 10
  else if (entry.status === "missing_dependency") score += 0

  // Bonus for builtin/manifest sources (more trustworthy)
  if (entry.source_type === "builtin") score += 10
  else if (entry.source_type === "manifest" || entry.source_type === "local-scan") score += 5

  // Bonus for higher confidence
  score += Math.round(entry.confidence * 10)

  // Penalty for high risk if we might not need it
  if (entry.risk_level === "high" && matchedTags.length === 0) score -= 5

  // Platform match bonus
  if (entry.platforms.includes("any") || entry.platforms.includes(process.platform as any)) score += 5

  return Math.min(score, 100)
}

const PLAIN_OUTPUT_TYPES = new Set(["text", "json", "diagnostic", "diagnostics", "evidence", "review-output"])
const VALIDATION_CAPABILITY_TOKENS = [
  "verify",
  "verification",
  "validate",
  "validation",
  "audit",
  "inspect",
  "check",
  "consistency",
  "render",
  "preview",
]

function isArtifactCapability(entry: CapabilityEntry): boolean {
  const consumesFile = entry.input_types.some((item) => item === "file-path" || item.startsWith("."))
  const producesArtifact = entry.output_types.some((item) => !PLAIN_OUTPUT_TYPES.has(item.toLowerCase()))
  return consumesFile || producesArtifact
}

function isValidationCapability(entry: CapabilityEntry): boolean {
  return !!entry.verify_commands?.length
    || entry.capabilities.some((item) => {
      const normalized = item.toLowerCase()
      return VALIDATION_CAPABILITY_TOKENS.some((token) => normalized.includes(token))
    })
}

function consumesSelectedOutput(entry: CapabilityEntry, selected: MatchedCapability[]): boolean {
  const inputs = new Set(entry.input_types.map((item) => item.toLowerCase()))
  return selected.some((match) =>
    match.entry.id !== entry.id
    && match.entry.output_types.some((item) => inputs.has(item.toLowerCase())),
  )
}

function buildWorkflow(
  selected: MatchedCapability[],
  alternatives: MatchedCapability[],
  gaps: CapabilityGap[],
): CapabilityWorkflowStep[] {
  const steps: CapabilityWorkflowStep[] = []
  for (const match of selected) {
    steps.push({
      phase: "primary",
      entry_id: match.entry.id,
      kind: match.entry.kind,
      reason: match.reason,
      required: true,
    })

    if (isArtifactCapability(match.entry)) {
      steps.push({
        phase: "support",
        entry_id: match.entry.id,
        kind: match.entry.kind,
        reason: "artifact capability may need extraction, transformation, and output generation steps",
        required: false,
      })
    }

    if (isValidationCapability(match.entry) || consumesSelectedOutput(match.entry, selected) || isArtifactCapability(match.entry)) {
      steps.push({
        phase: "validation",
        entry_id: match.entry.id,
        kind: match.entry.kind,
        reason: match.entry.verify_commands?.length
          ? "capability declares verification commands"
          : "artifact output should be validated before final response",
        required: false,
      })
    }
  }

  for (const match of alternatives) {
    steps.push({
      phase: "fallback",
      entry_id: match.entry.id,
      kind: match.entry.kind,
      reason: `alternative capability: ${match.reason}`,
      required: false,
    })
  }

  for (const gap of gaps) {
    steps.push({
      phase: "fallback",
      entry_id: `capability-gap:${gap.tag}`,
      kind: "tool",
      reason: gap.requirement,
      required: true,
    })
  }

  const seen = new Set<string>()
  return steps.filter((step) => {
    const key = `${step.phase}:${step.entry_id}:${step.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── Main Planning Function ─────────────────────────────────────────────────────

/**
 * Plan capabilities for a given task context.
 * Returns selected capabilities, alternatives, gaps, and install suggestions.
 */
export function planCapabilities(
  registry: CapabilityEntry[],
  context: TaskContext,
): CapabilityPlan {
  const { tags, reasons } = analyzeTask(registry, context.user_goal, context.file_extensions)

  // Find all capabilities matching required tags
  const matching = new Map<string, MatchedCapability[]>()
  for (const tag of tags) {
    const candidates = findByCapability(registry, tag)
    const scored = candidates
      .map((entry) => ({
        entry,
        score: scoreCapability(entry, tags),
        reason: reasons.get(tag) ?? "matched capability tag",
        ready: entry.status === "available" || entry.status === "running",
      }))
      .sort((a, b) => b.score - a.score)
    matching.set(tag, scored)
  }

  // Select best option for each tag
  const selected: MatchedCapability[] = []
  const alternatives: MatchedCapability[] = []
  const seenIds = new Set<string>()

  for (const [, candidates] of matching) {
    const best = candidates[0]
    if (!best) continue
    if (!seenIds.has(best.entry.id)) {
      selected.push(best)
      seenIds.add(best.entry.id)
    }
    // Push remaining as alternatives
    if (candidates.length > 1) {
      for (const c of candidates.slice(1)) {
        if (!seenIds.has(c.entry.id)) {
          alternatives.push(c)
          seenIds.add(c.entry.id)
        }
      }
    }
  }

  // Identify gaps: tags with no candidates
  const gaps: CapabilityGap[] = []
  for (const tag of tags) {
    const candidates = matching.get(tag)
    if (!candidates || candidates.length === 0) {
      gaps.push({
        tag,
        reason: reasons.get(tag) ?? "needed for task",
        requirement: `No capability found for tag: ${tag}`,
      })
    }
  }

  // Generate install suggestions for capabilities that are not ready
  const installSuggestions: InstallSuggestion[] = []
  for (const m of selected) {
    if (!m.ready) {
      const action = m.entry.install_strategy === "none" ? "ask_permission"
        : m.entry.risk_level === "high" ? "ask_permission"
        : m.entry.install_strategy === "system_package_manager" ? "ask_permission"
        : "auto_install"

      installSuggestions.push({
        entry_id: m.entry.id,
        action,
        reason: `${m.entry.id} is ${m.entry.status}, needs ${m.entry.install_strategy}`,
        risk: m.entry.risk_level,
      })
    }
  }

  const rationale = [
    `Analyzed user goal: "${context.user_goal.slice(0, 80)}..."`,
    `Required capability tags: [${tags.join(", ")}]`,
    `Selected ${selected.length} capabilities from registry`,
    `Found ${gaps.length} capability gaps`,
    `Generated ${installSuggestions.length} install suggestions`,
  ].join("; ")
  const workflow = buildWorkflow(selected, alternatives, gaps)

  return {
    required_tags: tags,
    selected,
    alternatives,
    workflow,
    gaps,
    install_suggestions: installSuggestions,
    rationale,
  }
}

/**
 * Quick check: does the registry have at least one entry per required capability tag?
 */
export function checkCoverage(
  registry: CapabilityEntry[],
  requiredTags: string[],
): { covered: string[]; uncovered: string[] } {
  const covered: string[] = []
  const uncovered: string[] = []

  for (const tag of requiredTags) {
    const matches = findByCapability(registry, tag)
    if (matches.length > 0) covered.push(tag)
    else uncovered.push(tag)
  }

  return { covered, uncovered }
}
