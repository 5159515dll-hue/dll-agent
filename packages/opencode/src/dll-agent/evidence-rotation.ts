/**
 * dll-agent evidence-rotation.ts
 *
 * Evidence file rotation and session directory cleanup.
 * Prevents evidence directories from growing unboundedly.
 *
 * Policy:
 * - Max 50 evidence files per session directory
 * - Auto-cleanup old (7+ day) evidence files
 * - Max 90 session directories
 * - Rotate sessions older than 30 days
 */
import fs from "fs"
import path from "path"
import os from "os"

const DLL_AGENT_DIR = path.join(os.homedir(), ".dll-agent")
const SESSIONS_DIR = path.join(DLL_AGENT_DIR, "sessions")
const EVIDENCE_DIR = path.join(DLL_AGENT_DIR, "evidence")

const MAX_EVIDENCE_PER_SESSION = 50
const MAX_SESSION_DIRS = 90
const EVIDENCE_RETENTION_DAYS = 7
const SESSION_RETENTION_DAYS = 30

export interface RotationResult {
  cleaned: boolean
  evidenceRemoved: number
  sessionsRemoved: number
  errors: string[]
}

export interface RotationOptions {
  baseDir?: string
  maxEvidencePerSession?: number
  maxSessionDirs?: number
  evidenceRetentionDays?: number
  sessionRetentionDays?: number
  activeSessionID?: string
}

function sessionDirsFor(baseDir: string) {
  const sessionsDir = path.join(baseDir, "sessions")
  if (!fs.existsSync(sessionsDir)) return []
  return fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: path.join(sessionsDir, d.name) }))
}

/**
 * Rotate evidence files: remove old files exceeding retention period,
 * and trim excess files within each session directory.
 */
export function rotateEvidence(maxPerSession?: number, maxRetentionDays?: number): RotationResult {
  return rotateEvidenceWithOptions({
    maxEvidencePerSession: maxPerSession,
    evidenceRetentionDays: maxRetentionDays,
  })
}

/**
 * Rotate evidence/session state with explicit policy knobs.
 * This is intentionally conservative: the active session is never removed,
 * and only evidence-like JSON/JSONL files are trimmed inside retained sessions.
 */
export function rotateEvidenceWithOptions(options: RotationOptions = {}): RotationResult {
  const baseDir = options.baseDir ?? DLL_AGENT_DIR
  const sessionsDir = path.join(baseDir, "sessions")
  const maxFiles = options.maxEvidencePerSession ?? MAX_EVIDENCE_PER_SESSION
  const maxSessions = options.maxSessionDirs ?? MAX_SESSION_DIRS
  const retentionDays = options.evidenceRetentionDays ?? EVIDENCE_RETENTION_DAYS
  const sessionRetentionDays = options.sessionRetentionDays ?? SESSION_RETENTION_DAYS
  const result: RotationResult = { cleaned: false, evidenceRemoved: 0, sessionsRemoved: 0, errors: [] }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const sessionCutoff = Date.now() - sessionRetentionDays * 24 * 60 * 60 * 1000

  try {
    if (!fs.existsSync(sessionsDir)) return result

    const sessionDirs = sessionDirsFor(baseDir)

    // Sort by name (which includes timestamps) for oldest-first cleanup
    for (const dir of sessionDirs) {
      try {
        if (dir.name === options.activeSessionID) continue
        const dirStat = fs.statSync(dir.path)
        if (dirStat.mtimeMs < sessionCutoff) {
          fs.rmSync(dir.path, { recursive: true, force: true })
          result.sessionsRemoved++
          continue
        }

        const files = fs.readdirSync(dir.path)
          .map((f) => ({ name: f, path: path.join(dir.path, f) }))
          .filter((f) => f.name.endsWith(".json") || f.name.endsWith(".jsonl"))

        // Remove old files
        for (const file of files) {
          try {
            const stat = fs.statSync(file.path)
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(file.path)
              result.evidenceRemoved++
            }
          } catch {
            result.errors.push(`Failed to process: ${file.path}`)
          }
        }

        // Trim excess: keep only the newest N files per session
        const remaining = fs.readdirSync(dir.path)
          .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
          .map((f) => ({ name: f, path: path.join(dir.path, f) }))

        if (remaining.length > maxFiles) {
          // Sort by modification time, oldest first
          remaining.sort((a, b) => {
            try {
              return fs.statSync(a.path).mtimeMs - fs.statSync(b.path).mtimeMs
            } catch {
              return 0
            }
          })

          // Remove oldest excess
          const toRemove = remaining.slice(0, remaining.length - maxFiles)
          for (const file of toRemove) {
            try {
              fs.unlinkSync(file.path)
              result.evidenceRemoved++
            } catch {
              result.errors.push(`Failed to remove: ${file.path}`)
            }
          }
        }

        // Remove empty session directories
        const afterClean = fs.readdirSync(dir.path).filter(
          (f) => f !== "." && f !== "..",
        )
        if (afterClean.length === 0) {
          fs.rmdirSync(dir.path)
          result.sessionsRemoved++
        }
      } catch {
        result.errors.push(`Failed to process session dir: ${dir.path}`)
      }
    }

    result.cleaned = result.evidenceRemoved > 0 || result.sessionsRemoved > 0

    // Truncate total session dirs if exceeding max
    const allDirs = sessionDirsFor(baseDir)
      .filter((d) => d.name !== options.activeSessionID)

    if (allDirs.length + (options.activeSessionID ? 1 : 0) > maxSessions) {
      const sorted = allDirs
        .map((d) => ({
          name: d.name,
          path: d.path,
          mtime: (() => {
            try { return fs.statSync(d.path).mtimeMs }
            catch { return 0 }
          })(),
        }))
        .sort((a, b) => a.mtime - b.mtime)

      const keepBudget = Math.max(0, maxSessions - (options.activeSessionID ? 1 : 0))
      const toRemove = sorted.slice(0, Math.max(0, sorted.length - keepBudget))
      for (const dir of toRemove) {
        try {
          fs.rmSync(dir.path, { recursive: true, force: true })
          result.sessionsRemoved++
        } catch {
          result.errors.push(`Failed to remove session: ${dir.path}`)
        }
      }
    }
  } catch (err) {
    result.errors.push(`Rotation failed: ${String(err)}`)
  }

  return result
}

/**
 * Get storage statistics for evidence and session directories.
 */
export function getStorageStats(): {
  evidenceDir: string
  sessionsDir: string
  sessionCount: number
  totalEvidenceFiles: number
  totalSizeBytes: number
  needsRotation: boolean
} {
  const stats = {
    evidenceDir: EVIDENCE_DIR,
    sessionsDir: SESSIONS_DIR,
    sessionCount: 0,
    totalEvidenceFiles: 0,
    totalSizeBytes: 0,
    needsRotation: false,
  }

  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
      stats.sessionCount = dirs.length

      for (const dir of dirs) {
        const dirPath = path.join(SESSIONS_DIR, dir.name)
        try {
          const files = fs.readdirSync(dirPath)
          for (const file of files) {
            const fp = path.join(dirPath, file)
            try {
              const stat = fs.statSync(fp)
              if (stat.isFile()) {
                stats.totalEvidenceFiles++
                stats.totalSizeBytes += stat.size
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }

    stats.needsRotation =
      stats.sessionCount > MAX_SESSION_DIRS ||
      stats.totalEvidenceFiles > MAX_SESSION_DIRS * 10
  } catch { /* skip */ }

  return stats
}
