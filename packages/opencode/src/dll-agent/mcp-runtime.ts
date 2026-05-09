/**
 * dll-agent MCP Runtime
 *
 * Narrow runtime bridge for on-demand MCP startup. It keeps heavy MCP servers
 * registered by default, performs safety/preflight checks before OpenCode MCP
 * connection, and records runtime decisions as evidence.
 */

import fs from "fs"
import path from "path"
import type { McpRuntimeRequest } from "./capability-orchestrator"
import type { CapabilityEntry } from "./capability-schema"
import { write as writeEvidence } from "./evidence"
import type { DllRole } from "./role-model-registry"
import { classifyRoleToolRequest } from "./role-tool-policy"
import {
  checkPort,
  degrade,
  healthcheck,
  loadStatus,
  markRunning,
  markStopped,
  shouldStart,
  stopManagedServer,
  type McpHealthcheckResult,
  type McpServerDecl,
} from "./mcp-manager"

export type McpRuntimeAction =
  | "allow_connect"
  | "skip_already_connected"
  | "blocked_missing_binary"
  | "blocked_missing_env"
  | "blocked_permission"
  | "blocked_mutex"
  | "blocked_port"
  | "blocked_sensitive_context"
  | "blocked_cooldown"

export interface McpRuntimeDecision {
  action: McpRuntimeAction
  name: string
  entry_id: string
  reason: string
  decl: McpServerDecl
  missing_binaries: string[]
  missing_env_keys: string[]
  blocked_ports: number[]
  evidence_ref?: string
}

export interface McpRuntimePreflightInput {
  request: McpRuntimeRequest
  entry?: CapabilityEntry
  openCodeStatus?: string
  sessionID?: string
  projectDir?: string
  role?: DllRole | null
  userGoal?: string
  explicitlyAuthorized?: boolean
}

const SENSITIVE_CONTEXT_PATTERNS = [
  /cookie|cookies|session\s+(cookie|token|credential)|登录态|真实登录|真实账号/i,
  /password|密码|token|api[_-]?key|secret|ssh\s+key|Authorization/i,
  /real\s+browser\s+profile|真实浏览器|浏览器\s*profile|default\s+profile/i,
]

function pathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
}

