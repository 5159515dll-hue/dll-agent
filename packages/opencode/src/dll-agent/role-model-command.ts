import {
  isDllRole,
  listRoleModels,
  validateRoleModel,
  type DllRole,
  type OverrideScope,
} from "./role-model-registry"
import type { SessionID } from "@/session/schema"

const argsRegex = /"[^"]*"|'[^']*'|\S+/g
const quoteTrimRegex = /^['"]|['"]$/g

export interface ParsedRoleModelSetArgs {
  role?: string
  model?: string
  scope: string
}

export type RoleModelSetValidation =
  | { ok: true; role: DllRole; model: string; scope: OverrideScope }
  | { ok: false; message: string }

export function parseRoleModelSetArgs(args: string): ParsedRoleModelSetArgs {
  const tokens = args.match(argsRegex)?.map((arg) => arg.replace(quoteTrimRegex, "")) ?? []
  const role = tokens[0]
  const model = tokens[1]
  const scopeIndex = tokens.indexOf("--scope")
  const scope = scopeIndex >= 0 ? tokens[scopeIndex + 1] : "global"
  return { role, model, scope }
}

export function validateRoleModelSetArgs(parsed: ParsedRoleModelSetArgs): RoleModelSetValidation {
  if (!parsed.role || !isDllRole(parsed.role)) {
    return { ok: false, message: "Usage: /role-model-set <role> <provider/model> [--scope session|project|global]" }
  }
  if (!parsed.model || !validateRoleModel(parsed.model).valid) {
    return { ok: false, message: "Invalid model. Expected provider/model." }
  }
  if (parsed.scope !== "session" && parsed.scope !== "project" && parsed.scope !== "global") {
    return { ok: false, message: "Invalid scope. Expected session, project, or global." }
  }
  return { ok: true, role: parsed.role, model: parsed.model, scope: parsed.scope }
}

export function roleModelsText(sessionID: SessionID, projectDir?: string) {
  const rows = listRoleModels(sessionID, projectDir).map((item) => {
    const fallback = item.fallback.length ? item.fallback.join(" -> ") : "-"
    const availability = item.providerAvailable ? "hint=configured" : "hint=unknown_or_missing"
    return `- ${item.role}: ${item.primary} | source=${item.source} | fallback=${fallback} | enabled=${item.enabled} | ${availability}`
  })
  return ["dll-agent role models:", ...rows].join("\n")
}

export function roleModelSetSuccessText(input: {
  role: DllRole
  previous: string
  current: string
  source: string
}) {
  return [
    `Updated ${input.role} model.`,
    `previous=${input.previous}`,
    `current=${input.current}`,
    `source=${input.source}`,
  ].join("\n")
}
