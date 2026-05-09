import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { isDllRole, type DllRole } from "./role-model-registry"
import { modelToString, resolveRoleProviderModel } from "./role-provider-bridge"
import type { SessionID } from "@/session/schema"

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
  persistExplicitOverride?: boolean
  triggerReason: string
  provider: Provider.Interface
  validateModel: (providerID: ProviderID, modelID: ModelID, sessionID: SessionID) => Effect.Effect<Provider.Model>
}) {
  return yield* resolveRoleProviderModel(input)
})
