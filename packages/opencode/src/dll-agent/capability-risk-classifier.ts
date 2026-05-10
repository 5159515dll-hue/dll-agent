import type { CapabilityEntry } from "./capability-schema"
import type {
  CapabilityAcquisitionKind,
  CapabilityAcquisitionRiskLevel,
  CapabilityInstallManifest,
  CapabilityRiskAssessment,
} from "./capability-acquisition"

export interface CapabilityRiskClassifierInput {
  kind?: CapabilityAcquisitionKind
  sourceUrl?: string
  sourceTrust?: "official" | "verified" | "unknown" | "untrusted"
  installCommands?: string[][]
  smokeCommands?: string[][]
  startCommands?: string[][]
  stopCommands?: string[][]
  requiresSecrets?: boolean
  readsSecrets?: boolean
  networkAccess?: "none" | "public" | "private"
  filesystem?: "none" | "project-read" | "project-write" | "sandbox-only" | "external-write" | "system-write"
  process?: "none" | "short-lived" | "long-running"
  browserProfile?: "none" | "isolated-only" | "real-profile"
  browserAutomation?: boolean
  privateRepository?: boolean
  privateToken?: boolean
  highCostApi?: boolean
  unknownBinary?: boolean
  downloadsExecutable?: boolean
  executableCode?: boolean
  staticOnly?: boolean
  metadataOnly?: boolean
  modifiesDllAgentCore?: boolean
  modifiesGatesRoutingRecoveryPermissionProvider?: boolean
  modifiesFullAccessSemantics?: boolean
  destructive?: boolean
  remoteMutation?: boolean
  globalInstall?: boolean
  sudo?: boolean
  shellRcMutation?: boolean
  systemDirectoryMutation?: boolean
  productionMutation?: boolean
  persistentDaemon?: boolean
  rollbackPlan?: string | string[][]
  smokeTests?: string[]
  entry?: CapabilityEntry
  manifest?: CapabilityInstallManifest
}

const RISK_ORDER: CapabilityAcquisitionRiskLevel[] = ["R0", "R1", "R2", "R3", "R4"]

function commandText(commands: string[][] | undefined) {
  return (commands ?? []).map((cmd) => cmd.join(" ")).join("\n")
}

function hasCurlPipeShell(text: string) {
  return /(curl|wget)\b[^|\n]*(\||\s+sh\b|\s+bash\b)|\|\s*(sh|bash)\b/i.test(text)
}

function hasGlobalInstall(text: string) {
  return /\b(npm|pnpm|yarn)\b[^;\n]*(\s-g\b|--global)|\bpip3?\b[^;\n]*\sinstall\b(?![^;\n]*--target)|\bbrew\s+install\b/i.test(text)
}

function hasSudo(text: string) {
  return /\bsudo\b/i.test(text)
}

function hasDestructive(text: string) {
  return /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-fdx\b|\bdrop\s+database\b/i.test(text)
}

function hasRemoteMutation(text: string) {
  return /\bgit\s+push\b|\bgh\s+(pr|release)\s+(create|upload)\b|\bnpm\s+publish\b|\bdeploy\b|\brelease\b|\bupload\b/i.test(text)
}

function hasShellRcMutation(text: string) {
  return /\.(zshrc|bashrc|bash_profile|profile)\b|LaunchAgent|launchctl/i.test(text)
}

function hasSystemMutation(text: string) {
  return /\/usr\/|\/opt\/|\/Library\/|systemctl|launchctl/i.test(text)
}

function entrySignals(entry: CapabilityEntry | undefined): Partial<CapabilityRiskClassifierInput> {
  if (!entry) return {}
  return {
    kind: entry.kind === "model" || entry.kind === "lsp" || entry.kind === "multimodal" ? "software" : entry.kind,
    installCommands: entry.runtime?.start_command ? [entry.runtime.start_command] : undefined,
    smokeCommands: entry.verify_commands?.map((command) => command.split(/\s+/)),
    networkAccess: entry.security?.allow_network ? "public" : "none",
    process: entry.runtime?.heavy || entry.runtime?.start_policy === "always" ? "long-running" : "short-lived",
    privateToken: entry.requires_token,
    highCostApi: entry.cost_level === "high",
    downloadsExecutable: entry.requires_install && entry.install_strategy !== "none",
    executableCode: entry.kind === "mcp" || entry.kind === "software" || entry.kind === "tool",
    globalInstall: entry.install_strategy === "system_package_manager",
    persistentDaemon: entry.runtime?.start_policy === "always",
  }
}

function manifestSignals(manifest: CapabilityInstallManifest | undefined): Partial<CapabilityRiskClassifierInput> {
  if (!manifest) return {}
  return {
    kind: manifest.kind,
    sourceUrl: manifest.source.url,
    sourceTrust: manifest.source.verified ? "verified" : "unknown",
    installCommands: manifest.commands.install,
    smokeCommands: manifest.commands.smoke,
    startCommands: manifest.commands.start,
    stopCommands: manifest.commands.stop,
    networkAccess: manifest.permissions.network,
    filesystem: manifest.permissions.filesystem,
    process: manifest.permissions.process,
    browserProfile: manifest.permissions.browserProfile ?? "none",
    requiresSecrets: manifest.permissions.secrets !== "never",
    executableCode: manifest.commands.install.length > 0 || manifest.commands.start.length > 0,
    rollbackPlan: manifest.rollback.steps,
  }
}

