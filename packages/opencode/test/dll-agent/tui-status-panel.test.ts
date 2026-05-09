import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  buildCostStatusLine,
  buildModelStatusLine,
  buildNextActionLine,
  buildObservableLedgerLine,
  buildObservabilitySummaryLine,
  buildObservableTaskLine,
  buildObservableVerificationLine,
  buildQuotaStatusLine,
  buildReviewStatusLine,
  buildWorkStatusLine,
} from "../../src/cli/cmd/tui/component/dll-agent-panel"
import { modelUsageIdentity } from "../../src/cli/cmd/tui/feature-plugins/sidebar/context"
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

  test("observable task lines expose final status, verification, doctor, result ledger, and continuation", () => {
    const report = {
      goal: "Finish CRM audit",
      phase: "implementation",
      risk: "high",
      final_status_detail: "CONTINUATION_REQUIRED",
      verification: { status: "not_run", required: ["typecheck"], passed: 0, failed: 0, not_run: 1, unknown: 0 },
      doctor: { status: "warn", pass_count: 20, warn_count: 1, fail_count: 0, latest_ref: "doctor.run@now" },
      results: {
        total: 3,
        verified: 1,
        partial: 1,
        failed: 0,
        blocked: 0,
        unverified: 1,
        stale: 0,
        reusable: 1,
        missing_evidence: 0,
        low_confidence: 1,
        unresolved: [],
      },
      continuation: {
        status: "required",
        last_packet_id: "cont_1",
        continuation_count: 2,
        blocking_unfinished: 1,
        requires_user_input: 0,
        budget_exhausted: false,
      },
      evidence: { latest: [{ type: "doctor.run" }] },
      routing: { decisions: 2 },
    } as any

    expect(buildObservableTaskLine({ report, width: 160 })).toContain("CONTINUATION_REQUIRED")
    expect(buildObservableVerificationLine({ report, width: 160 })).toContain("doctor:warn")
    expect(buildObservableLedgerLine({ report, width: 180 })).toContain("low_conf:1")
    expect(buildObservableLedgerLine({ report, width: 180 })).toContain("continuation:required")
    expect(buildObservabilitySummaryLine({ report, width: 180 })).toContain("routing:2")
    expect(buildObservabilitySummaryLine({ report, width: 180 })).toContain("not_run:20")
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

  test("model usage identity keeps same-provider models separate", () => {
    expect(modelUsageIdentity({
      providerID: "mimo",
      modelID: "mimo-v2.5-pro",
      name: "MiMo v2.5 Pro",
    })).toBe("mimo/mimo-v2.5-pro (MiMo v2.5 Pro)")
    expect(modelUsageIdentity({
      providerID: "mimo",
      modelID: "mimo-v2.5",
      name: "MiMo v2.5",
    })).toBe("mimo/mimo-v2.5 (MiMo v2.5)")
  })
})
