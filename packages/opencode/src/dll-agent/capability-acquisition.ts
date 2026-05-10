import fs from "fs"
import os from "os"
import path from "path"
import { write as writeEvidence } from "./evidence"

export type CapabilityAcquisitionKind = "skill" | "mcp" | "tool" | "software" | "provider" | "script"
export type CapabilityAcquisitionSourceType = "url" | "github" | "npm" | "pip" | "local" | "docs" | "user-provided"
export type CapabilitySourceTrust = "official" | "verified" | "unknown" | "untrusted"
export type CapabilityAcquisitionRiskLevel = "R0" | "R1" | "R2" | "R3" | "R4"
export type CapabilityLifecycleStatus =
  | "discovered"
  | "candidate"
  | "quarantined"
  | "risk_classified"
  | "audited"
  | "sandbox_installed"
  | "smoke_tested"
  | "approved"
  | "activated"
  | "monitored"
  | "disabled"
  | "rolled_back"

export type FinalAuditorVerdict = "pass" | "warn" | "block" | "needs_user_auth"

export interface CapabilityAcquisitionRecord {
  capability_id: string
  kind: CapabilityAcquisitionKind
  source: CapabilityAcquisitionSourceType
  source_url?: string
  version?: string
  source_trust: CapabilitySourceTrust
  risk_level: CapabilityAcquisitionRiskLevel
  status: CapabilityLifecycleStatus
  requires_user_authorization: boolean
  final_auditor_verdict?: FinalAuditorVerdict
  sandbox_path?: string
  evidence_refs: string[]
  rollback_plan?: string
  checksum?: string
  created_at: string
  updated_at: string
}

export interface CapabilityInstallManifest {
  version: 1
  id: string
  kind: CapabilityAcquisitionKind
  displayName: string
  description: string
  source: {
    type: CapabilityAcquisitionSourceType
    url?: string
    checksum?: string
    verified: boolean
  }
  risk: {
    level: CapabilityAcquisitionRiskLevel
    reasons: string[]
    requiresFinalAudit: boolean
    requiresUserAuthorization: boolean
  }
  permissions: {
    filesystem: "none" | "project-read" | "project-write" | "sandbox-only"
    network: "none" | "public" | "private"
    secrets: "never"
    process: "none" | "short-lived" | "long-running"
    browserProfile?: "none" | "isolated-only"
  }
  activation: {
    mode: "disabled" | "on_demand" | "autostart_lightweight"
    rolesAllowed: string[]
    rolesDenied: string[]
  }
  commands: {
    install: string[][]
    smoke: string[][]
    start: string[][]
    stop: string[][]
  }
  rollback: {
    steps: string[][]
    safe: boolean
  }
}

export interface CapabilityDiscoveryCandidate {
  candidate_id: string
  source: string
  kind: CapabilityAcquisitionKind
  why_useful: string
  risk_guess: CapabilityAcquisitionRiskLevel
  next_action: "inspect" | "quarantine" | "reject"
}

export interface CapabilityRiskAssessment {
  riskLevel: CapabilityAcquisitionRiskLevel
  reasons: string[]
  requiresFinalAuditor: boolean
  requiresUserAuthorization: boolean
  hardBlocked: boolean
  allowedAutomatically: boolean
  requiredSandbox: boolean
  requiredSmokeTests: string[]
  rollbackRequired: boolean
}

export interface CapabilityAuditPacket {
  candidate: CapabilityDiscoveryCandidate | CapabilityAcquisitionRecord | CapabilityInstallManifest
  risk_assessment: CapabilityRiskAssessment
  source_metadata: Record<string, unknown>
  requested_permissions: CapabilityInstallManifest["permissions"] | Record<string, unknown>
  sandbox_plan: Record<string, unknown>
  smoke_test_plan: string[][]
  rollback_plan: string[][] | string | null
  evidence_refs: string[]
}

