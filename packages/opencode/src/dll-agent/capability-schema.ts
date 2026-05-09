/**
 * dll-agent Capability Schema
 *
 * 统一所有能力（skill / mcp / tool / software / model）的机器可读声明结构。
 * 这是 capability-driven 系统的语义基础——所有 discovery、registry、planner、
 * resolver、lifecycle 模块都基于这个 schema 进行推理和决策。
 *
 * 设计原则：
 * 1. 兼容现有 tool-catalog / skill-registry / mcp-manager 的数据
 * 2. 不修改现有文件，纯新增
 * 3. 允许部分字段缺省，但 doctor 能报缺口
 * 4. 字段语义明确，可被 planner 自动推理
 */

// ─── Core Types ────────────────────────────────────────────────────────────────

/** 能力类型 */
export type CapabilityKind = "skill" | "mcp" | "tool" | "software" | "model" | "lsp" | "multimodal"

/** 风险等级 */
export type CapabilityRiskLevel = "low" | "medium" | "high"

/** 成本等级 */
export type CapabilityCostLevel = "free" | "low" | "medium" | "high"

/** 来源类型 */
export type CapabilitySourceType =
  | "builtin"       // 仓库内建声明（现有 tool-catalog / skill-registry）
  | "local-scan"    // which / npm ls / pip show 等本地扫描
  | "manifest"      // package.json / pyproject.toml / Cargo.toml 等
  | "mcp-manifest"  // MCP server manifest
  | "skill-metadata"// SKILL.md / skill 元数据
  | "discovered"    // 自动发现但未验证
  | "doc-summary"   // 官方文档/README 摘要（低信任）
  | "manual"        // 用户手写

/** 运行时状态 */
export type CapabilityStatus =
  | "registered"         // schema 完整，已注册
  | "active"             // 已被当前任务/会话激活
  | "available"          // 依赖就绪，可用
  | "unavailable"        // 当前不可用（泛化状态，用于 manifest/doctor 展示）
  | "missing_dependency" // 缺少依赖（binary/token/package）
  | "requires_key"       // 缺少 token/env key
  | "requires_install"   // 缺少本地 binary/package
  | "on_demand"          // 注册但按需启动/加载
  | "degraded"           // 降级可用
  | "blocked"            // 被安全/权限策略阻止
  | "running"            // MCP/service 正在运行
  | "failed"             // 启动或验证失败

/** 安装策略 */
export type InstallStrategy =
  | "none"                   // 无需安装（内建能力）
  | "project_local_npm"      // npm/pnpm/yarn 安装到项目
  | "project_local_pip"      // pip install 到项目 venv
  | "user_local_binary"      // 下载二进制到 ~/.dll-agent/tools/
  | "system_package_manager" // brew / apt / etc（高风险）
  | "npx_runtime"            // npx -y 运行时下载

/** 启动策略 */
export type StartPolicy =
  | "always"               // session 启动时始终启动
  | "on_demand"            // 任务触发时启动
  | "autostart_lightweight"// 轻量级自动启动
  | "disabled"             // 永不自动启动

/** 平台限制 */
export type Platform = "darwin" | "linux" | "win32" | "any"

// ─── Sub-structures ────────────────────────────────────────────────────────────

export interface CapabilityHealthcheck {
  /** 健康检查类型 */
  type: "url" | "command" | "pid" | "port" | "none"
  /** URL 模板（如 "http://127.0.0.1:{port}/health"） */
  url?: string
  /** 命令模板 */
  command?: string[]
  /** 端口检测 */
  port?: number
  /** 超时 ms */
  timeout_ms?: number
}

export interface CapabilityRuntime {
  /** 启动命令 */
  start_command?: string[]
  /** 停止命令 */
  stop_command?: string[]
  /** 所需环境变量（不含实际价值，仅 key 名） */
  env_keys?: string[]
  /** 是否必须 isolated 运行 */
  isolated?: boolean
  /** 互斥锁 key（防止多实例） */
  mutex_key?: string
  /** 是否为重型能力（浏览器/端口/常驻/高 CPU） */
  heavy?: boolean
  /** 重型原因 */
  heavy_reasons?: string[]
  /** 启动策略 */
  start_policy?: StartPolicy
  /** 是否需要用户确认启动 */
  requires_consent?: boolean
  /** 健康检查配置 */
  healthcheck?: CapabilityHealthcheck
  /** 最大启动重试次数 */
  max_start_retries?: number
  /** 启动超时 ms */
  start_timeout_ms?: number
  /** 空闲回收超时 ms */
  idle_timeout_ms?: number
}

