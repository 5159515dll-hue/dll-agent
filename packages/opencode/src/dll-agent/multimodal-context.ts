/**
 * dll-agent multimodal-context.ts
 *
 * Multimodal Context Interpreter: packet schema, hash/stale detection,
 * and evidence integration for the multimodal-context-interpreter role.
 *
 * This role converts non-text inputs (screenshots, images, webpage visuals,
 * PPT figures, flowcharts, charts, video, audio) into structured
 * multimodal_context_packet outputs for reuse by commander, reviewers,
 * Kimi archivist, Result Ledger, Continuation Gate, and Final Gate.
 */

import { write as writeEvidence } from "./evidence"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"

// ─── Packet Types ──────────────────────────────────────────────────────────

export type MultimodalInputType =
  | "screenshot"
  | "image"
  | "webpage_visual"
  | "ppt_figure"
  | "chart"
  | "flowchart"
  | "video"
  | "audio"
  | "ui"
  | "document_visual"

export type MultimodalConfidence = "low" | "medium" | "high"

export interface MultimodalObservation {
  /** What was observed */
  description: string
  /** Category for grouping */
  category: "text_content" | "visual_layout" | "error" | "warning" | "structure" | "data" | "other"
  /** Confidence for this specific observation */
  confidence: MultimodalConfidence
}

export interface MultimodalContextPacket {
  packet_type: "multimodal_context_packet"
  packet_id: string
  /** Source hash for dedup/stale detection */
  source_hash: string
  role: "multimodal-context-interpreter"
  model: string
  input_type: MultimodalInputType
  user_goal: string
  /** File path, URL, or evidence ref to the source input */
  source_ref: string
  /** How this multimodal content relates to the user's task */
  task_relevance: string
  /** Key observations */
  observations: MultimodalObservation[]
  /** Text/voice content detected in the input */
  detected_text: string | null
  /** Layout, modules, arrows, chart structure */
  visual_structure: string | null
  /** Errors, warnings, anomalies, broken links, inconsistencies */
  errors_or_warnings: string[]
  /** Details valuable for downstream tasks */
  important_details: string[]
  /** Uncertain observations */
  uncertainties: string[]
  /** Overall confidence */
  overall_confidence: MultimodalConfidence
  /** Whether the context is sufficient for downstream use */
  context_sufficient: boolean
  /** Recommended next role, if any */
  recommended_next_role: string | null
  /** Evidence references */
  evidence_refs: string[]
  redaction_status: "redacted" | "none"
  created_at: string
  /** Set when source changes */
  stale?: boolean
  invalidation_reason?: string
}

// ─── Packet helpers ────────────────────────────────────────────────────────

let packetCounter = 0

export function makePacketId(sessionID?: string): string {
  packetCounter++
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  const sessionPart = sessionID ? sessionID.slice(0, 8) : "nosession"
  return `mmctx_${sessionPart}_${ts}_${rand}_${packetCounter}`
}

/**
 * Generate a content hash for dedup/stale detection.
 * Uses SHA-256 on file content or URL + timestamp.
 */
export function hashSource(input: { filePath?: string; url?: string; content?: string }): string {
  const parts: string[] = []
  if (input.filePath && fs.existsSync(input.filePath)) {
    const stat = fs.statSync(input.filePath)
    parts.push(`file:${input.filePath}`)
    parts.push(`size:${stat.size}`)
    parts.push(`mtime:${stat.mtimeMs}`)
  } else if (input.filePath) {
    // File doesn't exist yet — hash the path
    parts.push(`file:${input.filePath}`)
  }
  if (input.url) parts.push(`url:${input.url}`)
  if (input.content) parts.push(`content:${input.content.slice(0, 500)}`)
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
}

/**
 * Check if an existing packet is stale (source changed).
 */
export function isPacketStale(packet: MultimodalContextPacket, sourceHash: string): boolean {
  return packet.source_hash !== sourceHash
}

/**
 * Build a multimodal context packet from raw data.
 */
