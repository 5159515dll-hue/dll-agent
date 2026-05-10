import { buildCapabilityStatusReport, type CapabilityStatusReport } from "./capability-status"
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

function intakeSummary(supervisor: SupervisorPanelState | undefined) {
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

function finalLine(report: ObservabilityPanelState, supervisor: SupervisorPanelState | undefined, width: number) {
  if (!report) return "任务：未知"
  if (!hasRuntimeTask(report)) return truncate(`任务：${intakeSummary(supervisor).label}｜阶段：${report.phase}｜风险：${report.risk}`, width)
  return truncate(`任务：${zhStatus(report.final_status_detail)}｜阶段：${report.phase}｜风险：${report.risk}`, width)
}

function goalLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "目标：不可用"
  return truncate(`目标：${report.goal ?? "未建立目标"}`, width)
}

function verificationLine(report: ObservabilityPanelState, width: number) {
  if (!report) return "验证：未知｜doctor：未知"
  if (!hasRuntimeTask(report) && report.verification.required.length === 0) return `验证：未要求｜doctor：${displayDoctor(report)}`
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
  const isIdle = !hasBlocker && !hasRuntimeTask(input.task)
  const doctorStatus = displayDoctor(input.task)
  const intake = intakeSummary(input.supervisor)
  const capability = input.capability
  const runningCapabilities = capability
    ? (capability.by_status.running ?? 0) + Object.keys(capability.runtime_states).length
    : 0
  return {
    global: [
      truncate(`dll-agent：${displayStatus({ supervisor: input.supervisor, task: input.task })}｜${input.projectLabel}｜${input.sessionLabel}`, width),
      truncate(
        `模型：指挥官=${input.commander.primary} [${input.commander.source}]｜当前角色=${activeRole}｜doctor=${doctorStatus}｜${costLine(input.cost, width)}`,
        width,
      ),
      quotaLine(input.quota, width),
    ].slice(0, input.compact ? 2 : 3),
    task: [
      finalLine(input.task, input.supervisor, width),
      truncate(intake.detail, width),
      goalLine(input.task, width),
      planLine(input.task, width),
    ].slice(0, input.compact ? 3 : 4),
    verification: [
      verificationLine(input.task, width),
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
      truncate(`状态：待命｜${intake.label}｜${intake.available ? "入口意图已分析" : "未建立工程任务"}`, width),
      truncate(`模型：${input.commander.primary} [${input.commander.source}]`, width),
      truncate(`审查：未触发｜工具/MCP：未运行｜能力运行 ${runningCapabilities}`, width),
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
