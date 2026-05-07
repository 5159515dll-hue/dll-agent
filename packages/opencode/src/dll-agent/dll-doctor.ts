/**
 * dll-agent dll-doctor.ts
 *
 * Comprehensive doctor/healthcheck for all dll-agent components.
 * Outputs graded reports: PASS / WARN / FAIL with NEXT ACTION suggestions.
 *
 * Checks:
 * 1. Risk-based permission policy
 * 2. LSP prewarm strategy
 * 3. Cross-review council
 * 4. Evidence file health (rotation, size, count)
 * 5. Supervisor state
 * 6. Multi-model handoff
 */

import { classifyCommand, classifyFileOp } from "./permission-classifier"
import { lspDoctorCheck } from "./lsp-bridge"
import { getStorageStats } from "./evidence-rotation"
import { checkEvidenceGate, checkReconciliationGate, finalGate } from "./gates"
import type { RiskLevel } from "./interfaces"
import { write as writeEvidence } from "./evidence"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

// ─── Doctor Result Types ────────────────────────────────────────────────────

export type DoctorSeverity = "PASS" | "WARN" | "FAIL"

export interface DoctorCheck {
  name: string
  severity: DoctorSeverity
  message: string
  nextAction: string | null
  evidence: string | null
}

export interface DoctorReport {
  timestamp: string
  overall: DoctorSeverity
  checks: DoctorCheck[]
  passCount: number
  warnCount: number
  failCount: number
}

// ─── Check Functions ────────────────────────────────────────────────────────

function checkPermissionPolicy(): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  // Test classification of common commands
  const testCases = [
    { command: "bun typecheck", expectedRisk: "low" as RiskLevel },
    { command: "bun test test/dll-agent/", expectedRisk: "low" as RiskLevel },
    { command: "git status", expectedRisk: "low" as RiskLevel },
    { command: "rm -rf /tmp/test", expectedRisk: "high" as RiskLevel },
    { command: "git push origin main", expectedRisk: "high" as RiskLevel },
    { command: "sudo systemctl restart nginx", expectedRisk: "high" as RiskLevel },
    { command: "cat .env", expectedRisk: "high" as RiskLevel },
  ]

  let mismatches = 0
  for (const tc of testCases) {
    const result = classifyCommand({ command: tc.command })
    if (result.risk !== tc.expectedRisk) {
      mismatches++
    }
  }

  if (mismatches === 0) {
    checks.push({
      name: "permission-classifier",
      severity: "PASS",
      message: `Risk classification validates correctly (${testCases.length} test cases, ${mismatches} mismatches)`,
      nextAction: null,
      evidence: "classifier smoke test passed",
    })
  } else {
    checks.push({
      name: "permission-classifier",
      severity: "WARN",
      message: `${mismatches}/${testCases.length} classification mismatches detected`,
      nextAction: "Review permission-classifier test suite output",
      evidence: null,
    })
  }

  // Check secret path detection
  const secretCheck = classifyFileOp({ path: ".env", operation: "read" })
  checks.push({
    name: "permission-secrets-detection",
    severity: secretCheck.secretRisk ? "PASS" : "FAIL",
    message: secretCheck.secretRisk
      ? "Secret file patterns detected correctly"
      : "Secret file detection may not be working",
    nextAction: secretCheck.secretRisk ? null : "Run permission-classifier tests to debug",
    evidence: null,
  })

  return checks
}

function checkLspStrategy(projectRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const result = lspDoctorCheck(projectRoot)

  checks.push({
    name: "lsp-main-language",
    severity: result.mainLanguage !== "unknown" ? "PASS" : "WARN",
    message: result.mainLanguage !== "unknown"
      ? `Main language detected: ${result.mainLanguage}`
      : "No main language detected — LSP prewarm will be skipped",
    nextAction: result.mainLanguage === "unknown"
      ? "Ensure project has standard config files (package.json, tsconfig.json, go.mod, etc.)"
      : null,
    evidence: null,
  })

  checks.push({
    name: "lsp-mode",
    severity: result.mode === "project-main" ? "PASS" : "WARN",
    message: `LSP prewarm mode: ${result.mode}`,
    nextAction: result.mode === "all-detected"
      ? "Consider switching to project-main mode for better performance"
      : null,
    evidence: null,
  })

  for (const warning of result.warnings) {
    checks.push({
      name: "lsp-warning",
      severity: "WARN",
      message: warning,
      nextAction: "Review LSP configuration",
      evidence: null,
    })
  }

  return checks
}

