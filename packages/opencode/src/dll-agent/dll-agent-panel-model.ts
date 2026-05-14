import { buildCapabilityStatusReport, type CapabilityStatusReport } from "./capability-status"
import type { ToolActivitySummary } from "./command-activity"
import {
  buildCostStatusLine,
  buildQuotaStatusLine,
  type CostPanelState,
  type ObservabilityPanelState,
  type PanelRoleModel,
  type SupervisorPanelState,
  SESSION_CAP_USD,
  truncate,
} from "./tui-status-adapter"

export interface DllAgentPanelModel {
  global: string[]
  task: string[]
  verification: string[]
  modelRole: string[]
  capability: string[]
  idle: string[]
  intake: string[]
  isIdle: boolean
  hasBlocker: boolean
  doctorStatus: string
}

export interface DllAgentPanelActivity {
  todos_total?: number
  todos_in_progress?: number
  todos_pending?: number
  todos_completed?: number
  modified_files?: number
  additions?: number
  deletions?: number
  tool_summary?: ToolActivitySummary
}

function valueOrUnknown(value: unknown) {
  if (value === undefined || value === null || value === "") return "未知"
  return String(value)
}

function hasRuntimeTask(report: ObservabilityPanelState) {
  if (!report) return false
  if (report.goal) return true
  if (report.blockers.length > 0) return true
  if (report.results.total > 0) return true
  if (report.verification.required.length > 0) return true
  if (report.reviewers.required.length > 0 || report.reviewers.running.length > 0 || report.reviewers.queued.length > 0) return true
  if (report.continuation.status !== "none" && report.continuation.status !== "unknown") return true
  return false
}

function hasVisibleActivity(activity: DllAgentPanelActivity | undefined) {
  if (!activity) return false
  if ((activity.todos_total ?? 0) > 0) return true
  if ((activity.modified_files ?? 0) > 0) return true
  return false
}

function zhStatus(value: string | undefined) {
  if (!value) return "未知"
  const map: Record<string, string> = {
    VERIFIED_COMPLETE: "已验证完成",
    CONTINUATION_REQUIRED: "需要继续",
    BLOCKED_USER_REQUIRED: "等待用户",
    BLOCKED_BUDGET_EXHAUSTED: "预算阻断",
    UNVERIFIED_PARTIAL: "未验证",
    FAILED: "失败",
    UNKNOWN: "未知",
    passed: "通过",
    failed: "失败",
    not_run: "未运行",
    partial: "部分",
    unknown: "未知",
    warn: "警告",
    fail: "失败",
    pass: "正常",
    none: "无",
    required: "需要继续",
    blocked_user: "等待用户",
    budget_exhausted: "预算阻断",
  }
  return map[value] ?? value
}

function displayStatus(input: { supervisor: SupervisorPanelState; task: ObservabilityPanelState }) {
  if (input.supervisor?.blocked_completion) return "阻断"
  if (!hasRuntimeTask(input.task)) return "待命"
  return zhStatus(input.task?.final_status_detail)
}

function displayPanelStatus(input: {
  supervisor: SupervisorPanelState
  task: ObservabilityPanelState
  activity?: DllAgentPanelActivity
}) {
  if (input.supervisor?.blocked_completion) return "阻断"
  if (hasVisibleActivity(input.activity)) return "执行中"
  return displayStatus({ supervisor: input.supervisor, task: input.task })
}

function displayDoctor(report: ObservabilityPanelState) {
  if (!report || report.doctor.status === "unknown") return "未运行"
  return zhStatus(report.doctor.status)
}

function intakeLevelLabel(level: unknown) {
  const map: Record<string, string> = {
    L0: "无状态寒暄",
    L1: "普通问答",
    L2: "只读工程分析",
    L3: "工程执行",
    L4: "高风险任务",
  }
  return map[String(level ?? "")] ?? "未分析"
}

function intakeKindLabel(kind: unknown) {
  const map: Record<string, string> = {
    greeting: "问候",
    stateless_chat: "无状态对话",
    informational: "信息问答",
    light_engineering_analysis: "只读工程分析",
    artifact_editing: "文档/产物编辑",
    coding: "代码修改",
    debugging: "调试",
    verification: "验证",
    planning: "计划",
    permission: "权限",
    high_risk: "高风险",
    multimodal: "多模态",
    unknown: "未知",
  }
  return map[String(kind ?? "")] ?? String(kind ?? "未知")
}

