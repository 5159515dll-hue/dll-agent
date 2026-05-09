/**
 * dll-agent permission-bridge.ts
 *
 * Bridge between risk-based permission classifier and opencode Permission pipeline.
 *
 * When dll-agent is enabled with auto-allow, this intercepts Permission.ask
 * calls and auto-approves low-risk operations while preserving high-risk gates.
 *
 * Principle: low-risk → auto-allow, medium-risk → confirm-once, high-risk → always ask.
 */
import { classifyPermissionRequest, permissionActionForRisk } from "./permission-classifier"
import { enabled as profileEnabled, autoAllowAll as profileAutoAllow } from "./profile"
import { classifyRoleToolRequest, roleFromMetadata } from "./role-tool-policy"

export interface PermissionBridgeResult {
  /** true if this request was intercepted and handled (auto-approved or blocked) */
  intercepted: boolean
  /** the decided action */
  action: "allow" | "ask" | "deny"
  /** human-readable reason */
  reason: string
}

/**
 * Perform a risk-based pre-check on a permission request.
 * If the result is "allow" (auto-approved), the caller should skip the normal ask flow.
 * If "ask", the caller should proceed with normal permission evaluation.
 * If "deny", the caller should block the request.
 */
export function permissionPreCheck(params: {
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  projectRoot?: string
  cwd?: string
  sessionID?: string
  /** Whether this permission type has been previously confirmed in this session */
  alreadyConfirmed?: boolean
}): PermissionBridgeResult {
  if (!profileEnabled() || !profileAutoAllow()) {
    return { intercepted: false, action: "ask", reason: "dll-agent auto-allow not enabled" }
  }

  const role = roleFromMetadata(params.metadata)
  const roleDecision = classifyRoleToolRequest({
    role,
    permission: params.permission,
    patterns: params.patterns,
    metadata: params.metadata,
    projectRoot: params.projectRoot,
    cwd: params.cwd,
    sessionID: params.sessionID,
  })
  if (roleDecision.action === "deny") {
    return {
      intercepted: true,
      action: "deny",
      reason: roleDecision.reason,
    }
  }

  const classification = classifyPermissionRequest({
    permission: params.permission,
    patterns: params.patterns,
    metadata: params.metadata,
    projectRoot: params.projectRoot,
    cwd: params.cwd,
  })

  const action = permissionActionForRisk(classification.risk, params.alreadyConfirmed ?? false)

  if (action === "allow") {
    return {
      intercepted: true,
      action: "allow",
      reason: `risk=${classification.risk}: ${classification.reason}`,
    }
  }

  if (action === "deny") {
    return {
      intercepted: true,
      action: "deny",
      reason: `risk=${classification.risk}: ${classification.reason}`,
    }
  }

  return {
    intercepted: true,
    action: "ask",
    reason: `risk=${classification.risk}: ${classification.reason} — requires user confirmation`,
  }
}
