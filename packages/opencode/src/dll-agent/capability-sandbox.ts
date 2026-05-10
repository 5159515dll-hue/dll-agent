import fs from "fs"
import path from "path"
import { capabilityAcquisitionPaths, parseCapabilityJson, writeCapabilityEvidence } from "./capability-acquisition"
import { readQuarantineCandidate } from "./capability-quarantine"

export interface SandboxState {
  candidate_id: string
  sandbox_path: string
  status: "created" | "installed" | "passed" | "failed"
  fixture_only: true
  network_allowed: false
  unknown_code_executed: false
  logs: string[]
  created_at: string
  updated_at: string
}

export interface SandboxSmokeResult {
  passed: boolean
  logs: string[]
  missing_files: string[]
}

function now() {
  return new Date().toISOString()
}

function safeID(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)
}

function sandboxDir(root: string, candidateID: string) {
  return path.join(capabilityAcquisitionPaths(root).sandbox, safeID(candidateID))
}

function statePath(root: string, candidateID: string) {
  return path.join(sandboxDir(root, candidateID), "sandbox-state.json")
}

function logPath(root: string, candidateID: string) {
  return path.join(sandboxDir(root, candidateID), "sandbox.log")
}

function assertInside(base: string, target: string) {
  const relative = path.relative(base, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("refusing path outside sandbox")
}

function readState(root: string, candidateID: string): SandboxState {
  return parseCapabilityJson(fs.readFileSync(statePath(root, candidateID), "utf8")) as SandboxState
}

function writeState(root: string, state: SandboxState) {
  fs.mkdirSync(state.sandbox_path, { recursive: true, mode: 0o700 })
  fs.writeFileSync(statePath(root, state.candidate_id), JSON.stringify(state, null, 2), { mode: 0o600 })
}

function appendLog(root: string, candidateID: string, line: string) {
  fs.appendFileSync(logPath(root, candidateID), `${line}\n`, { mode: 0o600 })
}

export function createSandbox(input: { root: string; candidateID: string; sessionID?: string }): SandboxState {
  const candidate = readQuarantineCandidate(input.root, input.candidateID)
  if (candidate.manifest.risk.level === "R4") throw new Error("R4 candidates cannot enter sandbox")
  const dir = sandboxDir(input.root, input.candidateID)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const state: SandboxState = {
    candidate_id: candidate.candidate_id,
    sandbox_path: dir,
    status: "created",
    fixture_only: true,
    network_allowed: false,
    unknown_code_executed: false,
    logs: ["sandbox created for fixture-only capability acquisition"],
    created_at: now(),
    updated_at: now(),
  }
  writeState(input.root, state)
  appendLog(input.root, input.candidateID, "sandbox created")
  writeCapabilityEvidence(
    "capability.sandbox_created",
    { candidate_id: candidate.candidate_id, sandbox_path: dir, fixture_only: true, network_allowed: false },
    input.sessionID,
  )
  return state
}

export function installFixtureToSandbox(input: {
  root: string
  candidateID: string
  files: Array<{ path: string; content: string }>
  sessionID?: string
}): SandboxState {
  if (!input.files.length) throw new Error("fixture install requires at least one file")
  const state = readState(input.root, input.candidateID)
  for (const file of input.files) {
    if (file.path.includes("..") || path.isAbsolute(file.path)) throw new Error("fixture path must be relative")
    const target = path.join(state.sandbox_path, file.path)
    assertInside(state.sandbox_path, target)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, file.content, { mode: 0o600 })
  }
  const updated: SandboxState = {
    ...state,
    status: "installed",
    logs: [...state.logs, `installed ${input.files.length} fixture file(s)`],
    updated_at: now(),
  }
  writeState(input.root, updated)
  appendLog(input.root, input.candidateID, `installed ${input.files.length} fixture file(s)`)
  writeCapabilityEvidence(
    "capability.installed",
    { candidate_id: input.candidateID, fixture_only: true, file_count: input.files.length },
    input.sessionID,
  )
  return updated
}

export function runSandboxSmokeTest(input: {
  root: string
  candidateID: string
  requiredFiles: string[]
  sessionID?: string
}): SandboxSmokeResult {
  const state = readState(input.root, input.candidateID)
  writeCapabilityEvidence(
    "capability.sandbox_smoke_started",
    { candidate_id: input.candidateID, fixture_only: true, network_allowed: false, command_execution: false },
    input.sessionID,
  )
  const missing = input.requiredFiles.filter((file) => {
    if (file.includes("..") || path.isAbsolute(file)) return true
    const target = path.join(state.sandbox_path, file)
    assertInside(state.sandbox_path, target)
    return !fs.existsSync(target)
  })
  const passed = missing.length === 0
  const logs = passed ? ["fixture smoke passed"] : [`fixture smoke failed; missing=${missing.join(",")}`]
  appendLog(input.root, input.candidateID, logs.join("; "))
  if (passed) markSandboxPassed({ root: input.root, candidateID: input.candidateID, logs, sessionID: input.sessionID })
  else markSandboxFailed({ root: input.root, candidateID: input.candidateID, logs, sessionID: input.sessionID })
  return { passed, logs, missing_files: missing }
}

export function collectSandboxLogs(input: { root: string; candidateID: string }) {
  const file = logPath(input.root, input.candidateID)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
}

export function markSandboxPassed(input: { root: string; candidateID: string; logs?: string[]; sessionID?: string }) {
  const state = readState(input.root, input.candidateID)
  const updated: SandboxState = {
    ...state,
    status: "passed",
    logs: [...state.logs, ...(input.logs ?? ["sandbox smoke passed"])],
    updated_at: now(),
  }
  writeState(input.root, updated)
  writeCapabilityEvidence(
    "capability.sandbox_smoke_passed",
    { candidate_id: input.candidateID, fixture_only: true, logs: input.logs ?? [] },
    input.sessionID,
  )
  return updated
}

export function markSandboxFailed(input: { root: string; candidateID: string; logs?: string[]; sessionID?: string }) {
  const state = readState(input.root, input.candidateID)
  const updated: SandboxState = {
    ...state,
    status: "failed",
    logs: [...state.logs, ...(input.logs ?? ["sandbox smoke failed"])],
    updated_at: now(),
  }
  writeState(input.root, updated)
  writeCapabilityEvidence(
    "capability.sandbox_smoke_failed",
    { candidate_id: input.candidateID, fixture_only: true, logs: input.logs ?? [] },
    input.sessionID,
  )
  return updated
}

export function sandboxPath(root: string, candidateID: string) {
  return sandboxDir(root, candidateID)
}

export * as CapabilitySandbox from "./capability-sandbox"
