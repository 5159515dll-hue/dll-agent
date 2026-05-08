/**
 * Classifies task artifacts so gates can distinguish audit/test outputs from
 * business source edits. This is intentionally lightweight and bounded: it
 * only inspects known artifact locations and report summaries.
 */

import fs from "fs"
import path from "path"
import {
  redactAuditReportFile,
  validateAuditReportContent,
  type ReportValidationIssue,
} from "./report-validator"

export type ArtifactKind =
  | "audit_report"
  | "screenshot"
  | "generated_script"
  | "command_log"
  | "business_source_change"
  | "other"

export interface ArtifactRecord {
  path: string
  kind: ArtifactKind
  purpose: string
  produced_by: "tool" | "model" | "user"
  verified_exists: boolean
  stale: boolean
}

export interface AuditReportMetrics {
  total?: number
  pass?: number
  fail?: number
  warn?: number
  saysNoBlockingIssues: boolean
  coverageGap: boolean
  redactionApplied: boolean
  validationIssues: ReportValidationIssue[]
}

export interface ArtifactLedgerSnapshot {
  projectDir: string
  artifacts: ArtifactRecord[]
  auditReports: { path: string; metrics: AuditReportMetrics }[]
  screenshotCount: number
  hasAuditEvidence: boolean
  failCount: number
  warnCount: number
  contradictions: string[]
  blockers: string[]
  redactionApplied: boolean
}

const ARTIFACT_DIRS = ["files", "test-screenshots", "output", ".playwright-mcp"]
const MAX_FILES_PER_DIR = 200

function rel(projectDir: string, filePath: string) {
  return path.relative(projectDir, filePath) || filePath
}

export function classifyArtifactPath(filePath: string): ArtifactKind {
  const normalized = filePath.replace(/\\/g, "/")
  const base = path.basename(normalized).toLowerCase()
  if (/full.*audit.*report|audit.*report|browser.*flow.*report/.test(base) && base.endsWith(".md")) return "audit_report"
  if (/\.(png|jpg|jpeg|webp)$/.test(base) && /screenshot|test-screenshots|playwright|audit/i.test(normalized)) return "screenshot"
  if (/audit.*browser|browser.*audit|playwright.*audit/.test(base) && /\.(mjs|js|ts)$/.test(base)) return "generated_script"
  if (/\.(log|trace|har)$/.test(base)) return "command_log"
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|vue|svelte)$/.test(base)) return "business_source_change"
  return "other"
}

export function parseAuditReportMetrics(content: string): AuditReportMetrics {
  const metric = (label: string) => {
    const re = new RegExp(`\\|\\s*(?:[✅❌⚠️🐛📸🔴🟠🟡🟢 ]*)?${label}\\s*\\|\\s*(\\d+)\\s*\\|`, "i")
    const found = content.match(re)
    return found ? Number(found[1]) : undefined
  }
  return {
    total: metric("Total Tests"),
    pass: metric("PASS"),
    fail: metric("FAIL"),
    warn: metric("WARN"),
    saysNoBlockingIssues: /No blocking issues found|无阻断问题|没有阻断/i.test(content),
    coverageGap: /(未覆盖|未完成|未验证|待补充|后续补充|remaining|not covered|not verified|coverage gap)/i.test(content),
    redactionApplied: false,
    validationIssues: validateAuditReportContent(content).issues,
  }
}

function walkBounded(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir).slice(0, MAX_FILES_PER_DIR)
  for (const entry of entries) {
    const full = path.join(dir, entry)
    try {
      const stat = fs.statSync(full)
      if (stat.isDirectory()) continue
      out.push(full)
    } catch {
      // Ignore transient files.
    }
  }
}

export function scanArtifactLedger(projectDir: string): ArtifactLedgerSnapshot {
  const files: string[] = []
  for (const dir of ARTIFACT_DIRS) walkBounded(path.join(projectDir, dir), files)

  for (const entry of ["audit-full-browser.mjs", "browser-test.mjs"]) {
    const full = path.join(projectDir, entry)
    if (fs.existsSync(full)) files.push(full)
  }

  const artifacts: ArtifactRecord[] = files.map((file) => {
    const kind = classifyArtifactPath(file)
    return {
      path: rel(projectDir, file),
      kind,
      purpose:
        kind === "audit_report" ? "task audit report" :
        kind === "screenshot" ? "browser evidence screenshot" :
        kind === "generated_script" ? "task-specific audit/test runner" :
        kind === "command_log" ? "tool execution log" :
        kind === "business_source_change" ? "business source change" :
        "task artifact",
      produced_by: "tool",
      verified_exists: true,
      stale: false,
    }
  })

  const auditReports = artifacts
    .filter((artifact) => artifact.kind === "audit_report")
    .map((artifact) => {
      const full = path.join(projectDir, artifact.path)
      const redaction = fs.existsSync(full) ? redactAuditReportFile(full) : { changed: false }
      const content = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : ""
      const metrics = parseAuditReportMetrics(content)
      metrics.redactionApplied = Boolean(redaction.changed)
      return { path: artifact.path, metrics }
    })

  const failCount = auditReports.reduce((sum, report) => sum + (report.metrics.fail ?? 0), 0)
  const warnCount = auditReports.reduce((sum, report) => sum + (report.metrics.warn ?? 0), 0)
  const screenshotCount = artifacts.filter((artifact) => artifact.kind === "screenshot").length
  const contradictions = auditReports
    .filter((report) => report.metrics.saysNoBlockingIssues && (report.metrics.fail ?? 0) > 0)
    .map((report) => `${report.path}: says no blocking issues but reports ${report.metrics.fail} FAIL`)
  const blockers = [
    ...contradictions,
    ...auditReports.flatMap((report) =>
      report.metrics.validationIssues
        .filter((issue) => issue.severity === "block")
        .map((issue) => `${report.path}: ${issue.message}`),
    ),
  ]
  const redactionApplied = auditReports.some((report) => report.metrics.redactionApplied)

  return {
    projectDir,
    artifacts,
    auditReports,
    screenshotCount,
    hasAuditEvidence: auditReports.length > 0 && screenshotCount > 0,
    failCount,
    warnCount,
    contradictions,
    blockers: [...new Set(blockers)],
    redactionApplied,
  }
}
