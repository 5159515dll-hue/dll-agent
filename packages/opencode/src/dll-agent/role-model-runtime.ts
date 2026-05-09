import { Effect, Exit } from "effect"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { write as evidenceWrite } from "./evidence"
import {
  isDllRole,
  resolveRoleModel,
  setRoleModelOverride,
  validateRoleModel,
  type DllRole,
} from "./role-model-registry"
import type { SessionID } from "@/session/schema"

export function modelToString(model: { providerID: ProviderID; modelID: ModelID }) {
  return `${model.providerID}/${model.modelID}`
}

export function roleForAgent(agentName: string): DllRole | undefined {
  if (isDllRole(agentName)) return agentName
  if (agentName === "build" || agentName === "plan") return "commander"
  return undefined
}

export const resolveEffectiveRoleModel = Effect.fn("DllAgentRoleModelRuntime.resolveEffectiveRoleModel")(function* (input: {
  role: DllRole
  sessionID: SessionID
  projectDir?: string
  explicitModel?: { providerID: ProviderID; modelID: ModelID }
  triggerReason: string
  provider: Provider.Interface
  validateModel: (providerID: ProviderID, modelID: ModelID, sessionID: SessionID) => Effect.Effect<Provider.Model>
}) {
  if (input.explicitModel) {
    const explicit = modelToString(input.explicitModel)
    const validation = validateRoleModel(explicit)
    if (validation.valid) {
      setRoleModelOverride(input.role, explicit, "session", input.sessionID, input.projectDir)
    }
  }

  const effective = resolveRoleModel(input.role, input.sessionID, input.projectDir)
  const candidates = [effective.primary, ...effective.fallback]
  for (const candidate of candidates) {
    const parsed = Provider.parseModel(candidate)
    const exit = yield* input.provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) {
      const selected = { providerID: parsed.providerID, modelID: parsed.modelID }
      evidenceWrite(
        "model.routing_decision",
        {
          task_id: input.sessionID,
          role: input.role,
          selected_model: modelToString(selected),
          candidate_models: candidates,
          risk_level: "low",
          trigger_reason: input.triggerReason,
          skipped_reviewers: [],
          skip_reason: null,
          correctness_reason: "effective role model resolved and provider-validated",
          cost_reason: null,
          evidence_refs: [],
          fallback_reason: candidate === effective.primary ? null : `primary unavailable: ${effective.primary}`,
          whether_required_for_correctness: true,
          source: effective.source,
        },
        input.sessionID,
      )
      return selected
    }
  }

  const fallback = yield* input.provider.defaultModel()
  yield* input.validateModel(fallback.providerID, fallback.modelID, input.sessionID)
  evidenceWrite(
    "model.routing_decision",
    {
      task_id: input.sessionID,
      role: input.role,
      selected_model: modelToString(fallback),
      candidate_models: candidates,
      risk_level: "low",
      trigger_reason: input.triggerReason,
      skipped_reviewers: [],
      skip_reason: null,
      correctness_reason: "role model candidates unavailable; Provider default model validated as final fallback",
      cost_reason: null,
      evidence_refs: [],
      fallback_reason: "all role model candidates failed Provider.Service.getModel",
      whether_required_for_correctness: true,
      source: "provider-default",
    },
    input.sessionID,
  )
  return fallback
})

