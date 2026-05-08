import { redact as evidenceRedact, write as evidenceWrite } from "./evidence"
import {
  resolveRoleModel,
  listRoleModels,
  getDefaultModel,
  type DllRole,
  type EffectiveRoleModel,
} from "./role-model-registry"

export const qualityLevels = ["max", "auto", "balanced", "economy"] as const
export const verifyLevels = ["strict", "normal", "light"] as const
export type Quality = (typeof qualityLevels)[number]
export type Verify = (typeof verifyLevels)[number]

export function enabled() {
  return process.env.DLL_AGENT_ENABLED === "1" || process.env.DLL_AGENT_ROLE_ROSTER !== undefined
}

/**
 * Phase 5: dll-agent 默认开启"全权放行"——用户启用 dll-agent 后所有工具/外部目录/
 * doom_loop 默认 allow，不再每次弹权限。可通过 DLL_AGENT_AUTO_ALLOW=0 显式关闭。
 * 关闭后回退到 OpenCode 默认 ruleset。
 */
export function autoAllowAll() {
  if (!enabled()) return false
  return process.env.DLL_AGENT_AUTO_ALLOW !== "0"
}

export function quality(): Quality {
  const value = process.env.DLL_AGENT_QUALITY
  if (qualityLevels.includes(value as Quality)) return value as Quality
  return "max"
}

export function verify(): Verify {
  const value = process.env.DLL_AGENT_VERIFY
  if (verifyLevels.includes(value as Verify)) return value as Verify
  return "strict"
}

const ROLE_MISSIONS: Record<DllRole, string> = {
  commander: "Default goal execution, routing, deep reasoning, stop-condition control, and evidence gate.",
  "chief-engineer": "Deep reasoning, engineering execution, hard debugging, patch design, and tool-use recovery.",
  "requirements-inspector": "Chinese requirement interpretation, instruction adherence, contradiction detection, and phase drift checks.",
  "long-context-archivist": "Long logs, documents, reports, PPT/Word consistency, memory, baseline, and history reconciliation.",
  "task-completion-archivist": "Task completion continuation check and structured packet generation.",
  "final-auditor": "On-demand strategic overview and final audit only when stuck, off-track, conflicted, or making high-risk completion claims.",
  "role-cross": "Temporary role crossing for recovery or reviewer conflict.",
  "multimodal-context-interpreter": "多模态上下文解释模型。将截图、图片、网页视觉、PPT图示、流程图、图表、视频、音频等非纯文本输入转换为结构化上下文和证据，供主执行模型和审查模型使用。",
  "agentic-solver": "Future: autonomous multi-step agentic problem solving.",
  "multimodal-reader": "Future: multi-modal (image/PDF/audio) content analysis.",
  "voice-output": "Future: TTS/voice clone output.",
  executor: "Verification and test execution: typecheck, test, doctor.",
}

/**
 * Returns the role roster with models resolved from the Role Model Registry.
 * When projectDir or sessionID are not available, uses built-in defaults
 * (with global config overrides applied).
 */
export function roleRoster(projectDir?: string) {
  const resolve = (role: DllRole) => resolveRoleModel(role, undefined, projectDir)
  const c = resolve("commander")
  const ce = resolve("chief-engineer")
  const ri = resolve("requirements-inspector")
  const lca = resolve("long-context-archivist")
  const fa = resolve("final-auditor")
  return {
    commander: { model: c.primary, mission: ROLE_MISSIONS.commander },
    chiefEngineer: { model: ce.primary, mission: ROLE_MISSIONS["chief-engineer"] },
    requirementsInspector: { model: ri.primary, mission: ROLE_MISSIONS["requirements-inspector"] },
    longContextArchivist: { model: lca.primary, mission: ROLE_MISSIONS["long-context-archivist"] },
    finalAuditor: { model: fa.primary, mission: ROLE_MISSIONS["final-auditor"] },
  }
}

