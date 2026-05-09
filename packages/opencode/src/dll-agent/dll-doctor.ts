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
import { checkContinuationGate } from "./continuation-gate"
import { CAPABILITY_ORCHESTRATOR_VERSION } from "./capability-orchestrator"
import { scanArtifactLedger } from "./artifact-ledger"
import { buildEvidenceSnapshot } from "./evidence-normalizer"
import { evaluateCompletionReadiness } from "./completion-readiness"
import { doctorCheck as roleModelDoctorCheck } from "./role-model-registry"
import { doctorCheckRoleToolPolicy } from "./role-tool-policy"
import { doctorCheckGoalContracts } from "./goal-contract"
import { buildTaskObservabilityReport } from "./task-observability"
import { evaluateRealWorldScenarioSuite } from "./scenario-evaluation"
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

function checkRoleToolPolicy(): DoctorCheck[] {
  const result = doctorCheckRoleToolPolicy()
  return [{
    name: "role-tool-policy",
    severity: result.ok ? "PASS" : "FAIL",
    message: result.ok
      ? "Role tool policies validate correctly: writable roles can write, reviewers are read-only, high-risk tools require confirmation"
      : `Role tool policy issues detected: ${result.issues.join("; ")}`,
    nextAction: result.ok ? null : "Review role-tool-policy.ts and agent permission wiring",
    evidence: result.ok ? "role-tool-policy smoke test passed" : result.issues.join("; "),
  }]
}

function checkGoalContractHealth(): DoctorCheck[] {
  const result = doctorCheckGoalContracts()
  return [{
    name: "goal-contract",
    severity: result.ok ? "PASS" : "FAIL",
    message: result.ok
      ? `Goal Contract storage validates correctly (${result.checked} contract(s) checked)`
      : `Goal Contract issues detected: ${result.issues.slice(0, 3).join("; ")}`,
    nextAction: result.ok ? null : "Repair or remove corrupted ~/.dll-agent/sessions/*/goal-contract.json files",
    evidence: result.ok ? "goal-contract doctor check passed" : result.issues.join("; "),
  }]
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
      nextAction: "Run: dll-agent doctor --repair-safe",
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
      nextAction: "Run: dll-agent doctor --repair-safe",
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

  // Continuation gate check: does it detect blocking unfinished items?
  const contState = {
    version: 1 as const, phase: "test", risk: "medium" as const,
    required_reviews: [], completed_reviews: [],
    blocked_completion: false, block_reason: null, reviewer_conflict: false,
    metrics: { tool_failures: 0, permission_denied: 0, user_corrections: 0,
      context_percent: 0, context_tokens: 0, final_claim: true,
      verification_evidence: false, reviewer_conflict_signal: false,
      repeated_tool_failure: false, real_tool_evidence: false },
    updated_at: new Date().toISOString(),
  }
  const contResult = checkContinuationGate({
    assistantText: "Task complete. 未完成: key bridge not wired.",
    isCompletionClaim: true,
    state: contState,
    sessionID: "doctor-check",
  })
  checks.push({
    name: "continuation-gate",
    severity: !contResult.passed ? "PASS" :
      contResult.has_non_blocking ? "WARN" : "FAIL",
    message: !contResult.passed
      ? "Continuation gate correctly blocks completion with unfinished items"
      : contResult.has_non_blocking
      ? "Continuation gate detects non-blocking unfinished items"
      : "Continuation gate did NOT detect unfinished items — may indicate detection gap",
    nextAction: contResult.passed && !contResult.has_non_blocking
      ? "Review UNFINISHED_INDICATOR_PATTERNS in continuation-gate.ts"
      : null,
    evidence: contResult.block_reason,
  })

  return checks
}

function checkArtifactEvidence(projectRoot?: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  if (!projectRoot) {
    checks.push({
      name: "artifact-ledger",
      severity: "WARN",
      message: "Project root unavailable; artifact ledger check skipped",
      nextAction: "Run doctor from a project directory",
      evidence: null,
    })
    return checks
  }

  try {
    const artifactSnapshot = scanArtifactLedger(projectRoot)
    const evidenceSnapshot = buildEvidenceSnapshot({ projectDir: projectRoot })
    const readiness = evaluateCompletionReadiness({ snapshot: evidenceSnapshot })
    const blockers = [...new Set([...artifactSnapshot.blockers, ...evidenceSnapshot.blockers])]
    checks.push({
      name: "artifact-ledger",
      severity: blockers.length > 0 ? "WARN" : "PASS",
      message: artifactSnapshot.artifacts.length > 0
        ? `Artifact ledger found ${artifactSnapshot.artifacts.length} artifact(s), ${artifactSnapshot.screenshotCount} screenshot(s), ${artifactSnapshot.auditReports.length} audit report(s), readiness=${readiness.status}`
        : "No task artifacts detected in common artifact locations",
      nextAction: blockers.length > 0
        ? "Resolve report blockers: redact secrets, fix FAILs, remove contradictory completion claims, or disclose PARTIAL/BLOCKED"
        : null,
      evidence: blockers.join("; ") || `completion_readiness=${readiness.status}`,
    })
  } catch (error) {
    checks.push({
      name: "artifact-ledger",
      severity: "WARN",
      message: "Could not inspect task artifacts",
      nextAction: "Check files/, test-screenshots/, output/, and .playwright-mcp manually",
      evidence: String(error),
    })
  }
  return checks
}