function intentProgressLine(supervisor: SupervisorPanelState | undefined, width: number) {
  const status = supervisor?.intent_judgement_status
  if (!status) return undefined
  if (status.status === "single_model_running") {
    return truncate(`正在判断意图：单模型｜${status.model ?? "当前指挥官模型"}｜请稍候`, width)
  }
  if (status.status === "multi_model_running") {
    return truncate(`正在判断意图：多模型共识｜${status.participants?.length ?? 0} 个模型｜请稍候`, width)
  }
  if (status.status === "completed") {
    const classification = supervisor?.intent_judgement?.classification
    const level = classification?.interaction_level ?? supervisor?.metrics?.interaction_level
    const kind = classification?.task_kind ?? supervisor?.metrics?.task_kind
    const levelText = level ? `${level} ${intakeLevelLabel(level)}` : "已完成"
    const kindText = kind ? `｜类别：${intakeKindLabel(kind)}` : ""
    const sourceMap: Record<string, string> = {
      deterministic: "确定性规则",
      hard_safety: "安全硬规则",
      single_model: "单模型",
      multi_model_consensus: "多模型共识",
    }
    const source = sourceMap[String(supervisor?.intent_judgement?.source ?? "")] ?? "已记录"
    return truncate(`意图已判断：${levelText}${kindText}｜来源：${source}`, width)
  }
  if (status.status === "failed") return truncate("意图判断：失败｜已回退到保守规则", width)
  return undefined
}

function answerDeliveryLine(supervisor: SupervisorPanelState | undefined, width: number) {
  const delivery = supervisor?.answer_delivery
  if (!delivery) return undefined
  const modeMap: Record<string, string> = {
    stateless_answer: "无状态回答",
    informational_answer: "普通问答",
    read_only_answer: "只读分析",
    engineering_verification: "工程验证",
    high_risk_governance: "高风险治理",
  }
  const statusMap: Record<string, string> = {
    candidate: "候选",
    accepted: "已接受",
    needs_internal_revision: "需内部修订",
    blocked: "阻断",
  }
  const lock = delivery.public_answer_emitted && !delivery.public_followup_allowed ? "｜公开输出已锁定" : ""
  return truncate(`答案：${statusMap[delivery.status] ?? delivery.status}｜${modeMap[delivery.mode] ?? delivery.mode}${lock}`, width)
}

function intakeSummary(
  supervisor: SupervisorPanelState | undefined,
  context?: { hasActivity?: boolean; hasRuntimeTask?: boolean },
) {
  const metrics = supervisor?.metrics ?? {}
  const level = metrics.interaction_level
  const kind = metrics.task_kind
  if (!level && metrics.read_only_answer_task) {
    return {
      available: true,
      label: "只读工程分析",
      detail: "意图分析：L2 只读工程分析｜只读回答｜审查/验证按需抑制",
    }
  }
  if (!level) {
    if (context?.hasActivity || context?.hasRuntimeTask) {
      return {
        available: true,
        label: "任务执行",
        detail: "意图分析：未记录｜已根据任务/工具活动显示运行状态",
      }
    }
    return {
      available: false,
      label: "普通对话/待命",
      detail: "意图分析：未运行｜等待用户目标",
    }
  }
  const label = intakeLevelLabel(level)
  const kindLabel = intakeKindLabel(kind)
  const reviewer = metrics.read_only_answer_task || metrics.trivial_no_tool_task || metrics.stateless_chat_task
    ? "审查/验证按需抑制"
    : "按规则路由"
  return {
    available: true,
    label,
    detail: `意图分析：${level} ${label}｜类别：${kindLabel}｜${reviewer}`,
  }
}

function capabilityLine(report: CapabilityStatusReport | undefined, width: number) {
  if (!report) return "能力：未知"
  const tools = report.by_kind.tool ?? 0
  const skills = report.by_kind.skill ?? 0
  const mcp = report.by_kind.mcp ?? 0
  const software = report.by_kind.software ?? 0
  const running = (report.by_status.running ?? 0) + Object.keys(report.runtime_states).length
  const onDemand = report.by_status.on_demand ?? report.pending_permission.length
  const blocked = (report.by_status.blocked ?? 0) + (report.by_status.failed ?? 0)
  return truncate(
    `能力：工具 ${tools}｜技能 ${skills}｜MCP ${mcp}｜软件 ${software}｜运行 ${running}｜按需 ${onDemand}｜阻断 ${blocked}`,
    width,
  )
}

function capabilityRiskLine(report: CapabilityStatusReport | undefined, width: number) {
  if (!report) return "LSP：未知"
  const missing = report.missing.length > 0 ? `｜缺失 ${report.missing.slice(0, 2).join(",")}${report.missing.length > 2 ? `+${report.missing.length - 2}` : ""}` : ""
  const blocked = report.blocked.length > 0 ? `｜阻断 ${report.blocked.slice(0, 2).join(",")}${report.blocked.length > 2 ? `+${report.blocked.length - 2}` : ""}` : ""
  return truncate(`LSP：${report.lsp.main_language || "未知"}｜预热 ${report.lsp.prewarm_count}｜懒加载 ${report.lsp.lazy_count}${missing}${blocked}`, width)
}

function planLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "计划：未知"
  if (!hasRuntimeTask(report)) return "计划：未建立｜下一步：等待你的任务"
  const blockers = report.blockers.length
  const next = blockers === 0 && report.next_actions[0]?.includes("Produce a Result Ledger packet")
    ? "等待下一步"
    : report.next_actions[0] ?? "就绪"
  return truncate(`计划：阻塞 ${blockers}｜续接 ${zhStatus(report.continuation.status)}｜下一步：${next}`, width)
}

function activityLine(activity: DllAgentPanelActivity | undefined, width: number) {
  if (!activity || !hasVisibleActivity(activity)) return undefined
  const todo = (activity.todos_total ?? 0) > 0
    ? `计划：进行中 ${activity.todos_in_progress ?? 0}｜待办 ${activity.todos_pending ?? 0}｜完成 ${activity.todos_completed ?? 0}`
    : "计划：未建立"
  const files = (activity.modified_files ?? 0) > 0
    ? `｜文件改动 ${activity.modified_files}（+${activity.additions ?? 0}/-${activity.deletions ?? 0}）`
    : ""
  return truncate(`${todo}${files}`, width)
}

function toolActivityLine(activity: DllAgentPanelActivity | undefined, width: number) {
  const summary = activity?.tool_summary
  if (!summary || summary.total === 0) return undefined
  return truncate(
    `工具：只读 ${summary.readonly_tools}｜写入 ${summary.writes}｜MCP ${summary.mcp}｜命令 ${summary.commands}｜失败 ${summary.failed}`,
    width,
  )
}

function finalLine(
  report: ObservabilityPanelState,
  supervisor: SupervisorPanelState | undefined,
  width: number,
  activity?: DllAgentPanelActivity,
) {
  if (!report) return "任务：未知"
  if (hasVisibleActivity(activity)) {
    const label = (activity?.modified_files ?? 0) > 0 ? "工程执行/有文件写入" : "工程执行"
    return truncate(`任务：${label}｜阶段：${report.phase}｜风险：${report.risk}`, width)
  }
  if (!hasRuntimeTask(report)) {
    return truncate(`任务：${intakeSummary(supervisor).label}｜阶段：${report.phase}｜风险：${report.risk}`, width)
  }
  return truncate(`任务：${zhStatus(report.final_status_detail)}｜阶段：${report.phase}｜风险：${report.risk}`, width)
}

function goalLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "目标：不可用"
  return truncate(`目标：${report.goal ?? "未建立目标"}`, width)
}

function verificationLine(report: ObservabilityPanelState, width: number, activity?: DllAgentPanelActivity) {
  if (!report) return "验证：未知｜doctor：未知"
  if (!hasRuntimeTask(report) && report.verification.required.length === 0) {
    if (hasVisibleActivity(activity)) return `验证：未记录｜doctor：${displayDoctor(report)}`
    return `验证：未要求｜doctor：${displayDoctor(report)}`
  }
  const v = report.verification
  return truncate(
    `验证：${zhStatus(v.status)}｜通过 ${v.passed}｜失败 ${v.failed}｜未跑 ${v.not_run}｜要求 ${v.required.length}｜doctor：${displayDoctor(report)}`,
    width,
  )
}

function resultLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "结果：未知"
  if (!hasRuntimeTask(report) && report.results.total === 0) return "结果：未产生工程结果"
  const r = report.results
  return truncate(`结果：总数 ${r.total}｜已验证 ${r.verified}｜部分 ${r.partial}｜失败 ${r.failed}｜过期 ${r.stale}｜低置信 ${r.low_confidence}`, width)
}

function reviewerLine(supervisor: SupervisorPanelState, report: ObservabilityPanelState, width: number) {
  const running = supervisor?.running_reviewers ?? report?.reviewers.running ?? []
  const queued = supervisor?.queued_reviewers ?? report?.reviewers.queued ?? []
  const required = supervisor?.required_reviews ?? report?.reviewers.required ?? []
  const completed = supervisor?.completed_reviews ?? report?.reviewers.completed ?? []
  return truncate(
    `审查：运行 ${running.join("+") || "无"}｜排队 ${queued.join(",") || "无"}｜要求 ${required.length}｜完成 ${completed.length}`,
    width,
  )
}

function routingLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "路由：未知"
  return truncate(
    `路由：${report.routing.decisions} 次｜模型 ${report.routing.selected_models.slice(-2).join(",") || "无"}｜跳过审查 ${report.routing.skipped_reviewers.length}`,
    width,
  )
}

