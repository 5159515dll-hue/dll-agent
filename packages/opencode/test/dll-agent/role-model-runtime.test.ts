import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"

const configRoot = path.join(os.tmpdir(), `dll-agent-role-model-runtime-${process.pid}`)
const projectDir = path.join(configRoot, "project")
const roleModelPath = path.join(configRoot, "config", "role-models.jsonc")
const sessionID = SessionID.make("ses_role_model_runtime")

let runtime: typeof import("../../src/dll-agent/role-model-runtime")
let registry: typeof import("../../src/dll-agent/role-model-registry")

const provider = {
  getModel: (providerID: ProviderID, modelID: ModelID) =>
    Effect.succeed({ id: modelID, providerID, name: String(modelID) } as Provider.Model),
  defaultModel: () =>
    Effect.succeed({ providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4-pro") }),
} as Provider.Interface

function validateModel(providerID: ProviderID, modelID: ModelID) {
  return Effect.succeed({ id: modelID, providerID, name: String(modelID) } as Provider.Model)
}

function writeGlobalRoleModel(role: string, primary: string) {
  fs.mkdirSync(path.dirname(roleModelPath), { recursive: true })
  fs.writeFileSync(
    roleModelPath,
    JSON.stringify(
      {
        version: 1,
        roles: {
          [role]: { primary, enabled: true },
        },
      },
      null,
      2,
    ),
  )
}

beforeEach(async () => {
  fs.rmSync(configRoot, { recursive: true, force: true })
  fs.mkdirSync(projectDir, { recursive: true })
  process.env.DLL_AGENT_CONFIG_ROOT = configRoot
  runtime = await import("../../src/dll-agent/role-model-runtime")
  registry = await import("../../src/dll-agent/role-model-registry")
})

afterEach(() => {
  fs.rmSync(configRoot, { recursive: true, force: true })
  delete process.env.DLL_AGENT_CONFIG_ROOT
})

describe("role-model-runtime", () => {
  test("runtime propagated subagent model does not overwrite global role override", async () => {
    writeGlobalRoleModel("role-cross", "mimo/mimo-v2.5-pro")

    const selected = await Effect.runPromise(
      runtime.resolveEffectiveRoleModel({
        role: "role-cross",
        sessionID,
        projectDir,
        explicitModel: { providerID: ProviderID.make("zai"), modelID: ModelID.make("glm-5.1") },
        persistExplicitOverride: false,
        triggerReason: "subtask effective role model",
        provider,
        validateModel,
      }),
    )

    expect(`${selected.providerID}/${selected.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(registry.resolveRoleModel("role-cross", sessionID, projectDir).primary).toBe("mimo/mimo-v2.5-pro")
  })

  test("real TUI explicit selection can persist a global role override", async () => {
    writeGlobalRoleModel("commander", "deepseek/deepseek-v4-pro")

    const selected = await Effect.runPromise(
      runtime.resolveEffectiveRoleModel({
        role: "commander",
        sessionID,
        projectDir,
        explicitModel: { providerID: ProviderID.make("mimo"), modelID: ModelID.make("mimo-v2.5-pro") },
        persistExplicitOverride: true,
        triggerReason: "explicit TUI/session model selection",
        provider,
        validateModel,
      }),
    )

    expect(`${selected.providerID}/${selected.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(registry.resolveRoleModel("commander", sessionID, projectDir).primary).toBe("mimo/mimo-v2.5-pro")
  })
})