export interface CapabilityDependencies {
  /** 必需的二进制 */
  binaries?: string[]
  /** 必需的 token 环境变量名 */
  tokens?: string[]
  /** 必需的 npm/pip/cargo 包 */
  packages?: string[]
  /** 占用的端口 */
  ports?: number[]
}

export interface CapabilitySecurity {
  /** 是否需要脱敏输出 */
  require_redaction?: boolean
  /** 是否允许网络请求 */
  allow_network?: boolean
  /** 是否需要用户确认 */
  require_consent?: boolean
  /** 是否允许写项目外部 */
  allow_external_write?: boolean
  /** 禁止的命令模式 */
  deny_commands?: string[]
  /** 允许的命令模式 */
  allow_commands?: string[]
}

export interface CapabilityTriggers {
  /** 触发关键词正则（序列化友好版：存 source string 而非 RegExp） */
  keywords?: string[]
  /** 文件扩展名 */
  file_extensions?: string[]
  /** 任务模式 */
  task_patterns?: string[]
  /** 仓库标记文件 */
  repo_markers?: string[]
  /** 运行时信号 */
  signals?: string[]
}

export interface CapabilityEvidence {
  /** 触发原因 */
  trigger_reason?: string
  /** 选型依据 */
  selection_rationale?: string
  /** 安装决策依据 */
  install_rationale?: string
  /** 验证结果 */
  verification_result?: "passed" | "failed" | "pending"
  /** 验证输出摘要 */
  verification_output?: string
  /** 回收状态 */
  cleanup_status?: "clean" | "stale" | "error"
}

// ─── Unified Capability Entry ──────────────────────────────────────────────────

export interface CapabilityEntry {
  /** 唯一标识，kebab-case（如 "playwright", "doc-docx", "repo-doctor"） */
  id: string
  /** 能力类型 */
  kind: CapabilityKind
  /** 人类可读名称 */
  name: string
  /** 一行中文描述 */
  description: string
  /** 语义能力标签（如 ["browser-automation", "screenshot", "e2e-testing"]） */
  capabilities: string[]
  /** 输入类型（如 ["url", "file-path", "text", "html"]） */
  input_types: string[]
  /** 输出类型（如 ["screenshot", "pdf", "text", "json"]） */
  output_types: string[]
  /** 风险等级 */
  risk_level: CapabilityRiskLevel
  /** 成本等级 */
  cost_level: CapabilityCostLevel
  /** 是否需要 API token */
  requires_token: boolean
  /** 是否需要在运行时安装 */
  requires_install: boolean
  /** 安装策略 */
  install_strategy: InstallStrategy
  /** 启动策略 */
  start_policy: StartPolicy
  /** 运行时配置（仅 mcp / software 类） */
  runtime?: CapabilityRuntime
  /** 依赖声明 */
  dependencies?: CapabilityDependencies
  /** 安全约束 */
  security?: CapabilitySecurity
  /** 触发条件 */
  triggers?: CapabilityTriggers
  /** 验证命令列表 */
  verify_commands?: string[]
  /** 来源元数据 */
  source: string
  /** 来源类型 */
  source_type: CapabilitySourceType
  /** 置信度 0-1 */
  confidence: number
  /** 当前状态 */
  status: CapabilityStatus
  /** 支持平台 */
  platforms: Platform[]
  /** 项目作用域（"global"=内建, "project"=项目特定, "user"=用户目录） */
  project_scope: "global" | "project" | "user"
  /** 最后验证时间 */
  last_verified_at?: string
  /** 注册时间 */
  registered_at: string
  /** 证据记录 */
  evidence?: CapabilityEvidence
}

// ─── Schema Validation Result ──────────────────────────────────────────────────

export interface SchemaValidationResult {
  /** 条目 id */
  id: string
  /** 是否通过 */
  valid: boolean
  /** 必须缺失的字段 */
  missing_required: string[]
  /** 字段值非法 */
  invalid_fields: string[]
  /** 建议修复 */
  suggestions: string[]
}

// ─── Required Fields Per Kind ───────────────────────────────────────────────────

