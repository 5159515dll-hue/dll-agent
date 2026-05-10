import crypto from "crypto"
import fs from "fs"
import path from "path"
import {
  type CapabilityInstallManifest,
  capabilityAcquisitionPaths,
  writeCapabilityEvidence,
} from "./capability-acquisition"
import { createQuarantineCandidate, quarantineCandidatePath } from "./capability-quarantine"
import { classifyCapabilityRisk } from "./capability-risk-classifier"
import { buildRollbackPlan, rollbackDryRun } from "./capability-rollback"

export interface StaticDownloadResult {
  candidate_id: string
  source_url: string
  redacted_url: string
  sha256: string
  byte_length: number
  content_kind: "manifest" | "skill" | "readme" | "schema" | "static_document"
  quarantine_path: string
  rollback_plan_id: string
  missing_checksum_warning: boolean
  external_live_download: boolean
}

export interface StaticDownloadInput {
  root: string
  url: string
  expectedSha256?: string
  maxBytes?: number
  candidateID?: string
  externalLiveDownload?: boolean
  sessionID?: string
}

const DEFAULT_MAX_BYTES = 256 * 1024
const TEXT_EXTENSIONS = [".md", ".json", ".jsonc", ".txt", ".yaml", ".yml"]
const EXECUTABLE_EXTENSIONS = [".sh", ".bash", ".zsh", ".exe", ".dmg", ".pkg", ".bin", ".node", ".so", ".dylib"]

function safeID(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)
}

export function redactCapabilityUrl(url: string) {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, "REDACTED")
    }
    if (parsed.hash) parsed.hash = parsed.hash.replace(/(token|key|password|auth|secret)=([^&]+)/gi, "$1=REDACTED")
    parsed.username = parsed.username ? "REDACTED" : ""
    parsed.password = parsed.password ? "REDACTED" : ""
    return parsed.toString()
  } catch {
    return "invalid-url"
  }
}

export function validateStaticDownloadUrl(url: string) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("capability download URL must be http(s)")
  if (parsed.username || parsed.password) throw new Error("capability download URL must not include credentials")
  const ext = path.extname(parsed.pathname).toLowerCase()
  if (EXECUTABLE_EXTENSIONS.includes(ext)) throw new Error("executable capability downloads are blocked in Phase B2")
  return parsed
}

function classifyContentKind(url: URL, contentType: string): StaticDownloadResult["content_kind"] {
  const base = path.basename(url.pathname).toLowerCase()
  if (base === "skill.md") return "skill"
  if (base.endsWith("manifest.json") || base.endsWith("manifest.jsonc")) return "manifest"
  if (base === "readme.md") return "readme"
  if (base.endsWith("schema.json")) return "schema"
  if (contentType.includes("json")) return "schema"
  return "static_document"
}

function assertStaticText(bytes: Uint8Array, url: URL, contentType: string) {
  const ext = path.extname(url.pathname).toLowerCase()
  if (EXECUTABLE_EXTENSIONS.includes(ext)) throw new Error("executable extension blocked")
  if (ext && !TEXT_EXTENSIONS.includes(ext)) throw new Error("unsupported static capability file extension")
  const header = Array.from(bytes.slice(0, 4))
  const binaryMagic =
    (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) ||
    (header[0] === 0x4d && header[1] === 0x5a) ||
    (header[0] === 0xcf && header[1] === 0xfa) ||
    (header[0] === 0xca && header[1] === 0xfe) ||
    (header[0] === 0x50 && header[1] === 0x4b)
  if (binaryMagic) throw new Error("binary capability download blocked")
  const normalizedType = contentType.toLowerCase()
  if (normalizedType && !/text|json|markdown|yaml|octet-stream/.test(normalizedType)) {
    throw new Error("unsupported capability content type")
  }
}

function buildStaticManifest(input: {
  id: string
  kind: StaticDownloadResult["content_kind"]
  url: string
  sha256: string
  verified: boolean
}): CapabilityInstallManifest {
  return {
    version: 1,
    id: input.id,
    kind: input.kind === "skill" ? "skill" : "software",
    displayName: input.id,
    description: `Static ${input.kind} downloaded into quarantine for inspection only.`,
    source: { type: "url", url: input.url, checksum: input.sha256, verified: input.verified },
    risk: { level: input.kind === "skill" ? "R1" : "R0", reasons: ["static text only"], requiresFinalAudit: false, requiresUserAuthorization: false },
    permissions: { filesystem: "none", network: "none", secrets: "never", process: "none", browserProfile: "none" },
    activation: { mode: "disabled", rolesAllowed: [], rolesDenied: ["commander", "final-auditor"] },
    commands: { install: [], smoke: [], start: [], stop: [] },
    rollback: { steps: [["delete-managed-quarantine-candidate"]], safe: true },
  }
}

export async function downloadStaticCapabilityToQuarantine(input: StaticDownloadInput): Promise<StaticDownloadResult> {
  const parsed = validateStaticDownloadUrl(input.url)
  const response = await fetch(parsed)
  if (!response.ok) throw new Error(`capability static download failed: ${response.status}`)
  const contentLength = Number(response.headers.get("content-length") ?? "0")
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  if (contentLength > maxBytes) throw new Error("capability static download exceeds max size")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error("capability static download exceeds max size")
  const contentType = response.headers.get("content-type") ?? ""
  assertStaticText(bytes, parsed, contentType)
  const content = Buffer.from(bytes).toString("utf8")
  const sha256 = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`
  if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new Error("capability static download checksum mismatch")
  const contentKind = classifyContentKind(parsed, contentType)
  const candidateID = safeID(input.candidateID ?? `${contentKind}-${path.basename(parsed.pathname) || "download"}`)
  const risk = classifyCapabilityRisk({
    staticOnly: true,
    metadataOnly: contentKind !== "skill",
    sourceUrl: input.url,
    rollbackPlan: "delete managed quarantine candidate",
  })
  if (risk.riskLevel !== "R0" && risk.riskLevel !== "R1") throw new Error(`static download classified too risky: ${risk.riskLevel}`)
  const manifest = buildStaticManifest({
    id: candidateID,
    kind: contentKind,
    url: redactCapabilityUrl(input.url),
    sha256,
    verified: Boolean(input.expectedSha256),
  })
  createQuarantineCandidate({ root: input.root, manifest, candidateID, sessionID: input.sessionID })
  const quarantinePath = quarantineCandidatePath(input.root, candidateID)
  const filename = contentKind === "skill" ? "SKILL.md" : path.basename(parsed.pathname) || "download.txt"
  fs.writeFileSync(path.join(quarantinePath, filename), content, { mode: 0o600 })
  const plan = buildRollbackPlan({ root: input.root, candidateID, managedPaths: [quarantinePath], sessionID: input.sessionID })
  rollbackDryRun({ root: input.root, plan, sessionID: input.sessionID })
  writeCapabilityEvidence(
    "capability.downloaded",
    {
      candidate_id: candidateID,
      url: redactCapabilityUrl(input.url),
      sha256,
      bytes: bytes.byteLength,
      content_kind: contentKind,
      external_live_download: input.externalLiveDownload === true,
      activated: false,
    },
    input.sessionID,
  )
  return {
    candidate_id: candidateID,
    source_url: input.url,
    redacted_url: redactCapabilityUrl(input.url),
    sha256,
    byte_length: bytes.byteLength,
    content_kind: contentKind,
    quarantine_path: quarantinePath,
    rollback_plan_id: plan.plan_id,
    missing_checksum_warning: !input.expectedSha256,
    external_live_download: input.externalLiveDownload === true,
  }
}

export * as CapabilityDownload from "./capability-download"
