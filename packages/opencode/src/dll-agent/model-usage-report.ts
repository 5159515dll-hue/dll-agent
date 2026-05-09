import { readEntries, redact, type Entry as EvidenceEntry } from "./evidence"
import { loadCostStatus } from "./cost-cap"
import { loadResults } from "./result-ledger"

export interface ModelUsageItem {
  role: string
  selected_model: string
  candidate_models: string[]
  trigger_reason: string
  correctness_reason: string
  cost_reason: string | null
  skipped_reviewers: string[]
  skip_reason: string | null
  whether_required_for_correctness: boolean
  fallback_reason: string | null
  result_refs: string[]
  estimated_cost_usd: number | null
  provider_status: string
  unresolved_routing_risk: boolean
  evidence_ref: string
}

export interface ModelUsageReport {
  generated_at: string
  sessionID: string
  total_decisions: number
  total_estimated_cost_usd: number
  by_model: Record<string, number>
  by_role: Record<string, number>
  unresolved_routing_risks: number
  items: ModelUsageItem[]
  redaction_status: "redacted"
}

function payloadRecord(entry: EvidenceEntry | undefined) {
  return entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown>
    : {}
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : []
}

function bool(value: unknown) {
  return value === true
}

function providerFor(model: string) {
  const slash = model.indexOf("/")
  if (slash === -1) return model || "unknown"
  return model.slice(0, slash)
}

function increment(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

export function buildModelUsageReport(input: {
  sessionID: string
  evidenceFile?: string
  maxItems?: number
}): ModelUsageReport {
  const cost = loadCostStatus(input.sessionID)
  const resultRefs = new Set(loadResults(input.sessionID).map((result) => result.packet_id))
  const routing = readEntries(input.evidenceFile)
    .filter((entry) => entry.sessionID === input.sessionID && entry.type === "model.routing_decision")
  const byModel: Record<string, number> = {}
  const byRole: Record<string, number> = {}
  const items = routing.map((entry) => {
    const payload = payloadRecord(entry)
    const selected = String(payload.selected_model ?? "unknown")
    const provider = providerFor(selected)
    const role = String(payload.role ?? "unknown")
    increment(byModel, selected)
    increment(byRole, role)
    const refs = stringArray(payload.result_refs).filter((ref) => resultRefs.size === 0 || resultRefs.has(ref))
    return {
      role,
      selected_model: selected,
      candidate_models: stringArray(payload.candidate_models),
      trigger_reason: String(payload.trigger_reason ?? "unknown"),
      correctness_reason: String(payload.correctness_reason ?? "unknown"),
      cost_reason: typeof payload.cost_reason === "string" ? payload.cost_reason : null,
      skipped_reviewers: stringArray(payload.skipped_reviewers),
      skip_reason: typeof payload.skip_reason === "string" ? payload.skip_reason : null,
      whether_required_for_correctness: bool(payload.whether_required_for_correctness),
      fallback_reason: typeof payload.fallback_reason === "string" ? payload.fallback_reason : null,
      result_refs: refs,
      estimated_cost_usd: cost.by_provider[provider] ?? null,
      provider_status: "not_available",
      unresolved_routing_risk: bool(payload.unresolved_routing_risk),
      evidence_ref: `${entry.type}@${entry.ts}`,
    } satisfies ModelUsageItem
  }).slice(-(input.maxItems ?? 50))

  return redact({
    generated_at: new Date().toISOString(),
    sessionID: input.sessionID,
    total_decisions: routing.length,
    total_estimated_cost_usd: cost.session_total_usd,
    by_model: byModel,
    by_role: byRole,
    unresolved_routing_risks: items.filter((item) => item.unresolved_routing_risk).length,
    items,
    redaction_status: "redacted",
  } satisfies ModelUsageReport) as ModelUsageReport
}

export function renderModelUsageReport(input: {
  sessionID: string
  evidenceFile?: string
  maxItems?: number
  maxChars?: number
}) {
  const report = buildModelUsageReport(input)
  const lines = [
    "dll-agent model usage",
    `session: ${report.sessionID}`,
    `decisions: ${report.total_decisions}`,
    `local estimated cost: $${report.total_estimated_cost_usd.toFixed(4)}`,
    `unresolved routing risks: ${report.unresolved_routing_risks}`,
    "",
    ...report.items.map((item) =>
      [
        `- ${item.role}: ${item.selected_model}`,
        `trigger=${item.trigger_reason}`,
        `correctness=${item.correctness_reason}`,
        item.cost_reason ? `cost=${item.cost_reason}` : "cost=not_available",
        item.skipped_reviewers.length ? `skipped=${item.skipped_reviewers.join(",")}` : "skipped=none",
        item.unresolved_routing_risk ? "risk=unresolved" : "risk=none",
      ].join(" | ")
    ),
  ]
  return lines.join("\n").slice(0, input.maxChars ?? 5_000)
}

export function renderRoutingReport(input: {
  sessionID: string
  evidenceFile?: string
  maxItems?: number
  maxChars?: number
}) {
  const report = buildModelUsageReport(input)
  const lines = [
    "dll-agent routing report",
    `session: ${report.sessionID}`,
    `decisions: ${report.total_decisions}`,
    `unresolved risks: ${report.unresolved_routing_risks}`,
    "",
    ...report.items.map((item) =>
      [
        `- role=${item.role}`,
        `model=${item.selected_model}`,
        `candidates=[${item.candidate_models.join(",") || "none"}]`,
        `required=${item.whether_required_for_correctness}`,
        `correctness=${item.correctness_reason}`,
        `cost=${item.cost_reason ?? "not_available"}`,
        `fallback=${item.fallback_reason ?? "none"}`,
        `evidence=${item.evidence_ref}`,
      ].join(" | ")
    ),
  ]
  return lines.join("\n").slice(0, input.maxChars ?? 5_000)
}

export function buildModelUsageStatusLine(input: {
  report: Pick<ModelUsageReport, "total_decisions" | "unresolved_routing_risks" | "total_estimated_cost_usd">
  width?: number
}) {
  return `routing decisions:${input.report.total_decisions} risks:${input.report.unresolved_routing_risks} local_cost:$${input.report.total_estimated_cost_usd.toFixed(3)}`
    .slice(0, input.width ?? 160)
}

export * as ModelUsageReport from "./model-usage-report"