function mergeSignals(input: CapabilityRiskClassifierInput): CapabilityRiskClassifierInput {
  return {
    ...entrySignals(input.entry),
    ...manifestSignals(input.manifest),
    ...input,
  }
}

function hasRollback(input: CapabilityRiskClassifierInput) {
  if (Array.isArray(input.rollbackPlan)) return input.rollbackPlan.length > 0
  return typeof input.rollbackPlan === "string" && input.rollbackPlan.trim().length > 0
}

export function classifyCapabilityRisk(raw: CapabilityRiskClassifierInput): CapabilityRiskAssessment {
  const input = mergeSignals(raw)
  const reasons: string[] = []
  let riskRank = 0
  const allCommands = [
    commandText(input.installCommands),
    commandText(input.smokeCommands),
    commandText(input.startCommands),
    commandText(input.stopCommands),
  ].filter(Boolean).join("\n")

  const raise = (level: CapabilityAcquisitionRiskLevel, reason: string) => {
    riskRank = Math.max(riskRank, RISK_ORDER.indexOf(level))
    reasons.push(reason)
  }

  if (input.metadataOnly) raise("R0", "metadata-only inspection")
  if (input.staticOnly) raise("R1", "static skill/schema/docs only")
  if (input.executableCode || input.downloadsExecutable) raise("R2", "downloads or installs executable capability content")
  if (input.kind === "mcp") raise("R2", "MCP package requires sandbox and smoke testing")
  if (input.networkAccess === "public") raise("R2", "public network access")
  if (input.filesystem === "project-write") raise("R2", "project write permission requested")

  if (input.browserAutomation) raise("R3", "browser automation requires user authorization")
  if (input.browserProfile === "isolated-only") raise("R3", "browser capability must remain isolated")
  if (input.networkAccess === "private") raise("R3", "private network or account access requested")
  if (input.process === "long-running" || input.persistentDaemon) raise("R3", "long-running process requested")
  if (input.privateRepository || input.privateToken) raise("R3", "private repository or token boundary")
  if (input.highCostApi) raise("R3", "high-cost API or provider usage")
  if (input.modifiesDllAgentCore || input.modifiesGatesRoutingRecoveryPermissionProvider) {
    raise("R3", "dll-agent core governance modification requires final-auditor review")
  }
  if (input.modifiesFullAccessSemantics) raise("R3", "Full Access semantics change requires user authorization")
  if (input.globalInstall || hasGlobalInstall(allCommands)) raise("R4", "global install or system package manager is blocked by default")
  if (input.sudo || hasSudo(allCommands)) raise("R4", "sudo is blocked by default")
  if (input.destructive || hasDestructive(allCommands)) raise("R4", "destructive command is blocked by default")
  if (input.remoteMutation || hasRemoteMutation(allCommands)) raise("R4", "remote publish/release/upload is blocked by default")
  if (input.shellRcMutation || hasShellRcMutation(allCommands)) raise("R4", "shell rc or LaunchAgent mutation is blocked by default")
  if (input.systemDirectoryMutation || hasSystemMutation(allCommands)) raise("R4", "system directory mutation is blocked by default")
  if (input.productionMutation) raise("R4", "production environment mutation is blocked by default")
  if (input.requiresSecrets || input.readsSecrets) raise("R4", "secret/cookie/token/SSH/keychain access is blocked by default")
  if (input.browserProfile === "real-profile") raise("R4", "real browser profile or cookie access is blocked by default")
  if (input.unknownBinary) raise("R4", "unknown binary execution is blocked by default")
  if (hasCurlPipeShell(allCommands)) raise("R4", "curl/wget pipe shell is blocked by default")

  const risk = RISK_ORDER[riskRank] ?? "R0"
  const rollbackRequired = risk === "R2" || risk === "R3" || risk === "R4"
  if (rollbackRequired && !hasRollback(input)) reasons.push("rollback plan required before installation or activation")

  const requiredSmokeTests = input.smokeTests ?? (input.smokeCommands ?? []).map((command) => command.join(" "))
  const hardBlocked = risk === "R4"
  const requiresFinalAuditor = risk === "R2" || risk === "R3" || risk === "R4"
  const requiresUserAuthorization = risk === "R3" || risk === "R4"
  const allowedAutomatically = (risk === "R0" || risk === "R1") || (risk === "R2" && hasRollback(input))

  return {
    riskLevel: risk,
    reasons: reasons.length ? [...new Set(reasons)] : ["no capability acquisition risk signals detected"],
    requiresFinalAuditor,
    requiresUserAuthorization,
    hardBlocked,
    allowedAutomatically: allowedAutomatically && !hardBlocked,
    requiredSandbox: risk === "R2" || risk === "R3",
    requiredSmokeTests,
    rollbackRequired,
  }
}

export * as CapabilityRiskClassifier from "./capability-risk-classifier"