export function modeSummary() {
  const cmdr = resolveRoleModel("commander")
  return {
    quality: quality(),
    verify: verify(),
    defaultAgent: "commander",
    defaultModel: cmdr.primary,
    commands: [
      "roles", "dll-status", "quality", "verify", "model-capability",
      "chief-engineer", "requirements-check", "context-check", "final-audit",
      "cross-review", "team-review",
      "role-models", "role-model-set", "role-model-reset", "role-model-test",
      "role-model-fallback-add", "role-model-fallback-remove",
      "multimodal-context", "multimodal-context-test",
      "tools", "tools-reload", "tools-status",
      "mcp-status", "mcp-start", "mcp-stop", "mcp-health",
      "capabilities", "capability-status", "capability-discover",
      "capability-plan", "capability-refresh", "capability-doctor",
    ],
    subagents: ["chief-engineer", "requirements-inspector", "long-context-archivist", "final-auditor", "role-cross", "multimodal-context-interpreter"],
  }
}

/**
 * Returns role command definitions.
 * Model fields are intentionally omitted — the runtime resolves the model
 * from the agent's configured model (via agent.ts → Role Model Registry).
 * This ensures that session-level model overrides take effect for slash commands.
 */
export function roleCommands() {
  const q = quality()
  const v = verify()
  const cmdr = resolveRoleModel("commander")
  const ce = resolveRoleModel("chief-engineer")
  const ri = resolveRoleModel("requirements-inspector")
  const lca = resolveRoleModel("long-context-archivist")
  const fa = resolveRoleModel("final-auditor")
  const rc = resolveRoleModel("role-cross")

  return {
    "roles": {
      description: "显示 dll-agent 角色队伍及各角色的使用场景与时机。",
      agent: "commander",
      template:
        "Show the current dll-agent role team. Explain that the visible active agent is only the coordinator, and real role work is done through the task tool and slash commands. List exact subagent names: chief-engineer, requirements-inspector, long-context-archivist, final-auditor, role-cross. Do not call this complete work; this is only a status/explanation command.",
    },
    "dll-status": {
      description: "显示 dll-agent 当前运行模式、模型能力与角色调度状态。",
      agent: "commander",
      template: [
        `Quality mode: ${q}.`,
        `Verification mode: ${v}.`,
        `Default commander/executor: ${cmdr.primary}, context 1,048,576, thinking=max.`,
        `Inspectors: ${ri.primary} and ${lca.primary}.`,
        `OpenAI strategic/final auditor: ${fa.primary}, on-demand only for stuck/off-track/conflict/high-risk finalization.`,
        "Available commands: /quality, /verify, /model-capability, /roles, /team-review, /chief-engineer, /cross-review, /role-models.",
      ].join("\n"),
    },
    "quality": {
      description: "查看或设置质量模式：max / auto / balanced / economy。默认推荐 max。",
      agent: "commander",
      template:
        `Current quality mode is ${q}. User requested quality mode: $ARGUMENTS\nSupported modes: max, auto, balanced, economy. Default/recommended is max: strongest, most expensive, no silent downgrade. For enforced relaunch, use: dll-agent --quality <mode>.`,
    },
    "verify": {
      description: "查看或设置验证模式：strict / normal / light。默认推荐 strict。",
      agent: "commander",
      template:
        `Current verification mode is ${v}. User requested verification mode: $ARGUMENTS\nSupported modes: strict, normal, light. Default/recommended is strict: every important claim needs evidence. For enforced relaunch, use: dll-agent --verify <mode>.`,
    },
    "model-capability": {
      description: "显示各角色当前配置的模型、来源与可用性状态。",
      agent: "commander",
      template: [
        "Show pinned dll-agent model capabilities:",
        `- default commander/executor: ${cmdr.primary} (source: ${cmdr.source})`,
        `- requirements-inspector: ${ri.primary} (source: ${ri.source})`,
        `- long-context-archivist: ${lca.primary} (source: ${lca.source})`,
        `- strategic/final auditor: ${fa.primary}, on-demand only (source: ${fa.source})`,
        "Do not claim live API verification unless doctor/API smoke was actually run.",
      ].join("\n"),
    },
    "chief-engineer": {
      description: "委托工程审查模型进行深度推理、代码诊断、修复与验证。",
      agent: "chief-engineer",
      subtask: true,
      template:
        "Act as the chief engineer. Use deep reasoning, code inspection, tools, and verification to move the user goal forward. If a fix is made, provide exact files, commands, observed outputs, and remaining risk.\n\n$ARGUMENTS",
    },
    "requirements-check": {
      description: "由需求一致性审查模型检查中文需求意图、逻辑矛盾与阶段偏离。",
      agent: "requirements-inspector",
      subtask: true,
      template:
        "Act as the requirements inspector. Check the user's Chinese intent, constraints, contradictions, phase drift, and whether the current work is still aligned with the real goal. Cite evidence.\n\n$ARGUMENTS",
    },
    "context-check": {
      description: "由长上下文归档模型整理长日志、文档、基线、历史阶段与证据一致性。",
      agent: "long-context-archivist",
      subtask: true,
      template:
        "Act as the long-context archivist. Check logs, documents, baselines, phase history, evidence, and memory drift. Only use evidence-backed conclusions.\n\n$ARGUMENTS",
    },
    "final-audit": {
      description: "触发最终审计模型对完成声明、验证证据与剩余风险进行审查。默认按需调用。",
      agent: "final-auditor",
      subtask: true,
      template:
        "Act as the on-demand strategic/final auditor. Check whether the user goal is complete, whether evidence is sufficient, whether tests/doctor/smoke checks really ran, whether strategic direction is still sound, and whether any claim is overconfident.\n\n$ARGUMENTS",
    },
    "cross-review": {
      description: "临时角色交叉审查，用于卡点恢复或审查冲突时切换视角。",
      agent: "role-cross",
      subtask: true,
      template:
        "Run a temporary role-crossing review. Inspect the problem from a different role's perspective, find blind spots, identify missing evidence, and propose actionable recovery steps. This role crossing ends after this review round.\n\n$ARGUMENTS",
    },
    "team-review": {
      description: "主执行模型驱动的多角色协同审查，根据任务需要自动调度审查角色。",
      agent: "commander",
      template:
        "Run a dll-agent team review for the current objective. Use the task tool only for roles that are actually needed; do not call OpenAI by default. Call these subagents as needed: requirements-inspector for intent/rules, long-context-archivist for logs/baseline/context, chief-engineer for executable recovery, final-auditor only for stuck/off-track/conflict/high-risk completion claims. Reconcile conflicts and continue toward the user goal.\n\n$ARGUMENTS",
    },
    // ─── Role Model Management Commands ────────────────────────────────────
    "role-models": {
      description: "显示所有角色当前配置的模型、来源（内置/全局/项目/会话）及 provider 可用性。",
      agent: "commander",
      template: [
        "Show the current role model assignments for all dll-agent roles.",
        "Use the role-model-registry.ts module to list all roles with:",
        "- role name",
        "- primary model (provider/model format)",
        "- fallback chain",
        "- source: built-in / global / project / session",
        "- enabled status",
        "- on-demand only flag",
        "- provider availability (API key detected?)",
        "Organize by active roles first, then future/disabled roles.",
        "This is a read-only status command.",
      ].join("\n"),
    },
    // role-model-set 已升级为 TUI 交互式对话框（见 dialog-role-model-set.tsx），
    // 不再注册为模板命令，避免自动补全中出现重复条目。
    "role-model-reset": {
      description: "重置角色模型覆盖，回退到下一层默认配置。用法：/role-model-reset <role> [--scope session|project|global|all]",
      agent: "commander",
      template: [
        "Reset a role's model override.",
        "Parameters: $ARGUMENTS",
        "Format: /role-model-reset <role> [--scope session|project|global|all]",
        "",
        "Instructions:",
        "1. Parse arguments: first arg is role name, optional --scope flag",
        "2. Default scope if not specified: session",
        "3. If --scope all: reset session, then project, then global overrides for this role",
        "4. Call resetRoleModelOverride() from role-model-registry.ts",
        "5. Report: previous model → restored model, source of restored model",
        "Do NOT reset if no override exists — just report 'no override to reset'.",
      ].join("\n"),
    },
    "role-model-test": {
      description: "对指定角色的当前模型进行轻量冒烟测试，不消耗大量 token。用法：/role-model-test <role>",
      agent: "commander",
      template: [
        "Run a lightweight smoke test for a role's current model.",
        "Parameters: $ARGUMENTS",
        "Format: /role-model-test <role>",
        "",
        "Instructions:",
        "1. Validate the role exists",
        "2. Resolve the effective model via resolveRoleModel()",
        "3. Check provider availability (API key in env)",
        "4. If provider available: try a minimal API call (single token, e.g., 'say hello' with max_tokens=1)",
        "5. Report: model, provider status, latency (approx), any errors",
        "6. Do NOT output the API key",
        "7. If provider unavailable: report which env var is missing and suggest how to configure it",
        "8. This is a lightweight smoke test — do not consume significant tokens",
      ].join("\n"),
    },
    "role-model-fallback-add": {
      description: "为指定角色添加备选模型。用法：/role-model-fallback-add <role> <provider/model> [--scope session|project|global]",
      agent: "commander",
      template: [
        "Add a fallback model to a role's fallback chain.",
        "Parameters: $ARGUMENTS",
        "Format: /role-model-fallback-add <role> <provider/model> [--scope session|project|global]",
        "",
        "Instructions:",
        "1. Validate role name and model format",
        "2. Read current config for the specified scope",
        "3. Add the model to the fallback array (avoid duplicates)",
        "4. Write the updated config",
        "5. Report: role, added fallback, current fallback chain",
        "This is a best-effort operation; if the config format doesn't match, report the issue.",
      ].join("\n"),
    },
    "role-model-fallback-remove": {
      description: "移除指定角色的备选模型。用法：/role-model-fallback-remove <role> <provider/model> [--scope session|project|global]",
      agent: "commander",
      template: [
        "Remove a fallback model from a role's fallback chain.",
        "Parameters: $ARGUMENTS",
        "Format: /role-model-fallback-remove <role> <provider/model> [--scope session|project|global]",
        "",
        "Instructions:",
        "1. Validate role name and model format",
        "2. Read current config for the specified scope",
        "3. Remove the model from the fallback array",
        "4. Write the updated config",
        "5. Report: role, removed fallback, current fallback chain",
      ].join("\n"),
    },
    "multimodal-context": {
      description: "触发多模态上下文解释模型，将截图/图片/网页视觉/PPT图示/图表/视频/音频转换为结构化上下文。默认按需调用，仅在有非纯文本输入时触发。",
      agent: "multimodal-context-interpreter",
      subtask: true,
      template: [
        "[dll-agent multimodal-context-interpreter]",
        "Act as the multimodal context interpreter. Your task is to analyze non-text input and produce a structured multimodal_context_packet.",
        "",
        "Instructions:",
        "1. Identify all non-text inputs (screenshots, images, webpage visuals, PPT figures, flowcharts, charts, video, audio, UI, document visuals)",
        "2. For each input: describe observations, detect text, map visual structure, note errors/warnings, extract important details",
        "3. Assign confidence (low/medium/high) to each observation and overall",
        "4. Set context_sufficient=false if the input is too ambiguous or incomplete",
        "5. NEVER claim high confidence if uncertainties remain",
        "6. NEVER treat image understanding as absolute fact",
        "7. Output the structured packet using multimodal-context.ts buildMultimodalPacket()",
        "8. Write evidence via writeMultimodalEvidence()",
        "9. Do NOT modify files, run commands, or change code",
        "10. This role is read-only; your output feeds into commander/reviewer for downstream decisions",
        "",
        "Output format (use the multimodal-context.ts types):",
        "- packet_type: multimodal_context_packet",
        "- input_type: screenshot|image|webpage_visual|ppt_figure|chart|flowchart|video|audio|ui|document_visual",
        "- observations[]: { description, category, confidence }",
        "- detected_text: recognized text or null",
        "- visual_structure: layout description or null",
        "- errors_or_warnings[]: anomalies found",
        "- important_details[]: details for downstream tasks",
        "- uncertainties[]: things you're not sure about",
        "- overall_confidence: low|medium|high",
        "- context_sufficient: true|false",
        "",
        "$ARGUMENTS",
      ].join("\n"),
    },
    "multimodal-context-test": {
      description: "对多模态上下文解释模型进行轻量配置检查，不消耗大量 token。",
      agent: "commander",
      template: [
        "Run a lightweight config check for the multimodal-context-interpreter role:",
        "1. Resolve the effective model via resolveRoleModel('multimodal-context-interpreter')",
        "2. Check provider availability (MIMO_API_KEY in env)",
        "3. If provider is unavailable, report which env var is missing",
        "4. Report: role, model, provider status, on-demand status",
        "5. Do NOT make actual multimodal API calls — this is a config check only",
      ].join("\n"),
    },
    "tools": {
      description: "显示当前生效的工具清单：全局默认 + 项目覆盖合并结果，以及每个工具的状态。",
      agent: "commander",
      template: [
        "Show the current dll-agent effective tools manifest.",
        "Use the tool-catalog.ts and tool-overlay.ts modules to display:",
        "- Global default tools (source: global)",
        "- Project overlay (if any)",
        "- Merged effective tools list",
        "- Per-tool status: registered / available / unavailable / active / running / failed / disabled_by_project / blocked_by_policy / requires_consent",
        "- Merge source per tool: global_default / project_add / project_override",
        "- Heavy MCPs marked as on_demand (not started)",
        "This command is read-only; do not start any MCP or change state.",
      ].join("\n"),
    },
    "tools-reload": {
      description: "重新读取全局和项目工具清单并更新会话生效清单，不启动重型 MCP。",
      agent: "commander",
      template: [
        "Reload the dll-agent tool manifests.",
        "1. Re-read global manifest from ~/.dll-agent/global/tools.jsonc (if exists)",
        "2. Re-read project overlay from <project>/.dll-agent/tools.jsonc or <project>/dll-agent.tools.jsonc (if exists)",
        "3. Re-merge to build new effective manifest",
        "4. Write new effective manifest to session state",
        "5. Write evidence for the reload event",
        "6. Display the updated tools list",
        "Do NOT auto-start any heavy MCPs; only update the registry.",
      ].join("\n"),
    },
    "tools-status": {
      description: "显示所有工具的详细状态：已注册、可用、运行中、失败、被阻止等。",
      agent: "commander",
      template: [
        "Show detailed tool status for all registered tools.",
        "For each tool, display: id, name, kind (skill/tool/mcp/command), status, merge source, start policy (for MCPs), risk level, security requirements.",
        "Organize by status groups: active/running → available → requires_consent → unavailable → disabled_by_project → blocked_by_policy → failed.",
        "Include evidence of when the manifest was last merged.",
      ].join("\n"),
    },
    "mcp-status": {
      description: "显示所有 MCP 服务状态：名称、运行状态、进程 ID、端口、健康状态、最近检查时间。",
      agent: "commander",
      template: [
        "Show detailed MCP server status for all MCP entries in the effective manifest.",
        "For each MCP, use mcp-manager.ts detailedStatus() to display:",
        "- name",
        "- status (running / stopped / failed / degraded)",
        "- pid (if running)",
        "- healthy (from healthcheck)",
        "- last_health_at",
        "- start_policy (on_demand / autostart_lightweight / disabled)",
        "- heavy (true/false)",
        "- mutex_key",
        "- error (last error message)",
        "Do NOT start any MCP; this is read-only.",
      ].join("\n"),
    },
    "mcp-start": {
      description: "按需启动指定 MCP 服务，启动前检查端口、互斥锁和健康状态。",
      agent: "commander",
      template: [
        "Start the specified MCP server by name.",
        "Before starting, check:",
        "1. Is the MCP registered in the effective manifest?",
        "2. Has it been removed by project overlay?",
        "3. Is there a healthcheck available?",
        "4. Does the user need to confirm (requires_consent)?",
        "5. Is there an existing process with the same name?",
        "6. Is there a port conflict?",
        "7. Is the MCP marked as isolated (needs separate profile)?",
        "8. Is the mutex lock held?",
        "Use mcp-manager.ts: shouldStart(), acquireLock(), healthcheck() to verify.",
        "If Playwright: ensure --isolated mode; warn about browser profile; check port conflicts.",
        "Write evidence for start attempt, success, or failure.",
        "MCP name: $ARGUMENTS",
      ].join("\n"),
    },
    "mcp-stop": {
      description: "停止指定 MCP 服务并释放互斥锁。",
      agent: "commander",
      template: [
        "Stop the specified MCP server.",
        "1. Find the MCP process by name/pid from mcp-manager state",
        "2. Send SIGTERM to the process",
        "3. Release the mutex lock via releaseLock()",
        "4. Mark status as stopped via markStopped()",
        "5. Write evidence for stop event",
        "Do NOT kill unrelated processes.",
        "MCP name: $ARGUMENTS",
      ].join("\n"),
    },
    "mcp-health": {
      description: "对指定 MCP 服务运行健康检查。",
      agent: "commander",
      template: [
        "Check health of the specified MCP server.",
        "1. Load server status from mcp-manager state",
        "2. Check if process is alive (kill -0 on pid)",
        "3. If health_url configured, attempt HTTP health check",
        "4. Report: healthy / unhealthy with reason",
        "5. Update last_health_at timestamp in state via markRunning",
        "6. Write evidence for health check result",
        "MCP name: $ARGUMENTS",
      ].join("\n"),
    },
    "capabilities": {
      description: "显示完整能力注册表：内置 + 全局 + 发现 + 项目多层合并结果。",
      agent: "commander",
      template: [
        "Show the current dll-agent capability registry (capability-driven system).",
        "Use the capability-registry.ts module to:",
        "1. Load builtin capabilities (mapped from tool-catalog + skill-registry via capability-mapping.ts)",
        "2. Load global registry (~/.dll-agent/capabilities/registry.json)",
        "3. Load discovered capabilities (~/.dll-agent/capabilities/discovered.json)",
        "4. Load project overlay (<project>/.dll-agent/capabilities.json)",
        "5. Merge all layers and display:",
        "   - Total capability entries and by kind (skill/tool/mcp/software/model)",
        "   - Per-entry: id, kind, name, capabilities (tags), status, risk_level, source, source_type, confidence",
        "   - Capabilities grouped by layer (builtin/global/discovered/project)",
        "6. Highlight: heavy MCPs, high-risk entries, capabilities with missing dependencies",
        "This command is read-only; do not start any MCP or change state.",
      ].join("\n"),
    },
    "capability-status": {
      description: "显示每个能力的详细状态：可用、运行中、缺少依赖、降级、被阻止等。",
      agent: "commander",
      template: [
        "Show detailed capability status for all registered capabilities.",
        "For each capability, display: id, kind, name, status, capabilities (tags), risk_level, cost_level,",
        "source_type, confidence, last_verified_at, install_strategy, start_policy.",
        "Organize by status groups: available → registered → missing_dependency → degraded → blocked → failed.",
        "Also show:",
        "- Which capabilities are from builtin vs discovered vs project",
        "- Which capabilities are currently running (runtime lifecycle state)",
        "- Which capabilities need installation or permission",
        "- Total counts by status and by kind",
      ].join("\n"),
    },
    "capability-discover": {
      description: "运行自动能力发现，扫描本地环境中的新能力并更新发现注册表。",
      agent: "commander",
      template: [
        "Run capability discovery to find new capabilities in the local environment.",
        "Use capability-discovery.ts::runDiscovery() to scan:",
        "1. Project manifest files (package.json, pyproject.toml, Cargo.toml, go.mod)",
        "2. MCP server manifests (.mcp/config.json, mcp.json)",
        "3. Skill metadata files (SKILL.md in .opencode/skills/)",
        "4. Locally installed commands (which, npm ls -g, pip show, bun pm)",
        "After discovery:",
        "- Show how many new capabilities were found (total, new, updated)",
        "- Show capabilities by source type (local-scan, manifest, etc.)",
        "- Note: discovered capabilities go to the discovered layer with confidence scores",
        "- Low-confidence capabilities (doc-summary) are capped at 0.5 confidence",
        "- Prompt the user to review and promote verified capabilities to the global registry",
        "Use force=true to skip TTL/cache and run a full fresh discovery.",
      ].join("\n"),
    },
    "capability-plan": {
      description: "根据任务目标规划所需能力，显示匹配方案、替代选项与能力缺口。用法：/capability-plan <任务描述>",
      agent: "commander",
      template: [
        "Use the capability planner to determine what capabilities are needed for the task.",
        "Given: $ARGUMENTS (the user's task goal)",
        "Using capability-planner.ts::planCapabilities(), show:",
        "1. Required semantic capability tags (derived from task analysis + registry triggers)",
        "2. Selected capabilities (best match for each tag, with scores and reasons)",
        "3. Alternative capabilities (other options that could serve the same need)",
        "4. Capability gaps (tags with no matching capability in the registry)",
        "5. Install suggestions (for capabilities that need dependency installation)",
        "Explain WHY each capability was selected (match score, availability, confidence, risk).",
        "If there are gaps, suggest what kind of capability would fill them.",
      ].join("\n"),
    },
    "capability-refresh": {
      description: "刷新能力状态：重新检查可用性、验证安装，并将高可信发现能力提升到全局注册表。",
      agent: "commander",
      template: [
        "Refresh capability statuses in the registry.",
        "1. For each capability in the global registry, re-check:",
        "   - Binary availability (which command, PATH check)",
        "   - Token availability (env var check)",
        "   - Port availability (lsof check)",
        "2. For discovered capabilities with confidence >= 0.7 and valid schema:",
        "   - Offer to promote them to the global registry (promoteDiscovered())",
        "3. For failed/crashed capabilities:",
        "   - Check if the issue is resolved (re-verify)",
        "4. Update last_verified_at timestamps",
        "5. Report changes: promoted, invalidated, status changes",
        "Use capability-registry.ts functions for all operations.",
      ].join("\n"),
    },
    "capability-doctor": {
      description: "对能力注册表与运行时进行专项健康检查：文件完整性、缓存时效、状态异常与残留。",
      agent: "commander",
      template: [
        "Run capability-specific health checks.",
        "1. Check registry files: parseable JSON, non-empty, no corruption",
        "2. Check discovery cache: staleness (>24h), TTL",
        "3. Check runtime state: failed/stale capability states",
        "4. Check confidence anomalies: doc-summary with high confidence, high-risk with low confidence",
        "5. Check lifecycle residuals: stale PID files, idle states, failed retries",
        "6. Check for prompt-only claimed capabilities (registered but no verify_commands)",
        "7. Report PASS/WARN/FAIL for each check",
        "Focus only on the capability layer; skip general system health (that's /doctor).",
      ].join("\n"),
    },
  }
}

