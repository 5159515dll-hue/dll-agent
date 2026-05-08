import { describe, expect, test } from "bun:test"
import { redactReportContent, validateAuditReportContent } from "../../src/dll-agent/report-validator"

describe("report-validator", () => {
  test("redacts password columns in markdown tables", () => {
    const input = `
| Role | Username | Password | Notes |
| --- | --- | --- | --- |
| SYSADMIN | sysadmin | admin123 | ok |
`
    const result = redactReportContent(input)
    expect(result.changed).toBe(true)
    expect(result.redacted_content).toContain("REDACTED")
    expect(result.redacted_content).not.toContain("admin123")
  })

  test("blocks contradictory audit report claims", () => {
    const result = validateAuditReportContent(`
No blocking issues found.
| Total Tests | 4 |
| ✅ PASS | 3 |
| ❌ FAIL | 1 |
| ⚠️ WARN | 0 |
`)
    expect(result.blockers.some((item) => item.includes("no blocking issues"))).toBe(true)
  })

  test("blocks uncovered audit scope", () => {
    const result = validateAuditReportContent(`
| Total Tests | 4 |
| ✅ PASS | 4 |
| ❌ FAIL | 0 |
| ⚠️ WARN | 0 |

## 未覆盖项
- 导出接口未验证
`)
    expect(result.blockers.some((item) => item.includes("uncovered"))).toBe(true)
  })
})
