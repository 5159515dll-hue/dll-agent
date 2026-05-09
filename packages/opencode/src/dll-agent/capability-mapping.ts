/**
 * dll-agent Capability Mapping
 *
 * 将现有 tool-catalog、skill-registry、mcp-manager 的类型安全地映射到
 * 统一 CapabilityEntry schema。所有映射函数是纯函数，不修改现有数据。
 *
 * 设计原则：
 * 1. 零破坏：不改现有文件，只做读取和转换
 * 2. 明确语义映射：每个字段的转换逻辑都有注释说明
 * 3. 缺失字段标记：无法自动推断的字段用缺省值并标记 source_type=builtin
 */

import type { CapabilityEntry, CapabilityKind, CapabilityRiskLevel, CapabilityCostLevel, StartPolicy, CapabilityRuntime, CapabilityDependencies, CapabilitySecurity, CapabilityTriggers, InstallStrategy } from "./capability-schema"
import type { ToolEntry, McpStartPolicy, ToolKind } from "./tool-catalog"
import type { SkillDefinition } from "./skill-registry"

// ─── Kind Mapping ───────────────────────────────────────────────────────────────

const KIND_MAP: Record<ToolKind, CapabilityKind> = {
  skill: "skill",
  tool: "tool",
  mcp: "mcp",
  command: "tool",
}

const RISK_MAP: Record<string, CapabilityRiskLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
}

const START_POLICY_MAP: Record<McpStartPolicy, StartPolicy> = {
  disabled: "disabled",
  on_demand: "on_demand",
  autostart_lightweight: "autostart_lightweight",
}

// ─── Inference Helpers ──────────────────────────────────────────────────────────

function inferInstallStrategy(tool: ToolEntry): InstallStrategy {
  if (tool.kind === "skill") return "none"
  if (tool.kind === "mcp" && tool.mcp?.command?.[0] === "npx") return "npx_runtime"
  if (inferPythonPackages(tool).length > 0) return "project_local_pip"
  if (tool.requirements?.binaries?.includes("npx")) return "npx_runtime"
  if (tool.requirements?.binaries?.includes("gh")) return "system_package_manager"
  return "none"
}

function inferCapabilityTags(tool: ToolEntry): string[] {
  const tags: string[] = []
  if (tool.id === "doc-docx") tags.push("docx-read", "docx-write", "document-processing")
  if (tool.id === "pdf") tags.push("pdf-read", "pdf-extract", "document-processing")
  if (tool.id === "ppt-pptx") tags.push("pptx-read", "pptx-write", "slide-generation")
  if (tool.id === "xlsx") tags.push("xlsx-read", "xlsx-write", "data-processing")
  if (tool.id === "github") tags.push("github-api", "issue-management", "pr-management", "release-management")
  if (tool.id === "playwright") tags.push("browser-automation", "e2e-testing", "screenshot", "page-interaction")
  if (tool.id === "engineering-test") tags.push("typecheck", "lint", "test", "build")
  if (tool.id === "observability") tags.push("process-monitor", "port-check", "health-check", "resource-monitor")
  if (tool.id === "repo-doctor") tags.push("repo-health", "git-status", "diagnostic")
  if (tool.id === "security-redaction") tags.push("secret-detection", "redaction", "log-safety")
  if (tool.id === "docs-sync") tags.push("document-sync", "consistency-check")
  if (tool.id === "test-gate") tags.push("test-verification", "gate-enforcement")
  return tags
}

function inferSkillCapabilityTags(skill: SkillDefinition): string[] {
  const tags: string[] = []
  if (skill.id === "repo-doctor") tags.push("repo-health", "diagnostic", "git-status")
  if (skill.id === "self-repair") tags.push("self-repair", "dll-agent-internal", "patch")
  if (skill.id === "security-redaction") tags.push("secret-detection", "redaction", "log-safety")
  if (skill.id === "test-gate") tags.push("test-verification", "gate-enforcement")
  if (skill.id === "docs-sync") tags.push("document-sync", "consistency-check")
  if (skill.id === "cost-guard") tags.push("cost-monitor", "quota-check")
  if (skill.id === "cross-review") tags.push("cross-review", "multi-model", "conflict-resolution")
  if (skill.id === "ux-review") tags.push("ui-review", "cli-audit", "ux-check")
  if (skill.id === "self-upgrade") tags.push("self-upgrade", "risk-assessment", "dll-agent-internal")
  if (skill.id === "model-routing-policy") tags.push("model-routing", "token-awareness")
  if (skill.id === "kimi-continuation-trigger") tags.push("task-continuation", "completion-check")
  if (skill.id === "glm-requirements-trigger") tags.push("requirement-check", "scope-audit")
  if (skill.id === "cross-review-escalation-policy") tags.push("escalation", "conflict-resolution")
  return tags
}

