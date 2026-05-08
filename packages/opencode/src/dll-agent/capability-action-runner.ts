/**
 * Guarded executor for capability actions.
 *
 * Only low-risk project-local installs are executed here. High-risk actions,
 * global installs, destructive commands, remote publishing, and credential
 * access remain outside automatic execution.
 */

import { spawnSync } from "child_process"
import path from "path"
import type { CapabilityAction } from "./capability-orchestrator"
import { write as writeEvidence } from "./evidence"
import { buildResultPacket, writeResult } from "./result-ledger"

export interface CapabilityActionRun {
  entry_id: string
  action: CapabilityAction["type"]
  status: "skipped" | "passed" | "failed" | "blocked"
  reason: string
  command?: string[]
  exitCode?: number | null
  stdout?: string
  stderr?: string
  verification?: CapabilityVerificationRun[]
}

export interface CapabilityVerificationRun {
  command: string
  status: "passed" | "failed" | "blocked" | "not_run"
  reason?: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
}

export interface CapabilityActionRunInput {
  sessionID?: string
  projectDir: string
  actions: CapabilityAction[]
  userGoal?: string
  timeoutMs?: number
  runner?: typeof spawnSync
}

function clip(text: string | undefined, max = 4_000): string | undefined {
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function isInsideProject(projectDir: string): boolean {
  const resolved = path.resolve(projectDir)
  return resolved !== "/" && resolved.startsWith(path.resolve(process.env.HOME ?? "/Users"))
}

function isSafeAutoInstallCommand(command: string[], projectDir: string): { ok: boolean; reason: string } {
  if (command.length === 0) return { ok: false, reason: "empty command" }
  if (!isInsideProject(projectDir)) return { ok: false, reason: "project dir is not a safe user project path" }
  const [bin, ...args] = command
  if (["sudo", "brew", "git", "gh", "rm", "curl", "wget"].includes(bin)) {
    return { ok: false, reason: `blocked command: ${bin}` }
  }
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && args.some((a) => a === "-g" || a === "--global")) {
    return { ok: false, reason: "global npm-style install is not auto-approved" }
  }
  if (bin === "pip" || bin === "pip3") {
    const venv = process.env.VIRTUAL_ENV
    if (!venv || !path.resolve(venv).startsWith(path.resolve(projectDir))) {
      return { ok: false, reason: "pip auto-install requires a project-local virtualenv" }
    }
  }
  if (!["bun", "npm", "pnpm", "yarn", "pip", "pip3", "python", "python3", "npx"].includes(bin)) {
    return { ok: false, reason: `command is not in auto-install allowlist: ${bin}` }
  }
  return { ok: true, reason: "safe project-local auto-install command" }
}

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

function isSafeVerifyCommand(command: string[]): { ok: boolean; reason: string } {
  if (command.length === 0) return { ok: false, reason: "empty verify command" }
  const [bin, ...args] = command
  if (["sudo", "brew", "git", "gh", "rm", "curl", "wget"].includes(bin)) {
    return { ok: false, reason: `blocked verify command: ${bin}` }
  }
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && args.some((a) => a === "-g" || a === "--global")) {
    return { ok: false, reason: "global npm-style verify command is not auto-approved" }
  }
  if (!["which", "bun", "npm", "pnpm", "yarn", "pip", "pip3", "python", "python3", "npx"].includes(bin)) {
    return { ok: false, reason: `verify command is not in allowlist: ${bin}` }
  }
  return { ok: true, reason: "safe verify command" }
}

function runVerifyCommands(
  commands: string[] | undefined,
  input: CapabilityActionRunInput,
): CapabilityVerificationRun[] {
  if (!commands || commands.length === 0) return []
  const runner = input.runner ?? spawnSync
  const results: CapabilityVerificationRun[] = []
  for (const raw of commands) {
    const argv = splitCommand(raw)
    const guard = isSafeVerifyCommand(argv)
    if (!guard.ok) {
      results.push({ command: raw, status: "blocked", reason: guard.reason } as CapabilityVerificationRun)
      continue
    }
    const [bin, ...args] = argv
    const child = runner(bin, args, {
      cwd: input.projectDir,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
      shell: false,
    })
    results.push({
      command: raw,
      status: child.status === 0 ? "passed" : "failed",
      exitCode: child.status,
      stdout: clip(typeof child.stdout === "string" ? child.stdout : undefined),
      stderr: clip(typeof child.stderr === "string" ? child.stderr : undefined),
    })
  }
  return results
}

