import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  buildCostStatusLine,
  buildModelStatusLine,
  buildNextActionLine,
  buildQuotaStatusLine,
  buildReviewStatusLine,
  buildWorkStatusLine,
} from "../../src/cli/cmd/tui/component/dll-agent-panel"
import type { EffectiveRoleModel } from "../../src/dll-agent/role-model-registry"

const commander = {
  role: "commander",
  primary: "deepseek/deepseek-v4-pro",
  fallback: [],
  source: "session",
  enabled: true,
  onDemandOnly: false,
  parsed: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
  providerAvailable: true,
} satisfies EffectiveRoleModel

const supervisor = {
  version: 1,
  phase: "implementation",
  risk: "high",
  required_reviews: ["requirements-inspector", "final-auditor"],
  completed_reviews: ["requirements-inspector"],
  blocked_completion: true,
  block_reason: "required verification not_run",
  reviewer_conflict: false,
  updated_at: new Date().toISOString(),
  metrics: { verification_evidence: true },
  queued_reviewers: ["final-auditor"],
  running_reviewers: ["chief-engineer"],
}

describe("dll-agent TUI status panel", () => {
  test("model line shows effective commander model, source, and active reviewer", () => {
    const line = buildModelStatusLine({
      commander,
      runningRoles: ["chief-engineer"],
      compact: true,
      width: 120,
    })

    expect(line).toContain("commander=deepseek-v4-pro [session]")
    expect(line).toContain("running chief-engineer")
  })

  test("work and review lines surface gate, risk, verification, and pending reviewers", () => {
    expect(buildWorkStatusLine({ supervisor, width: 120 })).toBe(
      "work blocked | phase:implementation | risk:high | gate:blocked | verify:partial",
    )
    expect(buildReviewStatusLine({ supervisor, width: 120 })).toContain("pending:final-auditor")
  })

  test("cost and quota lines stay compact and include MiMo visibility", () => {
    expect(
      buildCostStatusLine({
        cost: {
          session_total_usd: 0.42,
          by_provider: {},
          session_cap_exceeded: false,
          provider_cap_exceeded: {},
          last_warning: null,
        },
        capUsd: 5,
        width: 120,
      }),
    ).toBe("cost $0.420/$5.00")

    const quota = buildQuotaStatusLine({
      quota: {
        providers: {
          deepseek: { status: "configured" },
          kimi: { status: "missing_key" },
          openai: { status: "quota_unavailable" },
          zai: { status: "local_estimate_only" },
          mimo: { status: "no_quota_endpoint" },
        },
      },
      width: 160,
    })
    expect(quota).toContain("M:quota n/a")
  })

  test("next action prioritizes blocking decisions over ready state", () => {
    expect(
      buildNextActionLine({
        supervisor,
        cost: {
          session_total_usd: 0.42,
          by_provider: {},
          session_cap_exceeded: false,
          provider_cap_exceeded: {},
          last_warning: null,
        },
        width: 120,
      }),
    ).toBe("next resolve gate: required verification not_run")
  })

  test("dll-agent panel lets terminal foreground color render status text", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dll-agent-panel.tsx"),
      "utf8",
    )

    expect(source).not.toContain("fg={theme.text")
    expect(source).not.toContain("fg={theme.textMuted")
    expect(source).not.toContain("backgroundColor={theme.background")
    expect(source).not.toContain("useTheme")
  })

  test("prompt commander label is not hardcoded to DeepSeek", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/prompt/index.tsx"),
      "utf8",
    )

    expect(source).not.toContain("DeepSeek Commander")
    expect(source).toContain("resolveRoleModel(\"commander\"")
  })
})