export function buildMultimodalPacket(params: {
  sessionID?: string
  model: string
  inputType: MultimodalInputType
  userGoal: string
  sourceRef: string
  sourceHash: string
  taskRelevance: string
  observations: MultimodalObservation[]
  detectedText: string | null
  visualStructure: string | null
  errorsOrWarnings: string[]
  importantDetails: string[]
  uncertainties: string[]
  overallConfidence: MultimodalConfidence
  contextSufficient: boolean
  recommendedNextRole: string | null
  evidenceRefs: string[]
}): MultimodalContextPacket {
  return {
    packet_type: "multimodal_context_packet",
    packet_id: makePacketId(params.sessionID),
    source_hash: params.sourceHash,
    role: "multimodal-context-interpreter",
    model: params.model,
    input_type: params.inputType,
    user_goal: params.userGoal,
    source_ref: params.sourceRef,
    task_relevance: params.taskRelevance,
    observations: params.observations,
    detected_text: params.detectedText,
    visual_structure: params.visualStructure,
    errors_or_warnings: params.errorsOrWarnings,
    important_details: params.importantDetails,
    uncertainties: params.uncertainties,
    overall_confidence: params.overallConfidence,
    context_sufficient: params.contextSufficient,
    recommended_next_role: params.recommendedNextRole,
    evidence_refs: params.evidenceRefs,
    redaction_status: "none",
    created_at: new Date().toISOString(),
  }
}

/**
 * Validate that a packet meets minimum quality standards.
 */
export function validatePacket(packet: MultimodalContextPacket): {
  valid: boolean
  issues: string[]
} {
  const issues: string[] = []
  if (!packet.packet_id) issues.push("missing packet_id")
  if (!packet.source_hash || packet.source_hash === "0000000000000000") issues.push("missing or zero source_hash")
  if (!packet.user_goal) issues.push("missing user_goal")
  if (packet.observations.length === 0) issues.push("no observations — packet is empty")
  if (packet.overall_confidence === "low" && packet.context_sufficient) {
    issues.push("low confidence with context_sufficient=true — inconsistency")
  }
  if (packet.overall_confidence === "high" && packet.uncertainties.length > 0) {
    issues.push("high confidence with remaining uncertainties")
  }
  if (packet.overall_confidence === "high" && !packet.context_sufficient) {
    issues.push("high confidence but context_sufficient=false — inconsistency")
  }
  return { valid: issues.length === 0, issues }
}

// ─── Evidence integration ──────────────────────────────────────────────────

export function writeMultimodalEvidence(
  type: "multimodal.context.produced" | "multimodal.context.reused" | "multimodal.context.invalidated" | "multimodal.context.low_confidence",
  payload: {
    packet_id?: string
    source_hash?: string
    input_type?: MultimodalInputType
    model?: string
    overall_confidence?: MultimodalConfidence
    context_sufficient?: boolean
    context_packet_id?: string | null
    result_packet_id?: string
    structured_output_missing?: boolean
    validation_issues?: string[]
  },
  sessionID?: string,
) {
  writeEvidence(type, payload, sessionID)
}

// ─── Reviewer output normalization ─────────────────────────────────────────

const INPUT_TYPES: MultimodalInputType[] = [
  "screenshot",
  "image",
  "webpage_visual",
  "ppt_figure",
  "chart",
  "flowchart",
  "video",
  "audio",
  "ui",
  "document_visual",
]

const CONFIDENCES: MultimodalConfidence[] = ["low", "medium", "high"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string, fallback = "") {
  const value = record[key]
  return typeof value === "string" ? redactMultimodalContent(value) : fallback
}

function nullableStringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (value === null || value === undefined) return null
  return typeof value === "string" ? redactMultimodalContent(value) : null
}

function stringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string").map((item) => redactMultimodalContent(item))
}

function confidenceField(record: Record<string, unknown>, key: string, fallback: MultimodalConfidence) {
  const value = record[key]
  return typeof value === "string" && CONFIDENCES.includes(value as MultimodalConfidence)
    ? value as MultimodalConfidence
    : fallback
}

