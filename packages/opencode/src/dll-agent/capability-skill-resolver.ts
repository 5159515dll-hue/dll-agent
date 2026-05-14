/**
 * Dynamic capability -> skill resolver.
 *
 * This deliberately avoids hard-coded alias tables. A request such as
 * "ppt-pptx:tool" is resolved through tool catalog metadata and the currently
 * installed skills. New tools should become resolvable by declaring metadata
 * (id/name/skill_ref/description/triggers), not by editing this module.
 */

import { GLOBAL_DEFAULT_TOOLS, type ToolEntry } from "./tool-catalog"

export interface SkillLike {
  name: string
  description: string
}

export interface CapabilitySkillResolution {
  skill?: SkillLike
  requested_name: string
  normalized_request: string
  matched_tool?: ToolEntry
  candidate_names: string[]
  reason: string
}

function hasDeclaredFileInput(tool: ToolEntry): boolean {
  return (tool.triggers.file_extensions ?? []).length > 0
}

function fallbackWorkflow(tool: ToolEntry): string[] {
  if (!hasDeclaredFileInput(tool)) return []
  return [
    "workflow.primary: extract structured content with the declared file-processing capability",
    "workflow.support: create an optimized copy instead of overwriting the source",
    "workflow.validation: render/export or inspect the generated artifact before final response when a renderer is available",
    "workflow.fallback: if the preferred library is missing, use another registered local software path or request acquisition/authorization",
  ]
}

function fallbackPathPolicy(tool: ToolEntry): string[] {
  if (!hasDeclaredFileInput(tool)) return []
  return [
    "path_policy: explicit_absolute_path_first=true",
    "path_policy: validate and use the user-provided absolute path before any glob/search",
    "path_policy: use glob/search only after the explicit path is missing, inaccessible, or ambiguous",
  ]
}

export function buildCapabilityFallbackPacket(resolution: CapabilitySkillResolution): string | undefined {
  const tool = resolution.matched_tool
  if (!tool) return undefined
  const requirements = [
    ...(tool.requirements?.binaries ?? []).map((item) => `binary:${item}`),
    ...(tool.requirements?.tokens ?? []).map((item) => `token:${item}`),
    ...(tool.requirements?.ports ?? []).map((item) => `port:${item}`),
  ]
  return [
    `<capability_fallback id="${tool.id}" name="${tool.name}">`,
    `requested_name: ${resolution.requested_name}`,
    `reason: ${resolution.reason}`,
    "installed_skill: none_matched",
    "next_step: use this capability metadata to choose an available tool/software path; do not retry skill aliases",
    hasDeclaredFileInput(tool)
      ? "preferred_runtime_path: use the declared file-processing software/library path for extraction, editing, and validation"
      : undefined,
    `kind: ${tool.kind}`,
    `risk_level: ${tool.risk_level}`,
    `injection_policy: ${tool.injection_policy}`,
    `requirements: ${requirements.length ? requirements.join(", ") : "none"}`,
    `file_extensions: ${(tool.triggers.file_extensions ?? []).join(", ") || "none"}`,
    `task_patterns: ${(tool.triggers.task_patterns ?? []).join(", ") || "none"}`,
    `network_allowed: ${tool.security.allow_network}`,
    `requires_consent: ${tool.security.require_consent}`,
    ...fallbackPathPolicy(tool),
    ...fallbackWorkflow(tool),
    "",
    tool.prompt_detail,
    "</capability_fallback>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function stripKindSuffix(value: string): string {
  return value.replace(/:(skill|tool|mcp|software|capability)$/i, "")
}

export function normalizeCapabilityName(value: string): string {
  return stripKindSuffix(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[:_./\s]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function words(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3),
    ),
  ]
}

