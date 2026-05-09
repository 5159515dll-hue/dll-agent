import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"

const configRoot = path.join(os.tmpdir(), `dll-agent-role-provider-bridge-${process.pid}`)
const projectDir = path.join(configRoot, "project")
const roleModelPath = path.join(configRoot, "config", "role-models.jsonc")
const sessionID = SessionID.make("ses_role_provider_bridge")

let bridge: typeof import("../../src/dll-agent/role-provider-bridge")
let registry: typeof import("../../src/dll-agent/role-model-registry")
let runtime: typeof import("../../src/dll-agent/role-model-runtime")

function providerModel(providerID: ProviderID, modelID: ModelID) {
  return {
    id: modelID,
    providerID,
    name: String(modelID),
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: false,
      temperature: true,
      input: { text: true, image: String(modelID).includes("vision"), audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    limit: { context: 128_000, output: 8_000 },
  } as Provider.Model
}

function providerWithUnavailable(unavailable: string[]) {
  return {
    getModel: (providerID: ProviderID, modelID: ModelID) => {
      const id = `${providerID}/${modelID}`
      if (unavailable.includes(id)) return Effect.fail(new Error(`unavailable ${id}`))
      return Effect.succeed(providerModel(providerID, modelID))
    },
    defaultModel: () =>
      Effect.succeed({ providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4-pro") }),
  } as Provider.Interface
}

function writeGlobalRoleModel(role: string, primary: string, fallback: string[] = []) {
  fs.mkdirSync(path.dirname(roleModelPath), { recursive: true })
  fs.writeFileSync(
    roleModelPath,
    JSON.stringify({ version: 1, roles: { [role]: { primary, fallback, enabled: true } } }, null, 2),
  )
}

beforeEach(async () => {
  fs.rmSync(configRoot, { recursive: true, force: true })
  fs.mkdirSync(projectDir, { recursive: true })
  process.env.DLL_AGENT_CONFIG_ROOT = configRoot
  bridge = await import("../../src/dll-agent/role-provider-bridge")
  registry = await import("../../src/dll-agent/role-model-registry")
  runtime = await import("../../src/dll-agent/role-model-runtime")
})

afterEach(() => {
  fs.rmSync(configRoot, { recursive: true, force: true })
  delete process.env.DLL_AGENT_CONFIG_ROOT
})

describe("role-provider-bridge", () => {
  test("primary role model is provider-validated and writes snapshot", async () => {
    writeGlobalRoleModel("commander", "mimo/mimo-v2.5-pro")

    const resolved = await Effect.runPromise(
      bridge.resolveRoleProvider({
        role: "commander",
        sessionID,
        projectDir,
        triggerReason: "test primary",
        provider: providerWithUnavailable([]),
      }),
    )

    expect(`${resolved.providerID}/${resolved.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(resolved.providerVerified).toBe(true)
    expect(resolved.fallbackUsed).toBe(false)
    expect(resolved.providerMetadata?.supportsReasoning).toBe(true)
    expect(bridge.readRoleProviderSnapshot(sessionID, "commander")?.providerVerified).toBe(true)
  })

  test("unavailable primary uses fallback through Provider.Service", async () => {
    writeGlobalRoleModel("requirements-inspector", "zai/missing-model", ["mimo/mimo-v2.5-pro"])

    const resolved = await Effect.runPromise(
      bridge.resolveRoleProvider({
        role: "requirements-inspector",
        sessionID,
        projectDir,
        triggerReason: "test fallback",
        provider: providerWithUnavailable(["zai/missing-model"]),
      }),
    )

    expect(`${resolved.providerID}/${resolved.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(resolved.source).toBe("fallback")
    expect(resolved.fallbackUsed).toBe(true)
    expect(resolved.fallbackReason).toContain("primary unavailable")
  })

  test("all role candidates unavailable falls back to provider default", async () => {
    writeGlobalRoleModel("final-auditor", "openai/missing", ["mimo/missing"])

    const resolved = await Effect.runPromise(
      bridge.resolveRoleProvider({
        role: "final-auditor",
        sessionID,
        projectDir,
        triggerReason: "test provider default",
        provider: providerWithUnavailable(["openai/missing", "mimo/missing"]),
      }),
    )

    expect(`${resolved.providerID}/${resolved.modelID}`).toBe("deepseek/deepseek-v4-pro")
    expect(resolved.source).toBe("provider-default")
    expect(resolved.fallbackUsed).toBe(true)
    expect(resolved.unavailableReason).toContain("openai/missing")
  })

  test("runtime wrapper delegates to bridge without overwriting subagent role override", async () => {
    writeGlobalRoleModel("role-cross", "mimo/mimo-v2.5-pro")

    const selected = await Effect.runPromise(
      runtime.resolveEffectiveRoleModel({
        role: "role-cross",
        sessionID,
        projectDir,
        explicitModel: { providerID: ProviderID.make("zai"), modelID: ModelID.make("glm-5.1") },
        persistExplicitOverride: false,
        triggerReason: "subtask effective role model",
        provider: providerWithUnavailable([]),
        validateModel: (providerID, modelID) => Effect.succeed(providerModel(providerID, modelID)),
      }),
    )

    expect(`${selected.providerID}/${selected.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(registry.resolveRoleModel("role-cross", sessionID, projectDir).primary).toBe("mimo/mimo-v2.5-pro")
  })

  test("explicit commander selection can persist global override", async () => {
    writeGlobalRoleModel("commander", "deepseek/deepseek-v4-pro")

    const selected = await Effect.runPromise(
      bridge.resolveRoleProviderModel({
        role: "commander",
        sessionID,
        projectDir,
        explicitModel: {
          providerID: ProviderID.make("mimo"),
          modelID: ModelID.make("mimo-v2.5-pro"),
          source: "tui",
        },
        persistExplicitOverride: true,
        triggerReason: "explicit TUI/session model selection",
        provider: providerWithUnavailable([]),
      }),
    )

    expect(`${selected.providerID}/${selected.modelID}`).toBe("mimo/mimo-v2.5-pro")
    expect(registry.resolveRoleModel("commander", sessionID, projectDir).primary).toBe("mimo/mimo-v2.5-pro")
  })
})