export function systemPrompt() {
  if (!enabled()) return
  const roster = roleRoster()
  return [
    "dll-agent source-level operating profile is enabled.",
    "The role-team structure is only an operating method. The controlling objective is completing the user's real goal.",
    "Use lawful, auditable, reversible engineering means within user authorization and local safety boundaries: analyze, gather evidence, download tools, install dependencies, use MCP/skills/browser/shell, cross-review, temporarily cross roles, self-repair, and keep going.",
    "Do not bypass permissions, steal or leak secrets, damage the system, evade platform safety controls, or hide risk.",
    `Commander/default executor: ${roster.commander.model}. ${roster.commander.mission}`,
    `Chief engineer: ${roster.chiefEngineer.model}. ${roster.chiefEngineer.mission}`,
    `Requirements inspector: ${roster.requirementsInspector.model}. ${roster.requirementsInspector.mission}`,
    `Long-context archivist: ${roster.longContextArchivist.model}. ${roster.longContextArchivist.mission}`,
    `OpenAI strategic/final auditor: ${roster.finalAuditor.model}. ${roster.finalAuditor.mission}`,
    "OpenAI escalation triggers: two consecutive failed attempts, user says the agent is off-track, reviewer conflict, explicit strategic overview request, or a high-risk final completion claim.",
    "Temporary role crossing is allowed only during recovery or reviewer conflict; after that round, each model returns to its normal role.",
    "Every important conclusion, fix, configuration recommendation, and completion claim must be backed by evidence.",
    "If evidence is missing, label the claim as unverified and continue gathering evidence instead of pretending completion.",
    "The UI may show one active agent, but dll-agent is a role team. The DeepSeek commander should do normal work directly and call real subagents through the task tool when the task is complex, high-risk, stuck, weakly evidenced, or challenged by the user.",
    "Do not call OpenAI for ordinary status, ordinary planning, routine coding, or first-pass answers.",
    "Available subagents: chief-engineer, requirements-inspector, long-context-archivist, final-auditor, role-cross.",
    "Available role commands: /dll-status, /quality, /verify, /model-capability, /roles, /chief-engineer, /requirements-check, /context-check, /final-audit, /cross-review, /team-review, /role-models, /role-model-set, /role-model-reset, /role-model-test, /capabilities, /capability-status, /capability-discover, /capability-plan, /capability-refresh, /capability-doctor.",
    "Prompting is layered: source-level invariants are short and global; role prompts are role-specific; task packets are phase-specific; evidence packets are retrieved precisely; cross-role packets are temporary and removed after recovery.",
    "Do not feed every instruction to every model. Keep each model focused on its role unless role crossing is explicitly needed for recovery.",
    "",
    "可通过 /role-model-set 和 /role-model-reset 命令在运行时切换角色模型。使用 /role-models 查看当前配置。",
  ].join("\n")
}

export function redact(value: unknown) {
  return evidenceRedact(value)
}

export function writeEvidence(type: string, payload: unknown) {
  if (!enabled()) return
  evidenceWrite(type, payload)
}


