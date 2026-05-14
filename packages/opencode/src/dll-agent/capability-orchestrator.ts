/**
 * dll-agent Capability Runtime Orchestrator
 *
 * This is the runtime bridge between the declarative capability registry and
 * the session loop. It keeps capability planning out of prompt.ts while making
 * the result directly consumable by tools, skills, MCP, gates, doctor, and UX.
 */

import crypto from "crypto"
import path from "path"
import type { CapabilityEntry, CapabilityRiskLevel } from "./capability-schema"
import { GLOBAL_DEFAULT_TOOLS } from "./tool-catalog"
import { SKILL_REGISTRY, type SkillSignal } from "./skill-registry"
import { mapAllBuiltins } from "./capability-mapping"
import { getFullRegistry, snapshot, type RegistryMergeResult } from "./capability-registry"
import { planCapabilities, type CapabilityGap, type CapabilityPlan, type TaskContext } from "./capability-planner"
import { resolveAll, type ResolverDecision, type ResolverResult } from "./capability-resolver"
import { cleanupStale, type CleanupResult } from "./capability-lifecycle"
import { runDiscovery, type DiscoveryResult } from "./capability-discovery"
import { write as writeEvidence } from "./evidence"

export const CAPABILITY_ORCHESTRATOR_VERSION = "1.0.0"

export type CapabilityActionType =
  | "use"
  | "mcp_connect"
  | "skill_activate"
  | "auto_install"
  | "ask_permission"
  | "blocked"
  | "cleanup"

export interface CapabilityAction {
  type: CapabilityActionType
  entry_id: string
  risk_level: CapabilityRiskLevel
  reason: string
  auto_allowed: boolean
  install_command?: string[]
  verify_command?: string[]
  rollback_command?: string[]
}

export interface McpRuntimeRequest {
  name: string
  entry_id: string
  auto_connect: boolean
  reason: string
  risk_level: CapabilityRiskLevel
  heavy: boolean
  requires_consent: boolean
  config: {
    type: "local"
    command: string[]
    environment?: Record<string, string>
    enabled: boolean
    timeout?: number
  }
}

export interface CapabilityOrchestrationInput {
  sessionID?: string
  projectDir: string
  userGoal: string
  messageID?: string
  filesInvolved?: string[]
  failureType?: string
  maxRisk?: CapabilityRiskLevel
  allowMcpAutoConnect?: boolean
  allowMutatingActions?: boolean
  recordEvidence?: boolean
  performCleanup?: boolean
}

export interface CapabilityOrchestrationResult {
  version: string
  fingerprint: string
  registry: RegistryMergeResult
  registry_snapshot: ReturnType<typeof snapshot>
  plan: CapabilityPlan
  resolver: ResolverResult
  actions: CapabilityAction[]
  mcpRequests: McpRuntimeRequest[]
  skillSignals: SkillSignal[]
  skillIntents: string[]
  toolPromptTags: string[]
  unresolvedGaps: CapabilityGap[]
  blockedReasons: string[]
  cleanup?: CleanupResult
  discovery?: DiscoveryResult
  systemSummary: string
}

const SENSITIVE_TASK_PATTERNS = [
  /cookie|cookies|session|登录态|账号|密码|password|token|api[_-]?key|secret|ssh/i,
  /上传|发布|release|push|deploy|生产|production|真实账号/i,
  /删除|清空|drop\s+database|reset\s+database|force\s+push/i,
]

const MCP_AUTO_CONNECT_BLOCK_PATTERNS = [
  /cookie|cookies|session\s+(cookie|token|credential)|登录态|密码|password|token|api[_-]?key|secret/i,
  /真实账号|真实登录|production\s+(login|account|credential)|生产.*(登录|账号|凭据)/i,
  /上传|发布|release|push|deploy|删除|清空|drop\s+database|reset\s+database|force\s+push/i,
]

function hashStable(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16)
}

function fileExtensions(files: string[] | undefined): string[] {
  const out = new Set<string>()
  for (const file of files ?? []) {
    const ext = path.extname(file)
    if (ext) out.add(ext)
  }
  return [...out]
}

function taskHasSensitiveRisk(text: string): boolean {
  return SENSITIVE_TASK_PATTERNS.some((re) => re.test(text))
}

function taskBlocksMcpAutoConnect(text: string): boolean {
  return MCP_AUTO_CONNECT_BLOCK_PATTERNS.some((re) => re.test(text))
}