// ─── Resource Health Checks ─────────────────────────────────────────────────

function checkResourceHealth(): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  // Check for dangling bun/opencode background processes
  try {
    const psOutput = execSync("ps -axo pid,%cpu,command 2>/dev/null", {
      encoding: "utf8",
      timeout: 2_000,
    })
    const processLines = psOutput
      .split("\n")
      .slice(1)
      .filter((line) => /\b(bun|opencode)\b/.test(line))
      .filter((line) => !/dll-agent doctor|rg -i|grep/.test(line))
    const count = processLines.length
    const hot = processLines
      .map((line) => line.trim().match(/^(\d+)\s+([0-9.]+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .filter((match) => Number(match[2]) >= 20)
      .map((match) => `${match[1]}:${match[2]}%`)
    if (count > 5) {
      checks.push({
        name: "background-processes",
        severity: "WARN",
        message: `${count} bun/opencode background processes found — may indicate stale or leaked processes`,
        nextAction: "Run: ps -axo pid,%cpu,command | grep -E 'bun|opencode'; kill only stale session PIDs",
        evidence: `count=${count}${hot.length ? `, hot=${hot.join(",")}` : ""}`,
      })
    } else if (hot.length > 0) {
      checks.push({
        name: "background-processes",
        severity: "WARN",
        message: `High-CPU bun/opencode process detected (${hot.join(", ")})`,
        nextAction: `Inspect the matching session; if stale, run: kill ${hot.map((item) => item.split(":")[0]).join(" ")}`,
        evidence: `count=${count}, hot=${hot.join(",")}`,
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

  // Check for Playwright MCP processes that outlive a session.
  try {
    const psOutput = execSync("ps -axo pid,ppid,%cpu,etime,command 2>/dev/null | grep 'playwright-mcp' | grep -v grep", {
      encoding: "utf8",
      timeout: 2_000,
    }).trim()
    const lines = psOutput ? psOutput.split("\n").map((line) => line.trim()).filter(Boolean) : []
    const pids = lines
      .map((line) => line.match(/^(\d+)\s+/)?.[1])
      .filter(Boolean)
    if (pids.length > 0) {
      checks.push({
        name: "playwright-mcp-processes",
        severity: "WARN",
        message: `${pids.length} playwright-mcp process(es) are running; verify they belong to active sessions`,
        nextAction: `If stale, run dll-agent doctor --repair-safe or manually kill after verifying inactive: kill ${pids.join(" ")}`,
        evidence: `pids=${pids.join(",")}`,
      })
    } else {
      checks.push({
        name: "playwright-mcp-processes",
        severity: "PASS",
        message: "No playwright-mcp residual processes detected",
        nextAction: null,
        evidence: null,
      })
    }
  } catch {
    checks.push({
      name: "playwright-mcp-processes",
      severity: "PASS",
      message: "No playwright-mcp residual processes detected",
      nextAction: null,
      evidence: null,
    })
  }

  // Check quota status freshness and provider refresh errors.
  try {
    const quotaFile = process.env.DLL_AGENT_QUOTA_FILE ?? path.join(os.homedir(), ".dll-agent", "quota", "status.json")
    if (fs.existsSync(quotaFile)) {
      const quota = JSON.parse(fs.readFileSync(quotaFile, "utf8")) as {
        updated_at?: number
        ttl_sec?: number
        refresh_errors?: { provider?: string; error?: string }[] | null
        providers?: Record<string, { status?: string; message?: string }>
      }
      const updated = quota.updated_at ?? 0
      const ttl = quota.ttl_sec ?? 300
      const age = updated ? Math.max(0, Math.floor(Date.now() / 1000 - updated)) : Number.POSITIVE_INFINITY
      const errors = [
        ...(quota.refresh_errors ?? []).map((e) => `${e.provider ?? "unknown"}:${e.error ?? "error"}`),
        ...Object.entries(quota.providers ?? {})
          .filter(([, provider]) => provider?.status === "error")
          .map(([name, provider]) => `${name}:${provider.message ?? "error"}`),
      ]
      if (age > ttl || errors.length > 0) {
        checks.push({
          name: "quota-refresh",
          severity: "WARN",
          message: `Quota status ${age > ttl ? `stale (${age}s > TTL ${ttl}s)` : "has provider refresh errors"}`,
          nextAction: "Run: /Users/dailulu/.local/bin/dll-agent-quota (or restart dll-agent if refresh is managed at launch)",
          evidence: `file=${quotaFile}, age=${Number.isFinite(age) ? age : "missing"}, ttl=${ttl}, errors=${errors.slice(0, 3).join(";") || "none"}`,
        })
      } else {
        checks.push({
          name: "quota-refresh",
          severity: "PASS",
          message: `Quota status fresh (${age}s <= TTL ${ttl}s)`,
          nextAction: null,
          evidence: `file=${quotaFile}`,
        })
      }
    } else {
      checks.push({
        name: "quota-refresh",
        severity: "WARN",
        message: "Quota status file is missing",
        nextAction: "Run: /Users/dailulu/.local/bin/dll-agent-quota",
        evidence: `file=${quotaFile}`,
      })
    }
  } catch (error) {
    checks.push({
      name: "quota-refresh",
      severity: "WARN",
      message: "Could not parse quota status",
      nextAction: "Regenerate quota status with dll-agent-quota",
      evidence: String(error),
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

// ─── Capability System Checks ────────────────────────────────────────────────

function checkCapabilityHealth(projectRoot?: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  checks.push({
    name: "capability-orchestrator",
    severity: "PASS",
    message: `Capability runtime orchestrator loaded (v${CAPABILITY_ORCHESTRATOR_VERSION})`,
    nextAction: null,
    evidence: "module=capability-orchestrator.ts",
  })

  try {
    if (projectRoot) {
      const promptFile = path.join(projectRoot, "packages", "opencode", "src", "session", "prompt.ts")
      if (fs.existsSync(promptFile)) {
        const prompt = fs.readFileSync(promptFile, "utf8")
        const wired =
          prompt.includes("orchestrateCapabilities(") &&
          prompt.includes("capabilityRuntime?.mcpRequests") &&
          prompt.includes("mcp.add(")
        checks.push({
          name: "capability-runtime-wiring",
          severity: wired ? "PASS" : "FAIL",
          message: wired
            ? "Capability planner is wired into session prompt runtime and MCP connect path"
            : "Capability modules exist but are not wired into prompt runtime",
          nextAction: wired ? null : "Wire capability-orchestrator.ts into session/prompt.ts before resolveTools()",
          evidence: `file=${promptFile}`,
        })
      }
    }
  } catch (error) {
    checks.push({
      name: "capability-runtime-wiring",
      severity: "WARN",
      message: "Could not verify capability runtime wiring",
      nextAction: "Inspect session/prompt.ts for orchestrateCapabilities() and MCP.Service.add/connect integration",
      evidence: String(error),
    })
  }

  // Check: registry files exist and are parseable
  try {
    const regDir = path.join(os.homedir(), ".dll-agent", "capabilities")
    const regFile = path.join(regDir, "registry.json")
    const discFile = path.join(regDir, "discovered.json")

    if (fs.existsSync(regFile)) {
      try {
        const reg = JSON.parse(fs.readFileSync(regFile, "utf8"))
        const entryCount = Array.isArray(reg.entries) ? reg.entries.length : 0
        checks.push({
          name: "capability-registry-global",
          severity: entryCount > 0 ? "PASS" : "WARN",
          message: entryCount > 0
            ? `Global registry has ${entryCount} entries`
            : "Global registry file exists but has no entries",
          nextAction: entryCount === 0 ? "Run capability discovery" : null,
          evidence: `file=${regFile}`,
        })
      } catch {
        checks.push({
          name: "capability-registry-global",
          severity: "FAIL",
          message: "Global registry file is corrupted (unparseable JSON)",
          nextAction: "Regenerate registry from builtins or remove corrupted file",
          evidence: `file=${regFile}`,
        })
      }
    } else {
      checks.push({
        name: "capability-registry-global",
        severity: "WARN",
        message: "Global registry file does not exist",
        nextAction: "Run capability discovery to populate registry",
        evidence: `missing=${regFile}`,
      })
    }

    // Discovered layer
    if (fs.existsSync(discFile)) {
      try {
        const disc = JSON.parse(fs.readFileSync(discFile, "utf8"))
        const entryCount = Array.isArray(disc.entries) ? disc.entries.length : 0
        checks.push({
          name: "capability-registry-discovered",
          severity: "PASS",
          message: `Discovered layer has ${entryCount} entries`,
          nextAction: null,
          evidence: `file=${discFile}`,
        })
      } catch {
        checks.push({
          name: "capability-registry-discovered",
          severity: "WARN",
          message: "Discovered registry file is corrupted",
          nextAction: "Clear discovery cache and re-run discovery",
          evidence: `file=${discFile}`,
        })
      }
    }

    // Discovery cache staleness
    const cacheFile = path.join(regDir, "discovery-cache.json")
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
        const age = Date.now() - new Date(cache.last_run_at).getTime()
        const staleness = age > 24 * 60 * 60 * 1000 ? "STALE" : "OK"
        checks.push({
          name: "capability-discovery-cache",
          severity: staleness === "STALE" ? "WARN" : "PASS",
          message: staleness === "STALE"
            ? `Discovery cache is stale (${Math.round(age / 3600000)}h old)`
            : `Discovery cache is fresh (${Math.round(age / 3600000)}h ago)`,
          nextAction: staleness === "STALE" ? "Re-run capability discovery" : null,
          evidence: `age_hours=${Math.round(age / 3600000)}`,
        })
      } catch {
        checks.push({
          name: "capability-discovery-cache",
          severity: "WARN",
          message: "Discovery cache is corrupted",
          nextAction: "Clear and re-run discovery",
          evidence: `file=${cacheFile}`,
        })
      }
    }

    // Project registry
    if (projectRoot) {
      const projFile = path.join(projectRoot, ".dll-agent", "capabilities.json")
      if (fs.existsSync(projFile)) {
        checks.push({
          name: "capability-registry-project",
          severity: "PASS",
          message: "Project-level capability registry exists",
          nextAction: null,
          evidence: `file=${projFile}`,
        })
      }
    }
  } catch (err) {
    checks.push({
      name: "capability-system",
      severity: "WARN",
      message: "Could not inspect capability registry files",
      nextAction: "Check ~/.dll-agent/capabilities/ directory",
      evidence: String(err),
    })
  }

  // Check: MCP lifecycle residuals via runtime state
  try {
    const runtimeDir = path.join(os.homedir(), ".dll-agent", "runtime")
    if (fs.existsSync(runtimeDir)) {
      const files = fs.readdirSync(runtimeDir).filter((f) => f.endsWith(".json"))
      let staleCount = 0
      let failedCount = 0
      for (const file of files) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(runtimeDir, file), "utf8"))
          if (state.status === "failed") failedCount++
          if (state.status === "idle" && !state.pid) staleCount++
        } catch { /* skip */ }
      }
      if (failedCount > 0) {
        checks.push({
          name: "capability-runtime-failed",
          severity: "WARN",
          message: `${failedCount} capability runtime(s) in failed state`,
          nextAction: "Review failed capabilities and clear stale states",
          evidence: `runtime_dir=${runtimeDir}, failed=${failedCount}`,
        })
      }
      if (staleCount > 5) {
        checks.push({
          name: "capability-runtime-stale",
          severity: "WARN",
          message: `${staleCount} stale runtime states (no PID, idle)`,
          nextAction: "Run capability lifecycle cleanup",
          evidence: `runtime_dir=${runtimeDir}, stale=${staleCount}`,
        })
      } else if (files.length > 0) {
        checks.push({
          name: "capability-runtime",
          severity: "PASS",
          message: `${files.length} capability runtime state(s), ${staleCount} stale`,
          nextAction: null,
          evidence: `runtime_dir=${runtimeDir}`,
        })
      }
    }
  } catch {
    // Optional check
  }

  // Check: source/confidence anomalies
  try {
    const regFile = path.join(os.homedir(), ".dll-agent", "capabilities", "registry.json")
    if (fs.existsSync(regFile)) {
      const reg = JSON.parse(fs.readFileSync(regFile, "utf8"))
      const entries = Array.isArray(reg.entries) ? reg.entries : []
      const docSummaryEntries = entries.filter((e: any) => e.source_type === "doc-summary" && e.confidence > 0.5)
      if (docSummaryEntries.length > 0) {
        checks.push({
          name: "capability-confidence-anomaly",
          severity: "WARN",
          message: `${docSummaryEntries.length} doc-summary entries with confidence > 0.5`,
          nextAction: "Doc-summary sources should have confidence capped at 0.5",
          evidence: `count=${docSummaryEntries.length}`,
        })
      }
      const lowConfidenceHighRisk = entries.filter(
        (e: any) => e.risk_level === "high" && e.confidence < 0.5 && e.status === "available",
      )
      if (lowConfidenceHighRisk.length > 0) {
        checks.push({
          name: "capability-risk-confidence-mismatch",
          severity: "WARN",
          message: `${lowConfidenceHighRisk.length} high-risk capabilities with low confidence (<0.5) marked as available`,
          nextAction: "Review these entries — should they be degraded?",
          evidence: `count=${lowConfidenceHighRisk.length}`,
        })
      }
    }
  } catch {
    // Optional check
  }

  return checks
}

function checkObservabilityHealth(projectRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  try {
    const report = buildTaskObservabilityReport({
      sessionID: "doctor-observability-smoke",
      projectDir: projectRoot,
      maxEvents: 2,
    })
    checks.push({
      name: "task-observability",
      severity: "PASS",
      message: `Task status/trajectory renderer is available (evidence sessions=${report.cleanup.evidence_sessions})`,
      nextAction: report.cleanup.repair_safe_recommended ? report.cleanup.recommendation : null,
      evidence: `routing_decisions=${report.routing.decisions}, evidence_events=${report.evidence.total}`,
    })
  } catch (error) {
    checks.push({
      name: "task-observability",
      severity: "FAIL",
      message: "Task status/trajectory renderer failed",
      nextAction: "Inspect task-observability.ts and /task-status command wiring",
      evidence: String(error),
    })
  }
  return checks
}

function checkScenarioEvaluationHealth(): DoctorCheck[] {
  try {
    const report = evaluateRealWorldScenarioSuite()
    const severity: DoctorSeverity = report.fail > 0 || report.false_pass_risk > 0 ? "FAIL" : "PASS"
    return [{
      name: "real-world-scenario-evaluation",
      severity,
      message: severity === "PASS"
        ? `Phase 10 regression scenarios pass (${report.pass}/${report.total}); false_pass_risk=${report.false_pass_risk}`
        : `Phase 10 regression scenario gaps detected (${report.fail}/${report.total} failed, false_pass_risk=${report.false_pass_risk})`,
      nextAction: severity === "PASS" ? null : "Run scenario-evaluation tests and inspect failed acceptance refs",
      evidence: `human_intervention=${report.human_intervention_scenarios}, unnecessary_reviewer=${report.unnecessary_reviewer_scenarios}`,
    }]
  } catch (error) {
    return [{
      name: "real-world-scenario-evaluation",
      severity: "FAIL",
      message: "Phase 10 real-world scenario evaluator failed",
      nextAction: "Inspect scenario-evaluation.ts",
      evidence: String(error),
    }]
  }
}

// ─── Role Model Health Check ─────────────────────────────────────────────────

function checkRoleModelHealth(projectRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  try {
    const issues = roleModelDoctorCheck(undefined, projectRoot)
    if (issues.length === 0) {
      checks.push({
        name: "role-model-health",
        severity: "PASS",
        message: "All role models validated — no provider key issues or config conflicts",
        nextAction: null,
        evidence: "doctorCheck() returned no issues",
      })
    } else {
      for (const issue of issues) {
        checks.push({
          name: `role-model:${issue.role}`,
          severity: issue.severity,
          message: issue.message,
          nextAction: issue.severity === "FAIL"
            ? `Fix role model config for '${issue.role}'`
            : `Review role '${issue.role}' model assignment`,
          evidence: `role=${issue.role}, severity=${issue.severity}`,
        })
      }
    }
  } catch (error) {
    checks.push({
      name: "role-model-health",
      severity: "WARN",
      message: `Could not run role model health check: ${String(error)}`,
      nextAction: "Run role-model-registry doctor manually",
      evidence: String(error),
    })
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
  allChecks.push(...checkRoleToolPolicy())
  allChecks.push(...checkGoalContractHealth())

  // LSP checks
  allChecks.push(...checkLspStrategy(root))

  // Role model health checks
  allChecks.push(...checkRoleModelHealth(root))

  // Evidence health
  allChecks.push(...checkEvidenceHealth())
  allChecks.push(...checkArtifactEvidence(root))

  // Multi-model handoff checks
  allChecks.push(...checkMultiModelHandoff())

  // Resource health checks
  allChecks.push(...checkResourceHealth())

  // Capability system checks
  allChecks.push(...checkCapabilityHealth(root))

  // UX / observability checks
  allChecks.push(...checkObservabilityHealth(root))
  allChecks.push(...checkScenarioEvaluationHealth())

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
