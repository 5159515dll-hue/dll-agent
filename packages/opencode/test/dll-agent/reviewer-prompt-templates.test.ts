import { describe, expect, test } from "bun:test"
import { buildReviewerPrompt } from "../../src/dll-agent/reviewer-prompt-templates"

describe("reviewer prompt templates", () => {
  test("requirements-inspector prompt preserves compact context and structured output contract", () => {
    const prompt = buildReviewerPrompt({
      reviewer: "requirements-inspector",
      reason: "user correction",
      compactContext: "goal=finish requested work",
      effectiveModel: "glm/glm-5.1",
    })

    expect(prompt).toContain("<compact-review-context>")
    expect(prompt).toContain("goal=finish requested work")
    expect(prompt).toContain("requirements inspector")
    expect(prompt).toContain("machine-readable JSON")
    expect(prompt).toContain("\"reviewer\": \"requirements-inspector\"")
  })

  test("final-auditor prompt remains read-only", () => {
    const prompt = buildReviewerPrompt({
      reviewer: "final-auditor",
      reason: "final claim without verification",
      compactContext: "verification=not_run",
      effectiveModel: "openai/gpt-5.5-pro",
    })

    expect(prompt).toContain("read-only audit")
    expect(prompt).toContain("Do not run commands")
    expect(prompt).toContain("write/exec/task tools are denied")
    expect(prompt).toContain("\"reviewer\": \"final-auditor\"")
  })

  test("task-completion-archivist prompt includes continuation packet fields", () => {
    const prompt = buildReviewerPrompt({
      reviewer: "task-completion-archivist",
      reason: "unfinished indicators",
      compactContext: "active_plan=unchecked",
      effectiveModel: "kimi/kimi-k2.6",
    })

    expect(prompt).toContain("CONTINUATION PACKET")
    expect(prompt).toContain("blocking_unfinished")
    expect(prompt).toContain("non_blocking_followup")
    expect(prompt).toContain("requires_user_input")
    expect(prompt).toContain("next_execution_plan")
  })

  test("multimodal-context-interpreter prompt keeps the role as read-only packet generation", () => {
    const prompt = buildReviewerPrompt({
      reviewer: "multimodal-context-interpreter",
      reason: "image input detected",
      compactContext: "input=screenshot",
      effectiveModel: "mimo/mimo-v2.5",
    })

    expect(prompt).toContain("multimodal_context_packet")
    expect(prompt).toContain("read-only analysis")
    expect(prompt).toContain("Do not modify files")
    expect(prompt).toContain("\"role\": \"multimodal-context-interpreter\"")
  })
})