function normalizeNpxCommand(command: string[]): string[] {
  if (command[0] !== "npx") return command
  if (command.includes("-y") || command.includes("--yes")) return command
  return ["npx", "-y", ...command.slice(1)]
}

function resolverById(resolver: ResolverResult): Map<string, ResolverDecision> {
  return new Map(resolver.decisions.map((decision) => [decision.entry_id, decision]))
}

function selectedEntries(plan: CapabilityPlan): CapabilityEntry[] {
  const seen = new Set<string>()
  const entries: CapabilityEntry[] = []
  for (const match of plan.selected) {
    if (seen.has(match.entry.id)) continue
    seen.add(match.entry.id)
    entries.push(match.entry)
  }
  return entries
}

function actionFor(entry: CapabilityEntry, decision: ResolverDecision | undefined): CapabilityAction {
  if (!decision) {
    return {
      type: "blocked",
      entry_id: entry.id,
      risk_level: entry.risk_level,
      reason: "missing resolver decision",
      auto_allowed: false,
    }
  }

  const base = {
    entry_id: entry.id,
    risk_level: entry.risk_level,
    reason: decision.reason,
    install_command: decision.install_command,
    verify_command: decision.verify_command,
    rollback_command: decision.rollback_command,
  }

  if (decision.action === "use_now" || decision.action === "lazy_start") {
    return { ...base, type: entry.kind === "skill" ? "skill_activate" : "use", auto_allowed: true }
  }

  if (decision.action === "auto_install" && !decision.requires_user_consent && entry.risk_level !== "high") {
    return { ...base, type: "auto_install", auto_allowed: true }
  }

  if (decision.action === "ask_permission" || decision.requires_user_consent) {
    return { ...base, type: "ask_permission", auto_allowed: false }
  }

  return { ...base, type: "blocked", auto_allowed: false }
}

function acquisitionActionForGap(gap: CapabilityGap): CapabilityAction {
  return {
    type: "ask_permission",
    entry_id: `capability-gap:${gap.tag}`,
    risk_level: "medium",
    reason: `${gap.requirement}. Autonomous acquisition needs an approved source or manifest before download/install.`,
    auto_allowed: false,
  }
}

function buildMcpRequests(
  entries: CapabilityEntry[],
  input: CapabilityOrchestrationInput,
  resolver: ResolverResult,
): McpRuntimeRequest[] {
  const decisions = resolverById(resolver)
  const sensitive = taskBlocksMcpAutoConnect(input.userGoal)
  return entries
    .filter((entry) => entry.kind === "mcp" && entry.runtime?.start_command?.length)
    .map((entry) => {
      const decision = decisions.get(entry.id)
      const requiresConsent = !!entry.security?.require_consent || !!entry.runtime?.requires_consent
      const localEphemeralMcp = entry.install_strategy === "npx_runtime" && entry.runtime?.isolated
      const autoConnect = !!(
        input.allowMcpAutoConnect &&
        !sensitive &&
        decision?.action !== "skip" &&
        decision?.action !== "degrade" &&
        (decision?.action !== "ask_permission" || localEphemeralMcp)
      )
      return {
        name: entry.runtime?.mutex_key ? entry.id : entry.name,
        entry_id: entry.id,
        auto_connect: autoConnect,
        reason: sensitive
          ? "task mentions credentials/login/destructive/remote risk"
          : decision?.reason ?? "selected MCP capability",
        risk_level: entry.risk_level,
        heavy: !!entry.runtime?.heavy,
        requires_consent: requiresConsent && !autoConnect,
        config: {
          type: "local" as const,
          command: normalizeNpxCommand(entry.runtime!.start_command!),
          environment: undefined,
          enabled: true,
          timeout: entry.runtime?.start_timeout_ms,
        },
      }
    })
}

function deriveSkillSignals(plan: CapabilityPlan, resolver: ResolverResult): SkillSignal[] {
  const signals = new Set<SkillSignal>()
  if (plan.required_tags.includes("cross-review")) signals.add("reviewer_conflict")
  if (plan.required_tags.includes("diagnostic")) signals.add("tool_failures_high")
  if (resolver.blocked.length > 0) signals.add("verification_failed")
  return [...signals]
}

