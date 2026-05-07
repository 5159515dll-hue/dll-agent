import { redact as evidenceRedact, write as evidenceWrite } from "./evidence"

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

export function roleRoster() {
  return {
    commander: {
      model: "deepseek/deepseek-v4-pro",
      mission: "Default goal execution, routing, deep reasoning, stop-condition control, and evidence gate.",
    },
    chiefEngineer: {
      model: "deepseek/deepseek-v4-pro",
      mission: "Deep reasoning, engineering execution, hard debugging, patch design, and tool-use recovery.",
    },
    requirementsInspector: {
      model: "zai/glm-5.1",
      mission: "Chinese requirement interpretation, instruction adherence, contradiction detection, and phase drift checks.",
    },
    longContextArchivist: {
      model: "kimi/kimi-k2.6",
      mission: "Long logs, documents, reports, PPT/Word consistency, memory, baseline, and history reconciliation.",
    },
    finalAuditor: {
      model: "openai/gpt-5.5-pro",
      mission: "On-demand strategic overview and final audit only when stuck, off-track, conflicted, or making high-risk completion claims.",
    },
  }
}

export function modeSummary() {
  return {
    quality: quality(),
    verify: verify(),
    defaultAgent: "commander",
    defaultModel: "deepseek/deepseek-v4-pro",
    commands: ["roles", "dll-status", "quality", "verify", "model-capability", "chief-engineer", "requirements-check", "context-check", "final-audit", "cross-review", "team-review", "tools", "tools-reload", "tools-status", "mcp-status", "mcp-start", "mcp-stop", "mcp-health"],
    subagents: ["chief-engineer", "requirements-inspector", "long-context-archivist", "final-auditor", "role-cross"],
  }
}

