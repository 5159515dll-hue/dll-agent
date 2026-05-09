import fs from "fs"
import path from "path"

export type Entry = {
  ts: string
  type: string
  sessionID?: string
  payload: unknown
}

const secretPatterns = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key|token|password|passwd|secret)(['"]?\s*[:=]\s*['"]?)[^'"\s,}]+/gi,
]

/** 敏感字段名：当 JSON property key 命中时，无论 value 是否匹配已知 pattern，都执行脱敏 */
const SENSITIVE_KEYS = /^(api[_-]?key|token|password|passwd|secret|cookie|authorization|auth)$/i

function redactString(text: string): string {
  let result = text
  for (const pattern of secretPatterns) {
    if (pattern.source.startsWith("(api")) result = result.replace(pattern, "$1$2REDACTED")
    else if (pattern.source.startsWith("Bearer")) result = result.replace(pattern, "Bearer REDACTED")
    else if (pattern.source.startsWith("github_pat")) result = result.replace(pattern, "GITHUB-PAT-REDACTED")
    else if (pattern.source.startsWith("ghp_")) result = result.replace(pattern, "GHP-REDACTED")
    else result = result.replace(pattern, "sk-REDACTED")
  }
  return result
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value)
  }
  // For objects, use JSON.stringify with a replacer to redact secrets
  // without producing malformed JSON from regex-in-string attacks.
  // Also redacts values under sensitive field names (api_key, token, password, etc.)
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (typeof val !== "string") return val
    if (SENSITIVE_KEYS.test(_key)) return "REDACTED"
    return redactString(val)
  }))
}

export function file() {
  return process.env.DLL_AGENT_EVIDENCE_FILE
}

const DEFAULT_MAX_BYTES = 5_000_000
const DEFAULT_MAX_FILES = 3

function rotationCfg() {
  const maxBytes = parseInt(process.env.DLL_AGENT_EVIDENCE_MAX_BYTES ?? "", 10)
  const maxFiles = parseInt(process.env.DLL_AGENT_EVIDENCE_MAX_FILES ?? "", 10)
  return {
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
  }
}

/**
 * 当 evidence 文件大小超过阈值时，滚动到 `.1, .2, ...` 备份文件，
 * 超出 maxFiles 的最旧备份会被删除。轮转失败必须不阻塞写入。
 */
function rotateIfNeeded(target: string) {
  const { maxBytes, maxFiles } = rotationCfg()
  let size = 0
  try {
    size = fs.statSync(target).size
  } catch {
    return // file does not exist yet
  }
  if (size < maxBytes) return
  try {
    // unlink oldest
    const oldest = `${target}.${maxFiles}`
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest)
    // shift .i → .(i+1)
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${target}.${i}`
      const dst = `${target}.${i + 1}`
      if (fs.existsSync(src)) fs.renameSync(src, dst)
    }
    // current → .1
    fs.renameSync(target, `${target}.1`)
  } catch {
    // rotation is best-effort
  }
}

export function write(type: string, payload: unknown, sessionID?: string) {
  const target = file()
  if (!target) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    rotateIfNeeded(target)
    fs.appendFileSync(
      target,
      JSON.stringify({
        ts: new Date().toISOString(),
        type,
        sessionID,
        payload: redact(payload),
      } satisfies Entry) + "\n",
    )
  } catch {
    // Evidence logging is diagnostic and must not break the session.
  }
}

export function readEntries(target: string | undefined = file()): Entry[] {
  if (!target) return []
  try {
    if (!fs.existsSync(target)) return []
    return fs.readFileSync(target, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line) as Entry]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
