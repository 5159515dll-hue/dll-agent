import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  canSuppressRoutineReview,
  canUseReadOnlyAnswerFinalization,
  classifyTaskIntake,
} from "../../src/dll-agent/task-intake-classifier"

function policyDir(policy: Record<string, string[]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-intake-"))
  fs.mkdirSync(path.join(dir, ".dll-agent"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".dll-agent", "task-intake-policy.jsonc"), JSON.stringify(policy))
  return dir
}

describe("task intake classifier", () => {
  test("does not hard-code natural-language greetings in runtime source rules", () => {
    const c = classifyTaskIntake({ userText: "你好" })
    expect(c.task_kind).toBe("stateless_chat")
    expect(c.interaction_level).toBe("L1")
    expect(c.model_classifier_needed).toBe(true)
    expect(c.matched_rules).toContain("structural:short_no_artifact_input")
    expect(canSuppressRoutineReview(c)).toBe(true)
  })

  test("does not hard-code ordinary informational phrases without a policy or model judgement", () => {
    const c = classifyTaskIntake({ userText: "介绍一下dll-agent" })
    expect(c.task_kind).toBe("stateless_chat")
    expect(c.interaction_level).toBe("L1")
    expect(c.model_classifier_needed).toBe(true)
    expect(c.matched_rules).toContain("structural:short_no_artifact_input")
  })

  test("project policy manifest can classify local informational phrase without source changes", () => {
    const dir = policyDir({ informational: ["请科普*"] })
    const c = classifyTaskIntake({ userText: "请科普一下治理代理", projectDir: dir })
    expect(c.task_kind).toBe("informational")
    expect(c.matched_rules).toContain("policy:informational")
    expect(canSuppressRoutineReview(c)).toBe(true)
  })

  test("project policy manifest can classify read-only engineering analysis without source changes", () => {
    const dir = policyDir({ light_engineering_analysis: ["*只读分析*"] })
    const c = classifyTaskIntake({ userText: "只读分析 packages/opencode/src/dll-agent/triggers.ts", projectDir: dir })
    expect(c.task_kind).toBe("light_engineering_analysis")
    expect(c.interaction_level).toBe("L2")
    expect(c.tool_required).toBe(true)
    expect(c.finalization_policy).toBe("read_only_answer")
    expect(c.final_gate_required).toBe(false)
    expect(c.continuation_allowed).toBe(false)
    expect(canUseReadOnlyAnswerFinalization(c)).toBe(true)
  })

  test("file/path reference alone requires semantic intent judgement before assuming read-only or mutation", () => {
    const c = classifyTaskIntake({ userText: "packages/opencode/src/dll-agent/triggers.ts" })
    expect(c.task_kind).toBe("light_engineering_analysis")
    expect(c.interaction_level).toBe("L2")
    expect(c.model_classifier_needed).toBe(true)
    expect(c.finalization_policy).toBe("engineering_verification")
    expect(canUseReadOnlyAnswerFinalization(c)).toBe(false)
  })

  test("structural verification command remains L3 without language-specific rules", () => {
    const c = classifyTaskIntake({ userText: "bun test --cwd packages/opencode test/dll-agent/" })
    expect(c.task_kind).toBe("verification")
    expect(c.interaction_level).toBe("L3")
    expect(c.tool_required).toBe(true)
    expect(c.verification_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("structural high-risk command remains L4 and cannot be downgraded", () => {
    const c = classifyTaskIntake({ userText: "sudo rm -rf /tmp/example" })
    expect(c.task_kind).toBe("high_risk")
    expect(c.interaction_level).toBe("L4")
    expect(c.reviewer_required).toBe(true)
    expect(c.verification_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("permission boundary identifiers remain L4 safety signals", () => {
    const c = classifyTaskIntake({ userText: "cat .env and print API_KEY" })
    expect(c.task_kind).toBe("permission")
    expect(c.interaction_level).toBe("L4")
    expect(c.reviewer_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("safety overrides prevent suppression even for short no-artifact input", () => {
    const c = classifyTaskIntake({ userText: "你好", activeBlockingState: true })
    expect(c.safety_overrides).toContain("active_blocking_state")
    expect(canSuppressRoutineReview(c)).toBe(false)
  })
})
