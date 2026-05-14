import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  buildIntentJudgementPlan,
  buildIntentConsensusPlan,
  collectIntentConsensusParticipants,
  classificationFromIntentJudgement,
  mergeIntentJudgements,
  parseModelIntentJudgement,
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

  test("parses model intent judgement and converts it into runtime classification", () => {
    const deterministic = classifyTaskIntake({ userText: "ambiguous request without structural signals" })
    const parsed = parseModelIntentJudgement(JSON.stringify({
      task_kind: "light_engineering_analysis",
      interaction_level: "L2",
      confidence: "high",
      tool_required: true,
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: true,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "read_only_answer",
      reason: "read-only project analysis",
      missing_information: [],
    }))
    expect(parsed?.task_kind).toBe("light_engineering_analysis")
    const classification = classificationFromIntentJudgement({
      deterministic,
      judgement: parsed,
      source: "single_model",
    })
    expect(classification.interaction_level).toBe("L2")
    expect(classification.finalization_policy).toBe("read_only_answer")
    expect(classification.model_classifier_needed).toBe(false)
  })

  test("artifact editing intent cannot remain L2 read-only even if a model under-classifies it", () => {
    const deterministic = classifyTaskIntake({ userText: "/tmp/example.deck" })
    const parsed = parseModelIntentJudgement(JSON.stringify({
      task_kind: "artifact_editing",
      interaction_level: "L2",
      confidence: "high",
      tool_required: true,
      reviewer_required: false,
      verification_required: false,
      goal_contract_required: false,
      repo_doctor_allowed: true,
      continuation_allowed: false,
      final_gate_required: false,
      finalization_policy: "read_only_answer",
      reason: "the user wants an optimized artifact copy",
      missing_information: [],
    }))
    expect(parsed?.interaction_level).toBe("L3")
    const classification = classificationFromIntentJudgement({
      deterministic,
      judgement: parsed,
      source: "single_model",
    })
    expect(classification.task_kind).toBe("artifact_editing")
    expect(classification.interaction_level).toBe("L3")
    expect(classification.finalization_policy).toBe("engineering_verification")
    expect(classification.verification_required).toBe(true)
  })

  test("multi-model consensus chooses the majority intent without using OpenAI", () => {
    const deterministic = classifyTaskIntake({ userText: "ambiguous request without structural signals" })
    const merged = mergeIntentJudgements({
      deterministic,
      judgements: [
        {
          task_kind: "light_engineering_analysis",
          interaction_level: "L2",
          confidence: "medium",
          tool_required: true,
          reviewer_required: false,
          verification_required: false,
          goal_contract_required: false,
          repo_doctor_allowed: true,
          continuation_allowed: false,
          final_gate_required: false,
          finalization_policy: "read_only_answer",
          reason: "read-only analysis",
          missing_information: [],
        },
        {
          task_kind: "light_engineering_analysis",
          interaction_level: "L2",
          confidence: "high",
          tool_required: true,
          reviewer_required: false,
          verification_required: false,
          goal_contract_required: false,
          repo_doctor_allowed: true,
          continuation_allowed: false,
          final_gate_required: false,
          finalization_policy: "read_only_answer",
          reason: "read-only analysis confirmed",
          missing_information: [],
        },
        {
          task_kind: "coding",
          interaction_level: "L3",
          confidence: "medium",
          tool_required: true,
          reviewer_required: false,
          verification_required: true,
          goal_contract_required: true,
          repo_doctor_allowed: true,
          continuation_allowed: true,
          final_gate_required: true,
          finalization_policy: "engineering_verification",
          reason: "minority engineering execution vote",
          missing_information: [],
        },
      ],
    })
    expect(merged?.task_kind).toBe("light_engineering_analysis")
    expect(merged?.confidence).toBe("high")
  })

  test("model judgement cannot downgrade deterministic L4 hard safety", () => {
    const deterministic = classifyTaskIntake({ userText: "sudo rm -rf /tmp/dll-agent-test" })
    const classification = classificationFromIntentJudgement({
      deterministic,
      judgement: {
        task_kind: "informational",
        interaction_level: "L1",
        confidence: "high",
        tool_required: false,
        reviewer_required: false,
        verification_required: false,
        goal_contract_required: false,
        repo_doctor_allowed: false,
        continuation_allowed: false,
        final_gate_required: false,
        finalization_policy: "informational_answer",
        reason: "unsafe downgrade attempt",
        missing_information: [],
      },
      source: "single_model",
    })
    expect(classification.interaction_level).toBe("L4")
    expect(classification.reviewer_required).toBe(true)
  })

  test("session runtime records intent preflight even after commander execution has started", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt.ts"), "utf8")
    expect(source).toContain('mode?: "full" | "record_only"')
    expect(source).toContain('mode: alreadyAnswered ? "record_only" : "full"')
    expect(source).toContain("deterministic intake recorded after commander execution already started")
    expect(source).toContain("alreadyRecorded")
  })

  test("session prompt starts visible intent preflight before commander loop output", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt.ts"), "utf8")
    const preflight = source.indexOf("intent preflight error before loop")
    const loop = source.indexOf("return yield* loop({ sessionID: input.sessionID })")
    expect(preflight).toBeGreaterThan(0)
    expect(loop).toBeGreaterThan(preflight)
  })
})
