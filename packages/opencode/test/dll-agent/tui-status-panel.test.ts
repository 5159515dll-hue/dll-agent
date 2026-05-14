import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  buildCommandActivityExpandedLines,
  buildCommandActivityMiniLines,
  buildCostStatusLine,
  buildDllAgentPanelModel,
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
import type { ObservabilityPanelState } from "../../src/dll-agent/tui-status-adapter"

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

function emptyTask(): ObservabilityPanelState {
  return {
    goal: null,
    phase: "default",
    risk: "low",
    final_status: "UNVERIFIED_PARTIAL",
    final_status_detail: "UNVERIFIED_PARTIAL",
    blockers: [],
    next_actions: ["Produce a Result Ledger packet before final verified completion"],
    verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
    continuation: {
      status: "none",
      last_packet_id: null,
      continuation_count: 0,
      blocking_unfinished: 0,
      requires_user_input: 0,
      budget_exhausted: false,
    },
    reviewers: { required: [], completed: [], queued: [], running: [] },
    results: {
      total: 0,
      verified: 0,
      partial: 0,
      failed: 0,
      blocked: 0,
      unverified: 0,
      stale: 0,
      reusable: 0,
      missing_evidence: 0,
      low_confidence: 0,
      unresolved: [],
    },
    doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
    evidence: { total: 0, by_type: {}, latest: [] },
    routing: { decisions: 0, selected_models: [], skipped_reviewers: [] },
    cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
    generated_at: new Date().toISOString(),
    sessionID: "empty",
    projectDir: process.cwd(),
  }
}

