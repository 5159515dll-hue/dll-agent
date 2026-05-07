/**
 * dll-agent Tool Catalog
 *
 * 全局默认 tools / MCP / commands 声明的纯数据层。
 * "默认注册"不等于"默认启动"，"默认可用"不等于"默认注入完整说明"。
 *
 * Schema 定义：
 *   McpStartPolicy: "disabled" | "on_demand" | "autostart_lightweight"
 *   PromptInjectionPolicy: "always" | "on_demand" | "never"
 *   McpHeavyCriteria: 重型 MCP 定义（浏览器/端口/常驻/网络/私有 repo/大日志/高 CPU）
 *
 * Merge 优先级（在 tool-overlay.ts 中实现）：
 *   1. 内置安全 denylist 最高
 *   2. project remove 高于 global default
 *   3. project override 高于 global 同名 MCP
 *   4. project add 追加能力
 *   5. global default 提供基础能力
 *   6. 未声明能力不自动启用
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type McpStartPolicy = "disabled" | "on_demand" | "autostart_lightweight"
export type PromptInjectionPolicy = "always" | "on_demand" | "never"
export type ToolKind = "skill" | "tool" | "mcp" | "command"

export interface McpEntry {
  /** MCP server 唯一名 */
  name: string
  /** 启动命令 */
  command?: string[]
  /** 环境变量模板（不含实际 secrets） */
  env_keys?: string[]
  /** 健康检查 URL 模板 */
  health_url?: string
  /** 是否需要 isolated 运行 */
  isolated: boolean
  /** 互斥锁 key */
  mutex_key?: string
  /** 启动策略 */
  start_policy: McpStartPolicy
  /** 是否为重型工具 */
  heavy: boolean
  /** 重型标签 */
  heavy_reasons?: string[]
  /** 是否需要用户确认才能启动 */
  requires_consent: boolean
  /** 失败降级描述 */
  degrade_description?: string
}

export interface ToolEntry {
  /** 唯一 id，kebab-case */
  id: string
  /** 人类可读名称 */
  name: string
  /** 一行中文描述 */
  description: string
  /** 工具类型 */
  kind: ToolKind
  /** 风险级别 */
  risk_level: "low" | "medium" | "high"
  /** 触发关键词（用于 on-demand prompt 加载） */
  triggers: {
    keywords?: RegExp[]
    file_extensions?: string[]
    task_patterns?: string[]
  }
  /** prompt 注入策略 */
  injection_policy: PromptInjectionPolicy
  /** 关联的 MCP（如果 kind=mcp） */
  mcp_ref?: string
  /** 关联的 MCP 完整配置（如果 kind=mcp） */
  mcp?: McpEntry
  /** 关联的 skill id（如果通过 skill 触发） */
  skill_ref?: string
  /** 简短 prompt index 描述（≤200 字符） */
  prompt_index: string
  /** 详细说明（≤1500 中文字符） */
  prompt_detail: string
  /** 所需能力但不一定启动的东西 */
  requirements?: {
    binaries?: string[]
    tokens?: string[]
    ports?: number[]
  }
  /** 安全策略 */
  security: {
    /** 是否需要脱敏 */
    require_redaction: boolean
    /** 是否允许网络请求 */
    allow_network: boolean
    /** 是否需要用户确认 */
    require_consent: boolean
  }
}

// ─── Tool Manifest Schema ─────────────────────────────────────────────────────

export interface ToolManifest {
  version: 1
  /** 工具声明列表 */
  tools: ToolEntry[]
  /** prompt 注入上限 */
  prompt: {
    /** 全局工具索引最大字符数 */
    index_max_chars: number
    /** 单个工具详细说明最大字符数 */
    tool_detail_max_chars: number
    /** 每轮工具说明总注入最大字符数 */
    per_round_max_chars: number
  }
  /** 安全配置 */
  security: {
    /** 禁止的命令模式 */
    deny_commands: string[]
    /** 密钥脱敏模式 */
    secret_redaction: boolean
  }
  /** 启动策略配置 */
  startup: {
    /** 默认 policy */
    autostart_policy: McpStartPolicy
  }
  /** 特性开关 */
  features: {
    evidence: boolean
    doctor: boolean
  }
}

// ─── Global Default Tool Catalog ──────────────────────────────────────────────

/**
 * 全局默认工具目录。
 * 这是纯声明数据——不启动任何 MCP，不注入完整 prompt。
 * 所有重型 MCP（Playwright、observability）标记为 on_demand。
 */