function toolText(tool: ToolEntry | undefined): string {
  if (!tool) return ""
  return [
    tool.id,
    tool.name,
    tool.skill_ref,
    tool.mcp_ref,
    tool.description,
    tool.prompt_index,
    tool.prompt_detail,
    ...(tool.triggers.file_extensions ?? []),
    ...(tool.triggers.task_patterns ?? []),
  ]
    .filter(Boolean)
    .join(" ")
}

function candidateNames(requestedName: string, tool: ToolEntry | undefined): string[] {
  const raw = [
    requestedName,
    stripKindSuffix(requestedName),
    tool?.skill_ref,
    tool?.id,
    tool?.name,
    tool?.mcp_ref,
  ].filter((item): item is string => !!item && item.trim().length > 0)
  return [...new Set(raw)]
}

function findRequestedTool(requestedName: string, tools: ToolEntry[]): ToolEntry | undefined {
  const normalized = normalizeCapabilityName(requestedName)
  return tools.find((tool) =>
    [
      tool.id,
      tool.name,
      tool.skill_ref,
      tool.mcp_ref,
    ]
      .filter((item): item is string => !!item)
      .some((item) => normalizeCapabilityName(item) === normalized),
  )
}

function scoreSkill(
  skill: SkillLike,
  normalizedRequest: string,
  candidates: string[],
  metadataText: string,
): { score: number; reason: string } {
  const normalizedSkillName = normalizeCapabilityName(skill.name)
  const normalizedSkillDescription = normalizeCapabilityName(skill.description)
  const normalizedCandidates = candidates.map(normalizeCapabilityName)
  const normalizedMetadata = normalizeCapabilityName(metadataText)

  if (normalizedSkillName === normalizedRequest) return { score: 100, reason: "skill name matches request" }
  if (normalizedCandidates.includes(normalizedSkillName)) return { score: 95, reason: "skill name matches catalog metadata" }
  if (normalizedSkillName && normalizedMetadata.includes(normalizedSkillName)) {
    return { score: 85, reason: "skill name appears in tool metadata" }
  }
  if (normalizedSkillDescription.includes(normalizedRequest) && normalizedRequest.length >= 3) {
    return { score: 70, reason: "skill description matches request" }
  }

  const metadataWords = new Set(words(`${metadataText} ${candidates.join(" ")}`))
  const skillWords = words(`${skill.name} ${skill.description}`)
  const overlap = skillWords.filter((word) => metadataWords.has(word)).length
  if (overlap >= 2) return { score: 65, reason: "skill metadata overlaps tool metadata" }
  if (overlap === 1 && normalizedMetadata.includes(normalizedSkillName)) {
    return { score: 60, reason: "skill name and tool metadata overlap" }
  }

  return { score: 0, reason: "no dynamic metadata match" }
}

export function resolveCapabilitySkill(input: {
  requestedName: string
  skills: SkillLike[]
  tools?: ToolEntry[]
}): CapabilitySkillResolution {
  const tools = input.tools ?? GLOBAL_DEFAULT_TOOLS
  const normalizedRequest = normalizeCapabilityName(input.requestedName)
  const matchedTool = findRequestedTool(input.requestedName, tools)
  const candidates = candidateNames(input.requestedName, matchedTool)
  const metadata = toolText(matchedTool)
  const ranked = input.skills
    .map((skill) => {
      const result = scoreSkill(skill, normalizedRequest, candidates, metadata)
      return { skill, ...result }
    })
    .sort((a, b) => b.score - a.score)
  const best = ranked[0]

  if (best && best.score >= 60) {
    return {
      skill: best.skill,
      requested_name: input.requestedName,
      normalized_request: normalizedRequest,
      matched_tool: matchedTool,
      candidate_names: candidates,
      reason: best.reason,
    }
  }

  return {
    requested_name: input.requestedName,
    normalized_request: normalizedRequest,
    matched_tool: matchedTool,
    candidate_names: candidates,
    reason: matchedTool
      ? "tool metadata found, but no installed skill matched dynamically"
      : "no matching tool or installed skill metadata",
  }
}