const REQUIRED_FIELDS: Record<CapabilityKind, (keyof CapabilityEntry)[]> = {
  skill: ["id", "kind", "name", "description", "capabilities", "source", "source_type", "status", "platforms", "project_scope"],
  mcp: ["id", "kind", "name", "description", "capabilities", "runtime", "source", "source_type", "status", "platforms", "project_scope"],
  tool: ["id", "kind", "name", "description", "capabilities", "source", "source_type", "status", "platforms", "project_scope"],
  software: ["id", "kind", "name", "description", "capabilities", "dependencies", "source", "source_type", "status", "platforms", "project_scope"],
  model: ["id", "kind", "name", "description", "capabilities", "risk_level", "cost_level", "source", "source_type", "status", "platforms", "project_scope"],
  lsp: ["id", "kind", "name", "description", "capabilities", "source", "source_type", "status", "platforms", "project_scope"],
  multimodal: ["id", "kind", "name", "description", "capabilities", "source", "source_type", "status", "platforms", "project_scope"],
}

/** 验证单条 capability entry 的完整性 */
export function validateCapabilityEntry(entry: CapabilityEntry): SchemaValidationResult {
  const required = REQUIRED_FIELDS[entry.kind]
  const missing_required: string[] = []
  const invalid_fields: string[] = []
  const suggestions: string[] = []

  for (const field of required) {
    const value = entry[field]
    if (value === undefined || value === null) {
      missing_required.push(field)
      suggestions.push(`Add missing required field: ${field}`)
    }
    if (Array.isArray(value) && value.length === 0 && field === "capabilities") {
      invalid_fields.push(field)
      suggestions.push(`Field "${field}" should not be empty`)
    }
  }

  if (entry.confidence < 0 || entry.confidence > 1) {
    invalid_fields.push("confidence")
    suggestions.push("confidence must be between 0 and 1")
  }

  if (entry.install_strategy === "system_package_manager" && entry.risk_level !== "high") {
    suggestions.push(`Entry "${entry.id}" uses system_package_manager install_strategy but risk_level is "${entry.risk_level}" — consider raising to "high"`)
  }

  if (entry.kind === "mcp" && !entry.runtime) {
    missing_required.push("runtime")
    suggestions.push("MCP entries must have runtime configuration")
  }

  if (entry.kind === "model" && (!entry.risk_level || !entry.cost_level)) {
    suggestions.push("Model entries should specify risk_level and cost_level")
  }

  return {
    id: entry.id,
    valid: missing_required.length === 0 && invalid_fields.length === 0,
    missing_required,
    invalid_fields,
    suggestions,
  }
}

/** 批量验证 */
export function validateRegistry(entries: CapabilityEntry[]): Map<string, SchemaValidationResult> {
  const results = new Map<string, SchemaValidationResult>()
  const seenIds = new Set<string>()

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      const result = results.get(entry.id) ?? {
        id: entry.id,
        valid: false,
        missing_required: [],
        invalid_fields: ["id-duplicate"],
        suggestions: [`Duplicate entry id: "${entry.id}"`],
      }
      result.invalid_fields.push("id-duplicate")
      results.set(entry.id, result)
    } else {
      results.set(entry.id, validateCapabilityEntry(entry))
      seenIds.add(entry.id)
    }
  }

  return results
}

/** 列出 schema 中所有必须字段的缺口 */
export function schemaGaps(entries: CapabilityEntry[]): {
  id: string
  missing: string[]
  suggestions: string[]
}[] {
  return entries
    .map(validateCapabilityEntry)
    .filter((r) => !r.valid)
    .map((r) => ({ id: r.id, missing: r.missing_required, suggestions: r.suggestions }))
}

// ─── Entity-Level Defaults ─────────────────────────────────────────────────────

/**
 * 创建一个 minimal valid entry，用于快速原型。
 * 所有可选字段设为缺省值，caller 可以覆盖。
 */
export function createMinimalEntry(overrides: Partial<CapabilityEntry> & Pick<CapabilityEntry, "id" | "kind" | "name">): CapabilityEntry {
  const now = new Date().toISOString()
  return {
    description: overrides.description ?? overrides.name,
    capabilities: overrides.capabilities ?? [],
    input_types: overrides.input_types ?? [],
    output_types: overrides.output_types ?? [],
    risk_level: overrides.risk_level ?? "low",
    cost_level: overrides.cost_level ?? "free",
    requires_token: overrides.requires_token ?? false,
    requires_install: overrides.requires_install ?? false,
    install_strategy: overrides.install_strategy ?? "none",
    start_policy: overrides.start_policy ?? "disabled",
    source: overrides.source ?? "manual",
    source_type: overrides.source_type ?? "manual",
    confidence: overrides.confidence ?? 1.0,
    status: overrides.status ?? "registered",
    platforms: overrides.platforms ?? ["any"],
    project_scope: overrides.project_scope ?? "global",
    registered_at: now,
    ...overrides,
  }
}