function inputTypeField(record: Record<string, unknown>) {
  const value = record.input_type
  return typeof value === "string" && INPUT_TYPES.includes(value as MultimodalInputType)
    ? value as MultimodalInputType
    : "image"
}

function observationsField(record: Record<string, unknown>) {
  const value = record.observations
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => {
    const category = stringField(item, "category", "other")
    return {
      description: stringField(item, "description", "No description supplied."),
      category: (
        ["text_content", "visual_layout", "error", "warning", "structure", "data", "other"].includes(category)
          ? category
          : "other"
      ) as MultimodalObservation["category"],
      confidence: confidenceField(item, "confidence", "low"),
    }
  })
}

function extractJsonCandidate(rawText: string) {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1]
  const start = rawText.indexOf("{")
  const end = rawText.lastIndexOf("}")
  if (start >= 0 && end > start) return rawText.slice(start, end + 1)
  return rawText
}

function redactedPacket(packet: MultimodalContextPacket): MultimodalContextPacket {
  return {
    ...packet,
    user_goal: redactMultimodalContent(packet.user_goal),
    source_ref: redactMultimodalContent(packet.source_ref),
    task_relevance: redactMultimodalContent(packet.task_relevance),
    observations: packet.observations.map((observation) => ({
      ...observation,
      description: redactMultimodalContent(observation.description),
    })),
    detected_text: packet.detected_text ? redactMultimodalContent(packet.detected_text) : null,
    visual_structure: packet.visual_structure ? redactMultimodalContent(packet.visual_structure) : null,
    errors_or_warnings: packet.errors_or_warnings.map((item) => redactMultimodalContent(item)),
    important_details: packet.important_details.map((item) => redactMultimodalContent(item)),
    uncertainties: packet.uncertainties.map((item) => redactMultimodalContent(item)),
    evidence_refs: packet.evidence_refs.map((item) => redactMultimodalContent(item)),
    redaction_status: "redacted",
  }
}

export function parseMultimodalPacketOutput(rawText: string, input: {
  sessionID?: string
  model: string
  fallbackUserGoal: string
  fallbackEvidenceRefs?: string[]
}): MultimodalContextPacket | null {
  try {
    const parsed = JSON.parse(extractJsonCandidate(rawText)) as unknown
    if (!isRecord(parsed) || parsed.packet_type !== "multimodal_context_packet") return null
    return redactedPacket({
      packet_type: "multimodal_context_packet",
      packet_id: stringField(parsed, "packet_id", makePacketId(input.sessionID)),
      source_hash: stringField(parsed, "source_hash", hashSource({ content: rawText })),
      role: "multimodal-context-interpreter",
      model: stringField(parsed, "model", input.model),
      input_type: inputTypeField(parsed),
      user_goal: stringField(parsed, "user_goal", input.fallbackUserGoal),
      source_ref: stringField(parsed, "source_ref", "multimodal-subtask-output"),
      task_relevance: stringField(parsed, "task_relevance", "non-text input context for the current task"),
      observations: observationsField(parsed),
      detected_text: nullableStringField(parsed, "detected_text"),
      visual_structure: nullableStringField(parsed, "visual_structure"),
      errors_or_warnings: stringArrayField(parsed, "errors_or_warnings"),
      important_details: stringArrayField(parsed, "important_details"),
      uncertainties: stringArrayField(parsed, "uncertainties"),
      overall_confidence: confidenceField(parsed, "overall_confidence", "low"),
      context_sufficient: parsed.context_sufficient === true,
      recommended_next_role: nullableStringField(parsed, "recommended_next_role"),
      evidence_refs: [
        ...stringArrayField(parsed, "evidence_refs"),
        ...(input.fallbackEvidenceRefs ?? []),
      ],
      redaction_status: parsed.redaction_status === "redacted" ? "redacted" : "none",
      created_at: stringField(parsed, "created_at", new Date().toISOString()),
      stale: parsed.stale === true,
      invalidation_reason: nullableStringField(parsed, "invalidation_reason") ?? undefined,
    })
  } catch {
    return null
  }
}