function inferInputTypes(tool: ToolEntry): string[] {
  if (tool.id === "doc-docx") return ["file-path", ".docx"]
  if (tool.id === "pdf") return ["file-path", ".pdf"]
  if (tool.id === "ppt-pptx") return ["file-path", ".pptx"]
  if (tool.id === "xlsx") return ["file-path", ".xlsx", ".csv"]
  if (tool.id === "github") return ["url", "repo-name", "issue-number"]
  if (tool.id === "playwright") return ["url", "selector", "test-script"]
  if (tool.id === "observability") return ["pid", "port", "command"]
  return ["text"]
}

function inferOutputTypes(tool: ToolEntry): string[] {
  if (tool.id === "doc-docx") return ["docx", "text"]
  if (tool.id === "pdf") return ["pdf", "text"]
  if (tool.id === "ppt-pptx") return ["pptx", "text"]
  if (tool.id === "xlsx") return ["xlsx", "csv", "json"]
  if (tool.id === "github") return ["json", "text"]
  if (tool.id === "playwright") return ["screenshot", "html", "json", "video"]
  if (tool.id === "observability") return ["text", "json"]
  return ["text"]
}

function inferCostLevel(riskLevel: string, kind: string): CapabilityCostLevel {
  if (kind === "mcp" && riskLevel === "high") return "high"
  if (riskLevel === "high") return "medium"
  if (riskLevel === "medium") return "low"
  return "free"
}

// ─── Trigger Mapping ────────────────────────────────────────────────────────────

