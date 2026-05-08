/**
 * Validates and redacts generated audit reports before they are used as
 * completion evidence. Reports are task artifacts, not source files, so
 * automatic redaction is allowed for known generated report locations.
 */

import fs from "fs"
import path from "path"

export type ReportIssueSeverity = "block" | "warn"
export type ReportIssueType =
  | "secret_leak"
  | "metric_contradiction"
  | "metric_mismatch"
  | "coverage_gap"
  | "missing_metrics"

export interface ReportValidationIssue {
  severity: ReportIssueSeverity
  type: ReportIssueType
  message: string
}

export interface ReportValidationResult {
  issues: ReportValidationIssue[]
  blockers: string[]
  warnings: string[]
  redaction_needed: boolean
}

export interface ReportRedactionResult {
  changed: boolean
  redacted_content: string
  findings: string[]
}

const SENSITIVE_HEADER = /^(password|passwd|pwd|token|api[_ -]?key|secret|cookie|authorization|密码|口令|令牌)$/i
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /\beyJ[A-Za-z0-9._-]{20,}\b/g,
  /\badmin123\b/gi,
]

function metric(content: string, label: string): number | undefined {
  const re = new RegExp(`\\|\\s*(?:[✅❌⚠️🐛📸🔴🟠🟡🟢 ]*)?${label}\\s*\\|\\s*(\\d+)\\s*\\|`, "i")
  const found = content.match(re)
  return found ? Number(found[1]) : undefined
}

function containsSensitive(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(content)
  }) || /(?:password|passwd|pwd|密码|口令)\s*[:=]\s*[^,\s|]+/i.test(content)
}

function redactScalar(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, "REDACTED")
  }
  result = result.replace(/((?:password|passwd|pwd|密码|口令)\s*[:=]\s*)[^,\s|]+/gi, "$1REDACTED")
  return result
}

export function redactReportContent(content: string): ReportRedactionResult {
  const findings: string[] = []
  const lines = content.split(/\r?\n/)
  let currentSensitiveColumns: number[] = []
  const redacted = lines.map((line) => {
    const scalarRedacted = redactScalar(line)
    let nextLine = scalarRedacted
    if (/^\s*\|.*\|\s*$/.test(scalarRedacted)) {
      const cells = scalarRedacted.split("|")
      const normalized = cells.map((cell) => cell.trim())
      const sensitiveColumns = normalized
        .map((cell, index) => SENSITIVE_HEADER.test(cell) ? index : -1)
        .filter((index) => index >= 0)
      if (sensitiveColumns.length > 0) {
        currentSensitiveColumns = sensitiveColumns
        findings.push(`redacted sensitive markdown table column(s): ${sensitiveColumns.join(",")}`)
      } else if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(scalarRedacted)) {
        // Separator line; keep the current header mapping for data rows.
      } else if (currentSensitiveColumns.length > 0) {
        for (const index of currentSensitiveColumns) {
          if (index > 0 && index < cells.length - 1 && cells[index].trim()) {
            cells[index] = " REDACTED "
          }
        }
        nextLine = cells.join("|")
      }
    } else {
      currentSensitiveColumns = []
    }
    if (nextLine !== line && !findings.includes("redacted inline secret-like value(s)")) {
      findings.push("redacted inline secret-like value(s)")
    }
    return nextLine
  })
  const redactedContent = redacted.join("\n")
  return {
    changed: redactedContent !== content,
    redacted_content: redactedContent,
    findings: [...new Set(findings)],
  }
}

export function validateAuditReportContent(content: string): ReportValidationResult {
  const issues: ReportValidationIssue[] = []
  const total = metric(content, "Total Tests")
  const pass = metric(content, "PASS")
  const fail = metric(content, "FAIL")
  const warn = metric(content, "WARN")
  const saysNoBlocking = /No blocking issues found|无阻断问题|没有阻断/i.test(content)
  const hasCoverageGap = /(未覆盖|未完成|未验证|待补充|后续补充|remaining|not covered|not verified|coverage gap)/i.test(content)

  if (containsSensitive(content)) {
    issues.push({
      severity: "block",
      type: "secret_leak",
      message: "audit report contains secret-like or password-like content",
    })
  }

  if (total === undefined && pass === undefined && fail === undefined && warn === undefined) {
    issues.push({
      severity: "warn",
      type: "missing_metrics",
      message: "audit report does not expose Total/PASS/FAIL/WARN metrics",
    })
  }

  if (total !== undefined && pass !== undefined && fail !== undefined && warn !== undefined && total !== pass + fail + warn) {
    issues.push({
      severity: "block",
      type: "metric_mismatch",
      message: `audit report metrics mismatch: total=${total}, pass+fail+warn=${pass + fail + warn}`,
    })
  }

  if (saysNoBlocking && (fail ?? 0) > 0) {
    issues.push({
      severity: "block",
      type: "metric_contradiction",
      message: `audit report says no blocking issues but reports ${fail} FAIL result(s)`,
    })
  }

  if (hasCoverageGap) {
    issues.push({
      severity: "block",
      type: "coverage_gap",
      message: "audit report contains uncovered, unfinished, or unverified scope",
    })
  }

  return {
    issues,
    blockers: issues.filter((issue) => issue.severity === "block").map((issue) => issue.message),
    warnings: issues.filter((issue) => issue.severity === "warn").map((issue) => issue.message),
    redaction_needed: issues.some((issue) => issue.type === "secret_leak"),
  }
}

export function redactAuditReportFile(filePath: string): ReportRedactionResult {
  try {
    const content = fs.readFileSync(filePath, "utf8")
    const redaction = redactReportContent(content)
    if (redaction.changed) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, redaction.redacted_content)
    }
    return redaction
  } catch {
    return { changed: false, redacted_content: "", findings: [] }
  }
}
