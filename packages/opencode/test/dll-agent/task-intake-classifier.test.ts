import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { canSuppressRoutineReview, classifyTaskIntake } from "../../src/dll-agent/task-intake-classifier"

describe("task intake classifier", () => {
  test("classifies greetings as L0 commander-only intake", () => {
    const c = classifyTaskIntake({ userText: "你好" })
    expect(c.task_kind).toBe("greeting")
    expect(c.interaction_level).toBe("L0")
    expect(c.user_origin_only).toBe(true)
    expect(c.tool_required).toBe(false)
    expect(c.reviewer_required).toBe(false)
    expect(c.verification_required).toBe(false)
    expect(c.goal_contract_required).toBe(false)
    expect(c.repo_doctor_allowed).toBe(false)
    expect(canSuppressRoutineReview(c)).toBe(true)
  })

  test("classifies ordinary informational questions as L1 without reviewer or verification", () => {
    const c = classifyTaskIntake({ userText: "介绍一下dll-agent" })
    expect(c.task_kind).toBe("informational")
    expect(c.interaction_level).toBe("L1")
    expect(c.tool_required).toBe(false)
    expect(c.reviewer_required).toBe(false)
    expect(c.verification_required).toBe(false)
    expect(c.goal_contract_required).toBe(false)
    expect(c.repo_doctor_allowed).toBe(false)
    expect(canSuppressRoutineReview(c)).toBe(true)
  })

  test("classifies light engineering analysis as L2 and does not suppress routine review by default", () => {
    const c = classifyTaskIntake({ userText: "只读分析 packages/opencode/src/dll-agent/triggers.ts" })
    expect(c.task_kind).toBe("light_engineering_analysis")
    expect(c.interaction_level).toBe("L2")
    expect(c.tool_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("classifies code mutation as L3 with verification required", () => {
    const c = classifyTaskIntake({ userText: "修复按钮样式并运行测试" })
    expect(c.task_kind).toBe("coding")
    expect(c.interaction_level).toBe("L3")
    expect(c.tool_required).toBe(true)
    expect(c.verification_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("classifies provider routing permission work as L4 high-risk", () => {
    const c = classifyTaskIntake({ userText: "修改 Provider/RoleModel routing gate 和 permission 策略" })
    expect(c.task_kind).toBe("high_risk")
    expect(c.interaction_level).toBe("L4")
    expect(c.reviewer_required).toBe(true)
    expect(c.verification_required).toBe(true)
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("does not allow short continuation command to be suppressed as chat", () => {
    const c = classifyTaskIntake({ userText: "继续完成所有目标" })
    expect(c.task_kind).toBe("planning")
    expect(c.interaction_level).toBe("L2")
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("safety overrides prevent suppression", () => {
    const c = classifyTaskIntake({ userText: "介绍一下dll-agent", activeBlockingState: true })
    expect(c.task_kind).toBe("informational")
    expect(c.safety_overrides).toContain("active_blocking_state")
    expect(canSuppressRoutineReview(c)).toBe(false)
  })

  test("project policy manifest can classify local informational phrase without code changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-intake-"))
    fs.mkdirSync(path.join(dir, ".dll-agent"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".dll-agent", "task-intake-policy.jsonc"), JSON.stringify({
      informational: ["请科普*"],
    }))
    const c = classifyTaskIntake({ userText: "请科普一下治理代理", projectDir: dir })
    expect(c.task_kind).toBe("informational")
    expect(c.matched_rules).toContain("policy:informational")
    expect(canSuppressRoutineReview(c)).toBe(true)
  })
})