function checkEvidenceHealth(): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const stats = getStorageStats()

  if (stats.sessionCount > 90) {
    checks.push({
      name: "evidence-session-count",
      severity: "WARN",
      message: `${stats.sessionCount} session directories (max 100) — nearing limit`,
      nextAction: "Run evidence rotation to clean old sessions",
      evidence: `${stats.sessionsDir} (${stats.totalEvidenceFiles} files, ${(stats.totalSizeBytes / 1024).toFixed(1)} KB)`,
    })
  } else {
    checks.push({
      name: "evidence-session-count",
      severity: "PASS",
      message: `${stats.sessionCount} session directories (under 100 limit)`,
      nextAction: null,
      evidence: `${(stats.totalSizeBytes / 1024).toFixed(1)} KB total`,
    })
  }

  if (stats.totalEvidenceFiles > 500) {
    checks.push({
      name: "evidence-file-count",
      severity: "WARN",
      message: `${stats.totalEvidenceFiles} evidence files — consider rotation`,
      nextAction: "Run evidence rotation to clean old files",
      evidence: null,
    })
  }

  if (stats.needsRotation) {
    checks.push({
      name: "evidence-rotation-needed",
      severity: "WARN",
      message: "Evidence rotation recommended (session count or file count high)",
      nextAction: "Run: evidence rotation script or dll-agent doctor --rotate",
      evidence: null,
    })
  }

  return checks
}

function checkMultiModelHandoff(): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  // Check that gate detection works structurally
  const gateResult = checkEvidenceGate({
    assistantText: "I have completed the task. Tests pass.",
    isCompletionClaim: true,
    hasVerificationEvidence: false,
    risk: "high",
    allReviewsCompleted: true,
    hasUnresolvedConflict: false,
    costExceeded: false,
  })

  if (gateResult.passed === false && gateResult.block_reason) {
    checks.push({
      name: "evidence-gate",
      severity: "PASS",
      message: `Evidence gate correctly blocks high-risk unverified completion claims`,
      nextAction: null,
      evidence: `block_reason: ${gateResult.block_reason}`,
    })
  } else {
    checks.push({
      name: "evidence-gate",
      severity: "FAIL",
      message: "Evidence gate did not block an unverified high-risk completion claim",
      nextAction: "Check checkEvidenceGate logic in gates.ts",
      evidence: null,
    })
  }

  // Check reconciliation gate
  const reconResult = checkReconciliationGate({
    isCompletionClaim: true,
    assistantText: "Task completed.",
    state: {
      version: 1,
      phase: "test",
      risk: "medium",
      required_reviews: [],
      completed_reviews: ["requirements-inspector", "chief-engineer"],
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 0,
        context_tokens: 0,
        final_claim: true,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    },
  })

  checks.push({
    name: "reconciliation-gate",
    severity: reconResult.passed ? "WARN" : "PASS",
    message: reconResult.passed
      ? "Reconciliation gate passed — but completion without reviewer absorption passes (intentional: soft-gate)"
      : "Reconciliation gate correctly detects missing reviewer absorption",
    nextAction: null,
    evidence: reconResult.block_reason,
  })

  // Check final gate synthesis
  const finalResult = finalGate({
    evidenceGate: gateResult,
    supervisorState: {
      version: 1,
      phase: "test",
      risk: "low",
      required_reviews: [],
      completed_reviews: [],
      blocked_completion: false,
      block_reason: null,
      reviewer_conflict: false,
      metrics: {
        tool_failures: 0,
        permission_denied: 0,
        user_corrections: 0,
        context_percent: 0,
        context_tokens: 0,
        final_claim: false,
        verification_evidence: false,
        reviewer_conflict_signal: false,
        repeated_tool_failure: false,
        real_tool_evidence: false,
      },
      updated_at: new Date().toISOString(),
    },
    reconciliationConflicts: [],
    costExceeded: false,
  })

  checks.push({
    name: "final-gate",
    severity: finalResult.allowed ? "PASS" : "FAIL",
    message: finalResult.allowed
      ? "Final gate allows normal completions"
      : `Final gate blocked: ${finalResult.reasons.join("; ")}`,
    nextAction: null,
    evidence: null,
  })

  return checks
}

// ─── Resource Health Checks ─────────────────────────────────────────────────

