import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { enforceAuditPolicy } from "../../src/dll-agent/capability-audit-runtime"
import { createQuarantineCandidate, readQuarantineCandidate } from "../../src/dll-agent/capability-quarantine"
import { classifyCapabilityRisk } from "../../src/dll-agent/capability-risk-classifier"
import { readEntries } from "../../src/dll-agent/evidence"
import type { CapabilityInstallManifest } from "../../src/dll-agent/capability-acquisition"

const root = path.join(os.tmpdir(), `dll-agent-capability-audit-${process.pid}`)
const evidenceFile = path.join(root, "evidence.jsonl")

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
})

afterEach(() => {
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  fs.rmSync(root, { recursive: true, force: true })
})

function manifest(overrides: Partial<CapabilityInstallManifest> = {}): CapabilityInstallManifest {
  return {
    version: 1,
    id: "r2-fixture",
    kind: "mcp",
    displayName: "R2 Fixture",
    description: "Fixture MCP candidate.",
    source: { type: "local", url: "fixture://r2", checksum: "sha256-fixture", verified: true },
    risk: { level: "R2", reasons: ["fixture executable"], requiresFinalAudit: true, requiresUserAuthorization: false },
    permissions: { filesystem: "sandbox-only", network: "none", secrets: "never", process: "short-lived", browserProfile: "none" },
    activation: { mode: "disabled", rolesAllowed: ["commander"], rolesDenied: ["final-auditor"] },
    commands: { install: [], smoke: [["fixture-smoke"]], start: [], stop: [] },
    rollback: { steps: [["delete-managed-sandbox-fixture"]], safe: true },
    ...overrides,
  }
}

describe("Capability Acquisition Phase C mock final-auditor policy", () => {
  test("R2 requires final-auditor and mock pass allows fixture sandbox", () => {
    createQuarantineCandidate({ root, manifest: manifest() })
    const candidate = readQuarantineCandidate(root, "r2-fixture")
    const risk = classifyCapabilityRisk({ manifest: candidate.manifest })
    expect(risk.requiresFinalAuditor).toBe(true)
    const result = enforceAuditPolicy({ root, candidate, riskAssessment: risk, decision: "pass" })
    expect(result.allowed_to_sandbox).toBe(true)
    expect(result.requires_user_authorization).toBe(false)
    expect(result.packet.rollback_plan).toEqual(candidate.manifest.rollback.steps)
    expect(result.packet.smoke_test_plan).toEqual(candidate.manifest.commands.smoke)
  })

  test("R2 mock auditor block blocks sandbox", () => {
    createQuarantineCandidate({ root, manifest: manifest() })
    const candidate = readQuarantineCandidate(root, "r2-fixture")
    const result = enforceAuditPolicy({
      root,
      candidate,
      riskAssessment: classifyCapabilityRisk({ manifest: candidate.manifest }),
      decision: "block",
    })
    expect(result.blocked).toBe(true)
    expect(result.allowed_to_sandbox).toBe(false)
  })

  test("R3 requires user authorization even when mock auditor passes", () => {
    createQuarantineCandidate({ root, manifest: manifest({
      id: "r3-browser",
      risk: { level: "R3", reasons: ["browser automation"], requiresFinalAudit: true, requiresUserAuthorization: true },
      permissions: { filesystem: "sandbox-only", network: "public", secrets: "never", process: "short-lived", browserProfile: "isolated-only" },
    }) })
    const candidate = readQuarantineCandidate(root, "r3-browser")
    const result = enforceAuditPolicy({
      root,
      candidate,
      riskAssessment: classifyCapabilityRisk({ manifest: candidate.manifest, browserAutomation: true }),
      decision: "pass",
    })
    expect(result.requires_user_authorization).toBe(true)
    expect(result.allowed_to_sandbox).toBe(false)
  })

  test("R4 hard block cannot be overridden by final-auditor", () => {
    createQuarantineCandidate({ root, manifest: manifest({
      id: "r4-global",
      risk: { level: "R4", reasons: ["global install"], requiresFinalAudit: true, requiresUserAuthorization: true },
      activation: { mode: "disabled", rolesAllowed: [], rolesDenied: ["commander"] },
      commands: { install: [["npm", "install", "-g", "bad"]], smoke: [], start: [], stop: [] },
    }) })
    const candidate = readQuarantineCandidate(root, "r4-global")
    const result = enforceAuditPolicy({
      root,
      candidate,
      riskAssessment: classifyCapabilityRisk({ manifest: candidate.manifest }),
      decision: "pass",
    })
    expect(result.blocked).toBe(true)
    expect(result.verdict.blocking_reasons.join(" ")).toContain("R4 hard block")
  })

  test("final-auditor output evidence is redacted", () => {
    createQuarantineCandidate({ root, manifest: manifest() })
    const candidate = readQuarantineCandidate(root, "r2-fixture")
    enforceAuditPolicy({
      root,
      candidate,
      riskAssessment: classifyCapabilityRisk({ manifest: candidate.manifest }),
      decision: "warn",
      sessionID: "ses_audit",
    })
    const text = JSON.stringify(readEntries(evidenceFile))
    expect(text).not.toContain("secret-value")
    expect(text).toContain("capability.audit_policy_decision")
  })
})
