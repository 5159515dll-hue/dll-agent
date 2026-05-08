/**
 * dll-agent lsp-strategy tests
 */
import { describe, it, expect } from "bun:test"
import {
  detectProjectLanguage,
  computePrewarmPlan,
  isLspExcludedPath,
  lspNamesForLanguage,
  DEFAULT_LSP_STRATEGY,
} from "../../src/dll-agent/lsp-strategy"

describe("lsp-strategy", () => {
  describe("detectProjectLanguage", () => {
    it("detects typescript from package.json", () => {
      // Uses the current repo which has package.json
      const lang = detectProjectLanguage(
        "/Users/dailulu/projects/dll-agent-opencode",
      )
      expect(lang).toBe("typescript")
    })

    it("returns unknown for empty/nonexistent dir", () => {
      const lang = detectProjectLanguage("/tmp/nonexistent-project-xyz")
      expect(lang).toBe("unknown")
    })
  })

  describe("computePrewarmPlan", () => {
    it("prewarms only main language in project-main mode", () => {
      const plan = computePrewarmPlan(
        "/Users/dailulu/projects/dll-agent-opencode",
        DEFAULT_LSP_STRATEGY,
      )
      expect(plan.prewarm).toContain("typescript")
      expect(plan.prewarm.length).toBeLessThanOrEqual(3)
    })

    it("returns empty prewarm in lazy mode", () => {
      const plan = computePrewarmPlan(
        "/Users/dailulu/projects/dll-agent-opencode",
        { ...DEFAULT_LSP_STRATEGY, mode: "lazy" },
      )
      expect(plan.prewarm).toEqual([])
      expect(plan.lazy.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe("isLspExcludedPath", () => {
    it("flags node_modules", () => {
      expect(isLspExcludedPath("node_modules/react/index.js")).toBe(true)
    })

    it("flags .git", () => {
      expect(isLspExcludedPath(".git/config")).toBe(true)
    })

    it("flags dist", () => {
      expect(isLspExcludedPath("dist/bundle.js")).toBe(true)
    })

    it("flags .venv", () => {
      expect(isLspExcludedPath(".venv/lib/python3/site-packages/foo.py")).toBe(true)
    })

    it("flags __pycache__", () => {
      expect(isLspExcludedPath("__pycache__/module.cpython-311.pyc")).toBe(true)
    })

    it("does not flag normal source", () => {
      expect(isLspExcludedPath("src/components/Foo.tsx")).toBe(false)
    })
  })

  describe("lspNamesForLanguage", () => {
    it("returns typescript LSP names", () => {
      const names = lspNamesForLanguage("typescript")
      expect(names).toContain("typescript")
    })

    it("returns rust-analyzer for rust", () => {
      const names = lspNamesForLanguage("rust")
      expect(names).toContain("rust-analyzer")
    })

    it("returns empty for unknown", () => {
      expect(lspNamesForLanguage("unknown")).toEqual([])
    })
  })
})
