import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { downloadStaticCapabilityToQuarantine, redactCapabilityUrl } from "../../src/dll-agent/capability-download"
import { capabilityAcquisitionPaths, doctorCheckCapabilityAcquisition } from "../../src/dll-agent/capability-acquisition"
import { readQuarantineCandidate } from "../../src/dll-agent/capability-quarantine"
import { buildRollbackPlan, rollbackDryRun } from "../../src/dll-agent/capability-rollback"

const root = path.join(os.tmpdir(), `dll-agent-capability-download-${process.pid}`)

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function sha(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`
}

function serveFixture(routes: Record<string, { body: string | Uint8Array; contentType?: string }>) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const route = routes[url.pathname]
      if (!route) return new Response("not found", { status: 404 })
      return new Response(typeof route.body === "string" ? route.body : Buffer.from(route.body), {
        headers: { "content-type": route.contentType ?? "text/plain" },
      })
    },
  })
  return {
    url: (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`,
    stop: () => server.stop(true),
  }
}

describe("Capability Acquisition Phase B2 static download trial", () => {
  test("GitHub-style raw static manifest download -> quarantine with checksum", async () => {
    const body = JSON.stringify({ version: 1, name: "static-manifest" })
    const server = serveFixture({ "/manifest.json": { body, contentType: "application/json" } })
    try {
      const result = await downloadStaticCapabilityToQuarantine({
        root,
        url: server.url("/manifest.json"),
        expectedSha256: sha(body),
        candidateID: "static-manifest",
      })
      expect(result.content_kind).toBe("manifest")
      expect(result.sha256).toBe(sha(body))
      expect(readQuarantineCandidate(root, "static-manifest").manifest.activation.mode).toBe("disabled")
    } finally {
      server.stop()
    }
  })

  test("GitHub-style raw SKILL.md download is static_document skill and not activated", async () => {
    const body = "# Skill\n\nRead-only instructions."
    const server = serveFixture({ "/SKILL.md": { body, contentType: "text/markdown" } })
    try {
      const result = await downloadStaticCapabilityToQuarantine({ root, url: server.url("/SKILL.md"), candidateID: "skill-doc" })
      const record = readQuarantineCandidate(root, "skill-doc")
      expect(result.content_kind).toBe("skill")
      expect(record.manifest.kind).toBe("skill")
      expect(record.manifest.activation.mode).toBe("disabled")
      expect(result.missing_checksum_warning).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("local fixture HTTP fallback is marked non-external", async () => {
    const server = serveFixture({ "/README.md": { body: "# Fixture\n" } })
    try {
      const result = await downloadStaticCapabilityToQuarantine({ root, url: server.url("/README.md"), candidateID: "readme-doc" })
      expect(result.external_live_download).toBe(false)
      expect(fs.existsSync(path.join(result.quarantine_path, "README.md"))).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("checksum mismatch is rejected before activation", async () => {
    const server = serveFixture({ "/schema.json": { body: "{\"ok\":true}", contentType: "application/json" } })
    try {
      await expect(downloadStaticCapabilityToQuarantine({
        root,
        url: server.url("/schema.json"),
        expectedSha256: "sha256:bad",
        candidateID: "bad-checksum",
      })).rejects.toThrow("checksum mismatch")
      expect(fs.existsSync(path.join(capabilityAcquisitionPaths(root).quarantine, "bad-checksum"))).toBe(false)
    } finally {
      server.stop()
    }
  })

  test("binary magic, executable extension, and max size are blocked", async () => {
    const server = serveFixture({
      "/binary.md": { body: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), contentType: "text/plain" },
      "/large.md": { body: "x".repeat(20), contentType: "text/plain" },
    })
    try {
      await expect(downloadStaticCapabilityToQuarantine({ root, url: server.url("/binary.md") })).rejects.toThrow("binary")
      await expect(downloadStaticCapabilityToQuarantine({ root, url: server.url("/install.sh") })).rejects.toThrow("executable")
      await expect(downloadStaticCapabilityToQuarantine({ root, url: server.url("/large.md"), maxBytes: 4 })).rejects.toThrow("max size")
    } finally {
      server.stop()
    }
  })

  test("private URL query is redacted and no downloaded artifact is written to repo", async () => {
    const server = serveFixture({ "/README.md": { body: "# safe\n" } })
    try {
      expect(redactCapabilityUrl(`${server.url("/README.md")}?token=secret-value#section?key=secret-value`)).not.toContain("secret-value")
      const before = new Set(fs.readdirSync(process.cwd()))
      await downloadStaticCapabilityToQuarantine({ root, url: `${server.url("/README.md")}?token=secret-value`, candidateID: "redacted" })
      expect(new Set(fs.readdirSync(process.cwd()))).toEqual(before)
    } finally {
      server.stop()
    }
  })

  test("rollback dry-run lists quarantined candidate and doctor sees it", async () => {
    const server = serveFixture({ "/README.md": { body: "# safe\n" } })
    try {
      await downloadStaticCapabilityToQuarantine({ root, url: server.url("/README.md"), candidateID: "rollback-visible" })
      const plan = buildRollbackPlan({ root, candidateID: "rollback-visible" })
      expect(rollbackDryRun({ root, plan }).would_delete.length).toBeGreaterThan(0)
      expect(doctorCheckCapabilityAcquisition(root).find((check) => check.name === "capability-quarantine")?.severity).toBe("PASS")
    } finally {
      server.stop()
    }
  })
})