export function normalizeMultimodalPacketOutput(input: {
  rawText?: string
  sessionID?: string
  model: string
  fallbackUserGoal: string
  contextPacketID?: string
  evidenceRefs?: string[]
}) {
  const rawText = input.rawText ?? ""
  const parsed = rawText ? parseMultimodalPacketOutput(rawText, {
    sessionID: input.sessionID,
    model: input.model,
    fallbackUserGoal: input.fallbackUserGoal,
    fallbackEvidenceRefs: input.evidenceRefs,
  }) : null
  if (parsed) {
    const validation = validatePacket(parsed)
    return {
      packet: parsed,
      structuredOutputMissing: false,
      valid: validation.valid,
      validationIssues: validation.issues,
    }
  }

  const summary = redactMultimodalContent(rawText.replace(/\s+/g, " ").slice(0, 800))
  const packet = buildMultimodalPacket({
    sessionID: input.sessionID,
    model: input.model,
    inputType: "image",
    userGoal: input.fallbackUserGoal,
    sourceRef: input.contextPacketID ? `context_handoff:${input.contextPacketID}` : "multimodal-subtask-output",
    sourceHash: hashSource({ content: rawText || input.fallbackUserGoal }),
    taskRelevance: "fallback packet for an unstructured multimodal reviewer output",
    observations: [{
      description: summary || "Multimodal reviewer did not return a structured packet.",
      category: "warning",
      confidence: "low",
    }],
    detectedText: null,
    visualStructure: null,
    errorsOrWarnings: ["structured multimodal_context_packet missing"],
    importantDetails: [],
    uncertainties: ["raw multimodal reviewer output could not be parsed as structured JSON"],
    overallConfidence: "low",
    contextSufficient: false,
    recommendedNextRole: "commander",
    evidenceRefs: input.evidenceRefs ?? [],
  })
  return {
    packet: redactedPacket(packet),
    structuredOutputMissing: true,
    valid: false,
    validationIssues: ["structured multimodal_context_packet missing"],
  }
}

// ─── Session-level storage ─────────────────────────────────────────────────

function packetStorePath(sessionID: string): string {
  const root = process.env.DLL_AGENT_CONFIG_ROOT || path.join(os.homedir(), ".dll-agent")
  return path.join(root, "sessions", sessionID, "multimodal-packets.jsonl")
}

export function savePacket(sessionID: string, packet: MultimodalContextPacket) {
  try {
    const filePath = packetStorePath(sessionID)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, JSON.stringify(packet) + "\n")
  } catch {
    // best-effort
  }
}

export function loadPackets(sessionID: string): MultimodalContextPacket[] {
  try {
    const filePath = packetStorePath(sessionID)
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, "utf8")
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as MultimodalContextPacket } catch { return null }
      })
      .filter((p): p is MultimodalContextPacket => p !== null)
  } catch {
    return []
  }
}

/**
 * Find an existing reusable packet by source hash.
 * Only returns packets that are not stale and have sufficient context.
 */
export function findReusablePacket(
  sessionID: string,
  sourceHash: string,
  options?: {
    minConfidence?: MultimodalConfidence
    requireSufficient?: boolean
  },
): MultimodalContextPacket | null {
  const packets = loadPackets(sessionID)
  const minConf = options?.minConfidence ?? "medium"
  const requireSuff = options?.requireSufficient ?? true

  for (const packet of packets.reverse()) {
    if (packet.source_hash !== sourceHash) continue
    if (packet.stale) continue

    const confOrder: Record<MultimodalConfidence, number> = { low: 0, medium: 1, high: 2 }
    if (confOrder[packet.overall_confidence] < confOrder[minConf]) continue
    if (requireSuff && !packet.context_sufficient) continue

    return packet
  }
  return null
}

/**
 * Mark all packets for a source hash as stale.
 */
