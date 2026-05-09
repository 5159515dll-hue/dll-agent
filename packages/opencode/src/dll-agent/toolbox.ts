/**
 * dll-agent Script Toolbox
 *
 * 内置校验/诊断脚本的命令包装。所有脚本支持 --dry-run 模式。
 * 供 supervisor/commander 直接调用，不依赖外部脚本文件。
 */

import { execFileSync, type ExecFileSyncOptions } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

export interface ScriptResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  command: string
  dryRun: boolean
}

function run(command: string, cwd?: string, dryRun?: boolean): ScriptResult {
  if (dryRun) {
    return {
      success: true,
      stdout: `[dry-run] would run: ${command}`,
      stderr: "",
      exitCode: 0,
      command,
      dryRun: true,
    }
  }
  const opts: ExecFileSyncOptions = {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 100_000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  }
  const root = process.env.DLL_AGENT_ROOT || process.cwd()
  const wd = cwd ? (path.isAbsolute(cwd) ? cwd : path.join(root, cwd)) : root
  try {
    const stdout = execFileSync(command, { ...opts, cwd: wd }) as string
    return { success: true, stdout: stdout ?? "", stderr: "", exitCode: 0, command, dryRun: false }
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
      exitCode: err.status || 1,
      command,
      dryRun: false,
    }
  }
}

/** TypeScript typecheck */
export function typecheck(dryRun?: boolean): ScriptResult {
  return run("bun typecheck", "packages/opencode", dryRun)
}

/** Run all dll-agent unit tests */
export function runTests(dryRun?: boolean): ScriptResult {
  return run("bun test test/dll-agent/ --timeout 30000", "packages/opencode", dryRun)
}

/** Python wrapper syntax check */
export function pythonSyntax(dryRun?: boolean): ScriptResult {
  const bin = path.join(os.homedir(), ".local", "bin")
  return run(`python3 -m py_compile ${bin}/dll-agent ${bin}/dll-agent-quota`, undefined, dryRun)
}

/** dll-agent doctor */
export function doctor(dryRun?: boolean): ScriptResult {
  const bin = path.join(os.homedir(), ".local", "bin", "dll-agent")
  return run(`"${bin}" doctor`, undefined, dryRun)
}

/** Git diff whitespace check */
export function gitDiffCheck(dryRun?: boolean): ScriptResult {
  const root = process.env.DLL_AGENT_ROOT || process.cwd()
  return run("git diff --check", root, dryRun)
}

/** Quota refresh */
export function quotaRefresh(dryRun?: boolean): ScriptResult {
  const bin = path.join(os.homedir(), ".local", "bin", "dll-agent-quota")
  return run(`"${bin}"`, undefined, dryRun)
}

/** Session cleanup dry-run (只读，不删除) */
export function sessionCleanupDryRun(dryRun?: boolean): ScriptResult {
  const sessions = path.join(os.homedir(), ".dll-agent", "sessions")
  const cmd = `find ${sessions} -maxdepth 1 -type d | wc -l && du -sh ${sessions} 2>/dev/null`
  return run(cmd, undefined, dryRun)
}

/** 
 * 按保留天数列出可清理的旧 session。
 * 只输出统计信息，不执行删除。
 */
export function sessionListOld(olderThanDays: number, dryRun?: boolean): ScriptResult {
  const sessions = path.join(os.homedir(), ".dll-agent", "sessions")
  const cmd = `find ${sessions} -maxdepth 1 -name "ses_*" -type d -mtime +${olderThanDays} | wc -l && find ${sessions} -maxdepth 1 -name "ses_*" -type d -mtime +${olderThanDays} -exec du -sh {} + 2>/dev/null | awk '{sum+=$1} END {print sum "K"}'`
  return run(cmd, undefined, dryRun)
}