export function roleCommands() {
  const q = quality()
  const v = verify()
  return {
    "roles": {
      description: "Show the dll-agent role team and when each role must be used.",
      agent: "commander",
      template:
        "Show the current dll-agent role team. Explain that the visible active agent is only the coordinator, and real role work is done through the task tool and slash commands. List exact subagent names: chief-engineer, requirements-inspector, long-context-archivist, final-auditor, role-cross. Do not call this complete work; this is only a status/explanation command.",
    },
    "dll-status": {
      description: "Show dll-agent mode, model capabilities, and role dispatch state.",
      agent: "commander",
      template: [
        `Quality mode: ${q}.`,
        `Verification mode: ${v}.`,
        "Default commander/executor: deepseek/deepseek-v4-pro, context 1,048,576, thinking=max.",
        "Inspectors: zai/glm-5.1 and kimi/kimi-k2.6.",
        "OpenAI strategic/final auditor: openai/gpt-5.5-pro, on-demand only for stuck/off-track/conflict/high-risk finalization.",
        "Available commands: /quality, /verify, /model-capability, /roles, /team-review, /chief-engineer, /cross-review.",
      ].join("\n"),
    },
    "quality": {
      description: "Show or request quality mode: max, auto, balanced, economy.",
      agent: "commander",
      template:
        `Current quality mode is ${q}. User requested quality mode: $ARGUMENTS\nSupported modes: max, auto, balanced, economy. Default/recommended is max: strongest, most expensive, no silent downgrade. For enforced relaunch, use: dll-agent --quality <mode>.`,
    },
    "verify": {
      description: "Show or request verification mode: strict, normal, light.",
      agent: "commander",
      template:
        `Current verification mode is ${v}. User requested verification mode: $ARGUMENTS\nSupported modes: strict, normal, light. Default/recommended is strict: every important claim needs evidence. For enforced relaunch, use: dll-agent --verify <mode>.`,
    },
    "model-capability": {
      description: "Show pinned strongest model capabilities and role mapping.",
      agent: "commander",
      template:
        "Show pinned dll-agent model capabilities:\n- default commander/executor: deepseek/deepseek-v4-pro, context 1,048,576, thinking=max, reasoning=max.\n- requirements-inspector: zai/glm-5.1, context 204,800, thinking enabled.\n- long-context-archivist: kimi/kimi-k2.6, context 262,144, thinking enabled.\n- strategic/final auditor: openai/gpt-5.5-pro, context 1,050,000, output 128,000, reasoning=xhigh, on-demand only.\nDo not claim live API verification unless doctor/API smoke was actually run.",
    },
    "chief-engineer": {
      description: "Delegate execution/debugging to DeepSeek chief engineer.",
      agent: "chief-engineer",
      model: "deepseek/deepseek-v4-pro",
      subtask: true,
      template:
        "Act as the chief engineer. Use deep reasoning, code inspection, tools, and verification to move the user goal forward. If a fix is made, provide exact files, commands, observed outputs, and remaining risk.\n\n$ARGUMENTS",
    },
    "requirements-check": {
      description: "Run GLM Chinese requirement and logic inspection.",
      agent: "requirements-inspector",
      model: "zai/glm-5.1",
      subtask: true,
      template:
        "Act as the requirements inspector. Check the user's Chinese intent, constraints, contradictions, phase drift, and whether the current work is still aligned with the real goal. Cite evidence.\n\n$ARGUMENTS",
    },
    "context-check": {
      description: "Run Kimi long-context, document, log, and baseline inspection.",
      agent: "long-context-archivist",
      model: "kimi/kimi-k2.6",
      subtask: true,
      template:
        "Act as the long-context archivist. Check logs, documents, baselines, phase history, evidence, and memory drift. Only use evidence-backed conclusions.\n\n$ARGUMENTS",
    },
    "final-audit": {
      description: "Run on-demand GPT-5.5 Pro strategic/final evidence audit.",
      agent: "final-auditor",
      model: "openai/gpt-5.5-pro",
      subtask: true,
      template:
        "Act as the on-demand strategic/final auditor. Check whether the user goal is complete, whether evidence is sufficient, whether tests/doctor/smoke checks really ran, whether strategic direction is still sound, and whether any claim is overconfident.\n\n$ARGUMENTS",
    },
    "cross-review": {
      description: "Temporary role crossing for stuck tasks or reviewer conflict.",
      agent: "role-cross",
      model: "deepseek/deepseek-v4-pro",
      subtask: true,
      template:
        "Run a temporary role-crossing review. Inspect the problem from a different role's perspective, find blind spots, identify missing evidence, and propose actionable recovery steps. This role crossing ends after this review round.\n\n$ARGUMENTS",
    },
    "team-review": {
      description: "Commander-driven multi-role review plan.",
      agent: "commander",
      template:
        "Run a dll-agent team review for the current objective. Use the task tool only for roles that are actually needed; do not call OpenAI by default. Call these subagents as needed: requirements-inspector for intent/rules, long-context-archivist for logs/baseline/context, chief-engineer for executable recovery, final-auditor only for stuck/off-track/conflict/high-risk completion claims. Reconcile conflicts and continue toward the user goal.\n\n$ARGUMENTS",
    },
    "tools": {
      description: "Show current effective tools manifest: global + project merge, status per tool.",
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
      description: "Reload global + project tools manifests and update session effective manifest.",
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
      description: "Show detailed status of all tools: registered, available, running, failed, blocked.",
      agent: "commander",
      template: [
        "Show detailed tool status for all registered tools.",
        "For each tool, display: id, name, kind (skill/tool/mcp/command), status, merge source, start policy (for MCPs), risk level, security requirements.",
        "Organize by status groups: active/running → available → requires_consent → unavailable → disabled_by_project → blocked_by_policy → failed.",
        "Include evidence of when the manifest was last merged.",
      ].join("\n"),
    },
    "mcp-status": {
      description: "Show MCP server status: name, status, pid, port, health, last check.",
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
      description: "Start a specific MCP server by name (on-demand).",
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
      description: "Stop a specific MCP server by name.",
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
      description: "Run healthcheck on a specific MCP server.",
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
    "Available role commands: /dll-status, /quality, /verify, /model-capability, /roles, /chief-engineer, /requirements-check, /context-check, /final-audit, /cross-review, /team-review.",
    "Prompting is layered: source-level invariants are short and global; role prompts are role-specific; task packets are phase-specific; evidence packets are retrieved precisely; cross-role packets are temporary and removed after recovery.",
    "Do not feed every instruction to every model. Keep each model focused on its role unless role crossing is explicitly needed for recovery.",
  ].join("\n")
}

export function redact(value: unknown) {
  return evidenceRedact(value)
}

export function writeEvidence(type: string, payload: unknown) {
  if (!enabled()) return
  evidenceWrite(type, payload)
}


