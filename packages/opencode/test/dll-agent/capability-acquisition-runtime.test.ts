import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  capabilityAcquisitionPaths,
  doctorCheckCapabilityAcquisition,
  type CapabilityInstallManifest,
} from "../../src/dll-agent/capability-acquisition"
import { createQuarantineCandidate, markRiskAssessed, readQuarantineCandidate } from "../../src/dll-agent/capability-quarantine"
import {
  collectSandboxLogs,
  createSandbox,
  installFixtureToSandbox,
  markSandboxFailed,
  runSandboxSmokeTest,
  sandboxPath,
} from "../../src/dll-agent/capability-sandbox"
import {
  buildRollbackPlan,
  executeRollbackForFixture,
  rollbackDryRun,
  validateRollbackPlan,
} from "../../src/dll-agent/capability-rollback"
import { classifyCapabilityRisk } from "../../src/dll-agent/capability-risk-classifier"
import { readEntries } from "../../src/dll-agent/evidence"

const root = path.join(os.tmpdir(), `dll-agent-acquisition-runtime-${process.pid}`)
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

function fixtureManifest(overrides: Partial<CapabilityInstallManifest> = {}): CapabilityInstallManifest {
  return {
    version: 1,
    id: "fixture-mcp",
    kind: "mcp",
    displayName: "Fixture MCP",
    description: "Local fixture-only MCP package for sandbox testing.",
    source: { type: "local", url: "fixture://fixture-mcp", checksum: "sha256-fixture", verified: true },
    risk: { level: "R2", reasons: ["fixture executable package"], requiresFinalAudit: true, requiresUserAuthorization: false },
    permissions: {
      filesystem: "sandbox-only",
      network: "none",
      secrets: "never",
      process: "short-lived",
      browserProfile: "none",
    },
    activation: { mode: "disabled", rolesAllowed: ["commander"], rolesDenied: ["final-auditor"] },
    commands: { install: [], smoke: [], start: [], stop: [] },
    rollback: { steps: [["delete-managed-sandbox-fixture"]], safe: true },
    ...overrides,
  }
}