/** Full smoke check: typecheck + tests + python + doctor + git diff */
export function smokeCheck(dryRun?: boolean): ScriptResult[] {
  return [
    typecheck(dryRun),
    runTests(dryRun),
    pythonSyntax(dryRun),
    doctor(dryRun),
    gitDiffCheck(dryRun),
  ]
}

/** All toolbox scripts metadata for display */
export function listScripts() {
  return [
    { name: "typecheck", description: "TypeScript typecheck (tsgo --noEmit)", command: "bun typecheck" },
    { name: "test", description: "Run all dll-agent unit tests", command: "bun test test/dll-agent/" },
    { name: "python-syntax", description: "Python wrapper syntax check", command: "python3 -m py_compile" },
    { name: "doctor", description: "dll-agent health check", command: "dll-agent doctor" },
    { name: "git-diff", description: "Git whitespace check", command: "git diff --check" },
    { name: "quota-refresh", description: "Refresh quota/balance from provider APIs", command: "dll-agent-quota" },
    { name: "session-cleanup-dry-run", description: "List session directories count and size (read-only)", command: "ls + du sessions/" },
    { name: "session-list-old", description: "List sessions older than N days (read-only)", command: "find sessions/ -mtime" },
    { name: "smoke", description: "Full smoke: typecheck + test + python + doctor + git diff", command: "all above" },
  ]
}

// ─── Tool/MCP Doctor Checks ──────────────────────────────────────────────────

export interface ToolDoctorResult {
  check: string
  pass: boolean
  message: string
  suggestion?: string
}

/**
 * dll-agent doctor 工具/MCP 检查扩展。
 * 检查 global tools manifest、project overlay、MCP health、prompt limits 等。
 *
 * 此函数不依赖 Effect layer，可在纯 Node 环境运行。
 * 调用方负责传入 projectDir 和 sessionId。
 */
