import { classifyPermissionRequest } from "./permission-classifier"
import type { RiskLevel } from "./interfaces"
import type { DllRole } from "./role-model-registry"
import { isDllRole } from "./role-model-registry"
import { write as writeEvidence } from "./evidence"

export type RoleToolMode = "writable" | "read_only"
export type RoleToolAction = "allow" | "ask" | "deny"

export interface RoleToolPolicy {
  role: DllRole
  mode: RoleToolMode
  allow: string[]
  deny: string[]
  requiresConfirmationForHighRisk: boolean
}

export interface RoleToolDecision {
  role: DllRole | null
  permission: string
  action: RoleToolAction
  risk: RiskLevel
  reason: string
}

const MUTATING_TOOLS = ["bash", "edit", "write", "patch", "task", "todowrite", "workflow_tool_approval"]
const READ_ONLY_TOOLS = ["read", "grep", "glob", "list"]
const NETWORK_READ_TOOLS = ["webfetch", "websearch"]
const WRITABLE_ROLES = new Set<DllRole>(["commander", "chief-engineer", "executor"])

const ROLE_POLICIES: Record<DllRole, RoleToolPolicy> = {
  commander: writablePolicy("commander"),
  "chief-engineer": writablePolicy("chief-engineer"),
  executor: writablePolicy("executor"),
  "requirements-inspector": readOnlyPolicy("requirements-inspector"),
  "long-context-archivist": readOnlyPolicy("long-context-archivist"),
  "task-completion-archivist": readOnlyPolicy("task-completion-archivist"),
  "final-auditor": readOnlyPolicy("final-auditor", NETWORK_READ_TOOLS),
  "role-cross": readOnlyPolicy("role-cross", NETWORK_READ_TOOLS),
  "multimodal-context-interpreter": readOnlyPolicy("multimodal-context-interpreter", NETWORK_READ_TOOLS),
  "agentic-solver": readOnlyPolicy("agentic-solver"),
  "multimodal-reader": readOnlyPolicy("multimodal-reader", NETWORK_READ_TOOLS),
  "voice-output": readOnlyPolicy("voice-output"),
}

function writablePolicy(role: DllRole): RoleToolPolicy {
  return {
    role,
    mode: "writable",
    allow: ["*"],
    deny: [],
    requiresConfirmationForHighRisk: true,
  }
}

function readOnlyPolicy(role: DllRole, extraAllow: string[] = []): RoleToolPolicy {
  return {
    role,
    mode: "read_only",
    allow: [...READ_ONLY_TOOLS, ...extraAllow],
    deny: MUTATING_TOOLS,
    requiresConfirmationForHighRisk: true,
  }
}

export function roleToolPolicyFor(role: DllRole): RoleToolPolicy {
  return ROLE_POLICIES[role] ?? readOnlyPolicy(role)
}

export function isReadOnlyRole(role: string) {
  return isDllRole(role) && roleToolPolicyFor(role).mode === "read_only"
}

export function permissionConfigForRole(role: DllRole): Record<string, "allow" | "deny"> {
  const policy = roleToolPolicyFor(role)
  const config: Record<string, "allow" | "deny"> = {}
  for (const tool of policy.allow) config[tool] = "allow"
  for (const tool of policy.deny) config[tool] = "deny"
  return config
}

export function roleFromMetadata(metadata?: Record<string, unknown>): DllRole | null {
  const value = metadata?.dllAgentRole ?? metadata?.agent ?? metadata?.role
  if (typeof value !== "string") return null
  return isDllRole(value) ? value : null
}

export function classifyRoleToolRequest(input: {
  role?: DllRole | null
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  projectRoot?: string
  cwd?: string
  sessionID?: string
  writeEvidence?: boolean
}): RoleToolDecision {
  const classification = classifyPermissionRequest({
    permission: input.permission,
    patterns: input.patterns,
    metadata: input.metadata,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
  })
  const role = input.role ?? roleFromMetadata(input.metadata)
  const policy = role ? roleToolPolicyFor(role) : null
  const deniedByRole = policy?.deny.includes(input.permission) === true
  const action: RoleToolAction = deniedByRole
    ? "deny"
    : classification.risk === "high"
    ? "ask"
    : "allow"
  const reason = deniedByRole
    ? `role '${role}' denies tool '${input.permission}'`
    : classification.risk === "high"
    ? `risk=high requires confirmation: ${classification.reason}`
    : `risk=${classification.risk}: ${classification.reason}`

  const decision: RoleToolDecision = {
    role: role ?? null,
    permission: input.permission,
    action,
    risk: classification.risk,
    reason,
  }

  if (input.writeEvidence !== false) {
    writeEvidence("role_tool_policy.decision", {
      role: decision.role,
      permission: decision.permission,
      action: decision.action,
      risk: decision.risk,
      reason: decision.reason,
      patterns: input.patterns,
    }, input.sessionID)
  }

  return decision
}

export function doctorCheckRoleToolPolicy(): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  for (const [role, policy] of Object.entries(ROLE_POLICIES) as [DllRole, RoleToolPolicy][]) {
    if (WRITABLE_ROLES.has(role)) {
      if (policy.mode !== "writable") issues.push(`${role} should be writable`)
      if (policy.deny.some((tool) => ["bash", "edit", "write", "patch"].includes(tool))) {
        issues.push(`${role} should not deny core write tools`)
      }
      continue
    }
    for (const tool of MUTATING_TOOLS) {
      if (!policy.deny.includes(tool)) issues.push(`${role} must deny ${tool}`)
    }
  }
  const highRisk = classifyRoleToolRequest({
    role: "commander",
    permission: "bash",
    patterns: ["rm -rf /tmp/dll-agent-policy-smoke"],
    writeEvidence: false,
  })
  if (highRisk.action !== "ask") issues.push("high-risk command must require confirmation")
  return { ok: issues.length === 0, issues }
}