export interface CapabilityAuditorVerdict {
  verdict: "approve_auto" | "approve_with_user_auth" | "block" | "insufficient_evidence"
  risk_level: CapabilityAcquisitionRiskLevel
  blocking_reasons: string[]
  conditions: string[]
  required_user_authorization: boolean
  required_smoke_tests: string[]
  rollback_required: boolean
  confidence: "low" | "medium" | "high"
}

export interface CapabilityManifestValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function capabilityAcquisitionRoot() {
  return path.join(os.homedir(), ".dll-agent", "capabilities")
}

export function capabilityAcquisitionPaths(root = capabilityAcquisitionRoot()) {
  return {
    root,
    quarantine: path.join(root, "quarantine"),
    installed: path.join(root, "installed"),
    disabled: path.join(root, "disabled"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs"),
    manifests: path.join(root, "manifests"),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isCommandList(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((item) => isStringArray(item))
}

export function validateCapabilityInstallManifest(value: unknown): CapabilityManifestValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(value)) {
    return { valid: false, errors: ["manifest must be an object"], warnings }
  }
  if (value.version !== 1) errors.push("version must be 1")
  for (const key of ["id", "kind", "displayName", "description"]) {
    if (typeof value[key] !== "string" || !value[key]) errors.push(`${key} is required`)
  }
  const source = value.source
  if (!isRecord(source)) errors.push("source is required")
  else {
    if (typeof source.type !== "string") errors.push("source.type is required")
    if (source.url !== undefined && typeof source.url !== "string") errors.push("source.url must be a string")
    if (source.checksum !== undefined && typeof source.checksum !== "string") errors.push("source.checksum must be a string")
    if (typeof source.verified !== "boolean") errors.push("source.verified must be boolean")
  }
  const risk = value.risk
  if (!isRecord(risk)) errors.push("risk is required")
  else {
    if (!["R0", "R1", "R2", "R3", "R4"].includes(String(risk.level))) errors.push("risk.level must be R0-R4")
    if (!Array.isArray(risk.reasons)) errors.push("risk.reasons must be an array")
    if (typeof risk.requiresFinalAudit !== "boolean") errors.push("risk.requiresFinalAudit must be boolean")
    if (typeof risk.requiresUserAuthorization !== "boolean") errors.push("risk.requiresUserAuthorization must be boolean")
  }
  const permissions = value.permissions
  if (!isRecord(permissions)) errors.push("permissions is required")
  else {
    if (!["none", "project-read", "project-write", "sandbox-only"].includes(String(permissions.filesystem))) {
      errors.push("permissions.filesystem is invalid")
    }
    if (!["none", "public", "private"].includes(String(permissions.network))) errors.push("permissions.network is invalid")
    if (permissions.secrets !== "never") errors.push("permissions.secrets must be never")
    if (!["none", "short-lived", "long-running"].includes(String(permissions.process))) {
      errors.push("permissions.process is invalid")
    }
  }
  const activation = value.activation
  if (!isRecord(activation)) errors.push("activation is required")
  else {
    if (!["disabled", "on_demand", "autostart_lightweight"].includes(String(activation.mode))) {
      errors.push("activation.mode is invalid")
    }
    if (!isStringArray(activation.rolesAllowed)) errors.push("activation.rolesAllowed must be string[]")
    if (!isStringArray(activation.rolesDenied)) errors.push("activation.rolesDenied must be string[]")
  }
  const commands = value.commands
  if (!isRecord(commands)) errors.push("commands is required")
  else {
    for (const key of ["install", "smoke", "start", "stop"]) {
      if (!isCommandList(commands[key])) errors.push(`commands.${key} must be string[][]`)
    }
  }
  const rollback = value.rollback
  if (!isRecord(rollback)) errors.push("rollback is required")
  else {
    if (!isCommandList(rollback.steps)) errors.push("rollback.steps must be string[][]")
    if (typeof rollback.safe !== "boolean") errors.push("rollback.safe must be boolean")
  }

  if (isRecord(risk) && (risk.level === "R2" || risk.level === "R3" || risk.level === "R4")) {
    if (!isRecord(rollback) || !isCommandList(rollback.steps) || rollback.steps.length === 0) {
      errors.push("R2+ capabilities require rollback steps")
    }
  }
  if (isRecord(risk) && risk.level === "R4" && isRecord(activation) && activation.mode !== "disabled") {
    errors.push("R4 capabilities must not be activatable by manifest")
  }
  if (isRecord(source) && source.verified === false) warnings.push("source is unverified")
  return { valid: errors.length === 0, errors, warnings }
}

export function writeCapabilityEvidence(type: string, payload: unknown, sessionID?: string) {
  writeEvidence(type, payload, sessionID)
}

export function buildCapabilityAuditPacket(input: {
  candidate: CapabilityDiscoveryCandidate | CapabilityAcquisitionRecord | CapabilityInstallManifest
  riskAssessment: CapabilityRiskAssessment
  sourceMetadata?: Record<string, unknown>
  requestedPermissions?: CapabilityInstallManifest["permissions"] | Record<string, unknown>
  sandboxPlan?: Record<string, unknown>
  smokeTestPlan?: string[][]
  rollbackPlan?: string[][] | string | null
  evidenceRefs?: string[]
}): CapabilityAuditPacket {
  return {
    candidate: input.candidate,
    risk_assessment: input.riskAssessment,
    source_metadata: input.sourceMetadata ?? {},
    requested_permissions: input.requestedPermissions ?? {},
    sandbox_plan: input.sandboxPlan ?? {},
    smoke_test_plan: input.smokeTestPlan ?? [],
    rollback_plan: input.rollbackPlan ?? null,
    evidence_refs: input.evidenceRefs ?? [],
  }
}

export function doctorCheckCapabilityAcquisition(root = capabilityAcquisitionRoot()): {
  name: string
  severity: "PASS" | "WARN" | "FAIL"
  message: string
  nextAction: string | null
  evidence: string | null
}[] {
  const checks: {
    name: string
    severity: "PASS" | "WARN" | "FAIL"
    message: string
    nextAction: string | null
    evidence: string | null
  }[] = []
  const paths = capabilityAcquisitionPaths(root)
  if (!fs.existsSync(paths.root)) {
    checks.push({
      name: "capability-acquisition-store",
      severity: "PASS",
      message: "Capability acquisition store is not initialized; no autonomous installs have been attempted",
      nextAction: null,
      evidence: `root=${paths.root}`,
    })
    return checks
  }
  const missing = Object.entries(paths)
    .filter(([key]) => key !== "root")
    .filter(([, dir]) => !fs.existsSync(dir))
    .map(([key]) => key)
  checks.push({
    name: "capability-acquisition-directories",
    severity: missing.length === 0 ? "PASS" : "WARN",
    message: missing.length === 0
      ? "Capability acquisition directories are present"
      : `Capability acquisition directories missing: ${missing.join(", ")}`,
    nextAction: missing.length === 0 ? null : "Directories will be created by the first authorized acquisition workflow",
    evidence: `root=${paths.root}`,
  })

  const manifestFiles = fs.existsSync(paths.manifests)
    ? fs.readdirSync(paths.manifests).filter((item) => item.endsWith(".json") || item.endsWith(".jsonc"))
    : []
  let invalid = 0
  for (const file of manifestFiles) {
    try {
      const raw = fs.readFileSync(path.join(paths.manifests, file), "utf8")
      const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(?=\s*[}\]])/g, ""))
      if (!validateCapabilityInstallManifest(parsed).valid) invalid++
    } catch {
      invalid++
    }
  }
  checks.push({
    name: "capability-acquisition-manifests",
    severity: invalid === 0 ? "PASS" : "FAIL",
    message: invalid === 0
      ? `Capability acquisition manifests parse and validate (${manifestFiles.length} file(s))`
      : `${invalid}/${manifestFiles.length} capability acquisition manifest(s) are invalid`,
    nextAction: invalid === 0 ? null : "Fix invalid capability manifests before enabling autonomous acquisition",
    evidence: `manifests=${manifestFiles.length}, invalid=${invalid}`,
  })
  return checks
}

export * as CapabilityAcquisition from "./capability-acquisition"