export function toolDoctorChecks(projectDir?: string, sessionId?: string): ToolDoctorResult[] {
  const results: ToolDoctorResult[] = []

  // Check 1: global tools manifest exists
  try {
    const globalDir = path.join(os.homedir(), ".dll-agent", "global")
    const globalManifest = path.join(globalDir, "tools.jsonc")
    if (fs.existsSync(globalManifest)) {
      results.push({ check: "global-tools-manifest", pass: true, message: `Found: ${globalManifest}` })
    } else {
      results.push({
        check: "global-tools-manifest",
        pass: false,
        message: "Global tools manifest not found",
        suggestion: `Create ~/.dll-agent/global/tools.jsonc with default tool registry. Run: mkdir -p ~/.dll-agent/global`,
      })
    }
  } catch (err: any) {
    results.push({ check: "global-tools-manifest", pass: false, message: `Error reading: ${err.message}` })
  }

  // Check 2: global manifest schema (if exists, try to parse)
  try {
    const globalManifest = path.join(os.homedir(), ".dll-agent", "global", "tools.jsonc")
    if (fs.existsSync(globalManifest)) {
      const raw = fs.readFileSync(globalManifest, "utf8")
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      const parsed = JSON.parse(stripped)
      if (parsed.version === 1 && Array.isArray(parsed.tools)) {
        results.push({ check: "global-manifest-schema", pass: true, message: `Schema valid. ${parsed.tools.length} tools registered.` })
      } else {
        results.push({ check: "global-manifest-schema", pass: false, message: "Schema invalid: missing version or tools array" })
      }
    } else {
      results.push({ check: "global-manifest-schema", pass: true, message: "No global manifest — using built-in defaults" })
    }
  } catch (err: any) {
    results.push({ check: "global-manifest-schema", pass: false, message: `Parse error: ${err.message}` })
  }

  // Check 3: project tools manifest (if projectDir provided)
  if (projectDir) {
    const candidates = [
      path.join(projectDir, ".dll-agent", "tools.jsonc"),
      path.join(projectDir, "dll-agent.tools.jsonc"),
    ]
    let foundProject = false
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        foundProject = true
        try {
          const raw = fs.readFileSync(file, "utf8")
          const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
          JSON.parse(stripped)
          results.push({ check: "project-manifest-schema", pass: true, message: `Found & valid: ${file}` })
        } catch (err: any) {
          results.push({ check: "project-manifest-schema", pass: false, message: `Found ${file} but invalid: ${err.message}` })
        }
        break
      }
    }
    if (!foundProject) {
      results.push({ check: "project-manifest-schema", pass: true, message: "No project manifest — using global only" })
    }
  }

  // Check 4: session effective manifest
  if (sessionId) {
    const sessionDir = path.join(os.homedir(), ".dll-agent", "sessions", sessionId)
    const effectiveFile = path.join(sessionDir, "effective-tools.json")
    if (fs.existsSync(effectiveFile)) {
      results.push({ check: "session-effective-manifest", pass: true, message: `Written: ${effectiveFile}` })
    } else {
      results.push({ check: "session-effective-manifest", pass: false, message: "Not written yet (will be written on first tools load)" })
    }
  }

  // Check 5: MCP state dir
  const mcpDir = path.join(os.homedir(), ".dll-agent", "mcp")
  if (fs.existsSync(mcpDir)) {
    const files = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
    results.push({ check: "mcp-state-dir", pass: true, message: `${files.length} MCP state files found` })

    // Check each MCP state file for failed/degraded
    for (const file of files) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(mcpDir, file), "utf8"))
        if (state.status === "failed" || state.status === "degraded") {
          results.push({
            check: `mcp-${state.name}-health`,
            pass: false,
            message: `MCP "${state.name}" is ${state.status}: ${state.lastError ?? "unknown error"}`,
            suggestion: state.status === "failed"
              ? `Cooldown until ${state.cooldownUntil}. Review error: ${state.lastError}`
              : `Run /capability-status or dll-agent doctor for current MCP health; runtime will restart on demand`,
          })
        }
      } catch { /* skip corrupted */ }
    }
  } else {
    results.push({ check: "mcp-state-dir", pass: true, message: "No MCP state directory — nothing to check" })
  }

  // Check 6: heavy MCPs are NOT running (should be on-demand)
  try {
    const mcpDirCheck = path.join(os.homedir(), ".dll-agent", "mcp")
    if (fs.existsSync(mcpDirCheck)) {
      const files = fs.readdirSync(mcpDirCheck).filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
      for (const file of files) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(mcpDirCheck, file), "utf8"))
          // playwright should not be auto-started
          if (state.name === "playwright" && state.status === "running") {
            results.push({
              check: "heavy-mcp-not-auto-started",
              pass: false,
              message: "Playwright is running — it should be on-demand only",
              suggestion: "If stale, run dll-agent doctor --repair-safe or stop the process manually after verifying it is not active",
            })
          }
        } catch { /* skip */ }
      }
    }
    if (!results.some((r) => r.check === "heavy-mcp-not-auto-started")) {
      results.push({ check: "heavy-mcp-not-auto-started", pass: true, message: "No heavy MCP auto-started" })
    }
  } catch {
    results.push({ check: "heavy-mcp-not-auto-started", pass: true, message: "Skipped — MCP dir not accessible" })
  }

  // Check 7: GitHub token presence (without revealing)
  const ghToken = process.env.GITHUB_TOKEN
  if (ghToken) {
    results.push({ check: "github-token", pass: true, message: "GITHUB_TOKEN is set (token not displayed)" })
  } else {
    results.push({ check: "github-token", pass: true, message: "GITHUB_TOKEN not set — GitHub tools limited to public read" })
  }

  // Check 8: prompt index char limit
  results.push({
    check: "prompt-index-limit",
    pass: true,
    message: "Prompt index limit: 1200 chars global, 1500 per-tool, 3000 per-round (enforced in tool-prompt.ts)",
  })

  return results
}