function emptyCost() {
  return {
    session_total_usd: 0,
    by_provider: {},
    session_cap_exceeded: false,
    provider_cap_exceeded: {},
    last_warning: null,
  }
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
    expect(source).not.toContain("backgroundColor=")
  })

  test("session route shows dll-agent bottom panel only when sidebar is hidden", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/routes/session/index.tsx"),
      "utf8",
    )

    expect(source).toContain("<Show when={!sidebarVisible()}>")
    expect(source).toContain("<DllAgentSessionPanel sessionID={route.sessionID} />")
  })

  test("session sidebar owns the integrated dll-agent panel", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/routes/session/sidebar.tsx"),
      "utf8",
    )

    expect(source).toContain("DllAgentSessionPanel")
    expect(source).toContain('variant="sidebar"')
  })

  test("session panel reads supervisor state from the visible OpenCode session before wrapper session", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dll-agent-panel.tsx"),
      "utf8",
    )

    expect(source).toContain("const sessionID = createMemo(() => props.sessionID || process.env.DLL_AGENT_SESSION_ID)")
    expect(source).toContain("readSupervisorState(sessionID())")
    expect(source).toContain("readCostStatus(sessionID())")
    expect(source).not.toContain("const sessionID = createMemo(() => process.env.DLL_AGENT_SESSION_ID || props.sessionID)")
  })

  test("dll-agent mode hides duplicate sidebar capability, MCP, and LSP blocks", () => {
    const capability = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/feature-plugins/sidebar/capability.tsx"),
      "utf8",
    )
    const lsp = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/feature-plugins/sidebar/lsp.tsx"),
      "utf8",
    )
    const mcp = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx"),
      "utf8",
    )

    expect(capability).toContain("when={!dllEnabled()}")
    expect(lsp).toContain("when={!dllEnabled()}")
    expect(mcp).toContain("when={!dllEnabled() && list().length > 0}")
  })

  test("panel model exposes task, model, capability, verification, and blocker summaries", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "crm-system",
      sessionLabel: "session: test",
      commander,
      supervisor,
      task: {
        goal: "Finish CRM audit",
        phase: "implementation",
        risk: "high",
        final_status: "CONTINUATION_REQUIRED",
        final_status_detail: "CONTINUATION_REQUIRED",
        blockers: ["required verification not_run"],
        next_actions: ["Run required verification"],
        verification: { status: "not_run", required: ["typecheck"], passed: 0, failed: 0, not_run: 1, unknown: 0 },
        continuation: {
          status: "required",
          last_packet_id: "cont_1",
          continuation_count: 1,
          blocking_unfinished: 1,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: {
          required: ["requirements-inspector", "final-auditor"],
          completed: ["requirements-inspector"],
          queued: ["final-auditor"],
          running: ["chief-engineer"],
        },
        results: {
          total: 2,
          verified: 1,
          partial: 1,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 1,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "warn", pass_count: 20, warn_count: 1, fail_count: 0, latest_ref: "doctor.run@now" },
        evidence: { total: 3, by_type: {}, latest: [] },
        routing: { decisions: 1, selected_models: ["deepseek/deepseek-v4-pro"], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 10, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "test",
        projectDir: process.cwd(),
      },
      capability: {
        generated_at: new Date().toISOString(),
        projectDir: process.cwd(),
        total: 8,
        by_kind: { tool: 3, skill: 2, mcp: 1, software: 1 },
        by_status: { available: 4, on_demand: 2, running: 1, blocked: 1 },
        available: ["read"],
        running: ["mcp-playwright"],
        missing: [],
        blocked: ["unsafe-cap"],
        pending_permission: ["github"],
        runtime_states: {},
        effective_status: {},
        effective_by_status: {},
        lsp: { main_language: "typescript", prewarm_count: 2, lazy_count: 1, target_count: 3 },
      },
      cost: {
        session_total_usd: 0.42,
        by_provider: {},
        session_cap_exceeded: false,
        provider_cap_exceeded: {},
        last_warning: null,
      },
      quota: undefined,
      width: 180,
      compact: false,
    })

    expect(model.global.join("\n")).toContain("指挥官=deepseek/deepseek-v4-pro [session]")
    expect(model.task.join("\n")).toContain("需要继续")
    expect(model.verification.join("\n")).toContain("doctor：警告")
    expect(model.modelRole.join("\n")).toContain("chief-engineer")
    expect(model.capability.join("\n")).toContain("工具 3｜技能 2｜MCP 1｜软件 1")
    expect(model.hasBlocker).toBe(true)
  })

  test("panel model treats idle chat without a goal as waiting instead of unverified partial", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: idle",
      commander,
      supervisor: undefined,
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 0, selected_models: [], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "idle",
        projectDir: process.cwd(),
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 140,
      compact: false,
    })

    expect(model.global.join("\n")).toContain("dll-agent：待命")
    expect(model.task.join("\n")).toContain("任务：普通对话/待命")
    expect(model.task.join("\n")).toContain("计划：未建立")
    expect(model.task.join("\n")).not.toContain("UNVERIFIED_PARTIAL")
    expect(model.task.join("\n")).not.toContain("Produce a Result Ledger packet")
    expect(model.verification.join("\n")).toContain("验证：未要求")
    expect(model.isIdle).toBe(true)
    expect(model.idle.join("\n")).toContain("普通对话")
    expect(model.idle.join("\n")).toContain("未建立工程任务")
  })

  test("panel model does not show waiting when todos or modified files exist", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: active-work",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        metrics: {},
        queued_reviewers: [],
        running_reviewers: [],
      },
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 0, selected_models: [], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "active-work",
        projectDir: process.cwd(),
      },
      activity: {
        todos_total: 3,
        todos_in_progress: 1,
        todos_pending: 1,
        todos_completed: 1,
        modified_files: 1,
        additions: 387,
        deletions: 0,
        tool_summary: {
          readonly_tools: 8,
          writes: 1,
          mcp: 0,
          commands: 0,
          running: 0,
          failed: 0,
          total: 9,
          evidence_ref: "session:test",
          redaction_status: "redacted",
        },
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 140,
      compact: false,
    })

    expect(model.global.join("\n")).toContain("dll-agent：执行中")
    expect(model.task.join("\n")).toContain("工程执行/有文件写入")
    expect(model.task.join("\n")).toContain("意图分析：未记录")
    expect(model.task.join("\n")).not.toContain("等待用户目标")
    expect(model.task.join("\n")).toContain("文件改动 1")
    expect(model.task.join("\n")).toContain("工具：只读 8｜写入 1｜MCP 0｜命令 0")
    expect(model.verification.join("\n")).toContain("验证：未记录")
    expect(model.verification.join("\n")).not.toContain("验证：未要求")
    expect(model.idle.join("\n")).not.toContain("未建立工程任务")
    expect(model.idle.join("\n")).not.toContain("入口意图已分析")
    expect(model.idle.join("\n")).toContain("运行态活动已检测")
    expect(model.isIdle).toBe(false)
  })

  test("panel model shows L2 read-only analysis intent instead of ordinary chat", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: readonly",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        metrics: {
          task_kind: "light_engineering_analysis",
          interaction_level: "L2",
          read_only_answer_task: true,
        },
        queued_reviewers: [],
        running_reviewers: [],
      },
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 1, selected_models: ["mimo/mimo-v2.5-pro"], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "readonly",
        projectDir: process.cwd(),
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 140,
      compact: false,
    })

    expect(model.task.join("\n")).toContain("任务：只读工程分析")
    expect(model.task.join("\n")).toContain("意图分析：L2 只读工程分析")
    expect(model.idle.join("\n")).toContain("只读工程分析")
    expect(model.idle.join("\n")).toContain("入口意图已分析")
  })

  test("panel model shows artifact editing as L3 engineering execution instead of read-only analysis", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "project",
      sessionLabel: "session: artifact",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        running_reviewers: [],
        queued_reviewers: [],
        required_reviews: [],
        completed_reviews: [],
        metrics: {
          task_kind: "artifact_editing",
          interaction_level: "L3",
        },
        intent_judgement_status: {
          message_id: "msg",
          status: "completed",
          action: "single_model_judge",
          model: "mimo/mimo-v2.5-pro",
          participants: ["mimo/mimo-v2.5-pro"],
          reason: "artifact editing",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        intent_judgement: {
          message_id: "msg",
          source: "single_model",
          plan_action: "single_model_judge",
          classification: {
            task_kind: "artifact_editing",
            interaction_level: "L3",
            finalization_policy: "engineering_verification",
            confidence: "high",
          },
          reason: "artifact editing",
          created_at: new Date().toISOString(),
        },
      },
      task: emptyTask(),
      cost: emptyCost(),
      quota: undefined,
      width: 120,
      compact: false,
    })
    expect(model.task.join("\n")).toContain("意图已判断：L3 工程执行｜类别：文档/产物编辑")
    expect(model.task.join("\n")).not.toContain("只读工程分析｜类别：文档/产物编辑")
  })

  test("panel model shows visible intent preflight progress while the user waits", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: intent",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        metrics: {},
        queued_reviewers: [],
        running_reviewers: [],
        intent_judgement_status: {
          message_id: "msg_1",
          status: "single_model_running",
          action: "single_model_judge",
          model: "mimo/mimo-v2.5-pro",
          participants: ["mimo/mimo-v2.5-pro"],
          reason: "deterministic classifier is ambiguous",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 0, selected_models: [], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "intent",
        projectDir: process.cwd(),
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 140,
      compact: false,
    })

    expect(model.task.join("\n")).toContain("正在判断意图：单模型")
    expect(model.task.join("\n")).toContain("mimo/mimo-v2.5-pro")
    expect(model.idle[0]).toContain("正在判断意图")
  })

  test("panel model keeps completed intent judgement visible after fast deterministic classification", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: intent-complete",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        metrics: {},
        queued_reviewers: [],
        running_reviewers: [],
        intent_judgement_status: {
          message_id: "msg_1",
          status: "completed",
          action: "deterministic_accept",
          reason: "deterministic classification accepted",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        intent_judgement: {
          message_id: "msg_1",
          source: "deterministic",
          plan_action: "deterministic_accept",
          classification: {
            task_kind: "light_engineering_analysis",
            interaction_level: "L2",
            confidence: "high",
            finalization_policy: "read_only_answer",
          },
          reason: "read-only task",
          created_at: new Date().toISOString(),
        },
      },
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 0, selected_models: [], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "intent-complete",
        projectDir: process.cwd(),
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 140,
      compact: false,
    })

    expect(model.task.join("\n")).toContain("意图已判断：L2 只读工程分析")
    expect(model.task.join("\n")).toContain("来源：确定性规则")
    expect(model.idle[0]).toContain("意图已判断")
  })

  test("panel model shows accepted answer-only delivery without pretending engineering completion", () => {
    const model = buildDllAgentPanelModel({
      projectLabel: "repo",
      sessionLabel: "session: answer",
      commander,
      supervisor: {
        version: 1,
        phase: "default",
        risk: "low",
        required_reviews: [],
        completed_reviews: [],
        blocked_completion: false,
        block_reason: null,
        reviewer_conflict: false,
        updated_at: new Date().toISOString(),
        metrics: {
          task_kind: "light_engineering_analysis",
          interaction_level: "L2",
          read_only_answer_task: true,
        },
        answer_delivery: {
          user_message_id: "user_1",
          assistant_message_id: "assistant_1",
          mode: "read_only_answer",
          status: "accepted",
          public_answer_emitted: true,
          internal_review_allowed: false,
          council_allowed: false,
          public_followup_allowed: false,
          accepted_reason: "read-only answer accepted",
          evidence_refs: ["assistant:assistant_1"],
          updated_at: new Date().toISOString(),
        },
      },
      task: {
        goal: null,
        phase: "default",
        risk: "low",
        final_status: "UNVERIFIED_PARTIAL",
        final_status_detail: "UNVERIFIED_PARTIAL",
        blockers: [],
        next_actions: ["Produce a Result Ledger packet before final verified completion"],
        verification: { status: "unknown", required: [], passed: 0, failed: 0, not_run: 0, unknown: 0 },
        continuation: {
          status: "none",
          last_packet_id: null,
          continuation_count: 0,
          blocking_unfinished: 0,
          requires_user_input: 0,
          budget_exhausted: false,
        },
        reviewers: { required: [], completed: [], queued: [], running: [] },
        results: {
          total: 0,
          verified: 0,
          partial: 0,
          failed: 0,
          blocked: 0,
          unverified: 0,
          stale: 0,
          reusable: 0,
          missing_evidence: 0,
          low_confidence: 0,
          unresolved: [],
        },
        doctor: { status: "unknown", pass_count: null, warn_count: null, fail_count: null, latest_ref: null },
        evidence: { total: 0, by_type: {}, latest: [] },
        routing: { decisions: 1, selected_models: ["mimo/mimo-v2.5-pro"], skipped_reviewers: [] },
        cleanup: { evidence_sessions: 0, repair_safe_recommended: false, recommendation: null },
        generated_at: new Date().toISOString(),
        sessionID: "answer",
        projectDir: process.cwd(),
      },
      capability: undefined,
      cost: undefined,
      quota: undefined,
      width: 160,
      compact: false,
    })

    expect(model.task.join("\n")).toContain("答案：已接受｜只读分析｜公开输出已锁定")
    expect(model.task.join("\n")).toContain("任务：只读工程分析")
    expect(model.task.join("\n")).not.toContain("已验证完成")
  })

  test("idle sidebar view stays compact and hides empty command activity", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/component/dll-agent-panel.tsx"),
      "utf8",
    )

    expect(source).toContain("showCommandActivity")
    expect(source).toContain("!panel().isIdle")
    expect(source).toContain("hasCommandActivity() && setCommandExpanded(true)")
  })

  test("command activity renderers support compact and expanded states", () => {
    const events = [{
      command_id: "cmd-1",
      timestamp: "2026-05-10T00:00:00.000Z",
      role: "commander",
      tool: "bash",
      command_summary: "dll-agent doctor",
      status: "passed",
      evidence_ref: "doctor.run@now",
      requires_user_action: false,
      redaction_status: "redacted",
    }] as any

    expect(buildCommandActivityMiniLines({ events, width: 80 })[0]).toContain("dll-agent doctor")
    expect(buildCommandActivityExpandedLines({ events, width: 120 })[0]).toContain("doctor.run@now")
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
