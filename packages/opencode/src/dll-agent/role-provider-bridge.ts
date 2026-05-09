import fs from "fs"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionID } from "@/session/schema"
import { configRoot } from "./role-model-store"
import { write as evidenceWrite, redact } from "./evidence"
import {
  resolveRoleModel,
  resetRoleModelOverride,
  setRoleModelOverride,
  validateRoleModel,
  type DllRole,
  type OverrideScope,
} from "./role-model-registry"

export type RoleProviderSource =
  | "explicit"
  | "session"
  | "project"
  | "global"
  | "built-in"
  | "provider-default"
  | "fallback"

export interface ResolveRoleProviderInput {
  role: DllRole
  sessionID?: SessionID
  projectDir?: string
  explicitModel?: {
    providerID: ProviderID
    modelID: ModelID
    source?: "tui" | "command" | "session"
  }
  persistExplicitOverride?: boolean
  triggerReason: string
  provider: Provider.Interface
  validateModel?: (providerID: ProviderID, modelID: ModelID, sessionID: SessionID) => Effect.Effect<Provider.Model>
}

export interface ResolvedRoleProvider {
  role: DllRole
  providerID: ProviderID
  modelID: ModelID
  source: RoleProviderSource
  scope?: OverrideScope
  available: boolean
  providerVerified: boolean
  fallbackUsed: boolean
  fallbackReason?: string
  unavailableReason?: string
  providerMetadata?: {
    supportsReasoning?: boolean
    supportsTools?: boolean
    supportsMultimodal?: boolean
    contextWindow?: number
  }
}

export function modelToString(model: { providerID: ProviderID; modelID: ModelID }) {
  return `${model.providerID}/${model.modelID}`
}

function snapshotPath(sessionID?: string) {
  if (!sessionID) return
  return path.join(configRoot(), "sessions", sessionID, "role-provider-bridge.json")
}

function metadata(model: Provider.Model): ResolvedRoleProvider["providerMetadata"] {
  return {
    supportsReasoning: model.capabilities?.reasoning,
    supportsTools: model.capabilities?.toolcall,
    supportsMultimodal: Boolean(
      model.capabilities?.input?.image ||
        model.capabilities?.input?.audio ||
        model.capabilities?.input?.video ||
        model.capabilities?.input?.pdf,
    ),
    contextWindow: model.limit?.context,
  }
}

function writeSnapshot(sessionID: string | undefined, resolved: ResolvedRoleProvider) {
  const file = snapshotPath(sessionID)
  if (!file) return
  try {
    let data: Record<string, unknown> = { version: 1, roles: {} }
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"))
    const roles = (data.roles as Record<string, unknown>) ?? {}
    roles[resolved.role] = {
      role: resolved.role,
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      source: resolved.source,
      scope: resolved.scope,
      available: resolved.available,
      providerVerified: resolved.providerVerified,
      fallbackUsed: resolved.fallbackUsed,
      fallbackReason: resolved.fallbackReason,
      unavailableReason: resolved.unavailableReason,
      providerMetadata: resolved.providerMetadata,
      updated_at: new Date().toISOString(),
    }
    data.version = 1
    data.roles = roles
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(redact(data), null, 2))
    fs.renameSync(tmp, file)
  } catch {
    return
  }
}

export function readRoleProviderSnapshot(sessionID: string | undefined, role: DllRole): ResolvedRoleProvider | undefined
export function readRoleProviderSnapshot(sessionID: string | undefined): Record<string, ResolvedRoleProvider> | undefined
export function readRoleProviderSnapshot(sessionID: string | undefined, role?: DllRole) {
  const file = snapshotPath(sessionID)
  if (!file) return
  try {
    if (!fs.existsSync(file)) return
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { roles?: Record<string, ResolvedRoleProvider> }
    if (role) return data.roles?.[role]
    return data.roles
  } catch {
    return
  }
}

export function resolveRoleProviderHint(input: {
  role: DllRole
  sessionID?: string
  projectDir?: string
}): ResolvedRoleProvider {
  const effective = resolveRoleModel(input.role, input.sessionID, input.projectDir)
  return {
    role: input.role,
    providerID: ProviderID.make(effective.parsed.providerID),
    modelID: ModelID.make(effective.parsed.modelID),
    source: effective.source,
    scope: effective.source,
    available: effective.providerAvailable,
    providerVerified: false,
    fallbackUsed: false,
    unavailableReason: effective.providerAvailable ? undefined : "provider availability is registry env-hint only",
  }
}

