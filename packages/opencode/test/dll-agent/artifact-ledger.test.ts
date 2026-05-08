import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { classifyArtifactPath, parseAuditReportMetrics, scanArtifactLedger } from "../../src/dll-agent/artifact-ledger"
import { buildEvidenceSnapshot } from "../../src/dll-agent/evidence-normalizer"
import { evaluateCompletionReadiness } from "../../src/dll-agent/completion-readiness"

const cleanup: string[] = []

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-artifact-test-"))
  cleanup.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("artifact-ledger", () => {
  test("classifies audit reports, screenshots, and generated scripts", () => {
    expect(classifyArtifactPath("files/full-crm-browser-flow-audit-report.md")).toBe("audit_report")
    expect(classifyArtifactPath("test-screenshots/home.png")).toBe("screenshot")
    expect(classifyArtifactPath("audit-full-browser.mjs")).toBe("generated_script")
  })

  test("parses audit report metrics and contradiction", () => {
    const metrics = parseAuditReportMetrics(`
> No blocking issues found during this audit session.
| Total Tests | 67 |
| ✅ PASS | 53 |
| ❌ FAIL | 5 |
| ⚠️ WARN | 9 |
`)
    expect(metrics.total).toBe(67)
    expect(metrics.fail).toBe(5)
    expect(metrics.warn).toBe(9)
    expect(metrics.saysNoBlockingIssues).toBe(true)
  })

  test("audit report plus screenshots become real evidence but not verified when FAIL exists", () => {
    const dir = tmpProject()
    fs.mkdirSync(path.join(dir, "files"), { recursive: true })
    fs.mkdirSync(path.join(dir, "test-screenshots"), { recursive: true })
    fs.writeFileSync(path.join(dir, "audit-full-browser.mjs"), "console.log('audit')\n")
    fs.writeFileSync(path.join(dir, "test-screenshots", "home.png"), "png")
    fs.writeFileSync(path.join(dir, "files", "full-crm-browser-flow-audit-report.md"), `
> No blocking issues found during this audit session.
| Total Tests | 67 |
| ✅ PASS | 53 |
| ❌ FAIL | 5 |
| ⚠️ WARN | 9 |
`)

    const artifacts = scanArtifactLedger(dir)
    expect(artifacts.hasAuditEvidence).toBe(true)
    expect(artifacts.failCount).toBe(5)
    expect(artifacts.contradictions.length).toBe(1)

    const snapshot = buildEvidenceSnapshot({ projectDir: dir })
    expect(snapshot.has_real_tool_evidence).toBe(true)
    expect(snapshot.fail_count).toBe(5)

    const readiness = evaluateCompletionReadiness({ snapshot })
    expect(readiness.can_claim_verified).toBe(false)
    expect(readiness.status).toBe("BLOCKED")
  })
})