export function markPacketsStale(sessionID: string, sourceHash: string) {
  try {
    const packets = loadPackets(sessionID)
    let changed = false
    for (const packet of packets) {
      if (packet.source_hash === sourceHash && !packet.stale) {
        packet.stale = true
        packet.invalidation_reason = "source_changed"
        changed = true
      }
    }
    if (changed) {
      const filePath = packetStorePath(sessionID)
      fs.writeFileSync(filePath, packets.map((p) => JSON.stringify(p)).join("\n") + "\n")
    }
  } catch {
    // best-effort
  }
}

// ─── Redaction ─────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*[^\s,}]+/gi,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /ghp_[A-Za-z0-9_]+/g,
  // QR code content hints
  /qr.?code.*?(?:key|token|secret|wallet)/gi,
  // Private media references
  /(?:\/Users\/[^/\s]+\/(?:Desktop|Downloads|Documents|Pictures|Movies|Music)\/[^\s"'`]+)/gi,
]

export function redactMultimodalContent(text: string): string {
  let result = text
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]")
  }
  return result
}

// ─── Trigger detection ─────────────────────────────────────────────────────

/**
 * Check if a user message or command contains multimodal input signals.
 */
export function detectMultimodalInput(messageText: string): {
  hasMultimodalSignal: boolean
  inputTypes: MultimodalInputType[]
  confidence: MultimodalConfidence
} {
  const inputTypes: MultimodalInputType[] = []
  const signals: { pattern: RegExp; type: MultimodalInputType; weight: number }[] = [
    { pattern: /截图|screenshot|screen.?shot|截屏|snip/i, type: "screenshot", weight: 3 },
    { pattern: /图片|image|photo|照片|\.(?:png|jpg|jpeg|gif|webp|bmp)\b/i, type: "image", weight: 3 },
    { pattern: /网页|webpage|页面.*(?:视觉|截图|布局|layout)|browser.*(?:visual|screenshot)/i, type: "webpage_visual", weight: 2 },
    { pattern: /PPT|slides?|演示|slide.*(?:图示|figure|截图)/i, type: "ppt_figure", weight: 2 },
    { pattern: /图表|chart|graph|plot|数据.*图|柱状图|折线图|饼图|散点图/i, type: "chart", weight: 2 },
    { pattern: /流程图|flowchart|flow.?chart|流程.*(?:图|示意)|process.*diagram/i, type: "flowchart", weight: 2 },
    { pattern: /视频|video|\.(?:mp4|mov|avi|webm)\b|录像/i, type: "video", weight: 1 },
    { pattern: /音频|audio|录音|voice(?!.?output|.?clone)|\.(?:mp3|wav|ogg|m4a)\b/i, type: "audio", weight: 1 },
    { pattern: /UI|界面|interface.*(?:截图|screenshot|视觉)|layout.*(?:视觉|截图)/i, type: "ui", weight: 2 },
    { pattern: /文档.*(?:视觉|截图|图示)|document.*(?:visual|figure|screenshot)|pdf.*(?:截图|图示|visual)/i, type: "document_visual", weight: 2 },
  ]

  let totalWeight = 0
  for (const signal of signals) {
    if (signal.pattern.test(messageText)) {
      inputTypes.push(signal.type)
      totalWeight += signal.weight
    }
  }

  const confidence: MultimodalConfidence =
    totalWeight >= 5 ? "high" : totalWeight >= 3 ? "medium" : "low"

  return {
    hasMultimodalSignal: inputTypes.length > 0,
    inputTypes: [...new Set(inputTypes)],
    confidence,
  }
}

/**
 * Check if message contains file attachments that are multimodal.
 */
export function hasImageAttachment(filePaths: string[]): boolean {
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tiff"]
  return filePaths.some((fp) => imageExts.some((ext) => fp.toLowerCase().endsWith(ext)))
}

export function hasVideoAttachment(filePaths: string[]): boolean {
  const videoExts = [".mp4", ".mov", ".avi", ".webm", ".mkv"]
  return filePaths.some((fp) => videoExts.some((ext) => fp.toLowerCase().endsWith(ext)))
}

export function hasAudioAttachment(filePaths: string[]): boolean {
  const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".flac"]
  return filePaths.some((fp) => audioExts.some((ext) => fp.toLowerCase().endsWith(ext)))
}