function unavailableMessage(exit: Exit.Exit<Provider.Model, unknown>) {
  if (Exit.isSuccess(exit)) return
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

export const resolveRoleProvider = Effect.fn("DllAgentRoleProviderBridge.resolveRoleProvider")(function* (
  input: ResolveRoleProviderInput,
) {
  if (input.explicitModel && input.persistExplicitOverride) {
    const explicit = modelToString(input.explicitModel)
    const validation = validateRoleModel(explicit)
    if (validation.valid) {
      setRoleModelOverride(input.role, explicit, "global", input.sessionID, input.projectDir)
      if (input.sessionID) resetRoleModelOverride(input.role, "session", input.sessionID, input.projectDir)
    }
  }

  const effective = resolveRoleModel(input.role, input.sessionID, input.projectDir)
  const candidates = [effective.primary, ...effective.fallback]
  const failures: string[] = []

  for (const candidate of candidates) {
    const parsed = Provider.parseModel(candidate)
    const exit = yield* input.provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) {
      const fallbackUsed = candidate !== effective.primary
      const resolved: ResolvedRoleProvider = {
        role: input.role,
        providerID: parsed.providerID,
        modelID: parsed.modelID,
        source: fallbackUsed ? "fallback" : effective.source,
        scope: effective.source,
        available: true,
        providerVerified: true,
        fallbackUsed,
        fallbackReason: fallbackUsed ? `primary unavailable: ${effective.primary}` : undefined,
        providerMetadata: metadata(exit.value),
      }
      evidenceWrite(
        "model.routing_decision",
        {
          task_id: input.sessionID,
          role: input.role,
          selected_model: modelToString(resolved),
          candidate_models: candidates,
          risk_level: "low",
          trigger_reason: input.triggerReason,
          skipped_reviewers: [],
          skip_reason: null,
          correctness_reason: "effective role model resolved through Role Provider Bridge and Provider.Service.getModel",
          cost_reason: null,
          evidence_refs: [],
          fallback_reason: resolved.fallbackReason ?? null,
          whether_required_for_correctness: true,
          source: resolved.source,
          provider_verified: true,
        },
        input.sessionID,
      )
      writeSnapshot(input.sessionID, resolved)
      return resolved
    }
    failures.push(`${candidate}: ${unavailableMessage(exit) ?? "unavailable"}`)
  }

  const fallback = yield* input.provider.defaultModel()
  const validated = input.validateModel && input.sessionID
    ? yield* input.validateModel(fallback.providerID, fallback.modelID, input.sessionID)
    : yield* input.provider.getModel(fallback.providerID, fallback.modelID)
  const resolved: ResolvedRoleProvider = {
    role: input.role,
    providerID: fallback.providerID,
    modelID: fallback.modelID,
    source: "provider-default",
    available: true,
    providerVerified: true,
    fallbackUsed: true,
    fallbackReason: "all role model candidates failed Provider.Service.getModel",
    unavailableReason: failures.join("; "),
    providerMetadata: metadata(validated),
  }
  evidenceWrite(
    "model.routing_decision",
    {
      task_id: input.sessionID,
      role: input.role,
      selected_model: modelToString(resolved),
      candidate_models: candidates,
      risk_level: "low",
      trigger_reason: input.triggerReason,
      skipped_reviewers: [],
      skip_reason: null,
      correctness_reason: "role model candidates unavailable; Provider default model validated through Role Provider Bridge",
      cost_reason: null,
      evidence_refs: [],
      fallback_reason: resolved.fallbackReason,
      unavailable_reason: resolved.unavailableReason,
      whether_required_for_correctness: true,
      source: resolved.source,
      provider_verified: true,
    },
    input.sessionID,
  )
  writeSnapshot(input.sessionID, resolved)
  return resolved
})

export const resolveRoleProviderModel = Effect.fn("DllAgentRoleProviderBridge.resolveRoleProviderModel")(function* (
  input: ResolveRoleProviderInput,
) {
  const resolved = yield* resolveRoleProvider(input)
  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  }
})

export * as RoleProviderBridge from "./role-provider-bridge"
