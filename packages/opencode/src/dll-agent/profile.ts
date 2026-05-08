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
      "tools", "tools-reload", "tools-status",
      "mcp-status", "mcp-start", "mcp-stop", "mcp-health",
      "capabilities", "capability-status", "capability-discover",
      "capability-plan", "capability-refresh", "capability-doctor",
    ],
    subagents: ["chief-engineer", "requirements-inspector", "long-context-archivist", "final-auditor", "role-cross"],
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
        `Default commander/executor: ${cmdr.primary}, context 1,048,576, thinking=max.`,
        `Inspectors: ${ri.primary} and ${lca.primary}.`,
        `OpenAI strategic/final auditor: ${fa.primary}, on-demand only for stuck/off-track/conflict/high-risk finalization.`,
        "Available commands: /quality, /verify, /model-capability, /roles, /team-review, /chief-engineer, /cross-review, /role-models.",
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
      description: "Delegate execution/debugging to DeepSeek chief engineer.",
      agent: "chief-engineer",
      subtask: true,
      template:
        "Act as the chief engineer. Use deep reasoning, code inspection, tools, and verification to move the user goal forward. If a fix is made, provide exact files, commands, observed outputs, and remaining risk.\n\n$ARGUMENTS",
    },
    "requirements-check": {
      description: "Run GLM Chinese requirement and logic inspection.",
      agent: "requirements-inspector",
      subtask: true,
      template:
        "Act as the requirements inspector. Check the user's Chinese intent, constraints, contradictions, phase drift, and whether the current work is still aligned with the real goal. Cite evidence.\n\n$ARGUMENTS",
    },
    "context-check": {
      description: "Run Kimi long-context, document, log, and baseline inspection.",
      agent: "long-context-archivist",
      subtask: true,
      template:
        "Act as the long-context archivist. Check logs, documents, baselines, phase history, evidence, and memory drift. Only use evidence-backed conclusions.\n\n$ARGUMENTS",
    },
    "final-audit": {
      description: "Run on-demand GPT-5.5 Pro strategic/final evidence audit.",
      agent: "final-auditor",
      subtask: true,
      template:
        "Act as the on-demand strategic/final auditor. Check whether the user goal is complete, whether evidence is sufficient, whether tests/doctor/smoke checks really ran, whether strategic direction is still sound, and whether any claim is overconfident.\n\n$ARGUMENTS",
    },
    "cross-review": {
      description: "Temporary role crossing for stuck tasks or reviewer conflict.",
      agent: "role-cross",
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
    // ─── Role Model Management Commands ────────────────────────────────────
    "role-models": {
      description: "Show all role model assignments, sources, and provider availability.",
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
      description: "Set a role's model. Usage: /role-model-set <role> <provider/model> [--scope session|project|global]",
      agent: "commander",
      template: [
        "Set the model for a specific dll-agent role.",
        "Parameters: $ARGUMENTS",
        "Format: /role-model-set <role> <provider/model> [--scope session|project|global]",
        "",
        "Instructions:",
        "1. Parse arguments: first arg is role name, second is provider/model, optional --scope flag",
        "2. Default scope if not specified: session",
        "3. Validate the role name exists (use role-model-registry.ts isDllRole)",
        "4. Validate model format (use role-model-registry.ts validateRoleModel)",
        "5. If setting voice/TTS model to a coding role (commander/chief-engineer/agentic-solver), warn but allow",
        "6. If setting final-auditor, warn that it remains on-demand only regardless of model",
        "7. Check provider availability (API key in env)",
        "8. Call setRoleModelOverride() from role-model-registry.ts",
        "9. Report: previous model → new model, scope, and provider availability",
        "10. If provider key is missing, note: 'saved but provider unavailable; will fallback at runtime'",
        "Do NOT make the change unless the role and model format are valid.",
      ].join("\n"),
    },
    "role-model-reset": {
      description: "Reset a role's model to the next-tier default. Usage: /role-model-reset <role> [--scope session|project|global|all]",
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
      description: "Lightweight smoke test for a role's current model. Usage: /role-model-test <role>",
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
      description: "Add a fallback model for a role. Usage: /role-model-fallback-add <role> <provider/model> [--scope session|project|global]",
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
      description: "Remove a fallback model from a role. Usage: /role-model-fallback-remove <role> <provider/model> [--scope session|project|global]",
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
    "capabilities": {
      description: "Show full capability registry: builtin + global + discovered + project merge.",
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
      description: "Show per-capability status: available, running, missing_dependency, degraded, blocked.",
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
      description: "Run automatic capability discovery and update the discovered registry.",
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
      description: "Plan capabilities needed for a given task goal.",
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
      description: "Refresh capability statuses: re-check availability, re-verify, promote from discovered.",
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
      description: "Run capability-specific health checks on the registry and runtime.",
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
    "Role models can be changed at runtime via /role-model-set and /role-model-reset commands. Use /role-models to view current assignments.",
  ].join("\n")
}

export function redact(value: unknown) {
  return evidenceRedact(value)
}

export function writeEvidence(type: string, payload: unknown) {
  if (!enabled()) return
  evidenceWrite(type, payload)
}


