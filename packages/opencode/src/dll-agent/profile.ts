import { redact as evidenceRedact, write as evidenceWrite } from "./evidence"
import { getPermissionMode } from "./permission-mode"
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
  return process.env.DLL_AGENT_ENABLED === "1"
}

/**
 * Current permission mode for legacy callers.
 * Runtime approval is enforced dynamically by permissionPreCheck(), not by
 * adding static allow-all rules to registered agents.
 */
export function autoAllowAll() {
  if (!enabled()) return false
  return getPermissionMode() === "full-access"
}

export function permissionMode() {
  return getPermissionMode()
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
      "roles", "dll-status", "task-status", "quality", "verify", "model-capability",
      "permissions",
      "chief-engineer", "requirements-check", "context-check", "final-audit",
      "cross-review", "team-review",
      "role-models", "role-model-set",
      "multimodal-context",
      "capability-status",
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
  const ri = resolveRoleModel("requirements-inspector")
  const lca = resolveRoleModel("long-context-archivist")
  const fa = resolveRoleModel("final-auditor")

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
    "task-status": {
      description: "直接显示当前任务目标、阶段、阻塞、验证、Result Ledger、routing evidence 和下一步动作。",
      agent: "commander",
      template:
        "Direct local command handled by dll-agent runtime. It must render current task status without making an LLM call.",
    },
    "permissions": {
      description: "切换 dll-agent 权限模式。用法：/permissions [default|auto-review|full-access]",
      agent: "commander",
      template: [
        "Direct local command handled by dll-agent runtime. It must show or set permission mode without making an LLM call.",
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
    "role-model-set": {
      description: "设置角色模型覆盖。用法：/role-model-set <role> <provider/model> [--scope session|project|global]",
      agent: "commander",
      template:
        "Local dll-agent command handled by SessionPrompt without an LLM call. Arguments: $ARGUMENTS",
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
    "The UI may show one active agent, but dll-agent is a role team. The commander should do normal work directly and call real subagents through the task tool when the task is complex, high-risk, stuck, weakly evidenced, or challenged by the user.",
    "Do not call OpenAI for ordinary status, ordinary planning, routine coding, or first-pass answers.",
    "Available subagents: chief-engineer, requirements-inspector, long-context-archivist, final-auditor, role-cross.",
    "Available role commands: /dll-status, /task-status, /permissions, /quality, /verify, /model-capability, /roles, /chief-engineer, /requirements-check, /context-check, /final-audit, /cross-review, /team-review, /role-models, /role-model-set, /multimodal-context, /capability-status.",
    "Prompting is layered: source-level invariants are short and global; role prompts are role-specific; task packets are phase-specific; evidence packets are retrieved precisely; cross-role packets are temporary and removed after recovery.",
    "Do not feed every instruction to every model. Keep each model focused on its role unless role crossing is explicitly needed for recovery.",
    "",
    "可通过 /role-model-set 命令在运行时切换角色模型。使用 /role-models 查看当前配置。",
  ].join("\n")
}

export function redact(value: unknown) {
  return evidenceRedact(value)
}

export function writeEvidence(type: string, payload: unknown) {
  if (!enabled()) return
  evidenceWrite(type, payload)
}