function commandExists(binary: string): boolean {
  if (!binary) return false
  if (binary.includes("/") || binary.startsWith(".")) return fs.existsSync(binary)
  return pathEntries().some((dir) => fs.existsSync(path.join(dir, binary)))
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

function requestCommand(request: McpRuntimeRequest) {
  return request.config.command.join(" ")
}

function requestToDecl(request: McpRuntimeRequest, entry?: CapabilityEntry): McpServerDecl {
  return {
    name: request.name,
    command: request.config.command,
    env: request.config.environment,
    healthUrl: entry?.runtime?.healthcheck?.url,
    isolated: !!entry?.runtime?.isolated || request.heavy,
    autoRestart: false,
    maxRetries: entry?.runtime?.max_start_retries ?? 3,
    timeoutMs: request.config.timeout ?? entry?.runtime?.start_timeout_ms ?? 30_000,
    cooldownMs: 60_000,
  }
}

function missingBinaries(request: McpRuntimeRequest, entry?: CapabilityEntry): string[] {
  const required = unique([request.config.command[0], ...(entry?.dependencies?.binaries ?? [])])
  return required.filter((binary) => !commandExists(binary))
}

function missingEnvKeys(entry?: CapabilityEntry): string[] {
  const required = unique([...(entry?.dependencies?.tokens ?? []), ...(entry?.runtime?.env_keys ?? [])])
  return required.filter((key) => !process.env[key])
}

function blockedPorts(entry?: CapabilityEntry): number[] {
  return (entry?.dependencies?.ports ?? []).filter((port) => !checkPort(port).free)
}

function hasSensitiveContext(input: McpRuntimePreflightInput): boolean {
  const text = `${input.request.reason}\n${input.userGoal ?? ""}`
  return SENSITIVE_CONTEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function evidencePayload(input: McpRuntimePreflightInput, decision: Omit<McpRuntimeDecision, "evidence_ref">) {
  return {
    name: decision.name,
    entry_id: decision.entry_id,
    action: decision.action,
    reason: decision.reason,
    role: input.role ?? "commander",
    risk_level: input.request.risk_level,
    heavy: input.request.heavy,
    requires_consent: input.request.requires_consent,
    open_code_status: input.openCodeStatus ?? "unknown",
    missing_binaries: decision.missing_binaries,
    missing_env_keys: decision.missing_env_keys,
    blocked_ports: decision.blocked_ports,
  }
}

function makeDecision(
  input: McpRuntimePreflightInput,
  action: McpRuntimeAction,
  reason: string,
  extras: Partial<Pick<McpRuntimeDecision, "missing_binaries" | "missing_env_keys" | "blocked_ports">> = {},
): McpRuntimeDecision {
  const decision: Omit<McpRuntimeDecision, "evidence_ref"> = {
    action,
    name: input.request.name,
    entry_id: input.request.entry_id,
    reason,
    decl: requestToDecl(input.request, input.entry),
    missing_binaries: extras.missing_binaries ?? [],
    missing_env_keys: extras.missing_env_keys ?? [],
    blocked_ports: extras.blocked_ports ?? [],
  }
  const eventType = action === "allow_connect" ? "mcp.runtime_preflight" : "mcp.runtime_blocked"
  writeEvidence(eventType, evidencePayload(input, decision), input.sessionID)
  return { ...decision, evidence_ref: `${eventType}:${decision.name}` }
}

export function preflightMcpRuntime(input: McpRuntimePreflightInput): McpRuntimeDecision {
  if (input.openCodeStatus === "connected") {
    return makeDecision(input, "skip_already_connected", "OpenCode MCP service already reports connected")
  }

  if (hasSensitiveContext(input) && !input.explicitlyAuthorized) {
    return makeDecision(input, "blocked_sensitive_context", "MCP task mentions credentials, cookies, secrets, or real browser profile without explicit authorization")
  }

  const binaries = missingBinaries(input.request, input.entry)
  if (binaries.length) {
    return makeDecision(input, "blocked_missing_binary", "Required MCP binary is missing", {
      missing_binaries: binaries,
    })
  }

  const envKeys = missingEnvKeys(input.entry)
  if (envKeys.length) {
    return makeDecision(input, "blocked_missing_env", "Required MCP environment key is missing", {
      missing_env_keys: envKeys,
    })
  }

  const ports = blockedPorts(input.entry)
  if (ports.length) {
    return makeDecision(input, "blocked_port", "Required MCP port is already in use", {
      blocked_ports: ports,
    })
  }

  const roleDecision = classifyRoleToolRequest({
    role: input.role ?? "commander",
    permission: "bash",
    patterns: [requestCommand(input.request)],
    metadata: {
      dllAgentRole: input.role ?? "commander",
      capability_kind: "mcp",
      capability_id: input.request.entry_id,
    },
    projectRoot: input.projectDir,
    cwd: input.projectDir,
    sessionID: input.sessionID,
  })
  if (roleDecision.action === "deny") {
    return makeDecision(input, "blocked_permission", roleDecision.reason)
  }
  if (roleDecision.action === "ask" && !input.explicitlyAuthorized) {
    return makeDecision(input, "blocked_permission", roleDecision.reason)
  }

  const start = shouldStart(requestToDecl(input.request, input.entry))
  if (!start.start) {
    if (start.reason.includes("already running")) {
      return makeDecision(input, "skip_already_connected", start.reason)
    }
    if (start.reason.includes("cooldown")) {
      return makeDecision(input, "blocked_cooldown", start.reason)
    }
    return makeDecision(input, "blocked_mutex", start.reason)
  }

  return makeDecision(input, "allow_connect", "MCP runtime preflight passed")
}

export function recordMcpRuntimeConnected(input: {
  decision: McpRuntimeDecision
  status?: string
  sessionID?: string
}) {
  markRunning(input.decision.decl, process.pid)
  const health = healthcheck(input.decision.decl)
  const evidence = writeEvidence("mcp.runtime_connected", {
    name: input.decision.name,
    entry_id: input.decision.entry_id,
    status: input.status ?? "unknown",
    health: health.healthy,
    health_detail: health.detail,
    preflight_evidence_ref: input.decision.evidence_ref,
  }, input.sessionID)
  return evidence
}

export function recordMcpRuntimeConnectFailed(input: {
  decision: McpRuntimeDecision
  error: unknown
  sessionID?: string
}) {
  degrade(input.decision.decl, String(input.error))
  return writeEvidence("mcp.runtime_connect_failed", {
    name: input.decision.name,
    entry_id: input.decision.entry_id,
    error: String(input.error),
    preflight_evidence_ref: input.decision.evidence_ref,
  }, input.sessionID)
}

export function recordMcpRuntimeStopped(input: {
  name: string
  entry_id?: string
  sessionID?: string
  reason?: string
}) {
  markStopped(input.name)
  return writeEvidence("mcp.runtime_stopped", {
    name: input.name,
    entry_id: input.entry_id,
    reason: input.reason ?? "stopped",
  }, input.sessionID)
}

export function stopMcpRuntime(input: {
  name: string
  entry_id?: string
  sessionID?: string
  reason?: string
}) {
  const result = stopManagedServer(input.name)
  writeEvidence("mcp.runtime_stopped", {
    name: input.name,
    entry_id: input.entry_id,
    stopped: result.stopped,
    reason: input.reason ?? result.reason,
    manager_reason: result.reason,
  }, input.sessionID)
  return result
}

export function runMcpRuntimeHealthcheck(input: {
  decision: McpRuntimeDecision
  sessionID?: string
}): McpHealthcheckResult {
  const result = healthcheck(input.decision.decl)
  writeEvidence("mcp.runtime_healthcheck", {
    name: input.decision.name,
    entry_id: input.decision.entry_id,
    healthy: result.healthy,
    detail: result.detail,
    probe: result.probe,
  }, input.sessionID)
  return result
}

export function mcpRuntimeStatus(name: string) {
  return loadStatus(name)
}