function maybeWriteResultLedger(
  input: CapabilityActionRunInput,
  action: CapabilityAction,
  run: CapabilityActionRun,
) {
  if (!input.sessionID || run.status !== "passed") return
  const verification = run.verification ?? []
  const failedOrBlocked = verification.filter((v) => v.status === "failed" || v.status === "blocked")
  const status = failedOrBlocked.length > 0 ? "PARTIAL" : "VERIFIED_COMPLETE"
  const packet = buildResultPacket({
    sessionID: input.sessionID,
    executing_role: "executor",
    model: "dll-agent-capability-runner",
    user_goal: input.userGoal ?? "capability auto-install",
    subtask_goal: `Install and verify capability ${action.entry_id}`,
    claimed_result: failedOrBlocked.length > 0
      ? `Capability ${action.entry_id} installed but verification has gaps`
      : `Capability ${action.entry_id} installed and verified`,
    completion_status: status,
    commands_run: [
      {
        command: run.command?.join(" ") ?? "unknown",
        result: run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "not_run",
        exitCode: run.exitCode ?? undefined,
        evidenceRef: "capability.actions",
      },
      ...verification.map((v) => ({
        command: v.command,
        result: v.status === "passed" ? "passed" as const : v.status === "failed" ? "failed" as const : "not_run" as const,
        exitCode: v.exitCode ?? undefined,
        evidenceRef: "capability.actions",
      })),
    ],
    verification_results: verification.length > 0
      ? verification.map((v) => ({
        name: v.command,
        status: v.status === "passed" ? "passed" as const : v.status === "failed" ? "failed" as const : "not_run" as const,
        evidenceRef: "capability.actions",
      }))
      : [{ name: "install command", status: "passed", evidenceRef: "capability.actions" }],
    evidence_refs: ["capability.actions"],
    unresolved_items: failedOrBlocked.map((v) => `${v.command}: ${v.status}`),
    known_risks: action.rollback_command ? [`rollback: ${action.rollback_command.join(" ")}`] : [],
  })
  writeResult(input.sessionID, packet)
}

export function runCapabilityActions(input: CapabilityActionRunInput): CapabilityActionRun[] {
  const timeoutMs = input.timeoutMs ?? 120_000
  const runner = input.runner ?? spawnSync
  const results: CapabilityActionRun[] = []

  for (const action of input.actions) {
    if (action.type !== "auto_install") {
      results.push({
        entry_id: action.entry_id,
        action: action.type,
        status: "skipped",
        reason: "not an auto_install action",
      })
      continue
    }
    if (!action.auto_allowed || action.risk_level === "high") {
      results.push({
        entry_id: action.entry_id,
        action: action.type,
        status: "blocked",
        reason: "action is not auto-approved",
        command: action.install_command,
      })
      continue
    }
    if (!action.install_command) {
      results.push({
        entry_id: action.entry_id,
        action: action.type,
        status: "blocked",
        reason: "missing install command",
      })
      continue
    }
    const guard = isSafeAutoInstallCommand(action.install_command, input.projectDir)
    if (!guard.ok) {
      results.push({
        entry_id: action.entry_id,
        action: action.type,
        status: "blocked",
        reason: guard.reason,
        command: action.install_command,
      })
      continue
    }

    const [bin, ...args] = action.install_command
    const child = runner(bin, args, {
      cwd: input.projectDir,
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
    })
    const installRun: CapabilityActionRun = {
      entry_id: action.entry_id,
      action: action.type,
      status: child.status === 0 ? "passed" : "failed",
      reason: child.error ? String(child.error) : child.status === 0 ? "install command passed" : "install command failed",
      command: action.install_command,
      exitCode: child.status,
      stdout: clip(typeof child.stdout === "string" ? child.stdout : undefined),
      stderr: clip(typeof child.stderr === "string" ? child.stderr : undefined),
      verification: child.status === 0 ? runVerifyCommands(action.verify_command, input) : [],
    }
    maybeWriteResultLedger(input, action, installRun)
    results.push(installRun)
  }

  if (results.length > 0) {
    writeEvidence("capability.actions", {
      projectDir: input.projectDir,
      results: results.map((r) => ({
        entry_id: r.entry_id,
        action: r.action,
        status: r.status,
        reason: r.reason,
        exitCode: r.exitCode,
        verification: r.verification?.map((v) => ({
          command: v.command,
          status: v.status,
          exitCode: v.exitCode,
        })),
      })),
    }, input.sessionID)
  }

  return results
}