function mapTriggers(tool: ToolEntry): CapabilityTriggers | undefined {
  const mapped: CapabilityTriggers = {}
  if (tool.triggers.keywords?.length) mapped.keywords = tool.triggers.keywords.map((r) => r.source)
  if (tool.triggers.file_extensions?.length) mapped.file_extensions = tool.triggers.file_extensions
  if (tool.triggers.task_patterns?.length) mapped.task_patterns = tool.triggers.task_patterns
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

function mapSkillTriggers(skill: SkillDefinition): CapabilityTriggers | undefined {
  const mapped: CapabilityTriggers = {}
  if (skill.triggers.keywords?.length) mapped.keywords = skill.triggers.keywords.map((r) => r.source)
  if (skill.triggers.fileGlobs?.length) mapped.file_extensions = skill.triggers.fileGlobs
  if (skill.triggers.intents?.length) mapped.task_patterns = skill.triggers.intents
  if (skill.triggers.signals?.length) mapped.signals = skill.triggers.signals
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

// ─── Sub-structure Mapping ──────────────────────────────────────────────────────

function mapRuntime(tool: ToolEntry): CapabilityRuntime | undefined {
  if (tool.kind !== "mcp" || !tool.mcp) return undefined
  return {
    start_command: tool.mcp.command,
    env_keys: tool.mcp.env_keys,
    isolated: tool.mcp.isolated,
    mutex_key: tool.mcp.mutex_key,
    heavy: tool.mcp.heavy,
    heavy_reasons: tool.mcp.heavy_reasons,
    start_policy: START_POLICY_MAP[tool.mcp.start_policy],
    requires_consent: tool.mcp.requires_consent,
    healthcheck: tool.mcp.health_url
      ? { type: "url", url: tool.mcp.health_url, timeout_ms: 5000 }
      : { type: "pid" },
    max_start_retries: 3,
    start_timeout_ms: 30000,
    idle_timeout_ms: 30 * 60 * 1000,
  }
}

function mapDependencies(tool: ToolEntry): CapabilityDependencies | undefined {
  const deps: CapabilityDependencies = {}
  if (tool.requirements?.binaries?.length) deps.binaries = tool.requirements.binaries
  if (tool.requirements?.tokens?.length) deps.tokens = tool.requirements.tokens
  if (tool.requirements?.ports?.length) deps.ports = tool.requirements.ports
  const packages = inferPythonPackages(tool)
  if (packages.length > 0) deps.packages = packages
  return Object.keys(deps).length > 0 ? deps : undefined
}

function inferPythonPackages(tool: ToolEntry): string[] {
  if (tool.id === "doc-docx") return ["python-docx"]
  if (tool.id === "pdf") return ["pypdf"]
  if (tool.id === "ppt-pptx") return ["python-pptx"]
  if (tool.id === "xlsx") return ["openpyxl"]
  return []
}

function inferVerifyCommands(tool: ToolEntry): string[] | undefined {
  if (tool.id === "doc-docx") return [`python3 -c "import docx"`]
  if (tool.id === "pdf") return [`python3 -c "import pypdf"`]
  if (tool.id === "ppt-pptx") return [`python3 -c "import pptx"`]
  if (tool.id === "xlsx") return [`python3 -c "import openpyxl"`]
  if (tool.id === "engineering-test") return ["bun typecheck", "bun test test/dll-agent/"]
  return undefined
}

function infrastructureCapabilities(): CapabilityEntry[] {
  const now = new Date().toISOString()
  return [
    {
      id: "project-main-lsp",
      kind: "lsp",
      name: "Project-main LSP",
      description: "项目主语言 LSP 预热策略；辅助语言保持 lazy",
      capabilities: ["lsp", "project-main-lsp", "code-navigation"],
      input_types: ["project-dir", "file-path"],
      output_types: ["diagnostics", "symbols"],
      risk_level: "low",
      cost_level: "free",
      requires_token: false,
      requires_install: false,
      install_strategy: "none",
      start_policy: "on_demand",
      source: "lsp-strategy.ts::DEFAULT_LSP_STRATEGY",
      source_type: "builtin",
      confidence: 1.0,
      status: "registered",
      platforms: ["any"],
      project_scope: "global",
      registered_at: now,
      evidence: { trigger_reason: "builtin LSP strategy registered; runtime remains lazy" },
    },
    {
      id: "multimodal-context-interpreter",
      kind: "multimodal",
      name: "Multimodal Context Interpreter",
      description: "多模态输入上下文解释；纯文本/代码任务不触发",
      capabilities: ["multimodal-context", "image-understanding", "screenshot-analysis"],
      input_types: ["image", "screenshot", "video", "audio", "visual-document"],
      output_types: ["multimodal_context_packet", "evidence_ref"],
      risk_level: "medium",
      cost_level: "medium",
      requires_token: true,
      requires_install: false,
      install_strategy: "none",
      start_policy: "on_demand",
      dependencies: { tokens: ["MIMO_API_KEY"] },
      security: { require_redaction: true, allow_network: true, require_consent: false },
      triggers: {
        file_extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".wav", ".mp3"],
        task_patterns: ["screenshot", "image", "视觉", "截图", "多模态"],
      },
      source: "multimodal-context.ts::role",
      source_type: "builtin",
      confidence: 1.0,
      status: "registered",
      platforms: ["any"],
      project_scope: "global",
      registered_at: now,
      evidence: { trigger_reason: "builtin multimodal role registered; text/code tasks remain commander-only" },
    },
  ]
}

function mapSecurity(tool: ToolEntry): CapabilitySecurity | undefined {
  return {
    require_redaction: tool.security.require_redaction,
    allow_network: tool.security.allow_network,
    require_consent: tool.security.require_consent,
  }
}

function mapSkillSecurity(skill: SkillDefinition): CapabilitySecurity | undefined {
  return {
    require_redaction: skill.securityPolicy.requireRedaction,
    allow_network: skill.securityPolicy.allowNetworkFetch,
    require_consent: skill.activationPolicy.requiresExplicitConsent ?? false,
    allow_external_write: skill.securityPolicy.allowExternalWrite,
  }
}

// ─── Main Mapping Functions ────────────────────────────────────────────────────

/**
 * 将 ToolEntry 映射为 CapabilityEntry。
 */
export function toolToCapabilityEntry(tool: ToolEntry): CapabilityEntry {
  const now = new Date().toISOString()
  const kind = KIND_MAP[tool.kind]
  const riskLevel = RISK_MAP[tool.risk_level]

  return {
    id: tool.id,
    kind,
    name: tool.name,
    description: tool.description,
    capabilities: inferCapabilityTags(tool),
    input_types: inferInputTypes(tool),
    output_types: inferOutputTypes(tool),
    risk_level: riskLevel,
    cost_level: inferCostLevel(tool.risk_level, tool.kind),
    requires_token: (tool.requirements?.tokens?.length ?? 0) > 0,
    requires_install: (tool.requirements?.binaries?.length ?? 0) > 0 || tool.kind === "mcp",
    install_strategy: inferInstallStrategy(tool),
    start_policy: tool.mcp
      ? START_POLICY_MAP[tool.mcp.start_policy]
      : tool.injection_policy === "always" ? "always" : "on_demand",
    runtime: mapRuntime(tool),
    dependencies: mapDependencies(tool),
    security: mapSecurity(tool),
    triggers: mapTriggers(tool),
    verify_commands: inferVerifyCommands(tool),
    source: "tool-catalog.ts::GLOBAL_DEFAULT_TOOLS",
    source_type: "builtin",
    confidence: 1.0,
    status: "registered",
    platforms: ["any"],
    project_scope: "global",
    last_verified_at: undefined,
    registered_at: now,
  }
}

/**
 * 将 SkillDefinition 映射为 CapabilityEntry。
 */
export function skillToCapabilityEntry(skill: SkillDefinition): CapabilityEntry {
  const now = new Date().toISOString()
  return {
    id: skill.id,
    kind: "skill",
    name: skill.name,
    description: skill.description,
    capabilities: inferSkillCapabilityTags(skill),
    input_types: ["text", "message-stream", "supervisor-signal"],
    output_types: ["review-output", "evidence", "diagnostic"],
    risk_level: RISK_MAP[skill.riskLevel],
    cost_level: skill.costPolicy?.allowOpenAI ? "high"
      : skill.costPolicy?.allowExpensiveReviewer ? "medium"
      : "free",
    requires_token: false,
    requires_install: false,
    install_strategy: "none",
    start_policy: "on_demand",
    dependencies: (skill.requiredTools?.length ?? 0) > 0
      ? { binaries: skill.requiredTools }
      : undefined,
    security: mapSkillSecurity(skill),
    triggers: mapSkillTriggers(skill),
    verify_commands: skill.verificationCommands,
    source: "skill-registry.ts::SKILL_REGISTRY",
    source_type: "builtin",
    confidence: 1.0,
    status: "registered",
    platforms: ["any"],
    project_scope: "global",
    registered_at: now,
    evidence: {
      trigger_reason: "builtin skill loaded from registry",
    },
  }
}

/**
 * 批量映射所有内置能力（tools + skills）。
 */
export function mapAllBuiltins(
  tools: ToolEntry[],
  skills: SkillDefinition[],
): CapabilityEntry[] {
  return [
    ...tools.map(toolToCapabilityEntry),
    ...skills.map(skillToCapabilityEntry),
    ...infrastructureCapabilities(),
  ]
}

// ─── Model Capability ───────────────────────────────────────────────────────────

/**
 * 创建一个 model 类型的 CapabilityEntry。
 */
export function modelCapability(opts: {
  id: string
  provider: string
  modelName: string
  description: string
  capabilities: string[]
  contextLimit: number
  riskLevel?: CapabilityRiskLevel
  costLevel?: CapabilityCostLevel
  requiresToken?: boolean
}): CapabilityEntry {
  const now = new Date().toISOString()
  return {
    id: opts.id,
    kind: "model",
    name: `${opts.provider}/${opts.modelName}`,
    description: opts.description,
    capabilities: opts.capabilities,
    input_types: ["text"],
    output_types: ["text"],
    risk_level: opts.riskLevel ?? "medium",
    cost_level: opts.costLevel ?? "medium",
    requires_token: opts.requiresToken ?? true,
    requires_install: false,
    install_strategy: "none",
    start_policy: "on_demand",
    source: "capability-mapping.ts::modelCapability",
    source_type: "builtin",
    confidence: 1.0,
    status: "available",
    platforms: ["any"],
    project_scope: "global",
    registered_at: now,
    evidence: {
      selection_rationale: `Context limit: ${opts.contextLimit} tokens`,
    },
  }
}

/**
 * 创建一个 software 类型的 CapabilityEntry。
 */
export function softwareCapability(opts: {
  id: string
  name: string
  description: string
  capabilities: string[]
  binaries?: string[]
  packages?: string[]
  install_strategy: InstallStrategy
  riskLevel?: CapabilityRiskLevel
  verifyCommand?: string[]
}): CapabilityEntry {
  const now = new Date().toISOString()
  return {
    id: opts.id,
    kind: "software",
    name: opts.name,
    description: opts.description,
    capabilities: opts.capabilities,
    input_types: ["command"],
    output_types: ["text", "json"],
    risk_level: opts.riskLevel ?? "low",
    cost_level: "free",
    requires_token: false,
    requires_install: opts.install_strategy !== "none",
    install_strategy: opts.install_strategy,
    start_policy: "on_demand",
    dependencies: {
      binaries: opts.binaries ?? [],
      packages: opts.packages ?? [],
    },
    verify_commands: opts.verifyCommand,
    source: "capability-mapping.ts::softwareCapability",
    source_type: "manual",
    confidence: 1.0,
    status: "registered",
    platforms: ["any"],
    project_scope: "global",
    registered_at: now,
  }
}