function costLine(cost: CostPanelState, width: number) {
  return buildCostStatusLine({ cost, capUsd: SESSION_CAP_USD, width }).replace(/^cost /, "费用：")
}

function quotaLine(quota: ReturnType<typeof import("./tui-status-adapter").readQuotaFile>, width: number) {
  return buildQuotaStatusLine({ quota, width }).replace(/^quota /, "配额：")
}

export function buildDllAgentPanelModel(input: {
  projectLabel: string
  sessionLabel: string
  commander: PanelRoleModel
  supervisor: SupervisorPanelState
  task: ObservabilityPanelState
  capability?: CapabilityStatusReport
  cost: CostPanelState
  quota: ReturnType<typeof import("./tui-status-adapter").readQuotaFile>
  activity?: DllAgentPanelActivity
  width: number
  compact: boolean
}): DllAgentPanelModel {
  const width = Math.max(32, input.width)
  const activeRoles = [
    ...(input.supervisor?.running_reviewers ?? []),
    ...(input.supervisor?.queued_reviewers ?? []),
  ]
  const activeRole = activeRoles[0] ?? "commander"
  const hasBlocker = Boolean(input.supervisor?.blocked_completion || (input.task?.blockers.length ?? 0) > 0)
  const hasActivity = hasVisibleActivity(input.activity)
  const isIdle = !hasBlocker && !hasRuntimeTask(input.task) && !hasActivity
  const doctorStatus = displayDoctor(input.task)
  const hasRuntime = hasRuntimeTask(input.task)
  const intake = intakeSummary(input.supervisor, { hasActivity, hasRuntimeTask: hasRuntime })
  const capability = input.capability
  const runningCapabilities = capability
    ? (capability.by_status.running ?? 0) + Object.keys(capability.runtime_states).length
    : 0
  const progress = intentProgressLine(input.supervisor, width)
  const answer = answerDeliveryLine(input.supervisor, width)
  const hasRecordedIntent = Boolean(
    input.supervisor?.metrics?.interaction_level
      || input.supervisor?.metrics?.read_only_answer_task
      || input.supervisor?.intent_judgement
      || input.supervisor?.intent_judgement_status,
  )
  const idleStateDetail = hasRecordedIntent
    ? "入口意图已分析"
    : hasActivity
      ? "运行态活动已检测"
      : hasRuntime
        ? "运行态任务已检测"
        : "未建立工程任务"
  return {
    global: [
      truncate(`dll-agent：${displayPanelStatus({ supervisor: input.supervisor, task: input.task, activity: input.activity })}｜${input.projectLabel}｜${input.sessionLabel}`, width),
      truncate(
        `模型：指挥官=${input.commander.primary} [${input.commander.source}]｜当前角色=${activeRole}｜doctor=${doctorStatus}｜${costLine(input.cost, width)}`,
        width,
      ),
      quotaLine(input.quota, width),
    ].slice(0, input.compact ? 2 : 3),
    task: [
      progress,
      answer,
      finalLine(input.task, input.supervisor, width, input.activity),
      truncate(intake.detail, width),
      activityLine(input.activity, width),
      toolActivityLine(input.activity, width),
      goalLine(input.task, width),
      planLine(input.task, width),
    ].filter((line): line is string => Boolean(line)).slice(0, input.compact ? 3 : 5),
    verification: [
      verificationLine(input.task, width, input.activity),
      resultLine(input.task, width),
    ],
    modelRole: [
      reviewerLine(input.supervisor, input.task, width),
      routingLine(input.task, width),
      truncate(`角色模型：指挥官 ${input.commander.providerAvailable ? "可用" : "不可用"}｜Provider 校验 ${valueOrUnknown(input.commander.providerVerified)}`, width),
    ].slice(0, input.compact ? 2 : 3),
    capability: [
      capabilityLine(input.capability, width),
      capabilityRiskLine(input.capability, width),
    ],
    idle: [
      progress ?? truncate(`状态：${isIdle ? "待命" : "执行中"}｜${hasActivity ? "计划/文件活动" : intake.label}｜${idleStateDetail}`, width),
      truncate(`模型：${input.commander.primary} [${input.commander.source}]`, width),
      toolActivityLine(input.activity, width) ?? truncate(`审查：未触发｜工具/MCP：未运行｜能力运行 ${runningCapabilities}`, width),
    ],
    intake: [truncate(intake.detail, width)],
    isIdle,
    hasBlocker,
    doctorStatus,
  }
}

export function readCapabilityPanelStatus(projectDir: string | undefined) {
  if (!projectDir) return
  try {
    return buildCapabilityStatusReport(projectDir)
  } catch {
    return
  }
}

export * as DllAgentPanelModel from "./dll-agent-panel-model"
