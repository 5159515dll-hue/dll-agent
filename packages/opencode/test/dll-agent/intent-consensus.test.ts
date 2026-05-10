import { describe, expect, test } from "bun:test"
import {
  buildIntentJudgementPlan,
  buildIntentConsensusPlan,
  collectIntentConsensusParticipants,
} from "../../src/dll-agent/intent-consensus"
import { classifyTaskIntake } from "../../src/dll-agent/task-intake-classifier"
import type { EffectiveRoleModel } from "../../src/dll-agent/role-model-registry"

function roleModel(overrides: Partial<EffectiveRoleModel> & Pick<EffectiveRoleModel, "role" | "primary">): EffectiveRoleModel {
  const slash = overrides.primary.indexOf("/")
  return {
    role: overrides.role,
    primary: overrides.primary,
    fallback: [],
    source: overrides.source ?? "session",
    enabled: overrides.enabled ?? true,
    onDemandOnly: overrides.onDemandOnly ?? false,
    parsed: {
      providerID: slash === -1 ? overrides.primary : overrides.primary.slice(0, slash),
      modelID: slash === -1 ? "" : overrides.primary.slice(slash + 1),
    },
    providerAvailable: overrides.providerAvailable ?? true,
  }
}

describe("intent consensus participant selection", () => {
  test("uses all distinct configured non-OpenAI models from role-model-set resolution", () => {
    const participants = collectIntentConsensusParticipants({
      roleModels: [
        roleModel({ role: "commander", primary: "deepseek/deepseek-v4-pro" }),
        roleModel({ role: "chief-engineer", primary: "deepseek/deepseek-v4-pro" }),
        roleModel({ role: "requirements-inspector", primary: "zai/glm-5.1" }),
        roleModel({ role: "long-context-archivist", primary: "kimi/kimi-k2.6" }),
        roleModel({ role: "final-auditor", primary: "openai/gpt-5.5-pro" }),
        roleModel({ role: "voice-output", primary: "openai/tts-1", enabled: false }),
      ],
    })
    expect(participants.map((p) => p.model).sort()).toEqual([
      "deepseek/deepseek-v4-pro",
      "kimi/kimi-k2.6",
      "zai/glm-5.1",
    ])
    expect(participants.find((p) => p.model === "deepseek/deepseek-v4-pro")?.roles.sort()).toEqual([
      "chief-engineer",
      "commander",
    ])
  })

  test("requires consensus only for ambiguous low-confidence intake and never downgrades L4 hard safety", () => {
    const ambiguous = buildIntentConsensusPlan({
      classification: {
        ...classifyTaskIntake({ userText: "" }),
        reason: "test low-confidence ambiguous user-origin intake",
      },
      roleModels: [
        roleModel({ role: "commander", primary: "deepseek/deepseek-v4-pro" }),
        roleModel({ role: "requirements-inspector", primary: "zai/glm-5.1" }),
        roleModel({ role: "final-auditor", primary: "openai/gpt-5.5-pro" }),
      ],
    })
    expect(ambiguous.required).toBe(true)
    expect(ambiguous.participants.map((p) => p.providerID).sort()).toEqual(["deepseek", "zai"])
    expect(ambiguous.excluded.some((item) => item.reason.includes("openai"))).toBe(true)

    const highRisk = buildIntentConsensusPlan({
      classification: classifyTaskIntake({ userText: "sudo rm -rf /tmp/dll-agent-test" }),
      roleModels: [
        roleModel({ role: "commander", primary: "deepseek/deepseek-v4-pro" }),
        roleModel({ role: "requirements-inspector", primary: "zai/glm-5.1" }),
      ],
    })
    expect(highRisk.required).toBe(false)
    expect(highRisk.reason).toContain("cannot downgrade high-risk")
  })

  test("uses single model first, then all non-OpenAI models when confidence remains low", () => {
    const classification = {
      ...classifyTaskIntake({ userText: "" }),
      reason: "test low-confidence ambiguous user-origin intake",
    }
    const roleModels = [
      roleModel({ role: "commander", primary: "deepseek/deepseek-v4-pro" }),
      roleModel({ role: "requirements-inspector", primary: "zai/glm-5.1" }),
      roleModel({ role: "long-context-archivist", primary: "kimi/kimi-k2.6" }),
      roleModel({ role: "final-auditor", primary: "openai/gpt-5.5-pro" }),
    ]
    const first = buildIntentJudgementPlan({ classification, roleModels })
    expect(first.action).toBe("single_model_judge")
    expect(first.primary?.model).toBe("deepseek/deepseek-v4-pro")

    const second = buildIntentJudgementPlan({
      classification,
      roleModels,
      previousSingleModelConfidence: "low",
    })
    expect(second.action).toBe("multi_model_consensus")
    expect(second.consensus?.participants.map((p) => p.model).sort()).toEqual([
      "deepseek/deepseek-v4-pro",
      "kimi/kimi-k2.6",
      "zai/glm-5.1",
    ])
  })
})