function checkResourceHealth(): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  // Check for dangling bun/opencode background processes
  try {
    const ps = execSync("ps aux 2>/dev/null | grep -E '(bun|opencode)' | grep -v grep | wc -l", {
      encoding: "utf8",
      timeout: 2_000,
    }).trim()
    const count = parseInt(ps, 10)
    if (count > 5) {
      checks.push({
        name: "background-processes",
        severity: "WARN",
        message: `${count} bun/opencode background processes found — may indicate stale or leaked processes`,
        nextAction: "Run: ps aux | grep -E '(bun|opencode)' and investigate stale processes",
        evidence: `count=${count}`,
      })
    } else {
      checks.push({
        name: "background-processes",
        severity: "PASS",
        message: `${count} bun/opencode background process(es) — within normal range`,
        nextAction: null,
        evidence: `count=${count}`,
      })
    }
  } catch {
    checks.push({
      name: "background-processes",
      severity: "WARN",
      message: "Could not check background processes (ps not available)",
      nextAction: "Manually check process count",
      evidence: null,
    })
  }

  // Check for stale reviewer loops: supervisor cooldown files with excessive call counts
  try {
    const sessionsDir = path.join(os.homedir(), ".dll-agent", "sessions")
    if (fs.existsSync(sessionsDir)) {
      let staleCount = 0
      let maxCallCount = 0
      const sessions = fs.readdirSync(sessionsDir)
      for (const sid of sessions) {
        const cdFile = path.join(sessionsDir, sid, "cooldown.json")
        try {
          if (fs.existsSync(cdFile)) {
            const cd = JSON.parse(fs.readFileSync(cdFile, "utf8"))
            const total = Object.values(cd.call_count ?? {}).reduce((s: number, c) => s + (c as number), 0)
            if (total > 10) staleCount++
            if (total > maxCallCount) maxCallCount = total as number
          }
        } catch { /* skip corrupted */ }
      }
      if (staleCount > 0) {
        checks.push({
          name: "stale-reviewer-loops",
          severity: "WARN",
          message: `${staleCount} session(s) have high reviewer call counts (max ${maxCallCount}) — possible stale reviewer loop`,
          nextAction: "Investigate sessions with excessive reviewer calls, consider clearing cooldown files",
          evidence: `stale_sessions=${staleCount}, max_calls=${maxCallCount}`,
        })
      } else {
        checks.push({
          name: "stale-reviewer-loops",
          severity: "PASS",
          message: "No sessions with excessive reviewer call counts detected",
          nextAction: null,
          evidence: null,
        })
      }
    }
  } catch {
    checks.push({
      name: "stale-reviewer-loops",
      severity: "WARN",
      message: "Could not scan cooldown files for stale loops",
      nextAction: "Check ~/.dll-agent/sessions/*/cooldown.json manually",
      evidence: null,
    })
  }

  // Check evidence file count and size (rotation health)
  try {
    const evidenceDir = path.join(os.homedir(), ".dll-agent", "evidence")
    if (fs.existsSync(evidenceDir)) {
      const files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".json"))
      if (files.length > 200) {
        checks.push({
          name: "evidence-bloat",
          severity: "WARN",
          message: `${files.length} evidence files — consider running evidence rotation`,
          nextAction: "Run dll-agent evidence rotation or clean ~/.dll-agent/evidence/",
          evidence: `file_count=${files.length}`,
        })
      }
    }
  } catch {
    // optional check
  }

  // Check for excessive watchers / file descriptors (macOS)
  try {
    const pid = process.pid.toString()
    const lsof = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, {
      encoding: "utf8",
      timeout: 3_000,
    }).trim()
    const fdCount = parseInt(lsof, 10)
    if (fdCount > 500) {
      checks.push({
        name: "file-descriptors",
        severity: "WARN",
        message: `${fdCount} open file descriptors — may indicate watcher leak or unclosed files`,
        nextAction: `Run: lsof -p ${pid} to inspect open files, check watcher cleanup`,
        evidence: `fd_count=${fdCount}`,
      })
    }
  } catch {
    // lsof may not be available
  }

  return checks
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a full dll-agent doctor check.
 */
export function runDoctor(projectRoot?: string): DoctorReport {
  const root = projectRoot ?? process.cwd()
  const allChecks: DoctorCheck[] = []

  // Permission checks
  allChecks.push(...checkPermissionPolicy())

  // LSP checks
  allChecks.push(...checkLspStrategy(root))

  // Evidence health
  allChecks.push(...checkEvidenceHealth())

  // Multi-model handoff checks
  allChecks.push(...checkMultiModelHandoff())

  // Resource health checks
  allChecks.push(...checkResourceHealth())

  const passCount = allChecks.filter((c) => c.severity === "PASS").length
  const warnCount = allChecks.filter((c) => c.severity === "WARN").length
  const failCount = allChecks.filter((c) => c.severity === "FAIL").length

  const overall: DoctorSeverity = failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS"

  const report: DoctorReport = {
    timestamp: new Date().toISOString(),
    overall,
    checks: allChecks,
    passCount,
    warnCount,
    failCount,
  }

  writeEvidence("doctor.run", { overall, passCount, warnCount, failCount })

  return report
}

/**
 * Format a doctor report for display (compact).
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `[dll-agent doctor] ${report.overall} (${report.passCount}P ${report.warnCount}W ${report.failCount}F)`,
    ``,
  ]

  for (const check of report.checks) {
    const icon = check.severity === "PASS" ? "✅" : check.severity === "WARN" ? "⚠️" : "❌"
    lines.push(`${icon} ${check.name}: ${check.message}`)
    if (check.nextAction) {
      lines.push(`   NEXT ACTION: ${check.nextAction}`)
    }
  }

  return lines.join("\n")
}
