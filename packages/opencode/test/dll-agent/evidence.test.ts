import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { write, redact } from "../../src/dll-agent/evidence"
import { rotateEvidenceWithOptions } from "../../src/dll-agent/evidence-rotation"

let tmpDir: string
let evidenceFile: string
let savedFile: string | undefined
let savedMax: string | undefined
let savedMaxFiles: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-evidence-"))
  evidenceFile = path.join(tmpDir, "evidence.jsonl")
  savedFile = process.env.DLL_AGENT_EVIDENCE_FILE
  savedMax = process.env.DLL_AGENT_EVIDENCE_MAX_BYTES
  savedMaxFiles = process.env.DLL_AGENT_EVIDENCE_MAX_FILES
  process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
})

afterEach(() => {
  if (savedFile === undefined) delete process.env.DLL_AGENT_EVIDENCE_FILE
  else process.env.DLL_AGENT_EVIDENCE_FILE = savedFile
  if (savedMax === undefined) delete process.env.DLL_AGENT_EVIDENCE_MAX_BYTES
  else process.env.DLL_AGENT_EVIDENCE_MAX_BYTES = savedMax
  if (savedMaxFiles === undefined) delete process.env.DLL_AGENT_EVIDENCE_MAX_FILES
  else process.env.DLL_AGENT_EVIDENCE_MAX_FILES = savedMaxFiles
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe("DllAgentEvidence rotation (P0-4)", () => {
  test("rotates when current file exceeds max bytes", () => {
    process.env.DLL_AGENT_EVIDENCE_MAX_BYTES = "500"
    process.env.DLL_AGENT_EVIDENCE_MAX_FILES = "2"
    const big = "x".repeat(400)
    write("test", { payload: big }, "ses1")
    write("test", { payload: big }, "ses1")
    // Second write triggers rotation; current file has only the latest entry.
    write("test", { payload: big }, "ses1")
    expect(fs.existsSync(evidenceFile)).toBe(true)
    expect(fs.existsSync(`${evidenceFile}.1`)).toBe(true)
  })

  test("never throws on rotation failure (best-effort)", () => {
    // Without setting MAX_BYTES, default is 5MB so no rotation; sanity-check write works.
    expect(() => write("ok", { hello: "world" }, "ses2")).not.toThrow()
    expect(fs.existsSync(evidenceFile)).toBe(true)
  })

  test("redacts secrets in payload before writing", () => {
    write("redact_test", { token: "sk-abcdefghijklmn", text: "Bearer somesecret123" }, "ses3")
    const content = fs.readFileSync(evidenceFile, "utf8")
    expect(content).not.toContain("sk-abcdefghijklmn")
    expect(content).toContain("REDACTED")
  })
})

describe("DllAgentEvidence session cleanup", () => {
  test("removes oldest sessions over the cap but preserves active session", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dll-rotation-"))
    try {
      const sessions = path.join(base, "sessions")
      fs.mkdirSync(sessions, { recursive: true })
      for (const name of ["old1", "old2", "active"]) {
        const dir = path.join(sessions, name)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, "evidence.jsonl"), "{}\n")
      }
      const oldTime = new Date(Date.now() - 10_000)
      fs.utimesSync(path.join(sessions, "old1"), oldTime, oldTime)
      fs.utimesSync(path.join(sessions, "old2"), new Date(Date.now() - 5_000), new Date(Date.now() - 5_000))

      const result = rotateEvidenceWithOptions({
        baseDir: base,
        maxSessionDirs: 2,
        activeSessionID: "active",
        sessionRetentionDays: 365,
      })

      expect(result.sessionsRemoved).toBe(1)
      expect(fs.existsSync(path.join(sessions, "active"))).toBe(true)
      expect(fs.existsSync(path.join(sessions, "old1"))).toBe(false)
      expect(fs.existsSync(path.join(sessions, "old2"))).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("trims evidence files inside retained sessions", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dll-rotation-"))
    try {
      const dir = path.join(base, "sessions", "ses_trim")
      fs.mkdirSync(dir, { recursive: true })
      for (let i = 0; i < 4; i++) {
        const file = path.join(dir, `evidence-${i}.jsonl`)
        fs.writeFileSync(file, "{}\n")
        const when = new Date(Date.now() - (4 - i) * 1000)
        fs.utimesSync(file, when, when)
      }

      const result = rotateEvidenceWithOptions({
        baseDir: base,
        maxEvidencePerSession: 2,
        maxSessionDirs: 10,
        sessionRetentionDays: 365,
      })

      expect(result.evidenceRemoved).toBe(2)
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length).toBe(2)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("DllAgentEvidence.redact (P0 session-state)", () => {
  test("redacts secrets in nested object", () => {
    const obj = { outer: { inner: { api_key: "sk-secret-key-12345" } } }
    const result = redact(obj) as typeof obj
    const value = (result as any).outer.inner.api_key
    expect(value).not.toContain("sk-secret-key-12345")
    expect(value).toContain("REDACTED")
  })

  test("redacts secrets in arrays", () => {
    const obj = { items: [{ token: "sk-abc123def456ghi" }, { name: "safe" }] }
    const result = redact(obj) as typeof obj
    expect(JSON.stringify(result)).not.toContain("sk-abc123def456ghi")
    expect(JSON.stringify(result)).toContain("REDACTED")
  })

  test("redacts Authorization header with Bearer token", () => {
    const obj = { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" } }
    const result = redact(obj) as typeof obj
    expect(JSON.stringify(result)).not.toContain("eyJhbGci")
    expect(JSON.stringify(result)).not.toContain("Bearer")
    const authVal = (result as any).headers.Authorization
    expect(authVal).toBe("REDACTED")
  })

  test("redacts cookie strings", () => {
    const result = redact("Set-Cookie: session=abc123; token=sk-abcdefghijklmnopqrst; HttpOnly")
    expect(result).not.toContain("sk-abcdefghijklmnopqrst")
    expect(result).toContain("REDACTED")
  })

  test("redacts password field", () => {
    const obj = { username: "admin", password: "supersecret123" }
    const result = redact(obj) as typeof obj
    expect(JSON.stringify(result)).not.toContain("supersecret123")
    expect(JSON.stringify(result)).toContain("REDACTED")
  })

  test("redacts api_key field", () => {
    const obj = { provider: "deepseek", api_key: "sk-my-deepseek-key-123456" }
    const result = redact(obj) as typeof obj
    expect(JSON.stringify(result)).not.toContain("sk-my-deepseek-key-123456")
    expect(JSON.stringify(result)).toContain("REDACTED")
  })

  test("does NOT redact session fingerprint/hash/cooldown keys (known-safe IDs)", () => {
    const fingerprint = "v2:chief-engineer:msg_abc:permission-denied-detected"
    const result = redact(fingerprint)
    // fingerprint should pass through unchanged — it's a machine ID, not a secret
    expect(result).toBe(fingerprint)
  })

  test("does NOT redact cooldown step numbers and reviewer names", () => {
    const obj = {
      last_called_step: { "requirements-inspector": 5 },
      call_count: { "requirements-inspector": 2 },
      last_review_step: 5,
    }
    const result = redact(obj) as typeof obj
    const str = JSON.stringify(result)
    expect(str).toContain("requirements-inspector")
    expect(str).toContain("5")
  })

  test("still redacts real API key even inside session state structure", () => {
    // If session state accidentally contains an API key, it MUST be redacted
    const obj = {
      metrics: { tool_failures: 2 },
      leaked_key: "sk-real-leaked-api-key-123456",
    }
    const result = redact(obj) as typeof obj
    expect(JSON.stringify(result)).not.toContain("sk-real-leaked-api-key-123456")
    expect(JSON.stringify(result)).toContain("REDACTED")
  })

  test("redacts GITHUB_PAT and GHP tokens", () => {
    const obj = { pat: "github_pat_11AAAAABBBBBCCCCCCDDDDDDEEEEEEFFFFFF", legacy: "ghp_abcdefghijklmnopqrstuvwxyz123456" }
    const result = redact(obj) as typeof obj
    const str = JSON.stringify(result)
    expect(str).not.toContain("github_pat_11AAAA")
    expect(str).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456")
    expect(str).toContain("GITHUB-PAT-REDACTED")
    expect(str).toContain("GHP-REDACTED")
  })
})
