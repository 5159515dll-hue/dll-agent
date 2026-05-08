import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { buildTaskSidebarLines, buildTaskStateSnapshot } from "../../src/dll-agent/task-state"

const cleanup: string[] = []

function tmpProject(report: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-task-state-"))
  cleanup.push(dir)
  fs.mkdirSync(path.join(dir, "files"), { recursive: true })
  fs.mkdirSync(path.join(dir, "test-screenshots"), { recursive: true })
  fs.writeFileSync(path.join(dir, "audit-full-browser.mjs"), "console.log('audit')\n")
  fs.writeFileSync(path.join(dir, "test-screenshots", "home.png"), "png")
  fs.writeFileSync(path.join(dir, "files", "full-crm-browser-flow-audit-report.md"), report)
  return dir
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("task-state", () => {
  test("reports verified artifact state", () => {
    const project = tmpProject(`
| Total Tests | 4 |
| ✅ PASS | 4 |
| ❌ FAIL | 0 |
| ⚠️ WARN | 0 |
`)
    const state = buildTaskStateSnapshot({ projectDir: project })
    expect(state.status).toBe("verified")
    expect(state.completed_steps).toContain("audit script generated")
    expect(state.completed_steps).toContain("audit report generated")
  })

  test("reports blocked artifact state in sidebar lines", () => {
    const project = tmpProject(`
No blocking issues found.
| Total Tests | 4 |
| ✅ PASS | 3 |
| ❌ FAIL | 1 |
| ⚠️ WARN | 0 |
`)
    const lines = buildTaskSidebarLines({ projectDir: project })
    expect(lines.join("\n")).toContain("blocked")
    expect(lines.join("\n")).toContain("task blocker")
  })
})