function buildSystemSummaryParts(result: Omit<CapabilityOrchestrationResult, "systemSummary">): string[] {
  const selected = result.plan.selected.map((m) => `${m.entry.id}:${m.entry.kind}`).slice(0, 8)
  const running = result.mcpRequests.filter((m) => m.auto_connect).map((m) => m.name)
  const blocked = result.blockedReasons.slice(0, 4)
  const gaps = result.unresolvedGaps.map((g) => g.tag).slice(0, 6)
  return [
    `version=${result.version}`,
    `required=[${result.plan.required_tags.slice(0, 10).join(",")}]`,
    `selected=[${selected.join(",")}]`,
    running.length ? `mcp_auto_connect=[${running.join(",")}]` : "mcp_auto_connect=[]",
    gaps.length ? `gaps=[${gaps.join(",")}]` : "gaps=[]",
    blocked.length ? `blocked=[${blocked.join("; ")}]` : "blocked=[]",
  ]
}

export function formatCapabilitySystemSummary(
  result: Omit<CapabilityOrchestrationResult, "systemSummary">,
  maxChars = 1_000,
): string {
  const line = `[dll-agent capability plan: ${buildSystemSummaryParts(result).join(" | ")}]`
  return line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line
}

export function orchestrateCapabilities(input: CapabilityOrchestrationInput): CapabilityOrchestrationResult {
  const builtins = mapAllBuiltins(GLOBAL_DEFAULT_TOOLS, SKILL_REGISTRY)
  let registry = getFullRegistry(builtins, input.projectDir)
  const taskContext: TaskContext = {
    user_goal: input.userGoal,
    file_extensions: fileExtensions(input.filesInvolved),
    failure_type: input.failureType,
    max_risk: input.maxRisk,
    platform: process.platform,
  }
  let plan = planCapabilities(registry.entries, taskContext)
  let discovery: DiscoveryResult | undefined
  if (plan.gaps.length > 0) {
    discovery = runDiscovery(input.projectDir)
    registry = getFullRegistry(builtins, input.projectDir)
    plan = planCapabilities(registry.entries, taskContext)
  }
  const entries = selectedEntries(plan)
  const resolver = resolveAll(entries)
  const decisions = resolverById(resolver)
  const entryActions = entries.map((entry) => actionFor(entry, decisions.get(entry.id)))
  const gapActions = plan.gaps.map(acquisitionActionForGap)
  const actions = [...entryActions, ...gapActions]
  const mcpRequests = buildMcpRequests(entries, input, resolver)
  const skillIntents = [
    ...new Set([
      ...plan.required_tags,
      ...entries.flatMap((entry) => entry.capabilities),
      ...entries.map((entry) => entry.id),
    ]),
  ]
  const skillSignals = deriveSkillSignals(plan, resolver)
  const toolPromptTags = [...new Set(entries.map((entry) => entry.id))]
  const blockedReasons = [
    ...resolver.blocked.map((decision) => `${decision.entry_id}: ${decision.reason}`),
    ...gapActions.map((action) => `${action.entry_id}: ${action.reason}`),
    ...mcpRequests
      .filter((request) => !request.auto_connect && request.requires_consent)
      .map((request) => `${request.entry_id}: ${request.reason}`),
  ]
  const cleanup = input.performCleanup === false ? undefined : cleanupStale(entries)

  const withoutSummary = {
    version: CAPABILITY_ORCHESTRATOR_VERSION,
    fingerprint: hashStable({
      projectDir: input.projectDir,
      messageID: input.messageID,
      userGoal: input.userGoal,
      files: input.filesInvolved ?? [],
      registryTimestamp: registry.timestamp,
    }),
    registry,
    registry_snapshot: snapshot(registry.entries),
    plan,
    resolver,
    actions,
    mcpRequests,
    skillSignals,
    skillIntents,
    toolPromptTags,
    unresolvedGaps: plan.gaps,
    blockedReasons,
    cleanup,
    discovery,
  }
  const result: CapabilityOrchestrationResult = {
    ...withoutSummary,
    systemSummary: formatCapabilitySystemSummary(withoutSummary),
  }

  if (input.recordEvidence !== false) {
    writeEvidence("capability.orchestrated", {
      fingerprint: result.fingerprint,
      required_tags: result.plan.required_tags,
      selected: result.plan.selected.map((m) => m.entry.id),
      actions: result.actions.map((a) => ({ entry_id: a.entry_id, type: a.type, auto_allowed: a.auto_allowed })),
      mcp_requests: result.mcpRequests.map((m) => ({ name: m.name, auto_connect: m.auto_connect })),
      gaps: result.unresolvedGaps.map((g) => g.tag),
      blocked: result.blockedReasons,
      discovery: result.discovery ? {
        total: result.discovery.total,
        new: result.discovery.new,
        updated: result.discovery.updated,
        by_source: result.discovery.by_source,
      } : null,
    }, input.sessionID)
  }

  return result
}