describe("Capability Acquisition Phase B1 quarantine/sandbox/rollback substrate", () => {
  test("quarantine candidate creation and manifest schema validation", () => {
    const record = createQuarantineCandidate({ root, manifest: fixtureManifest() })
    expect(record.status).toBe("quarantined")
    expect(readQuarantineCandidate(root, "fixture-mcp").manifest.id).toBe("fixture-mcp")
    expect(fs.existsSync(path.join(capabilityAcquisitionPaths(root).quarantine, "fixture-mcp", "quarantine.json"))).toBe(true)
  })

  test("R4 candidate can be quarantined but cannot enter sandbox", () => {
    const manifest = fixtureManifest({
      id: "blocked",
      risk: { level: "R4", reasons: ["curl pipe shell"], requiresFinalAudit: true, requiresUserAuthorization: true },
      activation: { mode: "disabled", rolesAllowed: [], rolesDenied: ["commander"] },
    })
    createQuarantineCandidate({ root, manifest })
    expect(() => createSandbox({ root, candidateID: "blocked" })).toThrow("R4 candidates cannot enter sandbox")
  })

  test("R2 fixture can enter sandbox without network or unknown code execution", () => {
    const record = createQuarantineCandidate({ root, manifest: fixtureManifest() })
    const risk = classifyCapabilityRisk({ manifest: record.manifest })
    markRiskAssessed({ root, candidateID: record.candidate_id, riskAssessment: risk })
    const sandbox = createSandbox({ root, candidateID: record.candidate_id })
    expect(sandbox.network_allowed).toBe(false)
    expect(sandbox.unknown_code_executed).toBe(false)
    expect(sandbox.fixture_only).toBe(true)
  })

  test("sandbox install writes only fixture files inside sandbox and not global paths", () => {
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    installFixtureToSandbox({
      root,
      candidateID: "fixture-mcp",
      files: [{ path: "package/manifest.json", content: "{\"ok\":true}" }],
    })
    expect(fs.existsSync(path.join(sandboxPath(root, "fixture-mcp"), "package", "manifest.json"))).toBe(true)
    expect(fs.existsSync("/tmp/package/manifest.json")).toBe(false)
    expect(() =>
      installFixtureToSandbox({ root, candidateID: "fixture-mcp", files: [{ path: "../escape", content: "bad" }] }),
    ).toThrow("fixture path must be relative")
  })

  test("sandbox smoke pass and fail states are marked without executing commands", () => {
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    installFixtureToSandbox({ root, candidateID: "fixture-mcp", files: [{ path: "ok.txt", content: "ok" }] })
    expect(runSandboxSmokeTest({ root, candidateID: "fixture-mcp", requiredFiles: ["ok.txt"] }).passed).toBe(true)
    expect(runSandboxSmokeTest({ root, candidateID: "fixture-mcp", requiredFiles: ["missing.txt"] }).passed).toBe(false)
    expect(collectSandboxLogs({ root, candidateID: "fixture-mcp" }).join("\n")).toContain("fixture smoke failed")
  })

  test("rollback plan is required and dry-run does not delete files", () => {
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    installFixtureToSandbox({ root, candidateID: "fixture-mcp", files: [{ path: "ok.txt", content: "ok" }] })
    expect(validateRollbackPlan(root, { plan_id: "empty", candidate_id: "fixture-mcp", managed_paths: [], dry_run_required: true, safe: true, created_at: new Date().toISOString() }).valid).toBe(false)
    const plan = buildRollbackPlan({ root, candidateID: "fixture-mcp" })
    const dryRun = rollbackDryRun({ root, plan })
    expect(dryRun.would_delete.length).toBeGreaterThan(0)
    expect(fs.existsSync(sandboxPath(root, "fixture-mcp"))).toBe(true)
  })

  test("rollback execute only deletes managed fixture sandbox and quarantine paths", () => {
    const sessionsDir = path.join(root, "sessions")
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, "active-session"), "active")
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    installFixtureToSandbox({ root, candidateID: "fixture-mcp", files: [{ path: "ok.txt", content: "ok" }] })
    const plan = buildRollbackPlan({ root, candidateID: "fixture-mcp" })
    const result = executeRollbackForFixture({ root, plan, dryRun: rollbackDryRun({ root, plan }) })
    expect(result.status).toBe("rolled_back")
    expect(fs.existsSync(sandboxPath(root, "fixture-mcp"))).toBe(false)
    expect(fs.existsSync(path.join(sessionsDir, "active-session"))).toBe(true)
  })

  test("rollback refuses sessions, secrets, and unmanaged paths", () => {
    const paths = capabilityAcquisitionPaths(root)
    const base = { plan_id: "bad", candidate_id: "fixture-mcp", dry_run_required: true as const, safe: true, created_at: new Date().toISOString() }
    expect(validateRollbackPlan(root, { ...base, managed_paths: [path.join(root, "sessions", "active")] }).valid).toBe(false)
    expect(validateRollbackPlan(root, { ...base, managed_paths: [path.join(paths.sandbox, ".env")] }).valid).toBe(false)
    expect(validateRollbackPlan(root, { ...base, managed_paths: ["/tmp/unmanaged"] }).valid).toBe(false)
  })

  test("doctor detects orphan quarantine, missing rollback, stale sandbox, and failed sandbox", () => {
    const paths = capabilityAcquisitionPaths(root)
    fs.mkdirSync(path.join(paths.quarantine, "orphan"), { recursive: true })
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    installFixtureToSandbox({ root, candidateID: "fixture-mcp", files: [{ path: "ok.txt", content: "ok" }] })
    runSandboxSmokeTest({ root, candidateID: "fixture-mcp", requiredFiles: ["ok.txt"] })
    markSandboxFailed({ root, candidateID: "fixture-mcp", logs: ["fixture failed"] })
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(sandboxPath(root, "fixture-mcp"), old, old)
    const checks = doctorCheckCapabilityAcquisition(root)
    expect(checks.find((check) => check.name === "capability-quarantine")?.severity).toBe("WARN")
    expect(checks.find((check) => check.name === "capability-sandbox")?.severity).toBe("WARN")
  })

  test("doctor detects global install attempts without running them", () => {
    const paths = capabilityAcquisitionPaths(root)
    fs.mkdirSync(paths.manifests, { recursive: true })
    fs.writeFileSync(path.join(paths.manifests, "global.json"), JSON.stringify(fixtureManifest({
      id: "global",
      commands: { install: [["npm", "install", "-g", "bad"]], smoke: [], start: [], stop: [] },
    })))
    const checks = doctorCheckCapabilityAcquisition(root)
    expect(checks.find((check) => check.name === "capability-global-install-guard")?.severity).toBe("FAIL")
  })

  test("evidence is redacted for sandbox and rollback events", () => {
    createQuarantineCandidate({ root, manifest: fixtureManifest() })
    createSandbox({ root, candidateID: "fixture-mcp" })
    markSandboxFailed({ root, candidateID: "fixture-mcp", logs: ["token=secret-value"] })
    const plan = buildRollbackPlan({ root, candidateID: "fixture-mcp" })
    rollbackDryRun({ root, plan })
    const entries = JSON.stringify(readEntries(evidenceFile))
    expect(entries).toContain("REDACTED")
    expect(entries).not.toContain("secret-value")
  })
})