export const GLOBAL_DEFAULT_TOOLS: ToolEntry[] = [
  // ── 文档与制品处理能力（skill/tool 为主，不默认启动 MCP）──
  {
    id: "doc-docx",
    name: "doc/docx",
    description: "Word 文档读取、整理、生成、格式检查",
    kind: "tool",
    risk_level: "low",
    triggers: {
      keywords: [/\.docx?$/i, /word.*文档|docx|\.doc\b/i],
      file_extensions: [".doc", ".docx"],
      task_patterns: ["文档整理", "格式修复", "Word 生成"],
    },
    injection_policy: "on_demand",
    skill_ref: "docs-sync",
    prompt_index: "doc/docx：可用于 Word 文档读取、整理、生成、格式检查。",
    prompt_detail:
      "doc/docx 能力：使用 python-docx 或等效库读写 Word 文档。支持读取段落、表格、样式、页眉页脚。可生成新文档、修改现有文档、检查格式一致性。处理文档时必须保留原文件，输出新文件；不允许无备份覆盖源文件。",
    requirements: { binaries: ["python3"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "pdf",
    name: "pdf",
    description: "PDF 文档读取、提取、生成、转换",
    kind: "tool",
    risk_level: "low",
    triggers: {
      keywords: [/\.pdf$/i, /pdf/i],
      file_extensions: [".pdf"],
      task_patterns: ["PDF 读取", "PDF 转换", "PDF 提取"],
    },
    injection_policy: "on_demand",
    prompt_index: "pdf：可用于 PDF 文档读取、文本提取、生成、格式转换。",
    prompt_detail:
      "pdf 能力：使用 PyPDF2/pdfplumber/pymupdf 等库读取 PDF。支持文本提取、表格识别、元数据读取。可生成 PDF 报告。处理时必须保留原文件；不允许覆盖源文件。",
    requirements: { binaries: ["python3"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "ppt-pptx",
    name: "ppt/pptx",
    description: "幻灯片生成、审查、格式修复",
    kind: "tool",
    risk_level: "low",
    triggers: {
      keywords: [/\.pptx?$/i, /ppt|幻灯片|演示文稿|presentation/i],
      file_extensions: [".ppt", ".pptx"],
      task_patterns: ["幻灯片生成", "PPT 审查", "格式修复"],
    },
    injection_policy: "on_demand",
    prompt_index: "ppt/pptx：可用于幻灯片生成、审查、格式修复。",
    prompt_detail:
      "ppt/pptx 能力：使用 python-pptx 库读写 PowerPoint 文件。支持 slide 操作、文本框、图表、图片、母版。可生成新幻灯片、检查格式一致性。处理时必须保留原文件。",
    requirements: { binaries: ["python3"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "xlsx",
    name: "xlsx",
    description: "表格读取、计算、清洗、导出",
    kind: "tool",
    risk_level: "low",
    triggers: {
      keywords: [/\.xlsx?$/i, /excel|表格|spreadsheet|数据.*清洗/i],
      file_extensions: [".xls", ".xlsx", ".csv"],
      task_patterns: ["表格处理", "数据清洗", "Excel 导出"],
    },
    injection_policy: "on_demand",
    prompt_index: "xlsx：可用于表格读取、计算、清洗、导出。",
    prompt_detail:
      "xlsx 能力：使用 openpyxl/pandas 等库读写 Excel 文件。支持公式计算、数据透视表、图表、条件格式。可清洗数据、生成报表。处理时必须保留原文件。",
    requirements: { binaries: ["python3"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },

  // ── GitHub 能力（skill + CLI/API wrapper，不假设 token 可用）──
  {
    id: "github",
    name: "github",
    description: "GitHub 仓库、issue、PR、workflow、release 相关操作",
    kind: "tool",
    risk_level: "medium",
    triggers: {
      keywords: [/github/i, /issue|pull.*request|pr\b|release|workflow|github\.com/i],
      file_extensions: [],
      task_patterns: ["创建 issue", "提交 PR", "查看 workflow", "release 管理"],
    },
    injection_policy: "on_demand",
    prompt_index: "github：可用于仓库、issue、PR、workflow、release 相关任务。无 token 时仅限公开读取。",
    prompt_detail:
      "GitHub 能力：通过 gh CLI 或 GitHub API 操作仓库。无 token 时仅限公开仓库读取。创建 issue/PR/release 必须用户明确授权。不要默认 push；不要打印 token；访问私有仓库必须确认凭据来源和权限范围。可用命令：gh api, gh issue, gh pr, gh release, gh workflow。",
    requirements: { binaries: ["gh"], tokens: ["GITHUB_TOKEN"] },
    security: { require_redaction: true, allow_network: true, require_consent: true },
  },

  // ── Playwright（重型 MCP，on_demand，isolated）──
  {
    id: "playwright",
    name: "playwright",
    description: "浏览器自动化、端到端测试、截图、交互验证",
    kind: "mcp",
    risk_level: "high",
    triggers: {
      keywords: [/playwright|browser|浏览器|端到端.*测试|e2e|截图.*验证|页面.*交互/i],
      file_extensions: [".spec.ts", ".e2e.ts"],
      task_patterns: ["浏览器自动化", "端到端测试", "截图验证"],
    },
    injection_policy: "on_demand",
    mcp_ref: "playwright",
    mcp: {
      name: "playwright",
      command: ["npx", "@anthropic/mcp-server-playwright"],
      env_keys: [],
      health_url: undefined,
      isolated: true,
      mutex_key: "playwright-browser-profile",
      start_policy: "on_demand",
      heavy: true,
      heavy_reasons: [
        "会打开浏览器",
        "会占用固定端口",
        "会启动常驻进程",
        "会访问网络",
        "会显著消耗 CPU/内存",
      ],
      requires_consent: true,
      degrade_description: "Playwright 浏览器未启动或不可用。",
    },
    prompt_index: "playwright：可用于浏览器自动化、端到端测试、截图、交互验证。需用户确认启动。",
    prompt_detail:
      "Playwright 能力：通过 MCP server 提供浏览器自动化。默认使用 isolated mode；同一个 browser profile 不能启动两次；同一个 port 不能启动两次。如果任务需要登录态，必须明确提示风险。启动前需用户确认。",
    requirements: { binaries: ["npx"] },
    security: { require_redaction: true, allow_network: true, require_consent: true },
  },

  // ── 工程测试能力 ──
  {
    id: "engineering-test",
    name: "engineering-test",
    description: "工程测试、typecheck、lint、build 验证",
    kind: "tool",
    risk_level: "low",
    triggers: {
      keywords: [/typecheck|类型检查|tsgo|noEmit|bun test|bun run|lint|eslint|build/i],
      file_extensions: [".test.ts", ".spec.ts", ".test.tsx"],
      task_patterns: ["运行测试", "类型检查", "构建验证"],
    },
    injection_policy: "always",
    skill_ref: "test-gate",
    prompt_index: "工程测试：typecheck (tsgo --noEmit)、test (bun test)、lint、build 验证。",
    prompt_detail:
      "工程测试能力：bun typecheck（从 packages/opencode 运行，使用 tsgo --noEmit），bun test test/dll-agent/（dll-agent 单元测试），bun test（完整测试）。所有测试必须实际运行，不能仅凭记忆声称通过。",
    requirements: { binaries: ["bun"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },

  // ── 监控诊断能力（observability）──
  {
    id: "observability",
    name: "observability",
    description: "进程、端口、日志、资源、服务健康检查",
    kind: "command",
    risk_level: "low",
    triggers: {
      keywords: [/监控|端口.*冲突|进程.*检查|健康检查|healthcheck|资源.*不足|日志.*检查/i],
      file_extensions: [],
      task_patterns: ["服务健康检查", "端口检查", "资源监控"],
    },
    injection_policy: "on_demand",
    prompt_index: "observability：可用于进程、端口、日志、资源、服务健康检查。",
    prompt_detail:
      "observability 能力：提供诊断命令模板和健康检查逻辑。支持进程状态检查（ps, pgrep）、端口占用检查（lsof -i :PORT）、资源使用检查（top, df, free）、日志扫描。不会默认启动监控 daemon。",
    requirements: { binaries: ["ps", "lsof"] },
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },

  // ── dll-agent 内置能力（always available）──
  {
    id: "repo-doctor",
    name: "repo-doctor",
    description: "仓库健康检查（git status / typecheck / lint / dep audit）",
    kind: "skill",
    risk_level: "low",
    triggers: {
      keywords: [/项目.*乱|repo.*health|健康检查|diagnose|repo.*doctor/i],
      file_extensions: [],
      task_patterns: ["仓库诊断", "健康检查"],
    },
    injection_policy: "always",
    skill_ref: "repo-doctor",
    prompt_index: "repo-doctor：仓库健康检查，git status / typecheck / lint / dep audit。",
    prompt_detail:
      "repo-doctor（skill）：检查 git status、typecheck baseline、lint readiness、依赖审计。由 built-in skill 系统激活，详见 skill-registry.ts。",
    requirements: {},
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "security-redaction",
    name: "security-redaction",
    description: "密钥脱敏与日志安全",
    kind: "skill",
    risk_level: "medium",
    triggers: {
      keywords: [/api[_-]?key|token|password|secret|脱敏|redact/i],
      file_extensions: [],
      task_patterns: ["安全审查", "脱敏检查"],
    },
    injection_policy: "always",
    skill_ref: "security-redaction",
    prompt_index: "security-redaction：密钥脱敏，禁止将 secrets 写入日志/evidence。",
    prompt_detail:
      "security-redaction（skill）：检测并脱敏 API key、token、password 等敏感信息。由 built-in skill 系统激活。所有 evidence 写入前自动脱敏。",
    requirements: {},
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "docs-sync",
    name: "docs-sync",
    description: "文档/计划与实现一致性检查",
    kind: "skill",
    risk_level: "low",
    triggers: {
      keywords: [/docs|文档.*同步|计划.*实现|plan.*sync/i],
      file_extensions: [".md"],
      task_patterns: ["文档同步", "计划更新"],
    },
    injection_policy: "on_demand",
    skill_ref: "docs-sync",
    prompt_index: "docs-sync：文档/计划与实现一致性检查，阻止计划伪装成完成。",
    prompt_detail:
      "docs-sync（skill）：检查文档标记的实现状态是否与代码一致。必须区分：已实现、部分实现、尚未实现、仅文档定义、prompt-only。由 built-in skill 系统激活。",
    requirements: {},
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
  {
    id: "test-gate",
    name: "test-gate",
    description: "测试与验证门禁（必须实际运行，不能无验证声称完成）",
    kind: "skill",
    risk_level: "medium",
    triggers: {
      keywords: [/run.*test|跑测试|测试.*通过|bun test|验证/i],
      file_extensions: [".test.ts"],
      task_patterns: ["运行测试", "验证通过"],
    },
    injection_policy: "always",
    skill_ref: "test-gate",
    prompt_index: "test-gate：测试与验证门禁，必须实际运行，禁止无证据声称完成。",
    prompt_detail:
      "test-gate（skill）：确保任何完成声明都有实际运行的测试/typecheck/doctor 结果支撑。由 built-in skill 系统激活。",
    requirements: {},
    security: { require_redaction: true, allow_network: false, require_consent: false },
  },
]

// ─── Default Manifest ─────────────────────────────────────────────────────────

export const DEFAULT_MANIFEST: ToolManifest = {
  version: 1,
  tools: GLOBAL_DEFAULT_TOOLS,
  prompt: {
    index_max_chars: 1200,
    tool_detail_max_chars: 1500,
    per_round_max_chars: 3000,
  },
  security: {
    deny_commands: [
      "rm -rf /",
      "git push --force origin main",
      "git push --force origin master",
      "curl | sh",
      "wget -O - | sh",
      "sudo rm -rf",
      "chmod 777 /",
      "> /dev/sda",
      "mkfs.",
      "dd if=",
    ],
    secret_redaction: true,
  },
  startup: {
    autostart_policy: "on_demand",
  },
  features: {
    evidence: true,
    doctor: true,
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 按 id 查找工具条目 */
export function findTool(id: string, catalog?: ToolEntry[]): ToolEntry | undefined {
  return (catalog ?? GLOBAL_DEFAULT_TOOLS).find((t) => t.id === id)
}

/** 找出所有重型 MCP */
export function heavyMcpEntries(tools: ToolEntry[]): ToolEntry[] {
  return tools.filter((t) => t.kind === "mcp" && t.mcp?.heavy === true)
}

/** 按 start_policy 过滤 MCP */
export function mcpByStartPolicy(tools: ToolEntry[], policy: McpStartPolicy): ToolEntry[] {
  return tools.filter((t) => t.kind === "mcp" && t.mcp?.start_policy === policy)
}

/** 构建触发关键词 → tool ids 的倒排索引 */
export function buildTriggerIndex(tools: ToolEntry[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const t of tools) {
    const words: string[] = []
    for (const kw of t.triggers.keywords ?? []) {
      // extract the literal part from regex
      const literal = kw.source.replace(/\\b/g, "").replace(/[.*+?^${}()|[\]\\]/g, "").toLowerCase()
      if (literal) words.push(literal)
    }
    for (const ext of t.triggers.file_extensions ?? []) {
      words.push(ext.toLowerCase())
    }
    for (const w of words) {
      const existing = index.get(w) ?? []
      existing.push(t.id)
      index.set(w, existing)
    }
  }
  return index
}
