/**
 * dll-agent Tool Prompt
 *
 * 最小 prompt 注入策略：全局默认只注入工具目录索引，不注入完整工具说明。
 *
 * 策略：
 *   1. 全局工具索引不超过 1200 中文字符（index_max_chars）
 *   2. 单个工具详细说明不超过 1500 中文字符（tool_detail_max_chars）
 *   3. 每轮工具说明总注入不超过 3000 中文字符（per_round_max_chars）
 *   4. 超出时只注入摘要和命令入口
 *
 * 触发详细说明的来源：
 *   - 用户明确提到工具名
 *   - 当前任务文件类型匹配
 *   - supervisor signals
 *   - doctor 失败
 *   - 测试失败
 *   - 浏览器/端到端测试需求
 *   - GitHub/CI/PR/issue 需求
 */

import type { ToolEntry, PromptInjectionPolicy } from "./tool-catalog"
import type { EffectiveManifest } from "./tool-overlay"

// ─── Prompt Index Builder ─────────────────────────────────────────────────────

/**
 * 从 effective manifest 构建全局工具目录索引（短版，用于 system prompt）。
 * 只注入 injection_policy 为 "always" 的条目和 on_demand 条目的摘要行。
 */
export function buildPromptIndex(manifest: EffectiveManifest): string {
  const lines: string[] = []
  let totalChars = 0
  const maxChars = manifest.prompt.index_max_chars

  // Always tools first
  const alwaysTools = manifest.tools.filter(
    (t) => t.injection_policy === "always",
  )

  if (alwaysTools.length > 0) {
    for (const t of alwaysTools) {
      const line = `- ${t.name}: ${t.prompt_index}`
      if (totalChars + line.length <= maxChars) {
        lines.push(line)
        totalChars += line.length
      }
    }
  }

  // On-demand tools as compact summary
  const onDemandTools = manifest.tools.filter(
    (t) => t.injection_policy === "on_demand",
  )

  if (onDemandTools.length > 0) {
    lines.push("")
    lines.push("Available skills & tools (loaded on-demand):")
    const summaryItems: string[] = []
    for (const t of onDemandTools) {
      summaryItems.push(t.name)
    }
    const summary = summaryItems.join(", ")
    lines.push(summary)
  }

  return lines.join("\n")
}

/**
 * 构建当前轮次需要注入的工具详细说明。
 * 根据触发上下文选择哪些工具需要详细说明。
 */
export interface TriggerContext {
  /** 用户消息文本 */
  user_message?: string
  /** 当前任务涉及的文件扩展名 */
  file_extensions?: string[]
  /** 任务关键词 */
  task_keywords?: string[]
  /** supervisor 信号 */
  signals?: string[]
  /** 是否有测试失败 */
  test_failure?: boolean
  /** 是否有 doctor 失败 */
  doctor_failure?: boolean
  /** 是否需要浏览器/端到端测试 */
  browser_needed?: boolean
  /** 是否有 GitHub/CI/PR/issue 需求 */
  github_needed?: boolean
}

/**
 * 根据触发上下文选择需要详细说明的 tools。
 */
export function selectToolsForDetail(
  manifest: EffectiveManifest,
  context: TriggerContext,
): ToolEntry[] {
  const selected: ToolEntry[] = []
  const seen = new Set<string>()

  for (const tool of manifest.tools) {
    if (tool.injection_policy === "never") continue
    if (seen.has(tool.id)) continue

    let shouldInclude = tool.injection_policy === "always"

    if (!shouldInclude && tool.injection_policy === "on_demand") {
      shouldInclude = matchesTrigger(tool, context)
    }

    if (shouldInclude) {
      selected.push(tool)
      seen.add(tool.id)
    }
  }

  return selected
}

/**
 * 检查 tool 是否匹配当前触发上下文。
 */
function matchesTrigger(tool: ToolEntry, context: TriggerContext): boolean {
  // User message keyword match
  if (context.user_message) {
    for (const kw of tool.triggers.keywords ?? []) {
      if (kw.test(context.user_message)) return true
    }
  }

  // File extension match
  if (context.file_extensions) {
    for (const ext of context.file_extensions) {
      if (tool.triggers.file_extensions?.includes(ext)) return true
    }
  }

  // Task keywords match
  if (context.task_keywords) {
    for (const kw of context.task_keywords) {
      for (const pattern of tool.triggers.task_patterns ?? []) {
        if (pattern.includes(kw) || kw.includes(pattern)) return true
      }
    }
  }

  // Signal-based: test failure → test-gate, engineering-test
  if (context.test_failure) {
    if (tool.id === "test-gate" || tool.id === "engineering-test") return true
  }

  // Signal-based: doctor failure → repo-doctor
  if (context.doctor_failure) {
    if (tool.id === "repo-doctor") return true
  }

  // Browser/E2E needed → playwright
  if (context.browser_needed) {
    if (tool.id === "playwright") return true
  }

  // GitHub needed → github
  if (context.github_needed) {
    if (tool.id === "github") return true
  }

  return false
}

/**
 * 构建详细工具说明文本。
 * 限制：单个工具 ≤ tool_detail_max_chars，总注入 ≤ per_round_max_chars。
 */
export function buildDetailPrompt(
  manifest: EffectiveManifest,
  selected: ToolEntry[],
): string {
  if (selected.length === 0) return ""

  const parts: string[] = []
  let totalChars = 0
  const maxPerTool = manifest.prompt.tool_detail_max_chars
  const maxTotal = manifest.prompt.per_round_max_chars

  for (const tool of selected) {
    const detail = tool.prompt_detail.slice(0, maxPerTool)
    if (totalChars + detail.length > maxTotal) {
      // Inject summary instead
      parts.push(`- ${tool.name}: ${tool.prompt_index.slice(0, 200)}`)
      continue
    }
    parts.push(`## ${tool.name}\n${detail}`)
    totalChars += detail.length
  }

  return parts.join("\n\n")
}

/**
 * 一站式函数：根据 context 生成本轮的 tool prompt。
 * 返回 { index, detail } — index 用于 system prompt，detail 用于本轮消息注入。
 */
export function generateToolPrompt(
  manifest: EffectiveManifest,
  context: TriggerContext,
): { index: string; detail: string } {
  const index = buildPromptIndex(manifest)
  const selected = selectToolsForDetail(manifest, context)
  const detail = buildDetailPrompt(manifest, selected)
  return { index, detail }
}

/**
 * 检测用户消息中是否包含工具触发关键词。
 * 返回匹配的 tool ids。
 */
export function detectToolTriggers(
  manifest: EffectiveManifest,
  userMessage: string,
): string[] {
  const triggered: string[] = []
  for (const tool of manifest.tools) {
    for (const kw of tool.triggers.keywords ?? []) {
      if (kw.test(userMessage)) {
        triggered.push(tool.id)
        break
      }
    }
  }
  return triggered
}

/**
 * 从文件扩展名检测可能需要的工具。
 * 返回匹配的 tool ids。
 */
export function detectFileTypeTriggers(
  manifest: EffectiveManifest,
  extensions: string[],
): string[] {
  const triggered: string[] = []
  for (const ext of extensions) {
    const normalExt = ext.startsWith(".") ? ext : `.${ext}`
    for (const tool of manifest.tools) {
      if (tool.triggers.file_extensions?.includes(normalExt)) {
        triggered.push(tool.id)
      }
    }
  }
  return [...new Set(triggered)]
}
